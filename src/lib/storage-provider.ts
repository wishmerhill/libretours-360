/**
 * The storage driver interface.
 *
 * Everything above this layer (storage.ts, assets.ts, panorama-import.ts and the
 * UI) talks to a `StorageProvider` and never asks where it is running. There are
 * two drivers with identical behaviour and an identical tree of data (see
 * storage-layout.ts):
 *
 *  - tauri-storage.ts: files under $APPDATA/projects/ (desktop app)
 *  - web-storage.ts:   path-keyed records in IndexedDB (browser / Docker)
 *
 * Contract shared by both:
 *  - `projectId` and storage keys are validated with the same rules; an unsafe
 *    one throws StorageError("InvalidKey") before anything is touched.
 *  - Reading something that does not exist throws StorageError("FileNotFound"),
 *    except panorama reads and url lookups, which return null / "".
 *  - All operations on one project are serialized.
 *  - writeProjectFile is atomic and keeps the previous valid content as backup.
 *
 * Validation of project data (Zod schema, schemaVersion, backup recovery,
 * quarantine policy) is NOT the driver's job: it lives once, in storage.ts.
 */
import { isTauri } from "./environment";
import { tauriProvider } from "./tauri-storage";
import { webProvider } from "./web-storage";

export interface NativeImport {
  /** Opens the OS file dialog. Resolves with the chosen paths, or null if cancelled. */
  pick(): Promise<string[] | null>;
  /**
   * Copies a file the user picked into `panoramas/<keyWithExt>` of the project
   * without the image passing through the WebView.
   */
  copyIntoProject(projectId: string, srcPath: string, keyWithExt: string): Promise<void>;
}

export interface StorageProvider {
  readonly kind: "tauri" | "web";

  /** Prepares the storage (creates folders, migrates old data). Safe to call many times. */
  init(): Promise<void>;

  // ── Project files ──
  /** Ids of the stored projects. Internal folders ("_corrupt", "_staging") are not listed. */
  listProjectIds(): Promise<string[]>;
  /** Raw text of `projects/<id>/project.json`. */
  readProjectFile(projectId: string): Promise<string>;
  /** Raw text of the last known-good copy (`project.json.bak`). */
  readProjectBackup(projectId: string): Promise<string>;
  /** Atomically replaces project.json (creating the project on first write). */
  writeProjectFile(projectId: string, json: string): Promise<void>;
  /** Removes the whole project: file, backup, panoramas and thumbnails. Missing is fine. */
  deleteProject(projectId: string): Promise<void>;
  /**
   * Duplicates a project: everything except project.json/.bak/.tmp is copied to
   * `projects/<dstId>/`, and `projectJson` becomes the new project.json. All or
   * nothing. Throws FileNotFound if the source is missing, IoError if the
   * destination already exists.
   */
  copyProject(srcId: string, dstId: string, projectJson: string): Promise<void>;
  /** Moves only project.json to `projects/_corrupt/`. Null if there was none. */
  quarantineProjectFile(projectId: string): Promise<string | null>;
  /** Moves the whole project to `projects/_corrupt/`. Null if there was none. */
  quarantineProjectDir(projectId: string): Promise<string | null>;

  // ── Assets ──
  /** Stores a panorama; resolves with the key actually used (an extension is added if missing). */
  writePanorama(projectId: string, storageKey: string, blob: Blob): Promise<string>;
  /** The panorama, or null if there is no such file. */
  readPanorama(projectId: string, storageKey: string): Promise<Blob | null>;
  /** Removes a panorama and its thumbnail. Already gone is fine. */
  deletePanorama(projectId: string, storageKey: string): Promise<void>;
  /** Stores the JPEG thumbnail of the panorama with the given key. */
  writeThumbnail(projectId: string, panoramaKey: string, blob: Blob): Promise<void>;
  /** URL an <img> / Photo Sphere Viewer can load, or "" if the panorama is missing. */
  panoramaUrl(projectId: string, storageKey: string): Promise<string>;
  /** Same for the thumbnail of the panorama; "" if there is none. */
  thumbnailUrl(projectId: string, panoramaKey: string): Promise<string>;

  /**
   * Stores a generic project asset (theme logo, overlay image, ...) under
   * `assets/`, separate from panoramas. Resolves with the key actually used
   * (an extension is added if missing).
   */
  writeAsset(projectId: string, storageKey: string, blob: Blob): Promise<string>;
  /** The asset, or null if there is no such file. */
  readAsset(projectId: string, storageKey: string): Promise<Blob | null>;
  /** Removes an asset. Already gone is fine. */
  deleteAsset(projectId: string, storageKey: string): Promise<void>;
  /** URL an <img> can load, or "" if the asset is missing. */
  assetUrl(projectId: string, storageKey: string): Promise<string>;

  /** Present only where the OS can copy files for us (desktop). */
  readonly nativeImport?: NativeImport;

  // ── Theme preset library (app-wide, not tied to any one project) ──
  /** Raw text of the local theme preset library. Throws FileNotFound if none was saved yet. */
  readThemeLibrary(): Promise<string>;
  /** Overwrites the local theme preset library. Creates it on first write. */
  writeThemeLibrary(json: string): Promise<void>;
}

// ─── Selection ─────────────────────────────────────────────────────────────

let override: StorageProvider | null = null;

/** The driver for the current runtime: the desktop one inside Tauri, else the browser one. */
export function getStorageProvider(): StorageProvider {
  return override ?? (isTauri() ? tauriProvider : webProvider);
}

/** Forces a driver (tests). Pass null to go back to automatic selection. */
export function setStorageProvider(provider: StorageProvider | null): void {
  override = provider;
}
