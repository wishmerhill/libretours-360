/**
 * Tauri v2 File System Storage Layer
 *
 * Every project lives in its own isolated folder inside $APPDATA:
 *
 *   $APPDATA/projects/<id>/project.json        (+ .bak / .tmp used for atomic writes)
 *   $APPDATA/projects/<id>/panoramas/<key>     full-size panoramas
 *   $APPDATA/projects/<id>/thumbnails/<key>.jpg  small previews for the dashboard
 *   $APPDATA/projects/_corrupt/                quarantined corrupted projects
 *   $APPDATA/projects/_staging/                folders being built (duplicate), renamed when complete
 *
 * Deleting a project is removing its folder; duplicating it is copying its
 * folder. Nothing outside $APPDATA/projects/<id>/ is ever touched by a project.
 *
 * Errors are never swallowed: every failure is thrown as a typed StorageError
 * (FileNotFound, PermissionDenied, InvalidKey, IoError) so callers can tell
 * "the file is not there" apart from "we are not allowed to read it".
 *
 * When running outside Tauri (browser), write/delete operations are no-ops and
 * the consumer should fall back to localStorage / IndexedDB.
 */
import { isTauri } from "./environment";
import { isSafeProjectId } from "./safe-key";
import { createKeyedQueue } from "./keyed-queue";
import {
  StorageError,
  classifyFsError,
  isStorageError,
  reportStorageIssue,
} from "./storage-errors";
import {
  BACKUP_SUFFIX,
  DIR_ASSETS,
  DIR_CORRUPT,
  DIR_PANORAMAS,
  DIR_PROJECTS,
  DIR_STAGING,
  DIR_THUMBNAILS,
  PROJECT_FILE,
  TMP_SUFFIX,
  assertSafeKey,
  quarantineStamp,
  thumbnailKeyFor,
  withImageExtension,
} from "./storage-layout";
import type { NativeImport, StorageProvider } from "./storage-provider";

// ─── Lazy imports ──────────────────────────────────────────────────────────
// Tauri APIs are imported lazily so that bundling does not fail in browser
// mode (they would be dead code but Vite still resolves them at build time).

let tauriPath: typeof import("@tauri-apps/api/path") | null = null;
let tauriFs: typeof import("@tauri-apps/plugin-fs") | null = null;
let tauriCore: typeof import("@tauri-apps/api/core") | null = null;

type TauriApis = {
  path: typeof import("@tauri-apps/api/path");
  fs: typeof import("@tauri-apps/plugin-fs");
  core: typeof import("@tauri-apps/api/core");
};

let apisOverride: TauriApis | null = null;

/** Replaces the Tauri APIs (tests run the real code against a fake file system). */
export function setTauriApisForTesting(apis: TauriApis | null): void {
  apisOverride = apis;
}

async function ensureTauri(): Promise<TauriApis> {
  if (apisOverride) return apisOverride;
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

// ─── Layout ────────────────────────────────────────────────────────────────

async function projectsRoot(): Promise<string> {
  const { path } = await ensureTauri();
  const root = await fsOp(undefined, () => path.appDataDir());
  return await path.join(root, DIR_PROJECTS);
}

/**
 * Resolves the root $APPDATA directory for the app.
 * Example: ~/Library/Application Support/com.libretours.studio/
 */
export async function getAppDataDir(): Promise<string> {
  const { path } = await ensureTauri();
  return await fsOp(undefined, () => path.appDataDir());
}

/**
 * Creates $APPDATA/projects/ if needed.
 *
 * Safe to call multiple times — mkdir with { recursive: true } is idempotent.
 * Throws a StorageError (e.g. PermissionDenied) if the folder cannot be created.
 */
export async function ensureDirectories(): Promise<void> {
  if (!isTauri()) return;
  const { fs } = await ensureTauri();
  const root = await projectsRoot();
  await fsOp(root, () => fs.mkdir(root, { recursive: true }));
}

// ─── Path resolution ───────────────────────────────────────────────────────

/** `$APPDATA/projects/<id>/` — throws InvalidKey if the id is not a safe folder name. */
export async function resolveProjectDir(projectId: string): Promise<string> {
  assertSafeKey(projectId, "project id");
  const { path } = await ensureTauri();
  return await path.join(await projectsRoot(), projectId);
}

/** `$APPDATA/projects/<id>/project.json` */
export async function resolveProjectPath(projectId: string): Promise<string> {
  const { path } = await ensureTauri();
  return await path.join(await resolveProjectDir(projectId), PROJECT_FILE);
}

/**
 * `$APPDATA/projects/<id>/panoramas/<key>` — throws InvalidKey if the id or the
 * key could point outside the project's own panoramas folder.
 */
export async function resolvePanoramaPath(projectId: string, storageKey: string): Promise<string> {
  assertSafeKey(storageKey, "storage key");
  const { path } = await ensureTauri();
  return await path.join(await resolveProjectDir(projectId), DIR_PANORAMAS, storageKey);
}

/** `$APPDATA/projects/<id>/thumbnails/<key>.jpg` */
export async function resolveThumbnailPath(
  projectId: string,
  panoramaKey: string,
): Promise<string> {
  assertSafeKey(panoramaKey, "storage key");
  const { path } = await ensureTauri();
  return await path.join(
    await resolveProjectDir(projectId),
    DIR_THUMBNAILS,
    thumbnailKeyFor(panoramaKey),
  );
}

/**
 * `$APPDATA/projects/<id>/assets/<key>` — throws InvalidKey if the id or the
 * key could point outside the project's own assets folder.
 */
export async function resolveAssetPath(projectId: string, storageKey: string): Promise<string> {
  assertSafeKey(storageKey, "storage key");
  const { path } = await ensureTauri();
  return await path.join(await resolveProjectDir(projectId), DIR_ASSETS, storageKey);
}

// ─── Project files ─────────────────────────────────────────────────────────

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
 * Reads the last known-good copy of a project (`project.json.bak`), written before
 * each overwrite of the main file. Used as a fallback when the main file is
 * missing or corrupted. Throws StorageError like readProjectFile.
 */
export async function readProjectBackup(projectId: string): Promise<string> {
  if (!isTauri()) throw new StorageError("FileNotFound", "Not running inside Tauri");
  return await readTextOrThrow((await resolveProjectPath(projectId)) + BACKUP_SUFFIX);
}

/**
 * Operations on one project's folder are serialized so that overlapping saves
 * (autosave, manual save, export), a delete or a copy can never interleave.
 */
const enqueue = createKeyedQueue();

/**
 * Atomic write: the new content goes to `project.json.tmp` first and is then
 * renamed over `project.json`, so a crash mid-write can never leave a truncated
 * project file. The previous valid content is kept as `project.json.bak`.
 * Creates the project folder if it does not exist yet.
 */
async function writeProjectFileAtomic(projectId: string, json: string): Promise<void> {
  const { fs } = await ensureTauri();
  const dir = await resolveProjectDir(projectId);
  const filePath = await resolveProjectPath(projectId);
  const tmpPath = filePath + TMP_SUFFIX;
  const backupPath = filePath + BACKUP_SUFFIX;

  await fsOp(dir, () => fs.mkdir(dir, { recursive: true }));
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

/** Removes a file or folder, treating "already gone" as success. */
async function removeIfExists(target: string, recursive = false): Promise<void> {
  const { fs } = await ensureTauri();
  try {
    await fsOp(target, () => fs.remove(target, recursive ? { recursive: true } : undefined));
  } catch (e) {
    if (!isStorageError(e, "FileNotFound")) throw e;
  }
}

/**
 * Deletes a project: its whole folder, i.e. project.json, backup, panoramas and
 * thumbnails, in one recursive removal. There is nothing left to garbage-collect.
 * Throws if the folder cannot be removed.
 */
export function deleteProjectDir(projectId: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return enqueue(projectId, async () => {
    await removeIfExists(await resolveProjectDir(projectId), true);
  });
}

async function moveToQuarantine(
  projectId: string,
  build: (dir: string, stamp: string) => Promise<{ from: string; name: string }>,
): Promise<string | null> {
  const { path, fs } = await ensureTauri();
  const dir = await resolveProjectDir(projectId);
  const quarantineDir = await path.join(await projectsRoot(), DIR_CORRUPT);
  await fsOp(quarantineDir, () => fs.mkdir(quarantineDir, { recursive: true }));

  const { from, name } = await build(dir, quarantineStamp());
  const to = await path.join(quarantineDir, name);
  try {
    await fsOp(from, () => fs.rename(from, to));
    return to;
  } catch (e) {
    if (isStorageError(e, "FileNotFound")) return null; // nothing to move
    throw e;
  }
}

/**
 * Moves only a corrupted `project.json` to `projects/_corrupt/`, keeping the
 * folder (panoramas, backup) in place. Used when the backup is still good.
 * Returns the new path, or null if there was nothing to move.
 */
export function quarantineProjectFile(projectId: string): Promise<string | null> {
  if (!isTauri()) return Promise.resolve(null);
  return enqueue(projectId, () =>
    moveToQuarantine(projectId, async (dir, stamp) => {
      const { path } = await ensureTauri();
      return {
        from: await path.join(dir, PROJECT_FILE),
        name: `${projectId}.${stamp}.project.json`,
      };
    }),
  );
}

/**
 * Moves the WHOLE project folder to `projects/_corrupt/<id>.<timestamp>/` when
 * neither project.json nor its backup can be used. Panoramas are preserved for
 * manual recovery and the project id becomes free again.
 * Returns the new path, or null if the folder did not exist.
 */
export function quarantineProjectDir(projectId: string): Promise<string | null> {
  if (!isTauri()) return Promise.resolve(null);
  return enqueue(projectId, () =>
    moveToQuarantine(projectId, async (dir, stamp) => ({
      from: dir,
      name: `${projectId}.${stamp}`,
    })),
  );
}

/**
 * Lists the ids of the project folders in $APPDATA/projects/.
 * A missing folder is an empty list; any other failure is thrown.
 * Folders starting with "_" (quarantine, staging) and loose files (including
 * projects saved by older versions as `<id>.json`) are ignored.
 */
export async function listProjectIds(): Promise<string[]> {
  if (!isTauri()) return [];
  const { fs } = await ensureTauri();
  const dir = await projectsRoot();
  if (!(await fsOp(dir, () => fs.exists(dir)))) return [];

  const entries = await fsOp(dir, () => fs.readDir(dir));
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory || !entry.name || entry.name.startsWith("_")) continue;
    if (!isSafeProjectId(entry.name)) {
      reportStorageIssue({
        level: "warning",
        id: `bad-name:${entry.name}`,
        title: "Ignored a folder with an invalid name",
        description: `"${entry.name}" in the projects folder cannot be opened because its name contains characters that are not allowed.`,
      });
      continue;
    }
    ids.push(entry.name);
  }
  return ids;
}

// ─── Duplicating a project ─────────────────────────────────────────────────

type Fs = Awaited<ReturnType<typeof ensureTauri>>["fs"];
type PathApi = Awaited<ReturnType<typeof ensureTauri>>["path"];

/** Files that belong to the write machinery of the source project, not to its content. */
const NOT_COPIED = new Set([PROJECT_FILE, PROJECT_FILE + BACKUP_SUFFIX, PROJECT_FILE + TMP_SUFFIX]);

/**
 * Recursively copies a folder using native `copyFile` (file contents never pass
 * through the WebView). The plugin has no directory copy, hence the recursion.
 * Symlinks are skipped, never followed.
 */
async function copyTree(fs: Fs, path: PathApi, from: string, to: string, topLevel: boolean) {
  await fsOp(to, () => fs.mkdir(to, { recursive: true }));
  for (const entry of await fsOp(from, () => fs.readDir(from))) {
    if (!entry.name || entry.isSymlink) continue;
    if (topLevel && NOT_COPIED.has(entry.name)) continue;
    const src = await path.join(from, entry.name);
    const dst = await path.join(to, entry.name);
    if (entry.isDirectory) await copyTree(fs, path, src, dst, false);
    else await fsOp(dst, () => fs.copyFile(src, dst));
  }
}

/**
 * Duplicates a project folder: everything except project.json/.bak/.tmp is copied
 * from `projects/<srcId>/` and `projectJson` is written as the new project.json.
 * The copy is assembled in `projects/_staging/<dstId>/` and renamed to
 * `projects/<dstId>/` only when complete, so a failure never leaves a half-made
 * project behind.
 */
export function copyProjectDir(srcId: string, dstId: string, projectJson: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return enqueue(srcId, async () => {
    const { path, fs } = await ensureTauri();
    const srcDir = await resolveProjectDir(srcId);
    const dstDir = await resolveProjectDir(dstId);
    const stagingDir = await path.join(await projectsRoot(), DIR_STAGING, dstId);

    if (!(await fsOp(srcDir, () => fs.exists(srcDir)))) {
      throw new StorageError("FileNotFound", `Project "${srcId}" was not found`, { path: srcDir });
    }
    if (await fsOp(dstDir, () => fs.exists(dstDir))) {
      throw new StorageError("IoError", `Project "${dstId}" already exists`, { path: dstDir });
    }

    await removeIfExists(stagingDir, true); // leftover of an interrupted copy
    try {
      await copyTree(fs, path, srcDir, stagingDir, true);
      const newFile = await path.join(stagingDir, PROJECT_FILE);
      await fsOp(newFile, () => fs.writeTextFile(newFile, projectJson));
      await fsOp(dstDir, () => fs.rename(stagingDir, dstDir));
    } catch (e) {
      await removeIfExists(stagingDir, true).catch(() => {});
      throw e;
    }
  });
}

// ─── Panorama assets (per project) ─────────────────────────────────────────

async function ensureSubdir(projectId: string, sub: string): Promise<void> {
  const { path, fs } = await ensureTauri();
  const dir = await path.join(await resolveProjectDir(projectId), sub);
  await fsOp(dir, () => fs.mkdir(dir, { recursive: true }));
}

/**
 * Writes a panorama Blob to `projects/<id>/panoramas/`.
 * Ensures the filename has a valid image extension derived from the Blob's MIME type.
 * Returns the **storage key** (with extension) that goes into the asset reference (makeAssetRef).
 */
export async function writePanoramaAsset(
  projectId: string,
  storageKey: string,
  blob: Blob,
): Promise<string> {
  if (!isTauri()) throw new Error("Not in Tauri environment");
  const { fs } = await ensureTauri();

  // Append a valid image extension if not already present
  const keyWithExt = withImageExtension(storageKey, blob);

  const filePath = await resolvePanoramaPath(projectId, keyWithExt);
  await ensureSubdir(projectId, DIR_PANORAMAS);

  // Convert Blob -> ArrayBuffer -> Uint8Array for Tauri's writeFile
  const uint8 = new Uint8Array(await blob.arrayBuffer());
  await fsOp(filePath, () => fs.writeFile(filePath, uint8));

  return keyWithExt;
}

/**
 * Imports a panorama from any location on disk with a native `copyFile`: the
 * image never passes through the WebView's memory. `srcPath` must have been
 * granted by the user (the native file dialog adds the chosen files to the
 * scope); `keyWithExt` is the destination file name inside the panoramas folder.
 */
export async function copyPanoramaFromPath(
  projectId: string,
  srcPath: string,
  keyWithExt: string,
): Promise<void> {
  if (!isTauri()) throw new Error("Not in Tauri environment");
  const { fs } = await ensureTauri();
  const dest = await resolvePanoramaPath(projectId, keyWithExt);
  await ensureSubdir(projectId, DIR_PANORAMAS);
  await fsOp(srcPath, () => fs.copyFile(srcPath, dest));
}

/** Writes the JPEG thumbnail of a panorama to `projects/<id>/thumbnails/`. */
export async function writeThumbnail(
  projectId: string,
  panoramaKey: string,
  blob: Blob,
): Promise<void> {
  if (!isTauri()) throw new Error("Not in Tauri environment");
  const { fs } = await ensureTauri();
  const filePath = await resolveThumbnailPath(projectId, panoramaKey);
  await ensureSubdir(projectId, DIR_THUMBNAILS);
  const uint8 = new Uint8Array(await blob.arrayBuffer());
  await fsOp(filePath, () => fs.writeFile(filePath, uint8));
}

/**
 * Reads a panorama asset as a Blob.
 * Returns null only if the file does not exist; other failures are thrown.
 */
export async function readPanoramaAsset(
  projectId: string,
  storageKey: string,
): Promise<Blob | null> {
  if (!isTauri()) return null;
  const { fs } = await ensureTauri();
  const filePath = await resolvePanoramaPath(projectId, storageKey);
  try {
    const uint8 = await fsOp(filePath, () => fs.readFile(filePath));
    return new Blob([uint8]);
  } catch (e) {
    if (isStorageError(e, "FileNotFound")) return null;
    throw e;
  }
}

/**
 * Deletes a panorama and its thumbnail. Files that are already gone are not an
 * error; any other failure is thrown.
 */
export async function deletePanoramaAsset(projectId: string, storageKey: string): Promise<void> {
  if (!isTauri()) return;
  await removeIfExists(await resolvePanoramaPath(projectId, storageKey));
  await removeIfExists(await resolveThumbnailPath(projectId, storageKey));
}

// ─── Generic assets (theme logo, overlay images, ...) ──────────────────────

/**
 * Writes a generic asset Blob to `projects/<id>/assets/`.
 * Ensures the filename has a valid image extension derived from the Blob's MIME type.
 * Returns the **storage key** (with extension) that goes into the asset reference (makeGenericAssetRef).
 */
export async function writeProjectAsset(
  projectId: string,
  storageKey: string,
  blob: Blob,
): Promise<string> {
  if (!isTauri()) throw new Error("Not in Tauri environment");
  const { fs } = await ensureTauri();

  const keyWithExt = withImageExtension(storageKey, blob);
  const filePath = await resolveAssetPath(projectId, keyWithExt);
  await ensureSubdir(projectId, DIR_ASSETS);

  const uint8 = new Uint8Array(await blob.arrayBuffer());
  await fsOp(filePath, () => fs.writeFile(filePath, uint8));

  return keyWithExt;
}

/**
 * Reads a generic asset as a Blob.
 * Returns null only if the file does not exist; other failures are thrown.
 */
export async function readProjectAsset(
  projectId: string,
  storageKey: string,
): Promise<Blob | null> {
  if (!isTauri()) return null;
  const { fs } = await ensureTauri();
  const filePath = await resolveAssetPath(projectId, storageKey);
  try {
    const uint8 = await fsOp(filePath, () => fs.readFile(filePath));
    return new Blob([uint8]);
  } catch (e) {
    if (isStorageError(e, "FileNotFound")) return null;
    throw e;
  }
}

/** Deletes a generic asset. Already gone is not an error; any other failure is thrown. */
export async function deleteProjectAsset(projectId: string, storageKey: string): Promise<void> {
  if (!isTauri()) return;
  await removeIfExists(await resolveAssetPath(projectId, storageKey));
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
 * Resolves a file of the project to a WebView-compatible asset URL (via
 * convertFileSrc), after checking that the key is safe and the file exists.
 *
 * Returns an empty string if it cannot be resolved (invalid key, missing file,
 * permission problem); the reason is logged, and callers decide how to tell the
 * user.
 */
async function resolveExistingAssetUrl(
  pathFor: () => Promise<string>,
  what: string,
): Promise<string> {
  if (!isTauri()) return ""; // not in Tauri, can't resolve

  try {
    const filePath = await pathFor();
    const { core } = await ensureTauri();
    if (!(await fileExists(filePath))) {
      console.warn(`[storage] ${what} is missing: ${filePath}`);
      return "";
    }
    return core.convertFileSrc(filePath);
  } catch (e) {
    console.error(`[storage] Cannot resolve ${what}:`, e);
    return "";
  }
}

// ─── Native panorama import (dialog + file copy) ───────────────────────────

const nativeImport: NativeImport = {
  async pick() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        filters: [{ name: "360° panoramas", extensions: ["jpg", "jpeg", "png", "webp"] }],
      });
      if (!selected) return null;
      return Array.isArray(selected) ? selected : [selected];
    } catch (e) {
      throw classifyFsError(e);
    }
  },
  copyIntoProject: copyPanoramaFromPath,
};

// ─── The StorageProvider ───────────────────────────────────────────────────

/** The desktop driver: real files and folders under $APPDATA/projects/. */
export const tauriProvider: StorageProvider = {
  kind: "tauri",
  init: ensureDirectories,
  listProjectIds,
  readProjectFile,
  readProjectBackup,
  writeProjectFile,
  deleteProject: deleteProjectDir,
  copyProject: copyProjectDir,
  quarantineProjectFile,
  quarantineProjectDir,
  writePanorama: writePanoramaAsset,
  readPanorama: readPanoramaAsset,
  deletePanorama: deletePanoramaAsset,
  writeThumbnail,
  panoramaUrl: (projectId, key) =>
    resolveExistingAssetUrl(() => resolvePanoramaPath(projectId, key), "Panorama file"),
  thumbnailUrl: (projectId, key) =>
    resolveExistingAssetUrl(() => resolveThumbnailPath(projectId, key), "Thumbnail"),
  writeAsset: writeProjectAsset,
  readAsset: readProjectAsset,
  deleteAsset: deleteProjectAsset,
  assetUrl: (projectId, key) =>
    resolveExistingAssetUrl(() => resolveAssetPath(projectId, key), "Asset file"),
  nativeImport,
};
