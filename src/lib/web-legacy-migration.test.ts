import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { getBlob } from "./assets";
import { getProject, loadProjects } from "./storage";
import { setStorageProvider } from "./storage-provider";
import { LEGACY_DB_NAME, LEGACY_MIGRATED_KEY, LEGACY_PROJECTS_KEY } from "./web-legacy-migration";
import { createWebStorage } from "./web-storage";
import {
  captureIssues,
  imageBlob,
  installLocalStorage,
  installWindow,
  makeProject,
  textOf,
} from "./test-support/storage-env";

installWindow({ tauri: false });
let local: Storage;
let dbCounter = 0;

/** Puts blobs where earlier versions kept them: one global store, no project in the key. */
async function seedLegacyBlobs(blobs: Record<string, Blob>): Promise<void> {
  const db: IDBDatabase = await new Promise((resolve, reject) => {
    const req = indexedDB.open(LEGACY_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("panoramas");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("panoramas", "readwrite");
    for (const [key, blob] of Object.entries(blobs)) tx.objectStore("panoramas").put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function legacyBlobKeys(): Promise<string[] | null> {
  const names = (await indexedDB.databases()).map((d) => d.name);
  if (!names.includes(LEGACY_DB_NAME)) return null;
  const db: IDBDatabase = await new Promise((resolve, reject) => {
    const req = indexedDB.open(LEGACY_DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const keys: IDBValidKey[] = await new Promise((resolve, reject) => {
    const r = db.transaction("panoramas").objectStore("panoramas").getAllKeys();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  db.close();
  return keys.map(String).sort();
}

async function keysOf(dbName: string): Promise<string[]> {
  const db: IDBDatabase = await new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const keys: IDBValidKey[] = await new Promise((resolve, reject) => {
    const r = db.transaction("files").objectStore("files").getAllKeys();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  db.close();
  return keys.map(String).sort();
}

const legacyScene = (id: string, panoramaUrl: string) => ({
  id,
  name: `Scene ${id}`,
  panoramaUrl,
  defaultZoom: 1,
  hotspots: [],
});

function newProvider(thumbnails = true) {
  const provider = createWebStorage({
    dbName: `mig-${dbCounter++}`,
    generateThumbnail: async (blob) =>
      thumbnails
        ? new Blob([`thumb of ${await blob.text()}`], { type: "image/jpeg" })
        : Promise.reject(new Error("no decoder")),
  });
  setStorageProvider(provider);
  return provider;
}

describe("migration of data saved by earlier browser versions", () => {
  beforeEach(() => {
    Object.assign(globalThis, { indexedDB: new IDBFactory() });
    local = installLocalStorage();
    setStorageProvider(null);
  });

  it("does nothing, and creates nothing, when there is no old data", async () => {
    const provider = newProvider();
    await provider.init();
    assert.deepEqual(await provider.listProjectIds(), []);
    assert.equal(await legacyBlobKeys(), null);
    assert.equal(local.getItem(LEGACY_MIGRATED_KEY), null);
  });

  it("moves projects and their images into the per-project tree", async () => {
    const withImages = makeProject("tour_a", {
      name: "With images",
      initialSceneId: "s1",
      scenes: [legacyScene("s1", "idb:pano_one"), legacyScene("s2", "idb:pano_two")],
    });
    // Saved before versioning existed: no schemaVersion, no theme, no hotspots.
    const {
      schemaVersion: _v,
      theme: _t,
      floorplans: _f,
      ...ancient
    } = makeProject("tour_b", {
      name: "Ancient",
      scenes: [legacyScene("s1", "https://example.com/a.jpg")],
    });
    local.setItem(LEGACY_PROJECTS_KEY, JSON.stringify([withImages, ancient]));
    await seedLegacyBlobs({
      pano_one: imageBlob("one", "image/jpeg"),
      pano_two: imageBlob("two", "image/png"),
      orphan: imageBlob("nobody uses me"),
    });

    const provider = newProvider();
    setStorageProvider(provider);
    const projects = await loadProjects();
    assert.deepEqual(projects.map((p) => p.id).sort(), ["tour_a", "tour_b"]);

    const a = (await getProject("tour_a"))!;
    assert.deepEqual(
      a.scenes.map((s) => s.panoramaUrl),
      ["tauri:pano_one.jpg", "tauri:pano_two.png"],
      "same references the desktop app writes",
    );
    assert.equal(a.updatedAt, withImages.updatedAt, "moving is not an edit");
    assert.equal(await textOf(await getBlob("tour_a", a.scenes[1]!.panoramaUrl)), "fake image two");
    assert.equal(
      await textOf(await provider.readPanorama("tour_a", "pano_one.jpg")),
      "fake image one",
    );
    assert.notEqual(await provider.thumbnailUrl("tour_a", "pano_one.jpg"), "");

    const b = (await getProject("tour_b"))!;
    assert.equal(b.schemaVersion, 1);
    assert.equal(b.scenes[0]!.panoramaUrl, "https://example.com/a.jpg");

    // Old storage is emptied; a JSON-only copy of the list is kept.
    assert.equal(local.getItem(LEGACY_PROJECTS_KEY), null);
    assert.equal(JSON.parse(local.getItem(LEGACY_MIGRATED_KEY)!).length, 2);
    assert.equal(await legacyBlobKeys(), null, "old blob database removed");
  });

  it("reads wait for the migration, even without an explicit init", async () => {
    local.setItem(
      LEGACY_PROJECTS_KEY,
      JSON.stringify([makeProject("tour_a", { scenes: [legacyScene("s", "idb:pano_one")] })]),
    );
    await seedLegacyBlobs({ pano_one: imageBlob("one") });
    const provider = newProvider();
    assert.equal(JSON.parse(await provider.readProjectFile("tour_a")).id, "tour_a");
  });

  it("a failed thumbnail does not stop the move", async () => {
    local.setItem(
      LEGACY_PROJECTS_KEY,
      JSON.stringify([makeProject("tour_a", { scenes: [legacyScene("s", "idb:pano_one")] })]),
    );
    await seedLegacyBlobs({ pano_one: imageBlob("one") });
    const provider = newProvider(false);
    await provider.init();
    assert.equal(
      await textOf(await provider.readPanorama("tour_a", "pano_one.png")),
      "fake image one",
    );
    assert.equal(await provider.thumbnailUrl("tour_a", "pano_one.png"), "");
  });

  it("sets aside an invalid project (like a corrupted desktop file) and moves the rest", async () => {
    const cap = captureIssues();
    try {
      local.setItem(
        LEGACY_PROJECTS_KEY,
        JSON.stringify([
          { id: "tour_bad", name: 42, scenes: "nope" },
          makeProject("tour_ok", { scenes: [legacyScene("s", "idb:pano_one")] }),
        ]),
      );
      await seedLegacyBlobs({ pano_one: imageBlob("one"), keep_me: imageBlob("maybe needed") });
      const provider = newProvider();
      await provider.init();

      assert.deepEqual(await provider.listProjectIds(), ["tour_ok"]);
      assert.ok(cap.issues.some((i) => i.id === "corrupt:legacy-0" && i.level === "error"));
      // The entry itself was kept in projects/_corrupt/.
      const keys = await keysOf(`mig-${dbCounter - 1}`);
      assert.ok(keys.some((k) => /^projects\/_corrupt\/legacy-0\..+\.project\.json$/.test(k)));
      // Something was not moved cleanly, so the old blobs are NOT deleted wholesale.
      assert.deepEqual(await legacyBlobKeys(), ["keep_me"]);
    } finally {
      cap.stop();
    }
  });

  it("keeps a missing image reference as it was and warns", async () => {
    const cap = captureIssues();
    try {
      local.setItem(
        LEGACY_PROJECTS_KEY,
        JSON.stringify([
          makeProject("tour_a", { name: "Gappy", scenes: [legacyScene("s", "idb:gone")] }),
        ]),
      );
      await seedLegacyBlobs({});
      const provider = newProvider();
      setStorageProvider(provider);
      assert.equal((await getProject("tour_a"))?.scenes[0]?.panoramaUrl, "idb:gone");
      assert.ok(cap.issues.some((i) => i.id === "legacy-missing:tour_a" && i.level === "warning"));
    } finally {
      cap.stop();
    }
  });

  it("does not overwrite a project that already exists in the new tree (interrupted earlier run)", async () => {
    local.setItem(
      LEGACY_PROJECTS_KEY,
      JSON.stringify([
        makeProject("tour_a", { name: "Old", scenes: [legacyScene("s", "idb:pano_one")] }),
      ]),
    );
    await seedLegacyBlobs({ pano_one: imageBlob("one") });

    // First run: migrate, then put the old entry back as if the clean-up never happened.
    const first = newProvider();
    await first.init();
    await first.writeProjectFile(
      "tour_a",
      JSON.stringify({ ...makeProject("tour_a", { name: "Edited since" }), scenes: [] }),
    );
    local.setItem(
      LEGACY_PROJECTS_KEY,
      JSON.stringify([
        makeProject("tour_a", { name: "Old", scenes: [legacyScene("s", "idb:pano_one")] }),
      ]),
    );

    const second = createWebStorage({ dbName: `mig-${dbCounter - 1}` });
    setStorageProvider(second);
    await second.init();
    assert.equal((await getProject("tour_a"))?.name, "Edited since");
    assert.equal(local.getItem(LEGACY_PROJECTS_KEY), null);
  });

  it("moves a corrupted project list aside instead of deleting it", async () => {
    const cap = captureIssues();
    try {
      local.setItem(LEGACY_PROJECTS_KEY, "{ not json");
      const provider = newProvider();
      await provider.init();
      assert.equal(local.getItem(LEGACY_PROJECTS_KEY), null);
      const aside = [...Array(local.length).keys()]
        .map((i) => local.key(i)!)
        .find((k) => k.includes(".corrupt."));
      assert.equal(local.getItem(aside!), "{ not json");
      assert.ok(cap.issues.some((i) => i.id === "browser-store-corrupt"));
    } finally {
      cap.stop();
    }
  });

  it("is idempotent: a second start finds nothing to do", async () => {
    local.setItem(
      LEGACY_PROJECTS_KEY,
      JSON.stringify([makeProject("tour_a", { scenes: [legacyScene("s", "idb:pano_one")] })]),
    );
    await seedLegacyBlobs({ pano_one: imageBlob("one") });
    const provider = newProvider();
    await provider.init();
    const before = await provider.readProjectFile("tour_a");
    const again = createWebStorage({ dbName: `mig-${dbCounter - 1}` });
    await again.init();
    assert.equal(await again.readProjectFile("tour_a"), before);
    assert.equal(JSON.parse(local.getItem(LEGACY_MIGRATED_KEY)!).length, 1);
  });
});
