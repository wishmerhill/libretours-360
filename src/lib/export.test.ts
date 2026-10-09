import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import type { ThemeOverlayElement, TourProject } from "@/types/tour";
import { CURRENT_SCHEMA_VERSION } from "@/types/tour";
import { viewerHtml3D } from "./export";

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
  appendChild(child: FakeElement) {
    this.children.push(child);
  }
  addEventListener() {}
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
  class MarkersPlugin {}
  class Viewer {
    getPlugin = () => ({ addEventListener() {}, clearMarkers() {}, addMarker() {} });
    addEventListener() {}
  }
  const context = vm.createContext({ document, Viewer, MarkersPlugin, alert() {} });
  await vm.runInContext(`(async () => {${body}})()`, context);
  return elements;
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
