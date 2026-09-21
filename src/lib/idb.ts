/**
 * Local panorama asset storage.
 *
 * In Tauri mode, panoramas live on the file system inside their project's own
 * folder ($APPDATA/projects/<id>/panoramas/); every function takes the id of the
 * project that owns the asset. In browser mode, panorama blobs are stored in
 * IndexedDB (a single global store, so the project id is not part of the key).
 *
 * Panorama images are far too large for localStorage, so scenes store an
 * "idb:<key>" or "tauri:<key>" reference and the actual data lives here.
 */
import { isTauri } from "./environment";
import {
  writePanoramaAsset,
  readPanoramaAsset,
  deletePanoramaAsset,
  resolveTauriRef,
  resolveTauriThumbnailRef,
  makeTauriRef,
  parseTauriRef,
  TAURI_PREFIX,
} from "./tauri-storage";
import { StorageError } from "./storage-errors";

const DB_NAME = "opentour-assets";
const STORE = "panoramas";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = fn(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

export const IDB_PREFIX = "idb:";

/**
 * Store a panorama Blob for a project.
 *
 * In Tauri mode: writes to $APPDATA/projects/<id>/panoramas/ and returns a "tauri:<key>" ref.
 * In browser mode: writes to IndexedDB and returns an "idb:<key>" ref.
 */
export async function putBlob(projectId: string, key: string, blob: Blob): Promise<string> {
  if (isTauri()) {
    // writePanoramaAsset returns the key with the extension appended
    const keyWithExt = await writePanoramaAsset(projectId, key, blob);
    return makeTauriRef(keyWithExt);
  }

  // Browser fallback: IndexedDB
  await tx("readwrite", (s) => s.put(blob, key) as IDBRequest<IDBValidKey>);
  return IDB_PREFIX + key;
}

/**
 * Retrieve a Blob by its reference string (supports both "idb:" and "tauri:" prefixes).
 * Returns null if the asset does not exist.
 */
export async function getBlob(projectId: string, ref: string): Promise<Blob | null> {
  // Tauri ref
  if (ref.startsWith(TAURI_PREFIX)) {
    const key = parseTauriRef(ref);
    if (!key) return null;
    return await readPanoramaAsset(projectId, key);
  }

  // IndexedDB ref
  if (ref.startsWith(IDB_PREFIX)) {
    const res = await tx<Blob | undefined>("readonly", (s) => s.get(ref.slice(IDB_PREFIX.length)));
    return res ?? null;
  }

  return null;
}

/**
 * Delete a stored blob (and, in Tauri mode, its thumbnail) by its reference string.
 */
export async function deleteBlob(projectId: string, ref: string) {
  // Tauri ref
  if (ref.startsWith(TAURI_PREFIX)) {
    const key = parseTauriRef(ref);
    if (key) await deletePanoramaAsset(projectId, key);
    return;
  }

  // IndexedDB ref
  if (ref.startsWith(IDB_PREFIX)) {
    await tx(
      "readwrite",
      (s) => s.delete(ref.slice(IDB_PREFIX.length)) as unknown as IDBRequest<undefined>,
    );
  }
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
 * Browser mode only: copies an IndexedDB blob under a new key (used when
 * duplicating a project, since all blobs share one global store).
 * Returns the new ref, the same ref for anything that is not an "idb:" ref (nothing
 * to copy), or null if the source blob is missing.
 */
export async function cloneBlob(ref: string, key: string): Promise<string | null> {
  if (!ref.startsWith(IDB_PREFIX)) return ref;
  const res = await tx<Blob | undefined>("readonly", (s) => s.get(ref.slice(IDB_PREFIX.length)));
  if (!res) return null;
  await tx("readwrite", (s) => s.put(res, key) as IDBRequest<IDBValidKey>);
  return IDB_PREFIX + key;
}

const urlCache = new Map<string, string>();

/**
 * Resolves a panoramaUrl (http, data, idb:<key>, or tauri:<key>) of a project into
 * something an <img> tag / Photo Sphere Viewer can load.
 *
 * - For "idb:" refs: creates an object URL from the IndexedDB blob (cached).
 * - For "tauri:" refs: resolves to a convertFileSrc() URL ("" if the file is missing).
 * - For http(s) / data URLs: passes through unchanged.
 */
export async function resolveUrl(projectId: string, ref: string): Promise<string> {
  if (!ref) return "";
  if (ref.startsWith("http://") || ref.startsWith("https://") || ref.startsWith("data:"))
    return ref;

  // Tauri ref: resolve via convertFileSrc
  if (ref.startsWith(TAURI_PREFIX)) {
    return await resolveTauriRef(projectId, ref);
  }

  // IndexedDB ref
  if (ref.startsWith(IDB_PREFIX)) {
    const cached = urlCache.get(ref);
    if (cached) return cached;
    const blob = await getBlob(projectId, ref);
    if (!blob) return "";
    const url = URL.createObjectURL(blob);
    urlCache.set(ref, url);
    return url;
  }

  // Unknown/other — pass through as-is
  return ref;
}

/**
 * URL of the small preview of a panorama, for the dashboard.
 *
 * - "tauri:" refs: the thumbnail generated at import time, or "" when there is
 *   none (the full-size image is deliberately NOT used as a fallback).
 * - everything else (browser mode, external URLs): same as resolveUrl.
 */
export async function resolveThumbnailUrl(projectId: string, ref: string): Promise<string> {
  if (ref.startsWith(TAURI_PREFIX)) return await resolveTauriThumbnailRef(projectId, ref);
  return await resolveUrl(projectId, ref);
}
