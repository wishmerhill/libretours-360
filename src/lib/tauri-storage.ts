/**
 * Tauri v2 File System Storage Layer
 *
 * Provides file system operations for storing project data and panorama
 * assets inside the Tauri app data directory ($APPDATA).
 *
 * Errors are never swallowed: every failure is thrown as a typed StorageError
 * (FileNotFound, PermissionDenied, InvalidKey, IoError) so callers can tell
 * "the file is not there" apart from "we are not allowed to read it".
 *
 * When running outside Tauri (browser), write/delete operations are no-ops and
 * the consumer should fall back to localStorage / IndexedDB.
 */
import { isTauri } from "./environment";
import { isSafeStorageKey } from "./safe-key";
import {
  StorageError,
  classifyFsError,
  isStorageError,
  reportStorageIssue,
} from "./storage-errors";

// ─── Lazy imports ──────────────────────────────────────────────────────────
// Tauri APIs are imported lazily so that bundling does not fail in browser
// mode (they would be dead code but Vite still resolves them at build time).

let tauriPath: typeof import("@tauri-apps/api/path") | null = null;
let tauriFs: typeof import("@tauri-apps/plugin-fs") | null = null;
let tauriCore: typeof import("@tauri-apps/api/core") | null = null;

async function ensureTauri() {
  if (!isTauri()) throw new Error("Not running inside Tauri");
  tauriPath ??= await import("@tauri-apps/api/path");
  tauriFs ??= await import("@tauri-apps/plugin-fs");
  tauriCore ??= await import("@tauri-apps/api/core");
  return { path: tauriPath!, fs: tauriFs!, core: tauriCore! };
}

/** Runs a file system operation and converts any failure into a StorageError. */
async function fsOp<T>(path: string | undefined, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    throw classifyFsError(e, path);
  }
}

// ─── Directory names ───────────────────────────────────────────────────────

const DIR_PROJECTS = "projects";
const DIR_PANORAMAS = "panoramas";
/** Corrupted project files are moved here instead of being deleted. */
const DIR_CORRUPT = "_corrupt";

/**
 * Resolves the root $APPDATA directory for the app.
 * Example: ~/Library/Application Support/com.libretours.studio/
 */
export async function getAppDataDir(): Promise<string> {
  const { path } = await ensureTauri();
  return await fsOp(undefined, () => path.appDataDir());
}

/**
 * Creates the required subdirectories inside $APPDATA on startup.
 *
 * Safe to call multiple times — mkdir with { recursive: true } is idempotent.
 * Throws a StorageError (e.g. PermissionDenied) if the folders cannot be created.
 */
export async function ensureDirectories(): Promise<void> {
  if (!isTauri()) return;
  const { path, fs } = await ensureTauri();
  const root = await fsOp(undefined, () => path.appDataDir());

  for (const dir of [DIR_PROJECTS, DIR_PANORAMAS]) {
    const full = await path.join(root, dir);
    await fsOp(full, () => fs.mkdir(full, { recursive: true }));
  }
}

// ─── Key validation ────────────────────────────────────────────────────────

/**
 * Ids and storage keys end up in file names. Anything that could escape the
 * intended folder (path separators, "..", drive prefixes, ...) is rejected.
 */
export function assertSafeKey(key: string, what: "project id" | "storage key"): void {
  if (!isSafeStorageKey(key)) {
    throw new StorageError(
      "InvalidKey",
      `Invalid ${what} "${key.length > 64 ? `${key.slice(0, 64)}…` : key}": only letters, digits, "_", "-" and "." are allowed, and ".." is forbidden.`,
    );
  }
}

// ─── Project file helpers ──────────────────────────────────────────────────

const TMP_SUFFIX = ".tmp";
const BACKUP_SUFFIX = ".bak";

function projectFileName(projectId: string): string {
  return `${projectId}.json`;
}

/**
 * Returns the full filesystem path for a project JSON file.
 * Throws InvalidKey if the id is not a safe file name.
 */
export async function resolveProjectPath(projectId: string): Promise<string> {
  assertSafeKey(projectId, "project id");
  const { path } = await ensureTauri();
  const root = await fsOp(undefined, () => path.appDataDir());
  return await path.join(root, DIR_PROJECTS, projectFileName(projectId));
}

/**
 * Returns the full filesystem path for a panorama asset file.
 * Throws InvalidKey if the key could point outside $APPDATA/panoramas/.
 */
export async function resolvePanoramaPath(storageKey: string): Promise<string> {
  assertSafeKey(storageKey, "storage key");
  const { path } = await ensureTauri();
  const root = await fsOp(undefined, () => path.appDataDir());
  return await path.join(root, DIR_PANORAMAS, storageKey);
}

// ─── Project CRUD ──────────────────────────────────────────────────────────

async function readTextOrThrow(filePath: string): Promise<string> {
  const { fs } = await ensureTauri();
  return await fsOp(filePath, () => fs.readTextFile(filePath));
}

/**
 * Reads the raw JSON text of a project.
 * Throws StorageError: FileNotFound, PermissionDenied, IoError or InvalidKey.
 */
export async function readProjectFile(projectId: string): Promise<string> {
  if (!isTauri()) throw new StorageError("FileNotFound", "Not running inside Tauri");
  return await readTextOrThrow(await resolveProjectPath(projectId));
}

/**
 * Reads the last known-good copy of a project (`<id>.json.bak`), written before
 * each overwrite of the main file. Used as a fallback when the main file is
 * missing or corrupted. Throws StorageError like readProjectFile.
 */
export async function readProjectBackup(projectId: string): Promise<string> {
  if (!isTauri()) throw new StorageError("FileNotFound", "Not running inside Tauri");
  return await readTextOrThrow((await resolveProjectPath(projectId)) + BACKUP_SUFFIX);
}

/**
 * Writes are serialized per project so that overlapping saves (autosave, manual
 * save, export) can never land on disk out of order.
 */
const writeQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(projectId) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(projectId, tail);
  void tail.then(() => {
    if (writeQueues.get(projectId) === tail) writeQueues.delete(projectId);
  });
  return run;
}

/**
 * Atomic write: the new content goes to `<id>.json.tmp` first and is then
 * renamed over `<id>.json`, so a crash mid-write can never leave a truncated
 * project file. The previous valid content is kept as `<id>.json.bak`.
 */
async function writeProjectFileAtomic(projectId: string, json: string): Promise<void> {
  const { fs } = await ensureTauri();
  const filePath = await resolveProjectPath(projectId);
  const tmpPath = filePath + TMP_SUFFIX;
  const backupPath = filePath + BACKUP_SUFFIX;

  await fsOp(tmpPath, () => fs.writeTextFile(tmpPath, json));

  // Refresh the backup from the current file, but only if that file is valid
  // JSON: never overwrite a good backup with corrupted data. A failure here
  // must not block the save itself, so it is logged, not thrown.
  try {
    if (await fs.exists(filePath)) {
      const current = await fs.readTextFile(filePath);
      JSON.parse(current);
      await fs.writeTextFile(backupPath, current);
    }
  } catch (e) {
    console.warn(`[storage] Backup of ${projectId} not refreshed (existing backup kept):`, e);
  }

  try {
    await fsOp(filePath, () => fs.rename(tmpPath, filePath));
  } catch (e) {
    await fs.remove(tmpPath).catch(() => {});
    throw e;
  }
}

export function writeProjectFile(projectId: string, json: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return enqueue(projectId, () => writeProjectFileAtomic(projectId, json));
}

/** Removes a file, treating "already gone" as success. */
async function removeIfExists(filePath: string): Promise<void> {
  const { fs } = await ensureTauri();
  try {
    await fsOp(filePath, () => fs.remove(filePath));
  } catch (e) {
    if (!isStorageError(e, "FileNotFound")) throw e;
  }
}

/** Deletes a project with its backup and temp files. Throws if a file cannot be removed. */
export function deleteProjectFile(projectId: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return enqueue(projectId, async () => {
    const filePath = await resolveProjectPath(projectId);
    for (const path of [filePath, filePath + BACKUP_SUFFIX, filePath + TMP_SUFFIX]) {
      await removeIfExists(path);
    }
  });
}

/**
 * Moves a corrupted project file (and/or its backup) to
 * `$APPDATA/projects/_corrupt/` with a timestamp, so nothing is lost and the
 * project id becomes free again. Returns the new paths of the moved files.
 */
export function quarantineProjectFiles(
  projectId: string,
  which: { main: boolean; backup: boolean },
): Promise<string[]> {
  if (!isTauri()) return Promise.resolve([]);
  return enqueue(projectId, async () => {
    const { path, fs } = await ensureTauri();
    const filePath = await resolveProjectPath(projectId);
    const root = await fsOp(undefined, () => path.appDataDir());
    const quarantineDir = await path.join(root, DIR_PROJECTS, DIR_CORRUPT);
    await fsOp(quarantineDir, () => fs.mkdir(quarantineDir, { recursive: true }));

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const moves: [string, string][] = [];
    if (which.main) moves.push([filePath, `${projectId}.${stamp}.json`]);
    if (which.backup) moves.push([filePath + BACKUP_SUFFIX, `${projectId}.${stamp}.json.bak`]);

    const moved: string[] = [];
    for (const [from, name] of moves) {
      const to = await path.join(quarantineDir, name);
      try {
        await fsOp(from, () => fs.rename(from, to));
        moved.push(to);
      } catch (e) {
        if (!isStorageError(e, "FileNotFound")) throw e; // nothing to move
      }
    }
    return moved;
  });
}

/**
 * Lists the ids of the project files in $APPDATA/projects/.
 * A missing folder is an empty list; any other failure is thrown.
 */
export async function listProjectFiles(): Promise<string[]> {
  if (!isTauri()) return [];
  const { path, fs } = await ensureTauri();
  const root = await fsOp(undefined, () => path.appDataDir());
  const dir = await path.join(root, DIR_PROJECTS);
  if (!(await fsOp(dir, () => fs.exists(dir)))) return [];

  const entries = await fsOp(dir, () => fs.readDir(dir));
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.name?.endsWith(".json")) continue; // also skips .tmp, .bak and _corrupt/
    const id = entry.name.slice(0, -".json".length);
    if (!isSafeStorageKey(id)) {
      reportStorageIssue({
        level: "warning",
        id: `bad-name:${entry.name}`,
        title: "Ignored a file with an invalid name",
        description: `"${entry.name}" in the projects folder cannot be opened because its name contains characters that are not allowed.`,
      });
      continue;
    }
    ids.push(id);
  }
  return ids;
}

// ─── MIME type → file extension mapping ────────────────────────────────────

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/**
 * Derives a file extension from a Blob's MIME type.
 * Falls back to ".jpg" if unknown.
 */
function extensionFromBlob(blob: Blob): string {
  return MIME_TO_EXT[blob.type] || ".jpg";
}

// ─── Panorama asset helpers ────────────────────────────────────────────────────────

/**
 * Writes a panorama Blob to the $APPDATA/panoramas/ directory.
 * Ensures the filename has a valid image extension derived from the Blob's MIME type.
 * Returns the **storage key** (with extension) that can be passed to makeTauriRef().
 */
export async function writePanoramaAsset(storageKey: string, blob: Blob): Promise<string> {
  if (!isTauri()) throw new Error("Not in Tauri environment");
  const { fs } = await ensureTauri();

  // Append a valid image extension if not already present
  const ext = extensionFromBlob(blob);
  const keyWithExt =
    storageKey.endsWith(".jpg") || storageKey.endsWith(".png") || storageKey.endsWith(".webp")
      ? storageKey
      : storageKey + ext;

  const filePath = await resolvePanoramaPath(keyWithExt);

  // Convert Blob -> ArrayBuffer -> Uint8Array for Tauri's writeFile
  const arrayBuffer = await blob.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  await fsOp(filePath, () => fs.writeFile(filePath, uint8));

  return keyWithExt;
}

/**
 * Copies a panorama asset natively (no round-trip through the WebView memory).
 * `destKey` is given without extension; the source extension is kept.
 * Returns the new storage key, or null if the source file does not exist.
 */
export async function copyPanoramaAsset(srcKey: string, destKey: string): Promise<string | null> {
  if (!isTauri()) throw new Error("Not in Tauri environment");
  const { fs } = await ensureTauri();
  const srcPath = await resolvePanoramaPath(srcKey);
  if (!(await fsOp(srcPath, () => fs.exists(srcPath)))) return null;

  const ext = srcKey.match(/\.(jpg|png|webp)$/i)?.[0] ?? ".jpg";
  const keyWithExt = destKey + ext;
  const destPath = await resolvePanoramaPath(keyWithExt);
  await fsOp(destPath, () => fs.copyFile(srcPath, destPath));
  return keyWithExt;
}

/**
 * Reads a panorama asset from $APPDATA/panoramas/ as a Blob.
 * Returns null only if the file does not exist; other failures are thrown.
 */
export async function readPanoramaAsset(storageKey: string): Promise<Blob | null> {
  if (!isTauri()) return null;
  const { fs } = await ensureTauri();
  const filePath = await resolvePanoramaPath(storageKey);
  try {
    const uint8 = await fsOp(filePath, () => fs.readFile(filePath));
    return new Blob([uint8]);
  } catch (e) {
    if (isStorageError(e, "FileNotFound")) return null;
    throw e;
  }
}

/**
 * Deletes a panorama asset from the filesystem. A file that is already gone is
 * not an error; any other failure is thrown.
 */
export async function deletePanoramaAsset(storageKey: string): Promise<void> {
  if (!isTauri()) return;
  await removeIfExists(await resolvePanoramaPath(storageKey));
}

/**
 * Checks whether a file exists at the given path.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  if (!isTauri()) return false;
  const { fs } = await ensureTauri();
  return await fsOp(filePath, () => fs.exists(filePath));
}

// ─── Asset URL conversion for WebView ──────────────────────────────────────

/**
 * Converts a local filesystem path to a URL that can be loaded by the
 * Tauri WebView (e.g., in `<img>` tags or Three.js / Photo Sphere Viewer).
 *
 * In browser mode this is a no-op — returns the input unmodified.
 */
export async function assetUrl(localPath: string): Promise<string> {
  if (!isTauri()) return localPath;
  const { core } = await ensureTauri();
  return core.convertFileSrc(localPath);
}

/**
 * Tauri prefix used by the storage to identify panorama assets.
 * Similar to the "idb:" prefix used by the IndexedDB layer.
 */
export const TAURI_PREFIX = "tauri:";

/**
 * Builds a storage reference string that can be stored in the project JSON.
 * Format: "tauri:<storageKey>"
 */
export function makeTauriRef(storageKey: string): string {
  return TAURI_PREFIX + storageKey;
}

/**
 * Extracts the storage key from a tauri-prefixed reference.
 * Returns null if the ref is not a tauri reference.
 */
export function parseTauriRef(ref: string): string | null {
  if (!ref.startsWith(TAURI_PREFIX)) return null;
  return ref.slice(TAURI_PREFIX.length);
}

/**
 * Resolves a "tauri:<key>" reference to a WebView-compatible asset URL
 * (via convertFileSrc), after checking that the key is safe and the file exists.
 *
 * Returns an empty string if the reference cannot be resolved (invalid key,
 * missing file, permission problem); the reason is logged, and callers decide
 * how to tell the user.
 */
export async function resolveTauriRef(ref: string): Promise<string> {
  const key = parseTauriRef(ref);
  if (!key) return ref; // not a tauri ref, pass through
  if (!isTauri()) return ""; // not in Tauri, can't resolve

  try {
    const filePath = await resolvePanoramaPath(key);
    const { core } = await ensureTauri();
    if (!(await fileExists(filePath))) {
      console.warn(`[storage] Panorama file is missing: ${filePath}`);
      return "";
    }
    return core.convertFileSrc(filePath);
  } catch (e) {
    console.error(`[storage] Cannot resolve panorama reference "${ref}":`, e);
    return "";
  }
}
