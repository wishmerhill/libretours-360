/**
 * The portable project package (`.ltproj`): a zip holding a project AND its
 * images, so a tour can move between the browser and the desktop app (or to
 * another machine) without losing its panoramas, logo or overlay images.
 *
 * A plain JSON export only carries references ("tauri:<key>", "asset:<key>")
 * to files that stay behind in the storage of the app that wrote it. The
 * package ships those files too, in the same tree the storage drivers use
 * (storage-layout.ts):
 *
 *   manifest.json        { format, formatVersion, exportedAt, missing }
 *   project.json         the project, references unchanged
 *   panoramas/<key>      the bytes behind every "tauri:<key>" reference
 *   assets/<key>         the bytes behind every "asset:<key>" reference
 *
 * On import the project gets fresh ids (like a JSON import) and every file is
 * written back under the SAME key in the new project, so the references in
 * project.json stay valid untouched. Thumbnails are not shipped: they are
 * regenerated from the panoramas.
 */
import JSZip from "jszip";
import type { TourProject } from "@/types/tour";
import { makeThumbnail } from "./panorama-import";
import { importProjectJson, upsertProject } from "./storage";
import { ProjectValidationError } from "./storage-errors";
import {
  DIR_ASSETS,
  DIR_PANORAMAS,
  PROJECT_FILE,
  makeAssetRef,
  makeGenericAssetRef,
  parseAssetRef,
  parseGenericAssetRef,
} from "./storage-layout";
import { isSafeStorageKey } from "./safe-key";
import { getStorageProvider } from "./storage-provider";
import { saveFile } from "./save-file";

export const PACKAGE_EXTENSION = ".ltproj";
const PACKAGE_FORMAT = "libretours-project";
const PACKAGE_FORMAT_VERSION = 1;
const MANIFEST_FILE = "manifest.json";

interface PackageManifest {
  format: typeof PACKAGE_FORMAT;
  formatVersion: number;
  exportedAt: string;
  /** References whose file was missing when the package was built. */
  missing: string[];
}

/** Result of building or importing a package. */
export interface PackageResult {
  project: TourProject;
  /** Local references with no file behind them (left as they are in the project). */
  missing: string[];
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "tour";

/** Storage keys of the panoramas and generic assets a project references, deduplicated. */
function localKeys(project: TourProject): { panoramas: string[]; assets: string[] } {
  const panoramas = new Set<string>();
  const assets = new Set<string>();
  for (const scene of project.scenes) {
    const key = parseAssetRef(scene.panoramaUrl);
    if (key) panoramas.add(key);
  }
  const genericRefs = [
    project.theme.logoUrl,
    ...project.theme.overlays.filter((o) => o.type !== "text").map((o) => o.content),
    ...project.floorplans.map((f) => f.imageUrl),
  ];
  for (const ref of genericRefs) {
    const key = parseGenericAssetRef(ref);
    if (key) assets.add(key);
  }
  return { panoramas: [...panoramas], assets: [...assets] };
}

/** True if the project points at files kept in the app's storage (a plain JSON export loses them). */
export function hasLocalImages(project: TourProject): boolean {
  const { panoramas, assets } = localKeys(project);
  return panoramas.length + assets.length > 0;
}

/** True if the bytes start like a zip file (a package rather than a plain JSON). */
export function looksLikePackage(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  return (
    head.length === 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4
  );
}

// ─── Export ────────────────────────────────────────────────────────────────

/**
 * Builds the package of a stored project. A referenced file that cannot be
 * found does not fail the export: it is listed in `missing` (and in the manifest).
 */
export async function buildProjectPackage(
  project: TourProject,
): Promise<{ data: ArrayBuffer; missing: string[] }> {
  const storage = getStorageProvider();
  const { panoramas, assets } = localKeys(project);
  const zip = new JSZip();
  const missing: string[] = [];

  for (const key of panoramas) {
    const blob = await storage.readPanorama(project.id, key);
    if (blob) zip.file(`${DIR_PANORAMAS}/${key}`, await blob.arrayBuffer());
    else missing.push(makeAssetRef(key));
  }
  for (const key of assets) {
    const blob = await storage.readAsset(project.id, key);
    if (blob) zip.file(`${DIR_ASSETS}/${key}`, await blob.arrayBuffer());
    else missing.push(makeGenericAssetRef(key));
  }

  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    missing,
  };
  // Images are already compressed: only the JSON files are worth deflating.
  zip.file(MANIFEST_FILE, JSON.stringify(manifest, null, 2), { compression: "DEFLATE" });
  zip.file(PROJECT_FILE, JSON.stringify(project, null, 2), { compression: "DEFLATE" });
  const data = await zip.generateAsync({ type: "arraybuffer", compression: "STORE" });
  return { data, missing };
}

/**
 * Saves the project as a `.ltproj` file. Resolves with where it went and the
 * references that had no file, or null if the user cancelled the dialog.
 */
export async function exportProjectPackage(
  project: TourProject,
): Promise<{ location: string; missing: string[] } | null> {
  const { data, missing } = await buildProjectPackage(project);
  const location = await saveFile(
    new Blob([data], { type: "application/zip" }),
    `${slug(project.name)}${PACKAGE_EXTENSION}`,
    { name: "LibreTours project", extensions: [PACKAGE_EXTENSION.slice(1)] },
  );
  return location === null ? null : { location, missing };
}

// ─── Import ────────────────────────────────────────────────────────────────

async function readManifest(zip: JSZip): Promise<PackageManifest> {
  const file = zip.file(MANIFEST_FILE);
  if (!file) throw new ProjectValidationError([`${MANIFEST_FILE} is missing`]);
  let manifest: Partial<PackageManifest>;
  try {
    manifest = JSON.parse(await file.async("string"));
  } catch {
    throw new ProjectValidationError([`${MANIFEST_FILE} is not valid JSON`]);
  }
  if (manifest?.format !== PACKAGE_FORMAT) {
    throw new ProjectValidationError(["not a LibreTours 360 project package"]);
  }
  if (manifest.formatVersion !== PACKAGE_FORMAT_VERSION) {
    throw new ProjectValidationError(
      [`package format version ${String(manifest.formatVersion)} is not supported`],
      typeof manifest.formatVersion === "number" && manifest.formatVersion > PACKAGE_FORMAT_VERSION
        ? "UnsupportedVersion"
        : "Invalid",
    );
  }
  return manifest as PackageManifest;
}

/**
 * Imports a package as a NEW project (fresh ids, like a JSON import) with all
 * the images it carries.
 *
 * Throws ProjectValidationError if the file is not a valid package; storage
 * errors are rethrown as they are. All or nothing: if anything fails after the
 * first write, the new project is removed.
 */
export async function importProjectPackage(bytes: ArrayBuffer): Promise<PackageResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new ProjectValidationError(["the file is not a readable zip archive"]);
  }
  await readManifest(zip);
  const projectFile = zip.file(PROJECT_FILE);
  if (!projectFile) throw new ProjectValidationError([`${PROJECT_FILE} is missing`]);
  // Zod validation (which also rejects unsafe "tauri:"/"asset:" keys) + fresh ids.
  const project = importProjectJson(await projectFile.async("string"));

  const storage = getStorageProvider();
  const { panoramas, assets } = localKeys(project);
  const missing: string[] = [];
  // Old ref -> new ref, for the rare key the driver had to extend (no image extension).
  const renamed = new Map<string, string>();
  try {
    for (const key of panoramas) {
      const entry = isSafeStorageKey(key) ? zip.file(`${DIR_PANORAMAS}/${key}`) : null;
      if (!entry) {
        missing.push(makeAssetRef(key));
        continue;
      }
      const blob = new Blob([await entry.async("arraybuffer")], { type: mimeOf(key) });
      const stored = await storage.writePanorama(project.id, key, blob);
      if (stored !== key) renamed.set(makeAssetRef(key), makeAssetRef(stored));
      await makeThumbnail(project.id, makeAssetRef(stored), blob);
    }
    for (const key of assets) {
      const entry = isSafeStorageKey(key) ? zip.file(`${DIR_ASSETS}/${key}`) : null;
      if (!entry) {
        missing.push(makeGenericAssetRef(key));
        continue;
      }
      const blob = new Blob([await entry.async("arraybuffer")], { type: mimeOf(key) });
      const stored = await storage.writeAsset(project.id, key, blob);
      if (stored !== key) renamed.set(makeGenericAssetRef(key), makeGenericAssetRef(stored));
    }
    return { project: await upsertProject(renameRefs(project, renamed)), missing };
  } catch (e) {
    await storage
      .deleteProject(project.id)
      .catch((err) =>
        console.warn("[storage] Could not remove a partially imported project:", err),
      );
    throw e;
  }
}

/** The project with every reference in `renamed` replaced. */
function renameRefs(project: TourProject, renamed: Map<string, string>): TourProject {
  if (!renamed.size) return project;
  const ref = (value: string) => renamed.get(value) ?? value;
  return {
    ...project,
    scenes: project.scenes.map((s) => ({ ...s, panoramaUrl: ref(s.panoramaUrl) })),
    theme: {
      ...project.theme,
      logoUrl: ref(project.theme.logoUrl),
      overlays: project.theme.overlays.map((o) =>
        o.type === "text" ? o : { ...o, content: ref(o.content) },
      ),
    },
    floorplans: project.floorplans.map((f) => ({ ...f, imageUrl: ref(f.imageUrl) })),
  };
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

function mimeOf(key: string): string {
  const ext = key.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || "application/octet-stream";
}
