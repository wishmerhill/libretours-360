import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import type { ThemeOverlayElement, TourProject } from "@/types/tour";
import { CURRENT_SCHEMA_VERSION } from "@/types/tour";
import { viewerHtml3D, writeWeb3DTour } from "./export";

const overlay = (over: Partial<ThemeOverlayElement> = {}): ThemeOverlayElement => ({
  id: "o1",
  type: "text",
  position: "bottom-right",
  offsetX: 10,
  offsetY: 5,
  offsetUnit: "%",
  style: { fontSize: 18, color: "#ff0000" },
  content: "{{scene.title}} / {{project.name}}",
  ...over,
});

const project = (over: Partial<TourProject> = {}): TourProject => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  id: "tour_1",
  name: "My Tour",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  initialSceneId: null,
  scenes: [
    {
      id: "scene_a",
      name: "Hall",
      panoramaUrl: "panoramas/hall.jpg",
      defaultZoom: 1,
      defaultYaw: 0,
      defaultPitch: 0,
      hotspots: [],
      measurements: [],
    },
  ],
  theme: {
    showNavbar: true,
    showTitleOverlay: true,
    logoUrl: "data:image/png;base64,AAAA",
    overlays: [
      overlay(),
      overlay({ id: "o2", type: "image", content: "data:image/png;base64,BBBB" }),
    ],
  },
  floorplans: [],
  showMeasurements: true,
  ...over,
});

/** A tiny stand-in for the DOM: just what the Web 3D viewer script touches. */
class FakeElement {
  id = "";
  className = "";
  textContent = "";
  src = "";
  alt = "";
  style: { bottom?: string; right?: string; fontSize?: string; [key: string]: unknown } = {};
  children: FakeElement[] = [];
  private classes = new Set<string>();
  classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };
  readonly tagName: string;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  set innerHTML(_: string) {
    this.children = [];
  }
  get innerHTML() {
    return this.textContent.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  attributes: Record<string, string> = {};
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  listeners: Record<string, () => void> = {};
  appendChild(child: FakeElement) {
    this.children.push(child);
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners[type] = fn;
  }
}

interface FakeMarker {
  id: string;
  polyline?: [number, number][];
  position?: { yaw: number; pitch: number };
  html?: string;
  style?: Record<string, string>;
}

/** Runs the viewer's module script against FakeElements; Photo Sphere Viewer is stubbed out. */
async function runViewer(html: string) {
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)![1]!;
  const body = script.replace(/^\s*import .*$/gm, "");
  const elements = new Map<string, FakeElement>();
  const document = {
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, Object.assign(new FakeElement("div"), { id }));
      return elements.get(id)!;
    },
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener() {},
  };
  const markers = new Map<string, FakeMarker>();
  const plugin = {
    addEventListener() {},
    clearMarkers: () => markers.clear(),
    addMarker: (m: FakeMarker) => void markers.set(m.id, m),
    getMarkers: () => [...markers.values()],
    removeMarkers: (ids: string[]) => ids.forEach((id) => markers.delete(id)),
  };
  class MarkersPlugin {}
  class Viewer {
    getPlugin = () => plugin;
    // The panorama "loads" at once, so the first scene's markers are added.
    addEventListener(type: string, fn: () => void) {
      if (type === "ready") fn();
    }
  }
  const context = vm.createContext({ document, Viewer, MarkersPlugin, alert() {} });
  await vm.runInContext(`(async () => {${body}})()`, context);
  return Object.assign(elements, { markers });
}

test("Web 3D: the theme is embedded and rendered (logo bar, title, overlays with variables)", async () => {
  const els = await runViewer(viewerHtml3D(project()));

  assert.equal(els.get("logo")!.src, "data:image/png;base64,AAAA");
  assert.ok(els.get("navbar")!.classList.contains("visible"));
  assert.ok(els.get("title")!.classList.contains("visible"));
  assert.ok(els.get("title")!.classList.contains("with-navbar"));
  assert.equal(els.get("title")!.textContent, "Hall");

  const [text, image] = els.get("theme-overlays")!.children;
  assert.equal(text!.textContent, "Hall / My Tour");
  assert.equal(text!.style.bottom, "5%");
  assert.equal(text!.style.right, "10%");
  assert.equal(text!.style.fontSize, "18px");
  assert.equal(image!.tagName, "img");
  assert.equal(image!.src, "data:image/png;base64,BBBB");
});

test("Web 3D: showNavbar / showTitleOverlay turned off hide the logo bar and the title", async () => {
  const els = await runViewer(
    viewerHtml3D(
      project({
        theme: { showNavbar: false, showTitleOverlay: false, logoUrl: "data:x", overlays: [] },
      }),
    ),
  );
  assert.ok(!els.get("navbar")?.classList.contains("visible"));
  assert.ok(!els.get("title")!.classList.contains("visible"));
  assert.equal(els.get("theme-overlays")!.children.length, 0);
});

test("Web 3D: theme text cannot close the inline <script>", () => {
  const html = viewerHtml3D(
    project({
      theme: {
        showNavbar: true,
        showTitleOverlay: true,
        logoUrl: "",
        overlays: [overlay({ content: "</script><script>alert(1)</script>" })],
      },
    }),
  );
  assert.equal(html.match(/<\/script>/g)!.length, 1);
});

const withMeasurements = (over: Partial<TourProject> = {}) => {
  const base = project(over);
  base.scenes[0]!.measurements = [
    { id: "ms_1", a: { yaw: 170, pitch: 0 }, b: { yaw: -170, pitch: 10 }, label: "3,45 m" },
    { id: "ms_2", a: { yaw: 0, pitch: -20 }, b: { yaw: 30, pitch: -20 }, label: "" },
  ];
  return base;
};

test("Web 3D: measurements are drawn as great-circle polylines with labels", async () => {
  const els = await runViewer(viewerHtml3D(withMeasurements()));
  const { markers } = els;

  const line = markers.get("ms-ms_1-line")!;
  assert.equal(line.polyline!.length, 33);
  const [y0, p0] = line.polyline![0]!;
  const [y1, p1] = line.polyline![32]!;
  assert.ok(Math.abs(y0 - (170 * Math.PI) / 180) < 1e-9 && Math.abs(p0) < 1e-9);
  // Yaw is unwrapped across ±180°: the last point is -170° expressed as +190°.
  assert.ok(Math.abs(y1 - (190 * Math.PI) / 180) < 1e-9);
  assert.ok(Math.abs(p1 - (10 * Math.PI) / 180) < 1e-9);

  assert.ok(markers.has("ms-ms_1-halo"));
  assert.ok(markers.has("ms-ms_1-a") && markers.has("ms-ms_1-b"));
  assert.match(markers.get("ms-ms_1-label")!.html!, /3,45 m/);
  // No empty label pill for a measurement without a label.
  assert.ok(markers.has("ms-ms_2-line") && !markers.has("ms-ms_2-label"));
  // Read-only: measurement markers never catch the pointer.
  assert.equal(line.style!["pointerEvents"], "none");

  const toggle = els.get("measure-toggle")!;
  assert.ok(toggle.classList.contains("available"));
  assert.ok(toggle.classList.contains("on"));
});

test("Web 3D: the measurements toggle hides and shows them; showMeasurements sets the start", async () => {
  const els = await runViewer(viewerHtml3D(withMeasurements({ showMeasurements: false })));
  const measureIds = () => [...els.markers.keys()].filter((id) => id.startsWith("ms-"));
  const toggle = els.get("measure-toggle")!;

  assert.equal(measureIds().length, 0);
  assert.ok(!toggle.classList.contains("on"));

  toggle.listeners["click"]!();
  assert.ok(measureIds().length > 0);
  assert.ok(toggle.classList.contains("on"));
  assert.equal(toggle.attributes["aria-pressed"], "true");

  toggle.listeners["click"]!();
  assert.equal(measureIds().length, 0);
});

test("Web 3D: the toggle is not offered in a scene without measurements", async () => {
  const els = await runViewer(viewerHtml3D(project()));
  assert.ok(!els.get("measure-toggle")!.classList.contains("available"));
});

test("Web 3D: measurement labels are escaped and cannot close the inline <script>", async () => {
  const p = withMeasurements();
  p.scenes[0]!.measurements[0]!.label = "</script><img src=x onerror=alert(1)>";
  const html = viewerHtml3D(p);
  assert.equal(html.match(/<\/script>/g)!.length, 1);
  const els = await runViewer(html);
  assert.ok(!els.markers.get("ms-ms_1-label")!.html!.includes("<img"));
});

test("Web 3D export writes index.html through the sink; remote panoramas stay as URLs", async () => {
  const files = new Map<string, Uint8Array | string>();
  const p = project();
  p.scenes[0]!.panoramaUrl = "https://example.com/hall.jpg";
  p.theme = { showNavbar: false, showTitleOverlay: true, logoUrl: "", overlays: [] };
  await writeWeb3DTour(p, { writeFile: async (path, data) => void files.set(path, data) });
  assert.deepEqual([...files.keys()], ["index.html"]);
  assert.match(String(files.get("index.html")), /https:\/\/example\.com\/hall\.jpg/);
});
