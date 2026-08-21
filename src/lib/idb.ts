/**
 * Local panorama asset storage.
 *
 * In browser mode, uses IndexedDB to store large panorama blobs.
 * In Tauri mode, uses the filesystem ($APPDATA/panoramas/).
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
  makeTauriRef,
  parseTauriRef,
  TAURI_PREFIX,
} from "./tauri-storage";

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
 * Store a panorama Blob.
 *
 * In Tauri mode: writes to $APPDATA/panoramas/ and returns a "tauri:<key>" ref.
 * In browser mode: writes to IndexedDB and returns an "idb:<key>" ref.
 */
export async function putBlob(key: string, blob: Blob): Promise<string> {
  if (isTauri()) {
    // writePanoramaAsset returns the key with the extension appended
    const keyWithExt = await writePanoramaAsset(key, blob);
    return makeTauriRef(keyWithExt);
  }

  // Browser fallback: IndexedDB
  await tx("readwrite", (s) => s.put(blob, key) as IDBRequest<IDBValidKey>);
  return IDB_PREFIX + key;
}

/**
 * Retrieve a Blob by its reference string (supports both "idb:" and "tauri:" prefixes).
 */
export async function getBlob(ref: string): Promise<Blob | null> {
  // Tauri ref
  if (ref.startsWith(TAURI_PREFIX)) {
    const key = parseTauriRef(ref);
    if (!key) return null;
    return await readPanoramaAsset(key);
  }

  // IndexedDB ref
  if (ref.startsWith(IDB_PREFIX)) {
    const res = await tx<Blob | undefined>("readonly", (s) => s.get(ref.slice(IDB_PREFIX.length)));
    return res ?? null;
  }

  return null;
}

/**
 * Delete a stored blob by its reference string.
 */
export async function deleteBlob(ref: string) {
  // Tauri ref
  if (ref.startsWith(TAURI_PREFIX)) {
    const key = parseTauriRef(ref);
    if (key) await deletePanoramaAsset(key);
    return;
  }

  // IndexedDB ref
  if (ref.startsWith(IDB_PREFIX)) {
    await tx("readwrite", (s) => s.delete(ref.slice(IDB_PREFIX.length)) as unknown as IDBRequest<undefined>);
  }
}

const urlCache = new Map<string, string>();

/**
 * Resolves a panoramaUrl (http, data, idb:<key>, or tauri:<key>) into
 * something an <img> tag / Photo Sphere Viewer can load.
 *
 * - For "idb:" refs: creates an object URL from the IndexedDB blob (cached).
 * - For "tauri:" refs: resolves to a convertFileSrc() URL.
 * - For http(s) / data URLs: passes through unchanged.
 */
export async function resolveUrl(ref: string): Promise<string> {
  if (!ref) return "";
  if (ref.startsWith("http://") || ref.startsWith("https://") || ref.startsWith("data:")) return ref;

  // Tauri ref: resolve via convertFileSrc
  if (ref.startsWith(TAURI_PREFIX)) {
    return await resolveTauriRef(ref);
  }

  // IndexedDB ref
  if (ref.startsWith(IDB_PREFIX)) {
    const cached = urlCache.get(ref);
    if (cached) return cached;
    const blob = await getBlob(ref);
    if (!blob) return "";
    const url = URL.createObjectURL(blob);
    urlCache.set(ref, url);
    return url;
  }

  // Unknown/other — pass through as-is
  return ref;
}