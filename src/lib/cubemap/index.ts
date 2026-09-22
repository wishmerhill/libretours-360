/**
 * Entry point used by the editor: "Standalone 3D (CSS Cubemap)" export.
 * Wires the platform pieces (panorama storage, canvas converter, native or zip
 * destination) into the platform-independent exporter.
 */
import type { Scene, TourProject } from "@/types/tour";
import { getBlob, isLocalAssetRef } from "../assets";
import { blobToDataUrl, getThemeAsset, isGenericAssetRef } from "../theme-assets";
import { generateThumbnail } from "../thumbnails";
import viewerCss from "./viewer/viewer.css?raw";
import viewerJs from "./viewer/viewer.js?raw";
import { slugify } from "./build-html";
import { equirectToCubeFaces } from "./convert";
import { exportCubemapTour, type ExportDeps, type ExportProgress } from "./export";
import { openExportSink } from "./sinks";

export { CubemapExportError, type ExportProgress } from "./export";

export type CubemapExportResult =
  { status: "cancelled" } | { status: "done"; location: string; indexPath?: string };

/** Reads the image behind a scene: local storage refs, or a URL (which must allow CORS). */
async function getPanorama(projectId: string, scene: Scene): Promise<Blob> {
  const url = scene.panoramaUrl;
  if (!url) throw new Error("the scene has no panorama image");
  if (isLocalAssetRef(url)) {
    const blob = await getBlob(projectId, url);
    if (!blob) throw new Error("the panorama file is missing from the project");
    return blob;
  }
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error("the panorama could not be downloaded (offline, or the server blocks it)");
  }
  if (!response.ok)
    throw new Error(`the panorama could not be downloaded (HTTP ${response.status})`);
  return await response.blob();
}

/**
 * Resolves the theme logo (a data: URL, or a local "asset:<key>" reference) to
 * a data: URL that can be embedded inline in the standalone export. Best-effort:
 * a missing or unreadable logo simply means no logo in the exported tour.
 */
async function getLogoDataUrl(projectId: string, logoUrl: string): Promise<string> {
  if (!logoUrl) return "";
  if (logoUrl.startsWith("data:")) return logoUrl;

  let blob: Blob | null = null;
  if (isGenericAssetRef(logoUrl)) {
    blob = await getThemeAsset(projectId, logoUrl);
  } else if (logoUrl.startsWith("http://") || logoUrl.startsWith("https://")) {
    // Logo saved by an earlier version, before inline assets existed.
    try {
      const response = await fetch(logoUrl);
      if (response.ok) blob = await response.blob();
    } catch {
      blob = null;
    }
  }
  return blob ? await blobToDataUrl(blob) : "";
}

/**
 * Asks where to save, then converts every panorama to cube faces and writes the
 * standalone tour. Resolves with `cancelled` if the user dismisses the dialog.
 */
export async function exportCubemapStandalone(
  project: TourProject,
  options: { onProgress?: (progress: ExportProgress) => void; signal?: AbortSignal } = {},
): Promise<CubemapExportResult> {
  const sink = await openExportSink(`${slugify(project.name)}-tour-3d-cubemap`);
  if (!sink) return { status: "cancelled" };

  const deps: ExportDeps = {
    getPanorama: (scene) => getPanorama(project.id, scene),
    convert: equirectToCubeFaces,
    makeThumbnail: generateThumbnail,
    getLogoDataUrl: () => getLogoDataUrl(project.id, project.theme.logoUrl),
    assets: { js: viewerJs, css: viewerCss },
  };
  await exportCubemapTour(project, sink, deps, options);
  await sink.finish();
  return {
    status: "done",
    location: sink.location,
    ...(sink.indexPath && { indexPath: sink.indexPath }),
  };
}
