/**
 * End-to-end: builds a real export folder (procedural panoramas, real exporter,
 * real viewer files), opens it in headless Chrome over file:// with WebGL turned
 * OFF, and checks what is actually on screen. Skipped when Chrome is not installed
 * (set CHROME_PATH to point at it). Set E2E_SCREENSHOTS=<dir> to keep screenshots.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";
import type { Hotspot, TourProject } from "@/types/tour";
import { CURRENT_SCHEMA_VERSION } from "@/types/tour";
import { FACE_NAMES, chooseFaceSize, renderFaceRows } from "./core";
import { exportCubemapTour, type ExportDeps, type ExportSink } from "./export";
import { encodePng } from "./test-support/png";
import { findChrome, launchPage, type PageDriver } from "./test-support/chrome";

const W = 1000;
const H = 600;
const DEG = Math.PI / 180;
const chrome = findChrome();

// ─── Procedural panorama: every region has a known colour ───────────────────

type Rgb = [number, number, number];
const RED: Rgb = [220, 30, 30];
const GREEN: Rgb = [30, 180, 60];
const BLUE: Rgb = [40, 60, 220];
const YELLOW: Rgb = [230, 220, 40];
const MAGENTA: Rgb = [255, 0, 255];
const CYAN: Rgb = [0, 255, 255];
const WHITE: Rgb = [255, 255, 255];
// Deliberately unlike the page background (9, 9, 11): a hole in the cube shows the background.
const DARK: Rgb = [110, 110, 120];
const PAGE_BACKGROUND: Rgb = [9, 9, 11];
const MAX_PINHOLES = 3;
const ORANGE: Rgb = [255, 140, 0];

/** Sectors by yaw, caps above/below 60°, a magenta stripe at yaw 15..25 and a cyan band at pitch 15..25. */
function panoColor(lon: number, lat: number, front: Rgb): Rgb {
  if (lat > 60) return WHITE;
  if (lat < -60) return DARK;
  if (lon >= 15 && lon <= 25) return MAGENTA;
  if (lat >= 15 && lat <= 25) return CYAN;
  if (lon >= -45 && lon < 45) return front;
  if (lon >= 45 && lon < 135) return GREEN;
  if (lon >= -135 && lon < -45) return YELLOW;
  return BLUE;
}

function equirect(width: number, front: Rgb) {
  const height = width / 2;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = panoColor(
        ((x + 0.5) / width) * 360 - 180,
        90 - ((y + 0.5) / height) * 180,
        front,
      );
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return { data, width, fullHeight: height, firstRow: 0, rows: height };
}

const sources = { a: equirect(2048, RED), b: equirect(2048, ORANGE) };
const sourceOf = (blob: Blob) => (blob.size === 1 ? sources.a : sources.b);

/** The "panorama" handed to the exporter is a marker blob (size tells which scene). */
const deps: ExportDeps = {
  getPanorama: async (scene) => new Blob([scene.id === "a" ? "x" : "xy"]),
  convert: async (blob) => {
    const source = sourceOf(blob);
    const size = chooseFaceSize(source.width);
    return FACE_NAMES.map((name) => {
      const pixels = new Uint8Array(size * size * 4);
      renderFaceRows(source, name, size, pixels, 0, size);
      // PNG bytes under a .jpg name: browsers sniff the content, and it stays lossless for exact colours.
      return { name, blob: new Blob([new Uint8Array(encodePng(size, size, pixels))]) };
    });
  },
  makeThumbnail: async () =>
    new Blob([new Uint8Array(encodePng(4, 2, new Uint8Array(4 * 2 * 4).fill(200)))]),
  assets: {
    js: readFileSync(new URL("./viewer/viewer.js", import.meta.url), "utf8"),
    css: readFileSync(new URL("./viewer/viewer.css", import.meta.url), "utf8"),
  },
};

const hs = (over: Partial<Hotspot> & Pick<Hotspot, "id" | "yaw" | "pitch">): Hotspot => ({
  type: "arrow",
  tooltip: over.id,
  targetSceneId: null,
  ...over,
});

const NAV = 0; // indexes into scene "a" hotspots
const NAV_LOW = 1;
const POLE = 2;
const project: TourProject = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  id: "tour_e2e",
  name: "E2E Tour",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  initialSceneId: "a",
  theme: { showNavbar: true, showTitleOverlay: true, logoUrl: "" },
  floorplans: [],
  scenes: [
    {
      id: "a",
      name: "Hall",
      panoramaUrl: "tauri:a.jpg",
      defaultZoom: 1.5,
      defaultYaw: 0,
      defaultPitch: 0,
      hotspots: [
        hs({ id: "nav", yaw: 45, pitch: 10, targetSceneId: "b", tooltip: "To the kitchen" }),
        hs({ id: "nav-low", type: "door", yaw: 45, pitch: -10, targetSceneId: "b" }),
        hs({
          id: "pole",
          type: "info",
          yaw: 0,
          pitch: 60,
          tooltip: "Notes",
          content:
            "## Title\n**bold** text\n\n<script>window.__pwn = 1</script>\n[bad](javascript:alert(1)) [good](https://example.com/x)",
        }),
      ],
    },
    {
      id: "b",
      name: "Kitchen",
      panoramaUrl: "tauri:b.jpg",
      defaultZoom: 1,
      defaultYaw: 0,
      defaultPitch: 0,
      hotspots: [hs({ id: "back", yaw: -30, pitch: 0, targetSceneId: "a" })],
    },
  ],
};

// A second, small tour whose scenes carry a non-zero saved default view (yaw/pitch/zoom),
// to check that opening a tour and switching scenes applies exactly that saved view
// instead of always resetting to yaw=0/pitch=0 (reuses ids "a"/"b" so `deps` above still
// hands them the red/orange procedural panoramas).
const defaultsProject: TourProject = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  id: "tour_defaults",
  name: "Defaults Tour",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  initialSceneId: "a",
  theme: { showNavbar: true, showTitleOverlay: true, logoUrl: "" },
  floorplans: [],
  scenes: [
    {
      id: "a",
      name: "Hall",
      panoramaUrl: "tauri:a.jpg",
      defaultZoom: 1.5,
      defaultYaw: 30,
      defaultPitch: -15,
      hotspots: [hs({ id: "nav", yaw: 45, pitch: 10, targetSceneId: "b" })],
    },
    {
      id: "b",
      name: "Kitchen",
      panoramaUrl: "tauri:b.jpg",
      defaultZoom: 1,
      defaultYaw: -60,
      defaultPitch: 20,
      hotspots: [hs({ id: "back", yaw: -30, pitch: 0, targetSceneId: "a" })],
    },
  ],
};

/** Same formula as the viewer's zoomToFov(): 0.6x..3x maps to 90..30 degrees. */
function zoomToFov(zoom: number): number {
  return 90 - ((zoom - 0.6) / 2.4) * 60;
}

// ─── Independent projection maths (dot products, not the viewer's rotations) ─

function expectedScreen(
  yaw: number,
  pitch: number,
  view: { yaw: number; pitch: number; fov: number },
): { x: number; y: number } | null {
  const lon = yaw * DEG;
  const lat = pitch * DEG;
  const d = [Math.sin(lon) * Math.cos(lat), Math.sin(lat), -Math.cos(lon) * Math.cos(lat)] as const; // y up
  const vy = view.yaw * DEG;
  const vp = view.pitch * DEG;
  const f = [Math.sin(vy) * Math.cos(vp), Math.sin(vp), -Math.cos(vy) * Math.cos(vp)] as const;
  const r = [Math.cos(vy), 0, Math.sin(vy)] as const;
  const u = [-Math.sin(vy) * Math.sin(vp), Math.cos(vp), Math.cos(vy) * Math.sin(vp)] as const;
  const dot = (a: readonly number[], b: readonly number[]) =>
    a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const depth = dot(d, f);
  if (depth <= 0.01) return null;
  const p = H / 2 / Math.tan((view.fov * DEG) / 2);
  return { x: W / 2 + (p * dot(d, r)) / depth, y: H / 2 - (p * dot(d, u)) / depth };
}

// ─── Fixture ────────────────────────────────────────────────────────────────

let dir = "";
let page: PageDriver;
let loads = 0;
const shots = process.env["E2E_SCREENSHOTS"];

function folderSink(root: string): ExportSink {
  return {
    async writeFile(path, data) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
    },
  };
}

before(async () => {
  if (!chrome) return;
  dir = mkdtempSync(join(tmpdir(), "cubemap-export-"));
  await exportCubemapTour(project, folderSink(dir), deps);
  // --disable-3d-apis: WebGL is unavailable, exactly what must not matter.
  page = await launchPage(chrome, {
    width: W,
    height: H,
    args: ["--disable-3d-apis", "--disable-gpu"],
  });
});

after(async () => {
  await page?.close();
  if (dir && process.env["E2E_KEEP_EXPORT"]) console.log(`export kept in ${dir}`);
  else if (dir) rmSync(dir, { recursive: true, force: true });
});

async function open(hash = "", root = dir) {
  await page.goto(`${pathToFileURL(join(root, "index.html")).href}?n=${++loads}${hash}`);
  await page.waitFor(
    `document.documentElement.dataset.ready === "1" || document.documentElement.dataset.error === "1"`,
  );
}

async function snapshot(name: string) {
  const screenshot = await page.screenshot();
  if (shots) {
    mkdirSync(shots, { recursive: true });
    const { encodePng: encode } = await import("./test-support/png");
    writeFileSync(
      join(shots, `${name}.png`),
      encode(screenshot.width, screenshot.height, screenshot.data),
    );
  }
  return screenshot;
}

const dist = (pixel: number[], expected: Rgb) =>
  Math.max(...pixel.map((v, i) => Math.abs(v - expected[i]!)));

const close = (pixel: number[], expected: Rgb, tolerance = 45) =>
  pixel.every((v, i) => Math.abs(v - expected[i]!) <= tolerance);

function assertColor(pixel: number[], expected: Rgb, what: string) {
  assert.ok(close(pixel, expected), `${what}: expected ~rgb(${expected}), got rgb(${pixel})`);
}

async function hotspotCenters(): Promise<({ x: number; y: number } | null)[]> {
  return await page.eval(`[...document.querySelectorAll(".hs")].map(e => {
    if (getComputedStyle(e).display === "none") return null;
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })`);
}

const skip = chrome ? false : "Chrome not found (set CHROME_PATH)";

// ─── Tests ──────────────────────────────────────────────────────────────────

test(
  "the export folder has the expected layout and no absolute or internal paths",
  { skip },
  () => {
    for (const scene of ["a", "b"]) {
      for (const face of FACE_NAMES)
        assert.ok(existsSync(join(dir, "panoramas", scene, `${face}.jpg`)), `${scene}/${face}`);
      assert.ok(existsSync(join(dir, "thumbnails", `${scene}.jpg`)));
    }
    const json = readFileSync(join(dir, "project.json"), "utf8");
    assert.doesNotMatch(json, /tauri:|idb:|\/private\/|\/tmp\//);
    assert.match(json, /"\.\/panoramas\/a\/front\.jpg"/);
  },
);

test(
  "opens over file:// with WebGL unavailable and loads all six faces as plain <img>",
  { skip },
  async () => {
    await open("#yaw=0&pitch=0&fov=90");
    assert.equal(await page.eval("location.protocol"), "file:");
    assert.equal(
      await page.eval(`document.createElement("canvas").getContext("webgl")`),
      null,
      "WebGL must be off",
    );
    // Six distinct face files, each really decoded (512px), shown through native <img> tiles.
    const srcs = await page.eval<string[]>(
      `[...new Set([...document.querySelectorAll("#world .tile img")].map((i) => i.getAttribute("src")))].sort()`,
    );
    assert.deepEqual(srcs, FACE_NAMES.map((f) => `./panoramas/a/${f}.jpg`).sort());
    assert.deepEqual(
      await page.eval(
        `[...new Set([...document.querySelectorAll("#world .tile img")].map((i) => i.complete && i.naturalWidth))]`,
      ),
      [512],
    );
    assert.equal(await page.eval(`document.title`), "E2E Tour - Hall");
    assert.equal(await page.eval(`document.getElementById("title").textContent`), "Hall");
    await snapshot("front");
    assert.deepEqual(page.problems, []);
  },
);

test(
  "every direction shows the right part of the panorama (orientation, no mirroring)",
  { skip },
  async () => {
    const cases: [string, Rgb][] = [
      ["yaw=0&pitch=0", RED],
      ["yaw=90&pitch=0", GREEN],
      ["yaw=180&pitch=0", BLUE],
      ["yaw=-90&pitch=0", YELLOW],
      ["yaw=0&pitch=80", WHITE],
      ["yaw=0&pitch=-80", DARK],
      ["yaw=100&pitch=0", GREEN],
      ["yaw=-170&pitch=0", BLUE],
    ];
    for (const [view, colour] of cases) {
      await open(`#${view}&fov=90`);
      assertColor((await page.screenshot()).pixel(W / 2, H / 2 + 60), colour, view);
    }
    for (const yaw of [90, 180, -90]) {
      await open(`#yaw=${yaw}&pitch=0&fov=90`);
      if (yaw === 90) await snapshot("right");
    }
  },
);

test(
  "left/right and up/down are not mirrored: the stripe at yaw 15..25 and the band at pitch 15..25",
  { skip },
  async () => {
    await open("#yaw=0&pitch=0&fov=90");
    const shot = await snapshot("stripes");
    const p = H / 2 / Math.tan(45 * DEG); // 300
    const at = (lon: number) => W / 2 + p * Math.tan(lon * DEG);
    assertColor(shot.pixel(at(20), H / 2 + 100), MAGENTA, "stripe to the RIGHT of centre");
    assertColor(shot.pixel(at(-20), H / 2 + 100), RED, "no stripe to the LEFT of centre");
    assertColor(shot.pixel(at(12), H / 2 + 100), RED, "just before the stripe");
    assertColor(shot.pixel(at(28), H / 2 + 100), RED, "just after the stripe");
    assertColor(shot.pixel(W / 2 - 100, H / 2 - p * Math.tan(20 * DEG)), CYAN, "band ABOVE centre");
    assertColor(
      shot.pixel(W / 2 - 100, H / 2 + p * Math.tan(20 * DEG)),
      RED,
      "no band BELOW centre",
    );
  },
);

test(
  "hotspots land exactly where an independent projection puts them, for many views",
  { skip },
  async () => {
    const views = [
      { yaw: 0, pitch: 0, fov: 90 },
      { yaw: 30, pitch: 20, fov: 60 },
      { yaw: -70, pitch: -35, fov: 75 },
      { yaw: 40, pitch: 60, fov: 45 },
      { yaw: 200, pitch: 5, fov: 90 },
      { yaw: 20, pitch: 0, fov: 30 },
    ];
    const hotspots = project.scenes[0]!.hotspots;
    for (const view of views) {
      await open(`#yaw=${view.yaw}&pitch=${view.pitch}&fov=${view.fov}`);
      const actual = await hotspotCenters();
      hotspots.forEach((h, i) => {
        const expected = expectedScreen(h.yaw, h.pitch, view);
        const got = actual[i]!;
        const label = `${h.id} at view ${JSON.stringify(view)}`;
        if (!expected) return assert.equal(got, null, `${label} should be hidden`);
        assert.ok(
          got,
          `${label} should be visible at (${expected.x.toFixed(0)}, ${expected.y.toFixed(0)})`,
        );
        assert.ok(
          Math.abs(got.x - expected.x) < 1.5 && Math.abs(got.y - expected.y) < 1.5,
          `${label}: got (${got.x.toFixed(1)}, ${got.y.toFixed(1)}), expected (${expected.x.toFixed(1)}, ${expected.y.toFixed(1)})`,
        );
      });
    }
  },
);

test(
  "the CSS 3D cube and the hotspot overlay agree: hotspots sit on the panorama features they mark",
  { skip },
  async () => {
    // Meridian yaw=45 (red | green boundary) seen from yaw 40, pitch 0 is a vertical line through both nav hotspots.
    await open("#yaw=40&pitch=0&fov=80");
    let shot = await snapshot("boundary");
    const centers = await hotspotCenters();
    const row = H - 130; // below every hotspot, above the scene list
    const nearer = (pixel: number[], a: Rgb, b: Rgb) => dist(pixel, a) < dist(pixel, b);
    let boundary = -1;
    for (let x = 450; x < 900 && boundary < 0; x++) {
      if (nearer(shot.pixel(x, row), GREEN, RED)) boundary = x;
    }
    assert.ok(boundary > 0, "red/green boundary not found");
    for (const i of [NAV, NAV_LOW]) {
      assert.ok(
        Math.abs(centers[i]!.x - boundary) < 2.5,
        `hotspot ${i} x=${centers[i]!.x} vs boundary x=${boundary}`,
      );
    }

    // Parallel pitch=60 (white cap | red) seen from pitch 30 crosses the centre column where the "pole" hotspot is.
    await open("#yaw=0&pitch=30&fov=80");
    shot = await snapshot("pole");
    const pole = (await hotspotCenters())[POLE]!;
    const column = Math.round(W / 2 + 40); // beside the hotspot
    let edge = -1;
    for (let y = 0; y < H && edge < 0; y++) {
      if (nearer(shot.pixel(column, y), RED, WHITE)) edge = y;
    }
    assert.ok(edge > 0, "white cap edge not found");
    assert.ok(Math.abs(pole.x - W / 2) < 1.5);
    assert.ok(Math.abs(edge - pole.y) < 4, `cap edge y=${edge} vs hotspot y=${pole.y}`);
  },
);

test(
  "no holes and no seams: the background never shows through, whatever the view",
  { skip },
  async () => {
    // The page background is dark blue-black and no panorama colour is near it, so any
    // pixel of that colour inside the picture is a missing face, a gap or a seam.
    // Skipped areas: the title, the fullscreen button, the scene list and the hotspots.
    const views: string[] = [];
    for (const fov of [90, 50]) {
      for (let yaw = 0; yaw < 360; yaw += 30) {
        for (const pitch of [-75, -45, -20, 0, 20, 45, 75])
          views.push(`yaw=${yaw}&pitch=${pitch}&fov=${fov}`);
      }
    }
    const problems: string[] = [];
    for (const view of views) {
      await open(`#${view}`);
      const shot = await page.screenshot();
      const hotspots = (await hotspotCenters()).filter((c): c is { x: number; y: number } => !!c);
      let bad = 0;
      let first = "";
      for (let y = 70; y < H - 70; y++) {
        for (let x = 0; x < W; x++) {
          if (dist(shot.pixel(x, y), PAGE_BACKGROUND) > 25) continue;
          if (hotspots.some((c) => Math.abs(c.x - x) < 30 && Math.abs(c.y - y) < 30)) continue;
          if (!bad++) first = `(${x}, ${y})`;
        }
      }
      // Chrome leaves an isolated single-pixel pinhole where tile corners meet in a few views;
      // a missing tile or a seam is hundreds or thousands of pixels.
      if (bad > MAX_PINHOLES) problems.push(`${view}: ${bad} background pixels, first at ${first}`);
    }
    assert.deepEqual(problems, []);
  },
);

test("flat colour stays flat: no faint lines along tile or face edges", { skip }, async () => {
  // Areas that are one solid colour in the panorama. Any deviation is a seam blending the page
  // background in (a 1% darker line is enough to be visible on a big screen).
  const cases: { view: string; area: [number, number, number, number]; colour: Rgb }[] = [
    { view: "yaw=0&pitch=0&fov=90", area: [210, 240, 570, 520], colour: RED },
    { view: "yaw=0&pitch=0&fov=90", area: [660, 240, 760, 520], colour: RED },
    { view: "yaw=90&pitch=-20&fov=60", area: [100, 250, 900, 520], colour: GREEN },
    { view: "yaw=180&pitch=0&fov=50", area: [50, 240, 950, 520], colour: BLUE },
    { view: "yaw=-90&pitch=10&fov=75", area: [130, 300, 850, 520], colour: YELLOW },
    { view: "yaw=30&pitch=-60&fov=90", area: [420, 480, 580, 520], colour: DARK },
  ];
  const problems: string[] = [];
  for (const { view, area, colour } of cases) {
    await open(`#${view}`);
    const shot = await page.screenshot();
    let worst = 0;
    let at = "";
    for (let y = area[1]; y < area[3]; y++) {
      for (let x = area[0]; x < area[2]; x++) {
        const d = dist(shot.pixel(x, y), colour);
        if (d > worst) [worst, at] = [d, `(${x}, ${y})`];
      }
    }
    if (worst > 6) problems.push(`${view}: colour off by ${worst} at ${at}`);
  }
  assert.deepEqual(problems, []);
});

test(
  "dragging moves the scene with the pointer (right = look left), by exactly the field of view per pixel",
  { skip },
  async () => {
    await open("#yaw=0&pitch=0&fov=80");
    const before = (await hotspotCenters())[NAV]!;
    await page.mouse("mousePressed", 300, 300);
    for (let i = 1; i <= 5; i++) await page.mouse("mouseMoved", 300 + i * 20, 300);
    await new Promise((r) => setTimeout(r, 200)); // stop before releasing: no fling
    await page.mouse("mouseReleased", 400, 300);
    await new Promise((r) => setTimeout(r, 300));
    const after = (await hotspotCenters())[NAV]!;
    const expected = expectedScreen(45, 10, { yaw: -100 * (80 / H), pitch: 0, fov: 80 })!;
    assert.ok(after.x > before.x, "content must follow the pointer to the right");
    assert.ok(
      Math.abs(after.x - expected.x) < 2 && Math.abs(after.y - expected.y) < 2,
      `got (${after.x}, ${after.y}) expected (${expected.x}, ${expected.y})`,
    );

    // Vertical: dragging down looks up (content moves down).
    await open("#yaw=0&pitch=0&fov=80");
    const start = (await hotspotCenters())[NAV]!;
    await page.mouse("mousePressed", 300, 200);
    for (let i = 1; i <= 4; i++) await page.mouse("mouseMoved", 300, 200 + i * 15);
    await new Promise((r) => setTimeout(r, 200));
    await page.mouse("mouseReleased", 300, 260);
    await new Promise((r) => setTimeout(r, 200));
    const moved = (await hotspotCenters())[NAV]!;
    assert.ok(moved.y > start.y, "content must follow the pointer downwards");
    const expectedV = expectedScreen(45, 10, { yaw: 0, pitch: 60 * (80 / H), fov: 80 })!;
    assert.ok(Math.abs(moved.y - expectedV.y) < 2, `got y=${moved.y} expected y=${expectedV.y}`);
  },
);

test("wheel zooms (limits 30..90 degrees) and arrow keys turn the view", { skip }, async () => {
  await open("#yaw=0&pitch=0&fov=90");
  const wide = (await hotspotCenters())[NAV]!;
  await page.wheel(500, 300, -300);
  await new Promise((r) => setTimeout(r, 100));
  const closer = (await hotspotCenters())[NAV]!;
  assert.ok(closer.x - W / 2 > wide.x - W / 2, "zooming in pushes hotspots outwards");

  for (let i = 0; i < 40; i++) await page.wheel(500, 300, -500);
  await new Promise((r) => setTimeout(r, 100));
  const max = (await hotspotCenters())[NAV]!;
  const atMinFov = expectedScreen(45, 10, { yaw: 0, pitch: 0, fov: 30 });
  assert.ok(atMinFov && max, "hotspot still projected at the narrowest field of view");
  assert.ok(
    Math.abs(max.x - atMinFov.x) < 2,
    `fov is clamped at 30: hotspot x=${max.x}, expected ${atMinFov.x}`,
  );

  await open("#yaw=0&pitch=0&fov=60");
  await page.key("ArrowRight");
  await new Promise((r) => setTimeout(r, 100));
  const turned = (await hotspotCenters())[NAV]!;
  const expected = expectedScreen(45, 10, { yaw: 60 / 12, pitch: 0, fov: 60 })!;
  assert.ok(Math.abs(turned.x - expected.x) < 2, `got x=${turned.x} expected x=${expected.x}`);
});

test("clicking a door hotspot changes scene; the scene list switches back", { skip }, async () => {
  await open("#yaw=0&pitch=0&fov=90");
  const nav = (await hotspotCenters())[NAV]!;
  await page.mouse("mousePressed", nav.x, nav.y);
  await page.mouse("mouseReleased", nav.x, nav.y);
  await page.waitFor(`document.documentElement.dataset.scene === "b"`);
  assert.equal(await page.eval(`document.getElementById("title").textContent`), "Kitchen");
  assertColor((await snapshot("kitchen")).pixel(W / 2, H / 2 + 60), ORANGE, "scene b front");
  assert.equal(await page.eval(`document.querySelectorAll(".hs").length`), 1);
  assert.equal(
    await page.eval(`document.querySelector("#scene-list .active span").textContent`),
    "Kitchen",
  );
  assert.equal(
    await page.eval(`document.querySelector("#scene-list img").getAttribute("src")`),
    "./thumbnails/a.jpg",
  );
  assert.equal(
    await page.eval(`document.querySelector("#scene-list img").naturalWidth`),
    4,
    "thumbnail loads",
  );

  await page.eval(`document.querySelector('#scene-list button[data-scene="a"]').click()`);
  await page.waitFor(`document.documentElement.dataset.scene === "a"`);
  assertColor((await page.screenshot()).pixel(W / 2, H / 2 + 60), RED, "back to scene a");
  assert.deepEqual(page.problems, []);
});

test(
  "opening a tour, and switching scenes, applies each scene's saved default yaw/pitch/zoom",
  { skip },
  async () => {
    const defaultsDir = mkdtempSync(join(tmpdir(), "cubemap-defaults-"));
    try {
      await exportCubemapTour(defaultsProject, folderSink(defaultsDir), deps);

      // No hash: the initial scene must open exactly at its own saved default view.
      await open("", defaultsDir);
      const navCenter = (await hotspotCenters())[0]!;
      const expectedNav = expectedScreen(45, 10, {
        yaw: 30,
        pitch: -15,
        fov: zoomToFov(1.5),
      })!;
      assert.ok(
        Math.abs(navCenter.x - expectedNav.x) < 2 && Math.abs(navCenter.y - expectedNav.y) < 2,
        `scene "a" did not open at its saved default view: got (${navCenter.x}, ${navCenter.y}), expected (${expectedNav.x}, ${expectedNav.y})`,
      );

      // Switching scenes (no hash involved) must apply the target scene's own default view,
      // not the view left behind by the previous scene.
      await page.mouse("mousePressed", navCenter.x, navCenter.y);
      await page.mouse("mouseReleased", navCenter.x, navCenter.y);
      await page.waitFor(`document.documentElement.dataset.scene === "b"`);
      const backCenter = (await hotspotCenters())[0]!;
      const expectedBack = expectedScreen(-30, 0, {
        yaw: -60,
        pitch: 20,
        fov: zoomToFov(1),
      })!;
      assert.ok(
        Math.abs(backCenter.x - expectedBack.x) < 2 && Math.abs(backCenter.y - expectedBack.y) < 2,
        `scene "b" did not open at its saved default view: got (${backCenter.x}, ${backCenter.y}), expected (${expectedBack.x}, ${expectedBack.y})`,
      );
      assert.deepEqual(page.problems, []);
    } finally {
      rmSync(defaultsDir, { recursive: true, force: true });
    }
  },
);

test(
  "info hotspots show markdown as safe HTML: no script runs, no javascript: links",
  { skip },
  async () => {
    await open("#yaw=0&pitch=30&fov=90");
    const pole = (await hotspotCenters())[POLE]!;
    await page.mouse("mousePressed", pole.x, pole.y);
    await page.mouse("mouseReleased", pole.x, pole.y);
    await page.waitFor(`document.getElementById("modal").classList.contains("open")`);
    await snapshot("modal");
    assert.equal(await page.eval(`document.getElementById("modal-title").textContent`), "Notes");
    assert.equal(await page.eval(`document.querySelector("#modal-body h2").textContent`), "Title");
    assert.equal(
      await page.eval(`document.querySelector("#modal-body strong").textContent`),
      "bold",
    );
    assert.equal(await page.eval(`document.querySelectorAll("#modal-body script").length`), 0);
    assert.equal(await page.eval(`window.__pwn`), undefined);
    assert.match(
      await page.eval(`document.getElementById("modal-body").textContent`),
      /<script>window\.__pwn = 1<\/script>/,
    );
    assert.deepEqual(
      await page.eval(
        `[...document.querySelectorAll("#modal-body a")].map(a => [a.getAttribute("href"), a.rel])`,
      ),
      [["https://example.com/x", "noopener noreferrer"]],
    );
    await page.key("Escape");
    await page.waitFor(`!document.getElementById("modal").classList.contains("open")`);
  },
);

const rotationProject: TourProject = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  id: "tour_rotation",
  name: "Rotation Tour",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  initialSceneId: "a",
  theme: { showNavbar: true, showTitleOverlay: true, logoUrl: "" },
  floorplans: [],
  scenes: [
    {
      id: "a",
      name: "Hall",
      panoramaUrl: "tauri:a.jpg",
      defaultZoom: 1,
      defaultYaw: 0,
      defaultPitch: 0,
      hotspots: [
        hs({ id: "tilted", yaw: 20, pitch: 5, rotationX: -80, rotationY: 35, rotationZ: 7 }),
        hs({ id: "flat-info", type: "info", yaw: -20, pitch: 5, rotationX: -80, rotationY: 35 }),
      ],
    },
  ],
};

test(
  "navigation hotspots apply rotationX/Y/Z as a CSS3D tilt; info hotspots ignore it",
  { skip },
  async () => {
    const rotDir = mkdtempSync(join(tmpdir(), "cubemap-rotation-"));
    try {
      await exportCubemapTour(rotationProject, folderSink(rotDir), deps);
      await open("#yaw=0&pitch=0&fov=90", rotDir);
      const transforms = await page.eval<string[]>(
        `[...document.querySelectorAll(".hs")].map(e => e.style.transform)`,
      );
      assert.match(
        transforms[0]!,
        /perspective\(500px\) rotateX\(-80deg\) rotateY\(35deg\) rotateZ\(7deg\)$/,
        "arrow hotspot carries its 3D tilt",
      );
      assert.doesNotMatch(
        transforms[1]!,
        /perspective|rotateX|rotateY|rotateZ/,
        "info hotspots stay flat billboards even if rotation fields are set",
      );
      assert.deepEqual(page.problems, []);
    } finally {
      rmSync(rotDir, { recursive: true, force: true });
    }
  },
);

test(
  "a missing image is reported on screen instead of showing a broken tour",
  { skip },
  async () => {
    const broken = mkdtempSync(join(tmpdir(), "cubemap-broken-"));
    try {
      await exportCubemapTour(project, folderSink(broken), deps);
      rmSync(join(broken, "panoramas", "a", "right.jpg"));
      page.problems.length = 0;
      await open("", broken);
      assert.equal(await page.eval(`document.documentElement.dataset.error`), "1");
      const message = await page.eval<string>(`document.getElementById("error").textContent`);
      assert.match(message, /Hall/);
      assert.match(message, /panoramas folder/);
    } finally {
      rmSync(broken, { recursive: true, force: true });
      page.problems.length = 0;
    }
  },
);

// ─── The real converter (Canvas 2D + JPEG), run inside Chrome ───────────────

/** core.ts + convert.ts as one classic script (types stripped, imports/exports removed). */
function converterBundle(): string {
  const load = (file: string) =>
    stripTypeScriptTypes(readFileSync(new URL(file, import.meta.url), "utf8"))
      .replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "")
      .replace(/^export\s+/gm, "");
  return `(() => {\n${load("./core.ts")}\n${load("./convert.ts")}\nreturn { equirectToCubeFaces, chooseFaceSize, FACE_NAMES };\n})()`;
}

/** Draws a 2:1 panorama with the same colour layout as the procedural one, and returns it as a PNG blob. */
const PANO_IN_PAGE = (width: number) => `(async () => {
  const W = ${width}, H = W / 2;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const fill = (c, x0, x1, y0, y1) => { ctx.fillStyle = c; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); };
  const lon = (deg) => (deg + 180) / 360 * W;
  const lat = (deg) => (90 - deg) / 180 * H;
  fill("rgb(220,30,30)", 0, W, 0, H);
  fill("rgb(30,180,60)", lon(45), lon(135), 0, H);
  fill("rgb(40,60,220)", lon(135), W, 0, H);
  fill("rgb(40,60,220)", 0, lon(-135), 0, H);
  fill("rgb(230,220,40)", lon(-135), lon(-45), 0, H);
  fill("rgb(255,255,255)", 0, W, 0, lat(60));
  fill("rgb(110,110,120)", 0, W, lat(-60), H);
  return await canvas.convertToBlob({ type: "image/png" });
})()`;

test(
  "the real converter turns a 2:1 panorama into six correct JPEG faces (Canvas 2D, in Chrome)",
  { skip },
  async () => {
    await page.goto("about:blank");
    await page.eval(`window.__lib = ${converterBundle()}`);
    const result = await page.eval<{
      size: number;
      types: string[];
      names: string[];
      centres: Record<string, number[]>;
      progress: number[];
      ms: number;
    }>(`(async () => {
    const { equirectToCubeFaces, FACE_NAMES } = window.__lib;
    const source = await ${PANO_IN_PAGE(4096)};
    const progress = [];
    const t0 = performance.now();
    const faces = await equirectToCubeFaces(source, { onProgress: (f) => progress.push(f) });
    const ms = performance.now() - t0;
    const centres = {};
    let size = 0;
    for (const face of faces) {
      const bitmap = await createImageBitmap(face.blob);
      size = bitmap.width;
      const c = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
      c.drawImage(bitmap, 0, 0);
      // Sample slightly off the centre so that seams of the panorama do not matter.
      centres[face.name] = [...c.getImageData(bitmap.width * 0.5, bitmap.height * 0.6, 1, 1).data].slice(0, 3);
      if (bitmap.width !== bitmap.height) throw new Error("face is not square");
    }
    return { size, types: faces.map((f) => f.blob.type), names: faces.map((f) => f.name), centres, progress, ms };
  })()`);

    assert.deepEqual(result.names, [...FACE_NAMES]);
    assert.deepEqual(result.types, Array(6).fill("image/jpeg"));
    assert.equal(result.size, 1280, "4096px wide source -> 1280px faces");
    assertColor(result.centres["front"]!, RED, "front face");
    assertColor(result.centres["right"]!, GREEN, "right face");
    assertColor(result.centres["back"]!, BLUE, "back face");
    assertColor(result.centres["left"]!, YELLOW, "left face");
    assertColor(result.centres["top"]!, WHITE, "top face");
    assertColor(result.centres["bottom"]!, DARK, "bottom face");
    assert.ok(result.progress.length > 6);
    for (let i = 1; i < result.progress.length; i++)
      assert.ok(result.progress[i]! >= result.progress[i - 1]!);
    assert.equal(result.progress[result.progress.length - 1], 1);
    console.log(`converted 4096x2048 -> 6 x ${result.size}px in ${Math.round(result.ms)} ms`);
  },
);

test("the real converter refuses non-2:1 images and honours cancellation", { skip }, async () => {
  await page.goto("about:blank");
  await page.eval(`window.__lib = ${converterBundle()}`);
  const outcome = await page.eval<{
    ratio: string;
    aborted: string;
    garbage: string;
  }>(`(async () => {
    const { equirectToCubeFaces } = window.__lib;
    const attempt = async (blob, options) => {
      try { await equirectToCubeFaces(blob, options); return "no error"; } catch (e) { return e.name + ": " + e.message; }
    };
    const squareCanvas = new OffscreenCanvas(500, 500);
    squareCanvas.getContext("2d");
    const square = await squareCanvas.convertToBlob({ type: "image/png" });
    const controller = new AbortController();
    const pano = await ${PANO_IN_PAGE(2048)};
    const running = attempt(pano, { signal: controller.signal });
    controller.abort();
    return {
      ratio: await attempt(square),
      aborted: await running,
      garbage: await attempt(new Blob(["not an image"])),
    };
  })()`);
  assert.match(outcome.ratio, /must be 2:1/);
  assert.match(outcome.aborted, /^AbortError/);
  assert.match(outcome.garbage, /could not be decoded/);
});
