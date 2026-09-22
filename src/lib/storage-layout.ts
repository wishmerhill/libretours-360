/**
 * The on-storage layout shared by every storage driver (Tauri file system,
 * browser IndexedDB). A driver decides WHERE the bytes go; this module decides
 * what the tree looks like, so both produce exactly the same structure:
 *
 *   projects/<id>/project.json            (+ .bak, and .tmp on the file system)
 *   projects/<id>/panoramas/<key>         full-size panoramas
 *   projects/<id>/thumbnails/<key>.jpg    small previews for the dashboard
 *   projects/_corrupt/                    quarantined corrupted projects
 *   projects/_staging/                    folders being built (file system copy)
 */
import { isSafeProjectId, isSafeStorageKey } from "./safe-key";
import { StorageError } from "./storage-errors";

export const DIR_PROJECTS = "projects";
export const DIR_PANORAMAS = "panoramas";
export const DIR_THUMBNAILS = "thumbnails";
/** Corrupted projects are moved here instead of being deleted. */
export const DIR_CORRUPT = "_corrupt";
/** A duplicated project is assembled here and renamed into place when complete. */
export const DIR_STAGING = "_staging";
export const PROJECT_FILE = "project.json";
export const TMP_SUFFIX = ".tmp";
export const BACKUP_SUFFIX = ".bak";

// ─── Key validation ────────────────────────────────────────────────────────

/**
 * Ids and storage keys end up in file names / storage paths. Anything that could
 * escape the intended folder (path separators, "..", drive prefixes, ...) is
 * rejected, whatever the driver: a project must be portable between them.
 * Project ids additionally may not start with "_" (reserved for internal folders).
 */
export function assertSafeKey(key: string, what: "project id" | "storage key"): void {
  const ok = what === "project id" ? isSafeProjectId(key) : isSafeStorageKey(key);
  if (!ok) {
    const shown = key.length > 64 ? `${key.slice(0, 64)}…` : key;
    throw new StorageError(
      "InvalidKey",
      `Invalid ${what} "${shown}": only letters, digits, "_", "-" and "." are allowed, ".." is forbidden${
        what === "project id" ? ', and ids cannot start with "_"' : ""
      }.`,
    );
  }
}

// ─── File names ────────────────────────────────────────────────────────────

/**
 * The thumbnail of a panorama is always a JPEG named after the panorama's key:
 * `pano_abc.png` -> `pano_abc.jpg`. Deterministic, so scenes need no extra field.
 */
export function thumbnailKeyFor(panoramaKey: string): string {
  return panoramaKey.replace(/\.[^.]+$/, "") + ".jpg";
}

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/**
 * Makes sure a panorama key ends with an image extension, derived from the
 * Blob's MIME type (".jpg" if unknown) when the key has none.
 */
export function withImageExtension(storageKey: string, blob: Blob): string {
  if (/\.(jpg|png|webp)$/.test(storageKey)) return storageKey;
  return storageKey + (MIME_TO_EXT[blob.type] || ".jpg");
}

/** A timestamp usable inside a file name (no ":" or "."). */
export function quarantineStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ─── Asset references ──────────────────────────────────────────────────────

/**
 * Prefix of the reference a scene stores in `panoramaUrl` for an image kept in
 * the project's own storage: "tauri:<key>", where the key is relative to
 * `projects/<id>/panoramas/`.
 *
 * The name is historical: the prefix was introduced by the desktop app and is
 * already written in existing project files, so it is kept for every driver.
 * That makes a project.json byte-compatible between desktop and browser.
 */
export const ASSET_REF_PREFIX = "tauri:";

/** Builds the reference to store in the project JSON for a panorama key. */
export function makeAssetRef(storageKey: string): string {
  return ASSET_REF_PREFIX + storageKey;
}

/** The storage key of a local asset reference, or null if it is not one. */
export function parseAssetRef(ref: string): string | null {
  if (!ref.startsWith(ASSET_REF_PREFIX)) return null;
  return ref.slice(ASSET_REF_PREFIX.length);
}

export function isLocalAssetRef(ref: string): boolean {
  return ref.startsWith(ASSET_REF_PREFIX);
}
