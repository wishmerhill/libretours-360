/**
 * One-time move of the data saved by earlier browser versions into the
 * per-project tree of the web driver (see web-storage.ts).
 *
 * The old layout was:
 *  - localStorage "opentour.projects.v1": a JSON array with every project;
 *  - IndexedDB "opentour-assets" / "panoramas": one global store of blobs, which
 *    scenes referenced as "idb:<key>".
 *
 * Each project becomes `projects/<id>/project.json` with its panoramas under
 * `projects/<id>/panoramas/`, and its "idb:<key>" references become the same
 * "tauri:<key>" references the desktop app writes.
 *
 * Safety rules:
 *  - project.json is written LAST, after all its panoramas, and read back and
 *    validated; a crash before that leaves the old data untouched and the next
 *    start simply redoes the project (the keys are deterministic);
 *  - old blobs and the old list entry are removed only after that check;
 *  - entries that fail validation are set aside in `projects/_corrupt/` (like a
 *    corrupted desktop file), never dropped;
 *  - the migrated entries are kept (JSON only, no images) under
 *    "opentour.projects.v1.migrated" as a last-resort copy.
 */
import { uid } from "@/types/tour";
import { validateOrMigrateProject, parseProjectJson } from "./project-schema";
import { isSafeProjectId, isSafeStorageKey } from "./safe-key";
import { ProjectValidationError, describeStorageError, reportStorageIssue } from "./storage-errors";
import {
  DIR_CORRUPT,
  DIR_PANORAMAS,
  DIR_PROJECTS,
  DIR_THUMBNAILS,
  PROJECT_FILE,
  makeAssetRef,
  quarantineStamp,
  thumbnailKeyFor,
  withImageExtension,
} from "./storage-layout";
import type { WebFs } from "./web-storage";

export const LEGACY_PROJECTS_KEY = "opentour.projects.v1";
export const LEGACY_MIGRATED_KEY = `${LEGACY_PROJECTS_KEY}.migrated`;
export const LEGACY_DB_NAME = "opentour-assets";
const LEGACY_STORE = "panoramas";
const LEGACY_REF_PREFIX = "idb:";

export interface MigrationDeps {
  generateThumbnail: (source: Blob) => Promise<Blob>;
}

function localStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked by the browser settings
  }
}

// ─── The old blob database ─────────────────────────────────────────────────

function openLegacyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LEGACY_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(LEGACY_STORE)) {
        req.result.createObjectStore(LEGACY_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function legacyRequest<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
) {
  return new Promise<T>((resolve, reject) => {
    const r = run(db.transaction(LEGACY_STORE, mode).objectStore(LEGACY_STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function dropLegacyDb(db: IDBDatabase): Promise<void> {
  db.close();
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(LEGACY_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve(); // only wasted space, nothing to report
    req.onblocked = () => resolve(); // another tab still holds it: removed when it closes
  });
}

// ─── Migration ─────────────────────────────────────────────────────────────

/** Reads the old project list. A list that is not a JSON array is moved aside and reported. */
function readLegacyList(store: Storage): unknown[] | null {
  const raw = store.getItem(LEGACY_PROJECTS_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through: corrupted
  }
  const aside = `${LEGACY_PROJECTS_KEY}.corrupt.${Date.now()}`;
  store.setItem(aside, raw);
  store.removeItem(LEGACY_PROJECTS_KEY);
  reportStorageIssue({
    level: "error",
    id: "browser-store-corrupt",
    title: "Browser storage was corrupted",
    description: `The saved project list could not be read. A copy was kept under "${aside}".`,
  });
  return null;
}

/**
 * Moves every project of the old browser storage into the tree. Never throws
 * for a single bad project (it is reported and left in place); a failure of the
 * storage itself is thrown and the migration is retried at the next start.
 */
export async function migrateLegacyBrowserData(fs: WebFs, deps: MigrationDeps): Promise<void> {
  const store = localStore();
  const entries = store ? readLegacyList(store) : null;
  if (!store || !entries) return;

  // Opened only when a project has images in it (opening would create an empty database).
  const legacy: { db: IDBDatabase | null } = { db: null };
  const getLegacyDb = async () => (legacy.db ??= await openLegacyDb());

  const keep: unknown[] = []; // entries that must stay in the old list
  const done: unknown[] = []; // entries now safe in the new tree
  let clean = true; // false if anything was not migrated: then the old blobs must survive

  async function migrateEntry(entry: unknown, index: number): Promise<void> {
    let project;
    try {
      project = validateOrMigrateProject(entry);
    } catch (e) {
      if (!(e instanceof ProjectValidationError)) throw e;
      if (e.reason === "UnsupportedVersion") throw e;
      // Same policy as a corrupted desktop file: set it aside, tell the user.
      const path = `${DIR_PROJECTS}/${DIR_CORRUPT}/legacy-${index}.${quarantineStamp()}.${PROJECT_FILE}`;
      await fs.put(path, JSON.stringify(entry, null, 2));
      clean = false;
      reportStorageIssue({
        level: "error",
        id: `corrupt:legacy-${index}`,
        title: "A project saved by an earlier version was corrupted",
        description: `${e.message} It was kept in projects/_corrupt/.`,
      });
      return;
    }

    if (!isSafeProjectId(project.id)) throw new Error(`invalid project id "${project.id}"`);
    const projectPath = `${DIR_PROJECTS}/${project.id}/${PROJECT_FILE}`;
    const oldKeys = project.scenes
      .filter((s) => s.panoramaUrl.startsWith(LEGACY_REF_PREFIX))
      .map((s) => s.panoramaUrl.slice(LEGACY_REF_PREFIX.length));

    // Already there: a previous run was interrupted after writing it. Do not overwrite
    // (the new copy may have been edited since); only finish the clean-up below.
    if (!(await fs.has(projectPath))) {
      const refs = new Map<string, string>();
      let missing = 0;
      const scenes = [];
      for (const scene of project.scenes) {
        if (!scene.panoramaUrl.startsWith(LEGACY_REF_PREFIX)) {
          scenes.push(scene);
          continue;
        }
        const oldKey = scene.panoramaUrl.slice(LEGACY_REF_PREFIX.length);
        let ref = refs.get(oldKey);
        if (!ref) {
          const blob = await legacyRequest<unknown>(await getLegacyDb(), "readonly", (s) =>
            s.get(oldKey),
          );
          if (!(blob instanceof Blob)) {
            missing++; // already broken before: keep the reference as it was
            scenes.push(scene);
            continue;
          }
          const key = withImageExtension(isSafeStorageKey(oldKey) ? oldKey : uid("pano"), blob);
          await fs.put(`${DIR_PROJECTS}/${project.id}/${DIR_PANORAMAS}/${key}`, blob);
          try {
            const thumbnail = await deps.generateThumbnail(blob);
            await fs.put(
              `${DIR_PROJECTS}/${project.id}/${DIR_THUMBNAILS}/${thumbnailKeyFor(key)}`,
              thumbnail,
            );
          } catch (e) {
            // Best effort, like at import time: the dashboard shows a placeholder.
            console.warn(`[storage] Could not create a thumbnail for ${key}:`, e);
          }
          ref = makeAssetRef(key);
          refs.set(oldKey, ref);
        }
        scenes.push({ ...scene, panoramaUrl: ref });
      }

      // updatedAt is kept: moving a project is not an edit.
      const migrated = validateOrMigrateProject({ ...project, scenes });
      await fs.put(projectPath, JSON.stringify(migrated, null, 2));
      const written = await fs.get(projectPath);
      if (typeof written !== "string")
        throw new Error("the migrated project could not be read back");
      parseProjectJson(written);

      if (missing > 0) {
        reportStorageIssue({
          level: "warning",
          id: `legacy-missing:${project.id}`,
          title: `"${project.name}": ${missing} image${missing === 1 ? " was" : "s were"} already missing`,
          description: "These images were not found in the browser storage before the update.",
        });
      }
    }

    // The new copy is verified: the old images are no longer needed.
    if (oldKeys.length) {
      const db = await getLegacyDb();
      for (const key of oldKeys) {
        await legacyRequest<undefined>(
          db,
          "readwrite",
          (s) => s.delete(key) as IDBRequest<undefined>,
        );
      }
    }
  }

  for (const [index, entry] of entries.entries()) {
    try {
      await migrateEntry(entry, index);
      done.push(entry);
    } catch (e) {
      keep.push(entry);
      clean = false;
      const id = String((entry as { id?: unknown } | null)?.id ?? `#${index}`);
      reportStorageIssue({
        level: "error",
        id: `load-failed:${id}`,
        title: `Project "${id}" could not be moved to the new storage`,
        description: describeStorageError(e),
      });
    }
  }

  if (keep.length) store.setItem(LEGACY_PROJECTS_KEY, JSON.stringify(keep));
  else store.removeItem(LEGACY_PROJECTS_KEY);

  if (done.length) {
    try {
      const previous = JSON.parse(store.getItem(LEGACY_MIGRATED_KEY) ?? "[]") as unknown;
      store.setItem(
        LEGACY_MIGRATED_KEY,
        JSON.stringify([...(Array.isArray(previous) ? previous : []), ...done]),
      );
    } catch (e) {
      console.warn("[storage] Could not keep a copy of the migrated project list:", e); // best effort
    }
  }

  // Everything moved: what is left in the old database is unreferenced leftovers.
  if (legacy.db) {
    if (clean) await dropLegacyDb(legacy.db);
    else legacy.db.close();
  }
}
