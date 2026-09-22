/**
 * Browser storage driver (web app / Docker).
 *
 * It mirrors the desktop file tree exactly. Every "file" is one record of a
 * single IndexedDB object store, and its key is the path it would have on disk:
 *
 *   projects/<id>/project.json          (+ project.json.bak)
 *   projects/<id>/panoramas/<key>       Blob
 *   projects/<id>/thumbnails/<key>.jpg  Blob
 *   projects/_corrupt/...               quarantined corrupted projects
 *
 * Why IndexedDB and not the Origin Private File System: OPFS would give a real
 * directory tree, but writing to it from the main thread (createWritable) is not
 * available in Safari, while IndexedDB works in every browser. What OPFS cannot
 * do at all is a transaction across several files; IndexedDB can, and the
 * operations below rely on it:
 *  - saving project.json and refreshing its backup is ONE transaction, so there
 *    is no moment where a crash leaves a half-written project (the file system
 *    driver needs a tmp file + rename for the same guarantee);
 *  - deleting, duplicating and quarantining a project touch all of its records
 *    in one transaction, so they either happen completely or not at all (no
 *    staging folder needed).
 *
 * Only what is specific to a browser lives here. Validation, backup recovery
 * and the quarantine policy are shared with the desktop app (see storage.ts).
 */
import { createKeyedQueue } from "./keyed-queue";
import { isSafeProjectId } from "./safe-key";
import { StorageError, reportStorageIssue } from "./storage-errors";
import {
  BACKUP_SUFFIX,
  DIR_ASSETS,
  DIR_CORRUPT,
  DIR_PANORAMAS,
  DIR_PROJECTS,
  DIR_THUMBNAILS,
  PROJECT_FILE,
  assertSafeKey,
  quarantineStamp,
  thumbnailKeyFor,
  withImageExtension,
} from "./storage-layout";
import type { StorageProvider } from "./storage-provider";
import { generateThumbnail as defaultGenerateThumbnail } from "./thumbnails";
import { migrateLegacyBrowserData } from "./web-legacy-migration";

const DB_NAME = "opentour-fs";
const STORE = "files";

// ─── Paths ─────────────────────────────────────────────────────────────────

const projectPrefix = (id: string) => `${DIR_PROJECTS}/${id}/`;
const projectFilePath = (id: string) => projectPrefix(id) + PROJECT_FILE;
const panoramaPath = (id: string, key: string) => `${projectPrefix(id)}${DIR_PANORAMAS}/${key}`;
const thumbnailPath = (id: string, panoramaKey: string) =>
  `${projectPrefix(id)}${DIR_THUMBNAILS}/${thumbnailKeyFor(panoramaKey)}`;
const assetPath = (id: string, key: string) => `${projectPrefix(id)}${DIR_ASSETS}/${key}`;

/**
 * All records under a "folder" prefix ending in "/": from the prefix itself up
 * to, but excluding, the same text with "/" replaced by "0" (the next character
 * in code point order).
 */
function folderRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, prefix.slice(0, -1) + "0", false, true);
}

/** Files of a project that are not copied to a duplicate (the new project.json is written instead). */
const NOT_COPIED = new Set([PROJECT_FILE, PROJECT_FILE + BACKUP_SUFFIX]);

// ─── Errors ────────────────────────────────────────────────────────────────

/** Turns anything IndexedDB throws into a typed StorageError. */
export function classifyIdbError(e: unknown, path?: string): StorageError {
  if (e instanceof StorageError) return e;
  const name = e instanceof Error || e instanceof DOMException ? e.name : "";
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);

  if (name === "QuotaExceededError") {
    return new StorageError("IoError", "Browser storage is full", { path, cause: e });
  }
  if (name === "SecurityError" || name === "NotAllowedError") {
    return new StorageError("PermissionDenied", `Browser storage is not accessible: ${text}`, {
      path,
      cause: e,
    });
  }
  return new StorageError("IoError", `Browser storage error${path ? ` on ${path}` : ""}: ${text}`, {
    path,
    cause: e,
  });
}

// ─── IndexedDB plumbing ────────────────────────────────────────────────────

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Low-level access for the legacy-data migration, which runs before the provider is "ready". */
export interface WebFs {
  has(path: string): Promise<boolean>;
  put(path: string, value: string | Blob): Promise<void>;
  get(path: string): Promise<unknown>;
}

export interface WebStorageOptions {
  /** IndexedDB database name (tests use a different one for each case). */
  dbName?: string;
  /** Downscales a panorama into a thumbnail. Only the migration of old data needs it here. */
  generateThumbnail?: (source: Blob) => Promise<Blob>;
  /** Move data saved by earlier versions (localStorage + IndexedDB blobs) into the tree. Default true. */
  migrateLegacy?: boolean;
}

/**
 * Creates a browser storage driver. The app uses the shared `webProvider`; the
 * factory exists so tests can have an isolated database each.
 */
export function createWebStorage(options: WebStorageOptions = {}): StorageProvider {
  const dbName = options.dbName ?? DB_NAME;
  const makeThumbnail = options.generateThumbnail ?? defaultGenerateThumbnail;
  const enqueue = createKeyedQueue();

  // ── Database connection ──
  let dbPromise: Promise<IDBDatabase> | null = null;

  function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new StorageError("IoError", "This browser does not support IndexedDB"));
        return;
      }
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(dbName, 1);
      } catch (e) {
        reject(classifyIdbError(e));
        return;
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgrades the database, or the browser drops the connection: reconnect next time.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(classifyIdbError(req.error));
    });
  }

  function getDb(): Promise<IDBDatabase> {
    dbPromise ??= openDb().catch((e) => {
      dbPromise = null;
      throw e;
    });
    return dbPromise;
  }

  /**
   * Runs `fn` in ONE transaction. If `fn` throws, or any request fails, nothing
   * is written. `fn` may only await IndexedDB requests (a transaction commits
   * as soon as it has nothing pending).
   */
  async function transact<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    let tx: IDBTransaction;
    try {
      tx = (await getDb()).transaction(STORE, mode);
    } catch (e) {
      throw classifyIdbError(e);
    }
    const finished = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(tx.error ?? new DOMException("The transaction was aborted", "AbortError"));
    });
    finished.catch(() => {}); // reported through the throw below, never as an unhandled rejection

    let result: T;
    try {
      result = await fn(tx.objectStore(STORE));
    } catch (e) {
      try {
        tx.abort();
      } catch {
        // already finished
      }
      throw classifyIdbError(e);
    }
    try {
      await finished;
    } catch (e) {
      throw classifyIdbError(e);
    }
    return result;
  }

  const rawFs: WebFs = {
    has: (path) => transact("readonly", async (s) => (await request(s.count(path))) > 0),
    get: (path) => transact("readonly", (s) => request(s.get(path))),
    put: (path, value) =>
      transact("readwrite", async (s) => {
        s.put(value, path);
      }),
  };

  // ── Start-up: open the database, bring old data across ──
  let initPromise: Promise<void> | null = null;

  async function runInit(): Promise<void> {
    await getDb(); // fails early (and clearly) when IndexedDB is unavailable
    if (options.migrateLegacy === false) return;
    try {
      await migrateLegacyBrowserData(rawFs, { generateThumbnail: makeThumbnail });
    } catch (e) {
      // Old data stays where it is and is retried at the next start; the app keeps working.
      reportStorageIssue({
        level: "error",
        id: "legacy-migration",
        title: "Projects saved by an earlier version could not be moved yet",
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Every operation waits for this, so nothing reads the tree before the migration is done. */
  function ready(): Promise<void> {
    initPromise ??= runInit().catch((e) => {
      initPromise = null;
      throw e;
    });
    return initPromise;
  }

  // ── Object URLs of blobs (browsers cannot load an IndexedDB record directly) ──
  const objectUrls = new Map<string, string>();

  function forgetUrls(startsWith: string) {
    for (const [path, url] of objectUrls) {
      if (path.startsWith(startsWith)) {
        URL.revokeObjectURL(url);
        objectUrls.delete(path);
      }
    }
  }

  async function urlOf(path: string, what: string): Promise<string> {
    try {
      await ready();
      const cached = objectUrls.get(path);
      if (cached) return cached;
      const blob = await transact("readonly", (s) => request(s.get(path)));
      if (!(blob instanceof Blob)) {
        console.warn(`[storage] ${what} is missing: ${path}`);
        return "";
      }
      const url = URL.createObjectURL(blob);
      objectUrls.set(path, url);
      return url;
    } catch (e) {
      console.error(`[storage] Cannot resolve ${what} ${path}:`, e);
      return "";
    }
  }

  // ── Moving records ──

  /** Moves every record under `from` (a folder prefix) to the same relative path under `to`. */
  async function moveFolder(store: IDBObjectStore, from: string, to: string): Promise<boolean> {
    const range = folderRange(from);
    const keys = await request(store.getAllKeys(range));
    if (!keys.length) return false;
    const values = await request(store.getAll(range));
    keys.forEach((key, i) => store.put(values[i], to + String(key).slice(from.length)));
    store.delete(range);
    return true;
  }

  /** Text content of a record. A missing record is FileNotFound, like a missing file. */
  async function readText(path: string): Promise<string> {
    const value = await rawFs.get(path);
    if (value === undefined)
      throw new StorageError("FileNotFound", `File not found: ${path}`, { path });
    if (typeof value !== "string") {
      throw new StorageError("IoError", `Unexpected content in ${path}`, { path });
    }
    return value;
  }

  // ── The provider ──
  return {
    kind: "web",

    init: ready,

    async listProjectIds() {
      await ready();
      const keys = await transact("readonly", (s) =>
        request(s.getAllKeys(folderRange(`${DIR_PROJECTS}/`))),
      );
      const ids = new Set<string>();
      for (const key of keys) {
        const id = String(key).split("/")[1];
        if (!id || id.startsWith("_")) continue;
        if (!isSafeProjectId(id)) {
          reportStorageIssue({
            level: "warning",
            id: `bad-name:${id}`,
            title: "Ignored a folder with an invalid name",
            description: `"${id}" in the projects folder cannot be opened because its name contains characters that are not allowed.`,
          });
          continue;
        }
        ids.add(id);
      }
      return [...ids];
    },

    async readProjectFile(projectId) {
      assertSafeKey(projectId, "project id");
      await ready();
      return await readText(projectFilePath(projectId));
    },

    async readProjectBackup(projectId) {
      assertSafeKey(projectId, "project id");
      await ready();
      return await readText(projectFilePath(projectId) + BACKUP_SUFFIX);
    },

    async writeProjectFile(projectId, json) {
      assertSafeKey(projectId, "project id");
      await ready();
      const path = projectFilePath(projectId);
      await enqueue(projectId, () =>
        transact("readwrite", async (store) => {
          // Refresh the backup from the current file, but only if that file is valid
          // JSON: never overwrite a good backup with corrupted data.
          const current = await request(store.get(path));
          if (typeof current === "string") {
            try {
              JSON.parse(current);
              store.put(current, path + BACKUP_SUFFIX);
            } catch (e) {
              console.warn(
                `[storage] Backup of ${projectId} not refreshed (existing backup kept):`,
                e,
              );
            }
          }
          store.put(json, path);
        }),
      );
    },

    async deleteProject(projectId) {
      assertSafeKey(projectId, "project id");
      await ready();
      await enqueue(projectId, async () => {
        const prefix = projectPrefix(projectId);
        await transact("readwrite", async (store) => {
          store.delete(folderRange(prefix));
        });
        forgetUrls(prefix);
      });
    },

    async copyProject(srcId, dstId, projectJson) {
      assertSafeKey(srcId, "project id");
      assertSafeKey(dstId, "project id");
      await ready();
      await enqueue(srcId, () =>
        transact("readwrite", async (store) => {
          const from = projectPrefix(srcId);
          const to = projectPrefix(dstId);
          const srcRange = folderRange(from);
          const keys = await request(store.getAllKeys(srcRange));
          if (!keys.length) {
            throw new StorageError("FileNotFound", `Project "${srcId}" was not found`, {
              path: from,
            });
          }
          if ((await request(store.count(folderRange(to)))) > 0) {
            throw new StorageError("IoError", `Project "${dstId}" already exists`, { path: to });
          }
          const values = await request(store.getAll(srcRange));
          keys.forEach((key, i) => {
            const relative = String(key).slice(from.length);
            if (!NOT_COPIED.has(relative)) store.put(values[i], to + relative);
          });
          store.put(projectJson, to + PROJECT_FILE);
        }),
      );
    },

    async quarantineProjectFile(projectId) {
      assertSafeKey(projectId, "project id");
      await ready();
      return await enqueue(projectId, () =>
        transact("readwrite", async (store) => {
          const from = projectFilePath(projectId);
          const value = await request(store.get(from));
          if (value === undefined) return null;
          const to = `${DIR_PROJECTS}/${DIR_CORRUPT}/${projectId}.${quarantineStamp()}.${PROJECT_FILE}`;
          store.put(value, to);
          store.delete(from);
          return to;
        }),
      );
    },

    async quarantineProjectDir(projectId) {
      assertSafeKey(projectId, "project id");
      await ready();
      return await enqueue(projectId, async () => {
        const to = `${DIR_PROJECTS}/${DIR_CORRUPT}/${projectId}.${quarantineStamp()}`;
        const moved = await transact("readwrite", (store) =>
          moveFolder(store, projectPrefix(projectId), to + "/"),
        );
        forgetUrls(projectPrefix(projectId));
        return moved ? to : null;
      });
    },

    async writePanorama(projectId, storageKey, blob) {
      assertSafeKey(projectId, "project id");
      assertSafeKey(storageKey, "storage key");
      await ready();
      const keyWithExt = withImageExtension(storageKey, blob);
      assertSafeKey(keyWithExt, "storage key");
      const path = panoramaPath(projectId, keyWithExt);
      forgetUrls(path);
      await rawFs.put(path, blob);
      return keyWithExt;
    },

    async readPanorama(projectId, storageKey) {
      assertSafeKey(projectId, "project id");
      assertSafeKey(storageKey, "storage key");
      await ready();
      const value = await rawFs.get(panoramaPath(projectId, storageKey));
      return value instanceof Blob ? value : null;
    },

    async deletePanorama(projectId, storageKey) {
      assertSafeKey(projectId, "project id");
      assertSafeKey(storageKey, "storage key");
      await ready();
      const paths = [panoramaPath(projectId, storageKey), thumbnailPath(projectId, storageKey)];
      await transact("readwrite", async (store) => {
        paths.forEach((path) => store.delete(path));
      });
      paths.forEach(forgetUrls);
    },

    async writeThumbnail(projectId, panoramaKey, blob) {
      assertSafeKey(projectId, "project id");
      assertSafeKey(panoramaKey, "storage key");
      await ready();
      const path = thumbnailPath(projectId, panoramaKey);
      forgetUrls(path);
      await rawFs.put(path, blob);
    },

    async panoramaUrl(projectId, storageKey) {
      try {
        assertSafeKey(projectId, "project id");
        assertSafeKey(storageKey, "storage key");
      } catch (e) {
        console.error(`[storage] Cannot resolve panorama "${storageKey}":`, e);
        return "";
      }
      return await urlOf(panoramaPath(projectId, storageKey), "Panorama file");
    },

    async thumbnailUrl(projectId, panoramaKey) {
      try {
        assertSafeKey(projectId, "project id");
        assertSafeKey(panoramaKey, "storage key");
      } catch (e) {
        console.error(`[storage] Cannot resolve thumbnail of "${panoramaKey}":`, e);
        return "";
      }
      return await urlOf(thumbnailPath(projectId, panoramaKey), "Thumbnail");
    },

    async writeAsset(projectId, storageKey, blob) {
      assertSafeKey(projectId, "project id");
      assertSafeKey(storageKey, "storage key");
      await ready();
      const keyWithExt = withImageExtension(storageKey, blob);
      assertSafeKey(keyWithExt, "storage key");
      const path = assetPath(projectId, keyWithExt);
      forgetUrls(path);
      await rawFs.put(path, blob);
      return keyWithExt;
    },

    async readAsset(projectId, storageKey) {
      assertSafeKey(projectId, "project id");
      assertSafeKey(storageKey, "storage key");
      await ready();
      const value = await rawFs.get(assetPath(projectId, storageKey));
      return value instanceof Blob ? value : null;
    },

    async deleteAsset(projectId, storageKey) {
      assertSafeKey(projectId, "project id");
      assertSafeKey(storageKey, "storage key");
      await ready();
      const path = assetPath(projectId, storageKey);
      await transact("readwrite", async (store) => {
        store.delete(path);
      });
      forgetUrls(path);
    },

    async assetUrl(projectId, storageKey) {
      try {
        assertSafeKey(projectId, "project id");
        assertSafeKey(storageKey, "storage key");
      } catch (e) {
        console.error(`[storage] Cannot resolve asset "${storageKey}":`, e);
        return "";
      }
      return await urlOf(assetPath(projectId, storageKey), "Asset file");
    },
  };
}

/** The driver used by the app in a browser. */
export const webProvider: StorageProvider = createWebStorage();
