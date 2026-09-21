/**
 * Importing panoramas into a project.
 *
 *  - Tauri, native dialog (`pickPanoramaPaths` + `importPanoramaPaths`): the user
 *    picks files with the OS dialog, which grants access to exactly those files;
 *    each one is copied with a native `copyFile` straight into the project's
 *    panoramas folder, so the image never travels through the WebView's memory.
 *  - Drag & drop and the browser (`importPanoramaFiles`): File objects are read
 *    into memory and stored through `putBlob` (IPC in Tauri, IndexedDB in browser).
 *
 * In Tauri a JPEG thumbnail is generated for every imported panorama. A failed
 * thumbnail never fails the import; it is reported in the result instead.
 */
import { uid } from "@/types/tour";
import { isTauri } from "./environment";
import { deleteBlobs, putBlob } from "./idb";
import { classifyFsError } from "./storage-errors";
import {
  copyPanoramaFromPath,
  makeTauriRef,
  parseTauriRef,
  readPanoramaAsset,
  writeThumbnail,
} from "./tauri-storage";
import { generateThumbnail } from "./thumbnails";

export const PANORAMA_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
const UNSUPPORTED_MESSAGE = "Only JPG, PNG or WebP panoramas are supported.";

export interface ImportedPanorama {
  /** Reference to store in Scene.panoramaUrl ("tauri:<key>" or "idb:<key>"). */
  ref: string;
  /** Suggested scene name (file name without extension). */
  name: string;
  /** True if the panorama was imported but its dashboard thumbnail could not be made. */
  thumbnailFailed: boolean;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function extensionOf(fileName: string): string | null {
  const ext = fileName.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
  return ext && PANORAMA_EXTENSIONS.includes(ext) ? ext : null;
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

/** Generates and stores the thumbnail of a "tauri:" panorama; false on failure. */
async function makeThumbnail(projectId: string, ref: string, source: Blob): Promise<boolean> {
  const key = parseTauriRef(ref);
  if (!key) return true; // browser mode: no thumbnails
  try {
    await writeThumbnail(projectId, key, await generateThumbnail(source));
    return true;
  } catch (e) {
    console.warn(`[storage] Could not create a thumbnail for ${ref}:`, e);
    return false;
  }
}

async function rollback(projectId: string, refs: string[]) {
  await deleteBlobs(projectId, refs).catch((e) =>
    console.warn("[storage] Could not remove partially imported panoramas:", e),
  );
}

/**
 * Opens the native file dialog. Returns the chosen paths, or null if the user
 * cancelled. Only meaningful in Tauri.
 */
export async function pickPanoramaPaths(): Promise<string[] | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  try {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: "360° panoramas", extensions: PANORAMA_EXTENSIONS }],
    });
    if (!selected) return null;
    return Array.isArray(selected) ? selected : [selected];
  } catch (e) {
    throw classifyFsError(e);
  }
}

/**
 * Imports panoramas chosen with the native dialog by copying the files natively.
 * All-or-nothing: if one file fails, the ones already copied are removed.
 */
export async function importPanoramaPaths(
  projectId: string,
  paths: string[],
): Promise<ImportedPanorama[]> {
  const supported = paths.filter((p) => extensionOf(baseName(p)));
  if (!supported.length) throw new Error(UNSUPPORTED_MESSAGE);

  const imported: ImportedPanorama[] = [];
  try {
    for (const path of supported) {
      const fileName = baseName(path);
      const ext = extensionOf(fileName)!.replace("jpeg", "jpg");
      const key = `${uid("pano")}.${ext}`;
      const ref = makeTauriRef(key);

      await copyPanoramaFromPath(projectId, path, key);
      imported.push({ ref, name: stripExtension(fileName), thumbnailFailed: true });

      // Thumbnails are best-effort: read the copy back and downscale it.
      const copy = await readPanoramaAsset(projectId, key).catch(() => null);
      imported[imported.length - 1]!.thumbnailFailed = !(
        copy && (await makeThumbnail(projectId, ref, copy))
      );
    }
  } catch (e) {
    await rollback(
      projectId,
      imported.map((i) => i.ref),
    );
    throw e;
  }
  return imported;
}

/**
 * Imports File objects (drag & drop, browser file input). Files are read into
 * memory, so in Tauri prefer the native dialog for large panoramas.
 * All-or-nothing, like importPanoramaPaths.
 */
export async function importPanoramaFiles(
  projectId: string,
  files: File[],
): Promise<ImportedPanorama[]> {
  const imported: ImportedPanorama[] = [];
  try {
    for (const file of files) {
      const ref = await putBlob(projectId, uid("pano"), file);
      const ok = isTauri() ? await makeThumbnail(projectId, ref, file) : true;
      imported.push({ ref, name: stripExtension(file.name), thumbnailFailed: !ok });
    }
  } catch (e) {
    await rollback(
      projectId,
      imported.map((i) => i.ref),
    );
    throw e;
  }
  return imported;
}
