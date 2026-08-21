/**
 * Tauri v2 File System Storage Layer
 *
 * Provides file system operations for storing project data and panorama
 * assets inside the Tauri app data directory ($APPDATA).
 *
 * When running outside Tauri (browser), all operations gracefully fall back
 * to a no-op / simple mock, and the consumer should fall back to
 * localStorage / IndexedDB.
 */
import { isTauri } from "./environment";

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

// ─── Directory names ───────────────────────────────────────────────────────

const DIR_PROJECTS = "projects";
const DIR_PANORAMAS = "panoramas";

/**
 * Resolves the root $APPDATA directory for the app.
 * Example: ~/Library/Application Support/com.libretours.studio/
 */
export async function getAppDataDir(): Promise<string> {
  const { path } = await ensureTauri();
  return await path.appDataDir();
}

/**
 * Creates the required subdirectories inside $APPDATA on startup.
 *
 * Safe to call multiple times — mkdir with { recursive: true } is idempotent.
 */
export async function ensureDirectories(): Promise<void> {
  if (!isTauri()) return;
  const { path, fs } = await ensureTauri();
  const root = await path.appDataDir();

  await fs.mkdir(await path.join(root, DIR_PROJECTS), { recursive: true });
  await fs.mkdir(await path.join(root, DIR_PANORAMAS), { recursive: true });
}

// ─── Project file helpers ──────────────────────────────────────────────────

function projectFileName(projectId: string): string {
  return `${projectId}.json`;
}

/**
 * Returns the full filesystem path for a project JSON file.
 */
export async function resolveProjectPath(projectId: string): Promise<string> {
  const { path } = await ensureTauri();
  const root = await path.appDataDir();
  return await path.join(root, DIR_PROJECTS, projectFileName(projectId));
}

/**
 * Returns the full filesystem path for a panorama asset file.
 */
export async function resolvePanoramaPath(storageKey: string): Promise<string> {
  const { path } = await ensureTauri();
  const root = await path.appDataDir();
  return await path.join(root, DIR_PANORAMAS, storageKey);
}

// ─── Project CRUD ──────────────────────────────────────────────────────────

export async function readProjectFile(projectId: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { fs } = await ensureTauri();
    const filePath = await resolveProjectPath(projectId);
    const exists = await fs.exists(filePath);
    if (!exists) return null;
    return await fs.readTextFile(filePath);
  } catch {
    return null;
  }
}

export async function writeProjectFile(projectId: string, json: string): Promise<void> {
  if (!isTauri()) return;
  const { fs } = await ensureTauri();
  const filePath = await resolveProjectPath(projectId);
  await fs.writeTextFile(filePath, json);
}

export async function deleteProjectFile(projectId: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { fs } = await ensureTauri();
    const filePath = await resolveProjectPath(projectId);
    const exists = await fs.exists(filePath);
    if (exists) await fs.remove(filePath);
  } catch {
    // ignore
  }
}

export async function listProjectFiles(): Promise<string[]> {
  if (!isTauri()) return [];
  try {
    const { path, fs } = await ensureTauri();
    const root = await path.appDataDir();
    const dir = await path.join(root, DIR_PROJECTS);
    const exists = await fs.exists(dir);
    if (!exists) return [];
    const entries = await fs.readDir(dir);
    return entries
      .filter((e) => e.name?.endsWith(".json"))
      .map((e) => e.name!.replace(/\.json$/, ""));
  } catch {
    return [];
  }
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
export async function writePanoramaAsset(
  storageKey: string,
  blob: Blob,
): Promise<string> {
  if (!isTauri()) throw new Error("Not in Tauri environment");
  const { fs } = await ensureTauri();
  
  // Append a valid image extension if not already present
  const ext = extensionFromBlob(blob);
  const keyWithExt = storageKey.endsWith(".jpg") || storageKey.endsWith(".png") || storageKey.endsWith(".webp")
    ? storageKey
    : storageKey + ext;

  const filePath = await resolvePanoramaPath(keyWithExt);

  // Convert Blob -> ArrayBuffer -> Uint8Array for Tauri's writeFile
  const arrayBuffer = await blob.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  await fs.writeFile(filePath, uint8);

  return keyWithExt;
}

/**
 * Reads a panorama asset from $APPDATA/panoramas/ as a Blob.
 */
export async function readPanoramaAsset(storageKey: string): Promise<Blob | null> {
  if (!isTauri()) return null;
  try {
    const { fs } = await ensureTauri();
    const filePath = await resolvePanoramaPath(storageKey);
    const exists = await fs.exists(filePath);
    if (!exists) return null;
    const uint8 = await fs.readFile(filePath);
    return new Blob([uint8]);
  } catch {
    return null;
  }
}

/**
 * Deletes a panorama asset from the filesystem.
 */
export async function deletePanoramaAsset(storageKey: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { fs } = await ensureTauri();
    const filePath = await resolvePanoramaPath(storageKey);
    const exists = await fs.exists(filePath);
    if (exists) await fs.remove(filePath);
  } catch {
    // ignore
  }
}

/**
 * Checks whether a file exists at the given path.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { fs } = await ensureTauri();
    return await fs.exists(filePath);
  } catch {
    return false;
  }
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
 * by reading the file from $APPDATA/panoramas/ and converting via convertFileSrc.
 *
 * Returns the URL string, or empty string if resolution fails.
 */
export async function resolveTauriRef(ref: string): Promise<string> {
  const key = parseTauriRef(ref);
  if (!key) return ref; // not a tauri ref, pass through
  if (!isTauri()) return ""; // not in Tauri, can't resolve

  try {
    const filePath = await resolvePanoramaPath(key);
    const { core } = await ensureTauri();
    return core.convertFileSrc(filePath);
  } catch {
    return "";
  }
}