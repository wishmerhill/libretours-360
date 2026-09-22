/**
 * Builds the files of a standalone CSS cubemap tour: `index.html` (viewer +
 * tour data inline, so it needs no fetch and works from file://) and
 * `project.json` (the same data, clean relative paths, for other tools).
 *
 * Pure string work: no DOM, no Tauri, so it can be tested in Node.
 */
import type { Hotspot, TourProject } from "@/types/tour";
import { FACE_NAMES } from "./core";

export const FACE_EXTENSION = "jpg";

export interface CubemapTourScene {
  id: string;
  name: string;
  /** Six relative URLs, in FACE_NAMES order. */
  faces: string[];
  /** Relative URL of a small preview, or null. */
  thumbnail: string | null;
  defaultZoom: number;
  defaultYaw: number;
  defaultPitch: number;
  hotspots: Hotspot[];
}

export interface CubemapTour {
  format: "openstudio-cubemap-tour";
  version: 1;
  name: string;
  initialSceneId: string | null;
  theme: {
    showTitleOverlay: boolean;
    showNavbar: boolean;
    /** A data: URL, or "" if there is no logo. Never a remote URL: the tour must not depend on the network. */
    logoUrl: string;
  };
  scenes: CubemapTourScene[];
}

/** File name (without extension) used for a scene's folder, unique inside the export. */
export function sceneDirName(id: string, index: number, used: Set<string>): string {
  const base = id.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  let name = base || `scene-${index + 1}`;
  // Windows and macOS file systems are case-insensitive by default.
  if (used.has(name.toLowerCase())) name = `${name}-${index + 1}`;
  used.add(name.toLowerCase());
  return name;
}

/** Relative paths (inside the export folder) of the six faces of a scene. */
export function facePaths(dir: string): string[] {
  return FACE_NAMES.map((face) => `panoramas/${dir}/${face}.${FACE_EXTENSION}`);
}

export function thumbnailPath(dir: string): string {
  return `thumbnails/${dir}.jpg`;
}

/** Same as the editor uses: file-name-safe, lowercase slug of the project name. */
export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "tour"
  );
}

export function buildTour(
  project: TourProject,
  layout: { sceneId: string; dir: string; hasThumbnail: boolean }[],
  /** Theme logo, already resolved to a data: URL (or "" if there is none). */
  logoDataUrl = "",
): CubemapTour {
  const byId = new Map(layout.map((entry) => [entry.sceneId, entry]));
  return {
    format: "openstudio-cubemap-tour",
    version: 1,
    name: project.name,
    initialSceneId: project.initialSceneId,
    theme: {
      showTitleOverlay: project.theme.showTitleOverlay,
      showNavbar: project.theme.showNavbar,
      logoUrl: logoDataUrl,
    },
    scenes: project.scenes.map((scene) => {
      const entry = byId.get(scene.id);
      if (!entry) throw new Error(`Scene "${scene.name}" is missing from the export layout`);
      return {
        id: scene.id,
        name: scene.name,
        faces: facePaths(entry.dir).map((path) => `./${path}`),
        thumbnail: entry.hasThumbnail ? `./${thumbnailPath(entry.dir)}` : null,
        defaultZoom: scene.defaultZoom,
        defaultYaw: scene.defaultYaw,
        defaultPitch: scene.defaultPitch,
        hotspots: scene.hotspots,
      };
    }),
  };
}

export function buildProjectJson(tour: CubemapTour): string {
  return JSON.stringify(tour, null, 2);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JSON that can sit inside a <script>: `<` (so `</script>` and `<!--`) and line separators are escaped. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export interface ViewerAssets {
  js: string;
  css: string;
}

export function buildIndexHtml(tour: CubemapTour, assets: ViewerAssets): string {
  const title = escapeHtml(tour.name);
  // The viewer source must not be able to close its own <script>.
  const js = assets.js.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<style>
${assets.css}
</style>
</head>
<body>
<div id="stage"><div id="world"></div></div>
<div id="hotspots"></div>
<div id="navbar"><img id="logo" alt=""></div>
<div id="title"></div>
<div id="controls"><button id="fullscreen" type="button" aria-label="Fullscreen">&#x26F6;</button></div>
<div id="scene-list"></div>
<div id="loader"></div>
<div id="error" role="alert"></div>
<div id="modal" role="dialog" aria-modal="true">
<div id="modal-box">
<div id="modal-header"><span id="modal-title"></span><button id="modal-close" type="button" aria-label="Close">&times;</button></div>
<div id="modal-body"></div>
</div>
</div>
<noscript>This tour needs JavaScript. / Questo tour richiede JavaScript.</noscript>
<script>window.TOUR = ${jsonForScript(tour)};</script>
<script>
${js}
</script>
</body>
</html>
`;
}
