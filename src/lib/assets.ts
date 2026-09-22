/**
 * Panorama assets of a project.
 *
 * Panoramas live in their project's own folder (`projects/<id>/panoramas/`), in
 * the desktop app as files and in the browser as records of the same path in
 * IndexedDB; the storage driver hides the difference. Scenes store a
 * "tauri:<key>" reference (see storage-layout.ts) whose key is relative to that
 * folder, so every function takes the id of the project that owns the asset.
 *
 * Nothing here knows which driver is in use.
 */
import { StorageError } from "./storage-errors";
import { getStorageProvider } from "./storage-provider";
import { makeAssetRef, parseAssetRef } from "./storage-layout";

export { isLocalAssetRef } from "./storage-layout";

/**
 * Stores a panorama Blob in the project and returns the reference to put in
 * Scene.panoramaUrl. An image extension is appended to the key when it has none.
 */
export async function putBlob(projectId: string, key: string, blob: Blob): Promise<string> {
  return makeAssetRef(await getStorageProvider().writePanorama(projectId, key, blob));
}

/** Retrieves a Blob by its reference. Returns null if it is not a local reference or does not exist. */
export async function getBlob(projectId: string, ref: string): Promise<Blob | null> {
  const key = parseAssetRef(ref);
  return key ? await getStorageProvider().readPanorama(projectId, key) : null;
}

/** Deletes a stored panorama and its thumbnail by its reference string. Other references are ignored. */
export async function deleteBlob(projectId: string, ref: string) {
  const key = parseAssetRef(ref);
  if (key) await getStorageProvider().deletePanorama(projectId, key);
}

/**
 * Deletes several assets, trying all of them even if some fail; throws a single
 * error naming the failures afterwards.
 */
export async function deleteBlobs(projectId: string, refs: string[]): Promise<void> {
  const failures: unknown[] = [];
  for (const ref of refs) {
    try {
      await deleteBlob(projectId, ref);
    } catch (e) {
      failures.push(e);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new StorageError("IoError", `${failures.length} image files could not be deleted`, {
      cause: failures[0],
    });
  }
}

/**
 * Resolves a panoramaUrl (http, data, or a local "tauri:<key>" reference) of a
 * project into something an <img> tag / Photo Sphere Viewer can load.
 *
 * - local references: whatever the driver serves (an asset URL or an object URL);
 *   "" if the file is missing;
 * - http(s) / data URLs: passed through unchanged.
 */
export async function resolveUrl(projectId: string, ref: string): Promise<string> {
  if (!ref) return "";
  if (ref.startsWith("http://") || ref.startsWith("https://") || ref.startsWith("data:"))
    return ref;

  const key = parseAssetRef(ref);
  if (key) return await getStorageProvider().panoramaUrl(projectId, key);

  // "idb:<key>" of a version that predates the per-project layout is moved by the
  // browser driver at start-up; one still here points to nothing.
  if (ref.startsWith("idb:")) return "";

  // Unknown/other — pass through as-is
  return ref;
}

/**
 * URL of the small preview of a panorama, for the dashboard.
 *
 * - local references: the thumbnail generated at import time, or "" when there
 *   is none (the full-size image is deliberately NOT used as a fallback);
 * - everything else (external URLs): same as resolveUrl.
 */
export async function resolveThumbnailUrl(projectId: string, ref: string): Promise<string> {
  const key = parseAssetRef(ref);
  if (key) return await getStorageProvider().thumbnailUrl(projectId, key);
  return await resolveUrl(projectId, ref);
}
