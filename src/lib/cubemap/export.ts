/**
 * Export of a project as a standalone CSS cubemap tour.
 *
 *   <folder>/index.html
 *   <folder>/project.json
 *   <folder>/panoramas/<scene>/{front,right,back,left,top,bottom}.jpg
 *   <folder>/thumbnails/<scene>.jpg
 *
 * Scenes are processed one at a time and written as soon as they are ready, so
 * memory stays at one panorama's worth. `index.html` is written last: a folder
 * without it is an interrupted export, never a tour that opens half broken.
 *
 * Everything that touches the outside world (reading the panorama, converting
 * it, writing files) is passed in, which keeps this module testable in Node.
 */
import type { Scene, TourProject } from "@/types/tour";
import { FACE_NAMES } from "./core";
import {
  buildIndexHtml,
  buildProjectJson,
  buildTour,
  facePaths,
  sceneDirName,
  thumbnailPath,
  type ViewerAssets,
} from "./build-html";
import type { CubeFace, ConvertOptions } from "./convert";

/** Destination of the export: a folder on disk, a zip, ... Paths are relative and use "/". */
export interface ExportSink {
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
}

export interface ExportDeps {
  /** The panorama image of a scene. Throws if it cannot be read. */
  getPanorama(scene: Scene): Promise<Blob>;
  convert(source: Blob, options: ConvertOptions): Promise<CubeFace[]>;
  /** Small preview; a failure only means the scene has no thumbnail. */
  makeThumbnail(source: Blob): Promise<Blob>;
  /**
   * The theme logo, resolved to a data: URL ready to embed inline (or "" if
   * there is none). Best-effort: a failure here must not fail the export.
   */
  getLogoDataUrl?(): Promise<string>;
  assets: ViewerAssets;
}

export interface ExportProgress {
  sceneIndex: number;
  sceneCount: number;
  sceneName: string;
  /** Overall completed fraction, 0..1. */
  fraction: number;
}

export interface ExportOptions {
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
  maxFaceSize?: number;
}

export class CubemapExportError extends Error {
  readonly sceneName: string;

  constructor(sceneName: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Scene "${sceneName}": ${reason}`);
    this.name = "CubemapExportError";
    this.sceneName = sceneName;
    this.cause = cause;
  }
}

async function toBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

export async function exportCubemapTour(
  project: TourProject,
  sink: ExportSink,
  deps: ExportDeps,
  options: ExportOptions = {},
): Promise<void> {
  if (project.scenes.length === 0) throw new Error("The project has no scenes to export");
  const { onProgress, signal, maxFaceSize } = options;

  const used = new Set<string>();
  const layout: { sceneId: string; dir: string; hasThumbnail: boolean }[] = [];
  const count = project.scenes.length;

  for (const [index, scene] of project.scenes.entries()) {
    const report = (fraction: number) =>
      onProgress?.({
        sceneIndex: index,
        sceneCount: count,
        sceneName: scene.name,
        fraction: (index + fraction) / count,
      });
    report(0);

    const dir = sceneDirName(scene.id, index, used);
    let hasThumbnail = false;
    try {
      const source = await deps.getPanorama(scene);
      const faces = await deps.convert(source, {
        ...(maxFaceSize !== undefined && { maxFaceSize }),
        ...(signal && { signal }),
        // Thumbnail and writing take the last 5% of the scene.
        onProgress: (f) => report(f * 0.95),
      });

      const paths = facePaths(dir);
      for (const [i, name] of FACE_NAMES.entries()) {
        const face = faces.find((f) => f.name === name);
        if (!face) throw new Error(`The converter did not produce the "${name}" face`);
        await sink.writeFile(paths[i]!, await toBytes(face.blob));
      }

      try {
        await sink.writeFile(thumbnailPath(dir), await toBytes(await deps.makeThumbnail(source)));
        hasThumbnail = true;
      } catch (e) {
        console.warn(`[export] No thumbnail for "${scene.name}":`, e);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      throw new CubemapExportError(scene.name, e);
    }
    layout.push({ sceneId: scene.id, dir, hasThumbnail });
    report(1);
  }

  let logoDataUrl = "";
  if (deps.getLogoDataUrl) {
    try {
      logoDataUrl = await deps.getLogoDataUrl();
    } catch (e) {
      console.warn("[export] Could not embed the theme logo:", e);
    }
  }

  const tour = buildTour(project, layout, logoDataUrl);
  await sink.writeFile("project.json", buildProjectJson(tour));
  await sink.writeFile("index.html", buildIndexHtml(tour, deps.assets));
}
