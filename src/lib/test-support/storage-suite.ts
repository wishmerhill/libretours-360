/**
 * The storage conformance suite: the SAME tests run against every driver, through
 * the same high-level functions the app uses (storage.ts, assets.ts,
 * panorama-import.ts, ProjectSaver). A driver that passes it is interchangeable
 * with the others, down to the exact tree of data it produces.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { deleteBlob, getBlob, putBlob, resolveThumbnailUrl, resolveUrl } from "../assets";
import { importPanoramaFiles } from "../panorama-import";
import { ProjectSaver } from "../project-saver";
import {
  deleteProject,
  duplicateProject,
  getProject,
  loadProjects,
  upsertProject,
} from "../storage";
import { ProjectValidationError, StorageError } from "../storage-errors";
import { getStorageProvider, setStorageProvider, type StorageProvider } from "../storage-provider";
import { captureIssues, imageBlob, makeProject, textOf } from "./storage-env";

export interface Harness {
  driver: string;
  create(): Promise<{
    provider: StorageProvider;
    /** Every file of the data tree, as `projects/...` paths, sorted. */
    tree(): Promise<string[]>;
    cleanup(): Promise<void>;
  }>;
}

const scene = (id: string, panoramaUrl: string) => ({
  id,
  name: `Scene ${id}`,
  panoramaUrl,
  defaultZoom: 1,
  hotspots: [],
});

async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof StorageError && e.code === code);
}

export function defineStorageSuite(harness: Harness): void {
  describe(`storage conformance: ${harness.driver}`, () => {
    let env: Awaited<ReturnType<Harness["create"]>>;
    let storage: StorageProvider;

    beforeEach(async () => {
      env = await harness.create();
      setStorageProvider(env.provider);
      storage = getStorageProvider();
      await storage.init();
    });
    afterEach(async () => {
      setStorageProvider(null);
      await env.cleanup();
    });

    it("starts empty", async () => {
      assert.deepEqual(await loadProjects(), []);
      assert.equal(await getProject("nope"), null);
      assert.deepEqual(await env.tree(), []);
    });

    it("saves and reloads a project, stamping schemaVersion and updatedAt", async () => {
      const saved = await upsertProject(
        makeProject("p1", { updatedAt: "2000-01-01T00:00:00.000Z" }),
      );
      assert.equal(saved.schemaVersion, 1);
      assert.notEqual(saved.updatedAt, "2000-01-01T00:00:00.000Z");
      assert.deepEqual(await getProject("p1"), saved);
      assert.deepEqual(
        (await loadProjects()).map((p) => p.id),
        ["p1"],
      );
    });

    it("fills in defaults for data written without them, and reads pre-versioning data (v0)", async () => {
      await storage.writeProjectFile(
        "old",
        JSON.stringify({
          id: "old",
          name: "Old",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
          scenes: [{ id: "s", name: "S", panoramaUrl: "https://example.com/a.jpg" }],
        }),
      );
      const project = await getProject("old");
      assert.equal(project?.schemaVersion, 1);
      assert.deepEqual(project?.scenes[0]?.hotspots, []);
      assert.equal(project?.theme.showNavbar, true);
    });

    it("refuses data that does not match the schema and writes nothing", async () => {
      await assert.rejects(
        upsertProject({ ...makeProject("p1"), id: "../evil" }),
        ProjectValidationError,
      );
      await assert.rejects(
        upsertProject(
          makeProject("p1", {
            scenes: [
              {
                ...scene("s1", "https://example.com/a.jpg"),
                hotspots: [{ id: "h", type: "info", pitch: Number.NaN, yaw: 0, tooltip: "" }],
              },
            ],
          }),
        ),
        ProjectValidationError,
      );
      await assert.rejects(
        upsertProject(makeProject("p1", { scenes: [scene("s1", "tauri:../../x.jpg")] })),
        ProjectValidationError,
      );
      assert.deepEqual(await env.tree(), []);
    });

    it("rejects unsafe ids and keys before touching anything", async () => {
      const blob = imageBlob("x");
      await rejectsWith(storage.writeProjectFile("../x", "{}"), "InvalidKey");
      await rejectsWith(storage.writeProjectFile("_corrupt", "{}"), "InvalidKey");
      await rejectsWith(storage.readProjectFile("a/b"), "InvalidKey");
      await rejectsWith(storage.writePanorama("p1", "a/b", blob), "InvalidKey");
      await rejectsWith(storage.writePanorama("p1", "..", blob), "InvalidKey");
      await rejectsWith(storage.readPanorama("p1", "x\\y.jpg"), "InvalidKey");
      await rejectsWith(storage.writeThumbnail("p1", "../x", blob), "InvalidKey");
      assert.equal(await storage.panoramaUrl("p1", "../x"), "");
      assert.deepEqual(await env.tree(), []);
    });

    it("produces exactly the documented tree", async () => {
      await upsertProject(makeProject("p1"));
      const a = await putBlob("p1", "pano_a", imageBlob("a"));
      const b = await putBlob("p1", "pano_b", imageBlob("b", "image/webp"));
      await storage.writeThumbnail("p1", "pano_a.png", imageBlob("thumb a", "image/jpeg"));
      await upsertProject(makeProject("p1", { scenes: [scene("s1", a), scene("s2", b)] }));

      assert.deepEqual(await env.tree(), [
        "projects/p1/panoramas/pano_a.png",
        "projects/p1/panoramas/pano_b.webp",
        "projects/p1/project.json",
        "projects/p1/project.json.bak",
        "projects/p1/thumbnails/pano_a.jpg",
      ]);
    });

    it("stores panoramas per project, with the extension taken from the MIME type", async () => {
      const png = await putBlob("p1", "pano_x", imageBlob("png", "image/png"));
      const webp = await putBlob("p1", "pano_y", imageBlob("webp", "image/webp"));
      const jpg = await putBlob("p1", "pano_z", imageBlob("jpg", "image/jpeg"));
      const unknown = await putBlob(
        "p1",
        "pano_w",
        imageBlob("unknown", "application/octet-stream"),
      );
      const keep = await putBlob("p1", "pano_v.png", imageBlob("named", "image/jpeg"));
      assert.deepEqual(
        [png, webp, jpg, unknown, keep],
        [
          "tauri:pano_x.png",
          "tauri:pano_y.webp",
          "tauri:pano_z.jpg",
          "tauri:pano_w.jpg",
          "tauri:pano_v.png",
        ],
      );
      assert.equal(await textOf(await getBlob("p1", png)), "fake image png");

      // The same key in another project is a different file.
      const other = await putBlob("p2", "pano_x", imageBlob("other"));
      assert.equal(other, png);
      assert.equal(await textOf(await getBlob("p2", other)), "fake image other");
      await deleteBlob("p2", other);
      assert.equal(await getBlob("p2", other), null);
      assert.equal(await textOf(await getBlob("p1", png)), "fake image png");
    });

    it("returns null for a missing or non-local panorama and ignores deleting it", async () => {
      assert.equal(await getBlob("p1", "tauri:missing.jpg"), null);
      assert.equal(await getBlob("p1", "https://example.com/a.jpg"), null);
      await deleteBlob("p1", "tauri:missing.jpg");
      await deleteBlob("p1", "https://example.com/a.jpg");
    });

    it("resolves urls: external ones pass through, local ones only if the file exists", async () => {
      assert.equal(
        await resolveUrl("p1", "https://example.com/a.jpg"),
        "https://example.com/a.jpg",
      );
      assert.equal(
        await resolveUrl("p1", "data:image/png;base64,AAAA"),
        "data:image/png;base64,AAAA",
      );
      assert.equal(await resolveUrl("p1", ""), "");
      assert.equal(await resolveUrl("p1", "idb:legacy"), "");
      assert.equal(await resolveUrl("p1", "tauri:missing.jpg"), "");

      const ref = await putBlob("p1", "pano_a", imageBlob("a"));
      assert.notEqual(await resolveUrl("p1", ref), "");
      assert.equal(await resolveUrl("p2", ref), "", "another project has no such file");
    });

    it("keeps thumbnails next to the panorama and removes them with it", async () => {
      const ref = await putBlob("p1", "pano_a", imageBlob("a"));
      assert.equal(
        await resolveThumbnailUrl("p1", ref),
        "",
        "no thumbnail yet: never the full image",
      );

      await storage.writeThumbnail("p1", "pano_a.png", imageBlob("t", "image/jpeg"));
      assert.notEqual(await resolveThumbnailUrl("p1", ref), "");

      await deleteBlob("p1", ref);
      assert.equal(await resolveUrl("p1", ref), "");
      assert.equal(await resolveThumbnailUrl("p1", ref), "");
      assert.deepEqual(await env.tree(), []);
    });

    it("deletes a whole project and nothing else", async () => {
      for (const id of ["p1", "p2"]) {
        const ref = await putBlob(id, "pano_a", imageBlob(id));
        await storage.writeThumbnail(id, "pano_a.png", imageBlob(`t${id}`, "image/jpeg"));
        await upsertProject(makeProject(id, { scenes: [scene("s", ref)] }));
        await upsertProject(makeProject(id, { scenes: [scene("s", ref)] }));
      }
      await deleteProject("p1");

      assert.equal(await getProject("p1"), null);
      assert.ok((await env.tree()).every((f) => f.startsWith("projects/p2/")));
      assert.equal((await env.tree()).length, 4);
      assert.equal(await textOf(await getBlob("p2", "tauri:pano_a.png")), "fake image p2");
      await deleteProject("p1"); // already gone: not an error
    });

    it("duplicates a project with its panoramas and thumbnails, independently of the original", async () => {
      const ref = await putBlob("p1", "pano_a", imageBlob("a"));
      await storage.writeThumbnail("p1", "pano_a.png", imageBlob("t", "image/jpeg"));
      await upsertProject(makeProject("p1", { name: "Tour", scenes: [scene("s", ref)] }));
      await upsertProject(makeProject("p1", { name: "Tour", scenes: [scene("s", ref)] })); // creates a .bak

      const copy = await duplicateProject("p1");
      assert.ok(copy);
      assert.notEqual(copy.id, "p1");
      assert.equal(copy.name, "Tour (copy)");
      assert.deepEqual(await getProject(copy.id), copy);

      const tree = await env.tree();
      assert.deepEqual(
        tree.filter((f) => f.startsWith(`projects/${copy.id}/`)),
        [
          `projects/${copy.id}/panoramas/pano_a.png`,
          `projects/${copy.id}/project.json`,
          `projects/${copy.id}/thumbnails/pano_a.jpg`,
        ],
        "the copy gets the assets and a fresh project.json, not the source's backup",
      );
      assert.equal(await textOf(await getBlob(copy.id, ref)), "fake image a");
      assert.notEqual(await resolveThumbnailUrl(copy.id, ref), "");

      await deleteProject(copy.id);
      assert.equal(await textOf(await getBlob("p1", ref)), "fake image a");
      assert.equal(await duplicateProject("missing"), null);
    });

    it("copyProject fails cleanly: missing source, existing destination", async () => {
      await rejectsWith(storage.copyProject("nope", "dst", "{}"), "FileNotFound");
      await upsertProject(makeProject("a"));
      await upsertProject(makeProject("b", { name: "B" }));
      const before = await env.tree();
      await rejectsWith(storage.copyProject("a", "b", "{}"), "IoError");
      assert.deepEqual(await env.tree(), before);
      assert.equal((await getProject("b"))?.name, "B");
      assert.equal(await getProject("dst"), null);
    });

    it("lists only real projects, never the internal folders", async () => {
      await upsertProject(makeProject("p1"));
      await storage.writeProjectFile("bad", "garbage");
      await storage.writeProjectFile("bad", "garbage 2");
      await assert.rejects(
        getProject("bad"),
        (e: unknown) => e instanceof StorageError && e.code === "CorruptFile",
      );
      assert.deepEqual(await storage.listProjectIds(), ["p1"]);
    });

    it("recovers a corrupted project.json from the backup and keeps the damaged file", async () => {
      const cap = captureIssues();
      try {
        await upsertProject(makeProject("p1", { name: "First" }));
        await upsertProject(makeProject("p1", { name: "Second" }));
        await storage.writeProjectFile("p1", "{ this is not json"); // the backup is now "Second"

        const project = await getProject("p1");
        assert.equal(project?.name, "Second");
        assert.equal(
          JSON.parse(await storage.readProjectFile("p1")).name,
          "Second",
          "main repaired",
        );
        assert.ok(
          (await env.tree()).some((f) => /^projects\/_corrupt\/p1\..+\.project\.json$/.test(f)),
        );
        assert.ok(cap.issues.some((i) => i.id === "recovered:p1" && i.level === "warning"));
      } finally {
        cap.stop();
      }
    });

    it("recovers from the backup when project.json is missing", async () => {
      await upsertProject(makeProject("p1", { name: "First" }));
      await upsertProject(makeProject("p1", { name: "Second" })); // backup = First
      assert.ok(await storage.quarantineProjectFile("p1"));
      assert.equal(await storage.quarantineProjectFile("p1"), null, "nothing left to move");
      assert.equal((await getProject("p1"))?.name, "First");
    });

    it("moves the whole project (panoramas included) to _corrupt when nothing is usable", async () => {
      const cap = captureIssues();
      try {
        const ref = await putBlob("p1", "pano_a", imageBlob("a"));
        await storage.writeProjectFile("p1", "garbage");
        await storage.writeProjectFile("p1", "garbage 2"); // no valid file to back up

        await rejectsWith(getProject("p1"), "CorruptFile");
        assert.equal(await getBlob("p1", ref), null, "the id is free again");
        const tree = await env.tree();
        assert.ok(tree.every((f) => f.startsWith("projects/_corrupt/p1.")));
        assert.ok(
          tree.some((f) => f.endsWith("/panoramas/pano_a.png")),
          "panoramas kept for recovery",
        );
        assert.ok(tree.some((f) => f.endsWith("/project.json")));
        assert.ok(cap.issues.some((i) => i.id === "corrupt:p1"));
        assert.deepEqual(await storage.listProjectIds(), []);
      } finally {
        cap.stop();
      }
    });

    it("one unreadable project does not hide the others", async () => {
      const cap = captureIssues();
      try {
        await upsertProject(makeProject("good1"));
        await storage.writeProjectFile("bad", "garbage");
        await upsertProject(makeProject("good2"));
        assert.deepEqual((await loadProjects()).map((p) => p.id).sort(), ["good1", "good2"]);
      } finally {
        cap.stop();
      }
    });

    it("never quarantines a project written by a newer app version", async () => {
      await storage.writeProjectFile(
        "p1",
        JSON.stringify({ ...makeProject("p1"), schemaVersion: 99 }),
      );
      const before = await env.tree();
      await assert.rejects(
        getProject("p1"),
        (e: unknown) => e instanceof ProjectValidationError && e.reason === "UnsupportedVersion",
      );
      assert.deepEqual(await env.tree(), before);
    });

    it("rejects a project whose id does not match its folder", async () => {
      await storage.writeProjectFile("a", JSON.stringify(makeProject("b")));
      await rejectsWith(getProject("a"), "CorruptFile");
    });

    it("serializes concurrent saves of the same project", async () => {
      const names = Array.from({ length: 25 }, (_, i) => `Name ${i}`);
      await Promise.all(names.map((name) => upsertProject(makeProject("p1", { name }))));
      assert.equal((await getProject("p1"))?.name, "Name 24");
      assert.equal(JSON.parse(await storage.readProjectBackup("p1")).name, "Name 23");
    });

    it("imports dropped files into the project; a failed thumbnail does not fail the import", async () => {
      const files = [
        new File([imageBlob("one")], "Living room.jpg", { type: "image/jpeg" }),
        new File([imageBlob("two")], "Kitchen.png", { type: "image/png" }),
      ];
      const imported = await importPanoramaFiles("p1", files);
      assert.deepEqual(
        imported.map((i) => i.name),
        ["Living room", "Kitchen"],
      );
      assert.deepEqual(
        imported.map((i) => i.ref.split(".").pop()),
        ["jpg", "png"],
      );
      assert.equal(await textOf(await getBlob("p1", imported[1]!.ref)), "fake image two");
      // No image decoder in the test runtime: the panorama is there, the preview is not.
      assert.ok(imported.every((i) => i.thumbnailFailed));
    });

    it("edits through the app's own commands: add scene, hotspot, parameters, remove scene", async () => {
      await upsertProject(makeProject("p1"));
      let project = (await getProject("p1"))!;
      const saver = new ProjectSaver({
        getProject: () => project,
        save: upsertProject,
        deleteAssets: (id, refs) =>
          Promise.all(refs.map((r) => deleteBlob(id, r))).then(() => undefined),
      });

      // add two scenes from imported files
      const [a, b] = await importPanoramaFiles("p1", [
        new File([imageBlob("a")], "A.jpg", { type: "image/jpeg" }),
        new File([imageBlob("b")], "B.jpg", { type: "image/jpeg" }),
      ]);
      project = {
        ...project,
        initialSceneId: "sa",
        scenes: [scene("sa", a!.ref), scene("sb", b!.ref)],
      };
      saver.markDirty();
      await saver.flush();

      // add a hotspot, change a parameter
      project = {
        ...project,
        name: "Renamed",
        theme: { ...project.theme, showNavbar: false },
        scenes: project.scenes.map((s) =>
          s.id === "sa"
            ? {
                ...s,
                hotspots: [
                  {
                    id: "h1",
                    type: "door" as const,
                    pitch: 0.1,
                    yaw: 1.5,
                    tooltip: "Go",
                    targetSceneId: "sb",
                  },
                ],
              }
            : s,
        ),
      };
      saver.markDirty();
      await saver.flush();

      let reloaded = (await getProject("p1"))!;
      assert.equal(reloaded.name, "Renamed");
      assert.equal(reloaded.theme.showNavbar, false);
      assert.equal(reloaded.scenes[0]!.hotspots[0]!.targetSceneId, "sb");

      // remove a scene: its image goes only after the project was saved without it
      project = { ...project, scenes: project.scenes.filter((s) => s.id !== "sb") };
      saver.queueAssetDeletion([b!.ref]);
      await saver.flush();
      reloaded = (await getProject("p1"))!;
      assert.deepEqual(
        reloaded.scenes.map((s) => s.id),
        ["sa"],
      );
      assert.equal(await getBlob("p1", b!.ref), null);
      assert.equal(await textOf(await getBlob("p1", a!.ref)), "fake image a");
    });
  });
}
