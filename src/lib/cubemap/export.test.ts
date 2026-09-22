import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import type { Hotspot, Scene, TourProject } from "@/types/tour";
import { CURRENT_SCHEMA_VERSION } from "@/types/tour";
import {
  buildIndexHtml,
  buildProjectJson,
  buildTour,
  facePaths,
  jsonForScript,
  sceneDirName,
  slugify,
  type CubemapTour,
} from "./build-html";
import { FACE_NAMES } from "./core";
import { CubemapExportError, exportCubemapTour, type ExportDeps, type ExportSink } from "./export";

const viewerJs = readFileSync(new URL("./viewer/viewer.js", import.meta.url), "utf8");
const viewerCss = readFileSync(new URL("./viewer/viewer.css", import.meta.url), "utf8");
const assets = { js: viewerJs, css: viewerCss };

const hotspot = (over: Partial<Hotspot> = {}): Hotspot => ({
  id: "h1",
  type: "arrow",
  pitch: 0,
  yaw: 20,
  tooltip: "Go",
  targetSceneId: "scene_b",
  ...over,
});

const scene = (id: string, name: string, over: Partial<Scene> = {}): Scene => ({
  id,
  name,
  panoramaUrl: `tauri:pano_${id}.jpg`,
  defaultZoom: 1,
  defaultYaw: 0,
  defaultPitch: 0,
  hotspots: [],
  ...over,
});

const project = (scenes: Scene[], over: Partial<TourProject> = {}): TourProject => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  id: "tour_1",
  name: "My Tour",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  initialSceneId: null,
  scenes,
  theme: { showNavbar: true, showTitleOverlay: true, logoUrl: "" },
  floorplans: [],
  ...over,
});

class MemorySink implements ExportSink {
  files = new Map<string, Uint8Array | string>();
  order: string[] = [];
  async writeFile(path: string, data: Uint8Array | string) {
    this.files.set(path, data);
    this.order.push(path);
  }
  text(path: string): string {
    const data = this.files.get(path);
    assert.equal(typeof data, "string", `${path} should be text`);
    return data as string;
  }
}

function fakeDeps(over: Partial<ExportDeps> = {}): ExportDeps {
  return {
    getPanorama: async (s) => new Blob([`pano:${s.id}`]),
    convert: async (_blob, options) => {
      options.onProgress?.(0.5);
      options.onProgress?.(1);
      return FACE_NAMES.map((name) => ({ name, blob: new Blob([`face:${name}`]) }));
    },
    makeThumbnail: async () => new Blob(["thumb"]),
    assets,
    ...over,
  };
}

// ─── Layout and clean paths ────────────────────────────────────────────────

test("sceneDirName is a safe folder name and unique, even on case-insensitive disks", () => {
  const used = new Set<string>();
  assert.equal(sceneDirName("scene_ab12", 0, used), "scene_ab12");
  assert.equal(sceneDirName("../../etc/passwd", 1, used), "etc-passwd");
  assert.equal(sceneDirName("Scene_AB12", 2, used), "Scene_AB12-3"); // clashes with the first on macOS/Windows
  assert.equal(sceneDirName("////", 3, used), "scene-4");
  assert.equal(sceneDirName("scene_ab12", 4, used), "scene_ab12-5");
  for (const dir of used) assert.match(dir, /^[a-z0-9_-]+$/);
});

test("slugify matches the name the other exports use", () => {
  assert.equal(slugify("Casa Rossa - Piano 1!"), "casa-rossa-piano-1");
  assert.equal(slugify("***"), "tour");
});

test("project.json holds only clean relative paths, never internal references", () => {
  const p = project([scene("a", "Hall"), scene("b", "Kitchen", { panoramaUrl: "idb:xyz" })], {
    initialSceneId: "b",
  });
  const tour = buildTour(p, [
    { sceneId: "a", dir: "a", hasThumbnail: true },
    { sceneId: "b", dir: "b", hasThumbnail: false },
  ]);
  const json = buildProjectJson(tour);
  assert.doesNotMatch(json, /tauri:|idb:|blob:|data:|https?:|[A-Za-z]:\\|\/Users\//);
  const parsed = JSON.parse(json) as CubemapTour;
  assert.equal(parsed.scenes[0]!.faces.length, 6);
  assert.deepEqual(parsed.scenes[0]!.faces[0], "./panoramas/a/front.jpg");
  assert.equal(parsed.scenes[0]!.thumbnail, "./thumbnails/a.jpg");
  assert.equal(parsed.scenes[1]!.thumbnail, null);
  assert.equal(parsed.initialSceneId, "b");
});

// ─── index.html ────────────────────────────────────────────────────────────

function tourWith(over: Partial<CubemapTour> = {}): CubemapTour {
  const p = project([scene("a", "Hall", { hotspots: [hotspot()] }), scene("b", "Kitchen")]);
  return {
    ...buildTour(p, [
      { sceneId: "a", dir: "a", hasThumbnail: true },
      { sceneId: "b", dir: "b", hasThumbnail: true },
    ]),
    ...over,
  };
}

/** Evaluates a JS literal in a fresh context; the result is normalized so it compares with deepEqual. */
function evalLiteral(source: string): unknown {
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${source})`)));
}

function readInlineTour(html: string): unknown {
  const match = /<script>window\.TOUR = (.*);<\/script>/s.exec(html);
  assert.ok(match, "inline tour data not found");
  return evalLiteral(match[1]!);
}

test("index.html carries the tour inline and escapes anything that could break out of it", () => {
  const evil = '</script><img src=x onerror=alert(1)> & "quote"';
  const tour = tourWith({ name: evil });
  tour.scenes[0]!.name = evil;
  tour.scenes[0]!.hotspots = [hotspot({ tooltip: evil, content: `${evil}\u2028<!--` })];
  const html = buildIndexHtml(tour, assets);

  // Only the two script blocks that belong to the page exist.
  assert.equal(html.match(/<script/g)?.length, 2);
  assert.equal(html.match(/<\/script>/g)?.length, 2);
  assert.match(
    html,
    /<title>&lt;\/script&gt;&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;quote&quot;<\/title>/,
  );
  assert.deepEqual(readInlineTour(html), JSON.parse(JSON.stringify(tour)));
});

test("jsonForScript output is valid JS for every awkward string", () => {
  const value = { a: "</script>", b: "\u2028\u2029", c: "<!--", d: "\\u003c" };
  const js = jsonForScript(value);
  assert.doesNotMatch(js, /</);
  assert.deepEqual(evalLiteral(js), value);
});

test("index.html is self-contained: no network, no fetch, no WebGL, no base64", () => {
  const html = buildIndexHtml(tourWith(), assets);
  assert.doesNotMatch(html, /https?:\/\//i, "no absolute URL (CDN, esm.sh, ...)");
  assert.doesNotMatch(
    html,
    /\bimport\s*[({]|\bimport\s+\w+\s+from|type="module"/,
    "no ES module import",
  );
  assert.doesNotMatch(html, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/);
  assert.doesNotMatch(html, /getContext|WebGL2?RenderingContext|\bTHREE\b|three\.js/);
  assert.doesNotMatch(html, /data:image|;base64|btoa\(|atob\(/);
  assert.match(html, /perspective/);
  assert.match(html, /matrix3d\(/);
  assert.match(html, /new Image\(\)/);
});

test("the viewer script never contains a literal </script>", () => {
  const html = buildIndexHtml(tourWith(), { js: 'var s = "</script>";', css: "" });
  assert.equal(html.match(/<\/script>/g)?.length, 2);
});

// ─── Exporter ──────────────────────────────────────────────────────────────

test("exports every scene as six faces plus a thumbnail, then project.json and index.html last", async () => {
  const sink = new MemorySink();
  const p = project([scene("a", "Hall", { hotspots: [hotspot()] }), scene("b", "Kitchen")]);
  await exportCubemapTour(p, sink, fakeDeps());

  const expected = [
    ...facePaths("a"),
    "thumbnails/a.jpg",
    ...facePaths("b"),
    "thumbnails/b.jpg",
    "project.json",
    "index.html",
  ];
  assert.deepEqual(sink.order, expected);
  for (const path of facePaths("a")) assert.ok(sink.files.get(path) instanceof Uint8Array);
  assert.equal(
    new TextDecoder().decode(sink.files.get("panoramas/a/left.jpg") as Uint8Array),
    "face:left",
  );

  const json = JSON.parse(sink.text("project.json")) as CubemapTour;
  assert.deepEqual(readInlineTour(sink.text("index.html")), json);
  assert.equal(json.scenes[0]!.hotspots[0]!.targetSceneId, "scene_b");
});

test("a scene without a thumbnail still exports; the tour then has no thumbnail for it", async () => {
  const sink = new MemorySink();
  const p = project([scene("a", "Hall")]);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await exportCubemapTour(
      p,
      sink,
      fakeDeps({
        makeThumbnail: async () => {
          throw new Error("no canvas");
        },
      }),
    );
  } finally {
    console.warn = warn;
  }
  assert.ok(sink.files.has("index.html"));
  assert.ok(!sink.files.has("thumbnails/a.jpg"));
  assert.equal((JSON.parse(sink.text("project.json")) as CubemapTour).scenes[0]!.thumbnail, null);
});

test("a failing scene aborts the export naming the scene, and no index.html is written", async () => {
  const sink = new MemorySink();
  const p = project([scene("a", "Hall"), scene("b", "Kitchen")]);
  await assert.rejects(
    exportCubemapTour(
      p,
      sink,
      fakeDeps({
        getPanorama: async (s) => {
          if (s.id === "b") throw new Error("the panorama file is missing from the project");
          return new Blob(["x"]);
        },
      }),
    ),
    (e: unknown) =>
      e instanceof CubemapExportError &&
      e.sceneName === "Kitchen" &&
      /Scene "Kitchen": the panorama file is missing/.test(e.message),
  );
  assert.ok(!sink.files.has("index.html"));
  assert.ok(!sink.files.has("project.json"));
});

test("a sink failure is reported as a failure of the export", async () => {
  const sink: ExportSink = {
    async writeFile() {
      throw new Error("disk full");
    },
  };
  await assert.rejects(
    exportCubemapTour(project([scene("a", "Hall")]), sink, fakeDeps()),
    /disk full/,
  );
});

test("a converter that forgets a face is caught", async () => {
  const sink = new MemorySink();
  await assert.rejects(
    exportCubemapTour(
      project([scene("a", "Hall")]),
      sink,
      fakeDeps({ convert: async () => [{ name: "front", blob: new Blob(["x"]) }] }),
    ),
    /"right" face/,
  );
});

test("an empty project is refused", async () => {
  await assert.rejects(exportCubemapTour(project([]), new MemorySink(), fakeDeps()), /no scenes/);
});

test("cancelling stops the export with an AbortError, not a scene error", async () => {
  const controller = new AbortController();
  const sink = new MemorySink();
  await assert.rejects(
    exportCubemapTour(
      project([scene("a", "Hall"), scene("b", "Kitchen")]),
      sink,
      fakeDeps({
        convert: async () => {
          controller.abort();
          throw new DOMException("Export cancelled", "AbortError");
        },
      }),
      { signal: controller.signal },
    ),
    (e: unknown) => e instanceof DOMException && e.name === "AbortError",
  );
  assert.ok(!sink.files.has("index.html"));
});

test("progress only moves forward and ends at 100%", async () => {
  const seen: number[] = [];
  await exportCubemapTour(
    project([scene("a", "Hall"), scene("b", "Kitchen")]),
    new MemorySink(),
    fakeDeps(),
    {
      onProgress: (p) => seen.push(p.fraction),
    },
  );
  assert.ok(seen.length >= 4);
  for (let i = 1; i < seen.length; i++)
    assert.ok(seen[i]! >= seen[i - 1]!, `${seen[i]} < ${seen[i - 1]}`);
  assert.equal(seen[seen.length - 1], 1);
  assert.ok(seen.every((f) => f >= 0 && f <= 1));
});
