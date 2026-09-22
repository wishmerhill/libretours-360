/**
 * The local theme preset library: save the current project's theme for reuse
 * in other tours, apply a saved (or built-in) preset, rename/delete presets,
 * and import/export a theme as a standalone `.lt-theme` file.
 *
 * A preset's theme is always "portable": every local asset reference (logo,
 * overlay images) is inlined as a `data:` URL instead of a project-scoped
 * "asset:<key>" reference, so it does not depend on the project it was saved
 * from and can be written straight into a `.lt-theme` file. `materializeTheme`
 * does the reverse when a preset is applied to a project or a file is
 * imported: every `data:` URL becomes a real asset stored under that project.
 */
import saveAs from "file-saver";
import { type Theme, type ThemeOverlayElement, type ThemePreset, uid } from "@/types/tour";
import {
  THEME_EXPORT_FORMAT_VERSION,
  type ThemeExportFile,
  parseThemeExportFile,
  parseThemeLibrary,
} from "./project-schema";
import { getStorageProvider } from "./storage-provider";
import { isStorageError } from "./storage-errors";
import {
  blobToDataUrl,
  dataUrlToBlob,
  getThemeAsset,
  isGenericAssetRef,
  putThemeAsset,
} from "./theme-assets";

export type { ThemeExportFile } from "./project-schema";

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "theme"
  );
}

// ─── Built-in presets ───────────────────────────────────────────────────────

const BUILTIN_PREFIX = "builtin:";

export function isBuiltInThemePreset(id: string): boolean {
  return id.startsWith(BUILTIN_PREFIX);
}

/** Always available, never stored: no local assets, so they need no project to resolve from. */
export const BUILTIN_THEME_PRESETS: ThemePreset[] = [
  {
    id: `${BUILTIN_PREFIX}minimal`,
    name: "Minimal",
    theme: { showNavbar: true, showTitleOverlay: false, logoUrl: "", overlays: [] },
    createdAt: "",
    updatedAt: "",
  },
  {
    id: `${BUILTIN_PREFIX}corporate`,
    name: "Corporate",
    theme: {
      showNavbar: true,
      showTitleOverlay: true,
      logoUrl: "",
      overlays: [
        {
          id: "corporate-badge",
          type: "text",
          position: "bottom-right",
          offsetX: 16,
          offsetY: 16,
          offsetUnit: "px",
          style: {
            fontSize: 12,
            color: "#f4f4f5",
            backgroundColor: "rgba(24, 24, 27, 0.75)",
            padding: 8,
            borderRadius: 6,
          },
          content: "{{project.name}}",
        },
      ],
    },
    createdAt: "",
    updatedAt: "",
  },
];

// ─── Library persistence ────────────────────────────────────────────────────

async function readLibrary(): Promise<ThemePreset[]> {
  const storage = getStorageProvider();
  await storage.init();
  try {
    return parseThemeLibrary(await storage.readThemeLibrary());
  } catch (e) {
    if (isStorageError(e, "FileNotFound")) return [];
    throw e;
  }
}

async function writeLibrary(presets: ThemePreset[]): Promise<void> {
  await getStorageProvider().writeThemeLibrary(JSON.stringify({ presets }, null, 2));
}

/** User-saved presets from the library, plus the built-in ones (always listed first). */
export async function listThemePresets(): Promise<ThemePreset[]> {
  return [...BUILTIN_THEME_PRESETS, ...(await readLibrary())];
}

// ─── Portable (data: URLs) <-> project-local ("asset:" refs) conversion ────

async function toDataUrl(projectId: string, ref: string): Promise<string> {
  if (!ref || ref.startsWith("data:")) return ref;
  // A legacy http(s) reference cannot be embedded here: dropping it keeps the
  // preset/export self-contained rather than silently depending on a remote URL.
  if (!isGenericAssetRef(ref)) return "";
  const blob = await getThemeAsset(projectId, ref);
  return blob ? await blobToDataUrl(blob) : "";
}

async function toAssetRef(projectId: string, ref: string): Promise<string> {
  if (!ref || !ref.startsWith("data:")) return ref;
  return await putThemeAsset(projectId, uid("asset"), dataUrlToBlob(ref));
}

/** Resolves every local asset reference in `theme` to an inline `data:` URL. */
export async function portabilizeTheme(theme: Theme, projectId: string): Promise<Theme> {
  const logoUrl = await toDataUrl(projectId, theme.logoUrl);
  const overlays = await Promise.all(
    theme.overlays.map(async (el): Promise<ThemeOverlayElement> =>
      el.type === "text" ? el : { ...el, content: await toDataUrl(projectId, el.content) },
    ),
  );
  return { ...theme, logoUrl, overlays };
}

/**
 * Turns a portable theme (inline `data:` URLs) into one usable by `projectId`:
 * every image is stored as a local asset and overlay elements get fresh ids,
 * so applying the same preset twice (or importing the same file twice) never
 * collides with what is already on the project.
 */
export async function materializeTheme(theme: Theme, projectId: string): Promise<Theme> {
  const logoUrl = await toAssetRef(projectId, theme.logoUrl);
  const overlays = await Promise.all(
    theme.overlays.map(async (el): Promise<ThemeOverlayElement> => ({
      ...el,
      id: uid("overlay"),
      content: el.type === "text" ? el.content : await toAssetRef(projectId, el.content),
    })),
  );
  return { ...theme, logoUrl, overlays };
}

// ─── Save / rename / delete ─────────────────────────────────────────────────

/** Saves the current theme (with its local assets inlined) as a new library preset. */
export async function saveThemePreset(
  name: string,
  theme: Theme,
  projectId: string,
): Promise<ThemePreset> {
  const now = new Date().toISOString();
  const preset: ThemePreset = {
    id: uid("theme"),
    name,
    theme: await portabilizeTheme(theme, projectId),
    createdAt: now,
    updatedAt: now,
  };
  await writeLibrary([...(await readLibrary()), preset]);
  return preset;
}

export async function renameThemePreset(id: string, name: string): Promise<void> {
  if (isBuiltInThemePreset(id)) return;
  const presets = await readLibrary();
  await writeLibrary(
    presets.map((p) => (p.id === id ? { ...p, name, updatedAt: new Date().toISOString() } : p)),
  );
}

export async function deleteThemePreset(id: string): Promise<void> {
  if (isBuiltInThemePreset(id)) return;
  const presets = await readLibrary();
  await writeLibrary(presets.filter((p) => p.id !== id));
}

/** Materializes a saved/built-in preset's theme for use by `projectId`. */
export async function applyThemePreset(preset: ThemePreset, projectId: string): Promise<Theme> {
  return await materializeTheme(preset.theme, projectId);
}

// ─── `.lt-theme` file export / import ───────────────────────────────────────

/** Builds the exported file's content (pure, no download side effect: see exportThemeToFile). */
export async function buildThemeExportFile(
  name: string,
  theme: Theme,
  projectId: string,
): Promise<ThemeExportFile> {
  return {
    formatVersion: THEME_EXPORT_FORMAT_VERSION,
    name,
    exportedAt: new Date().toISOString(),
    theme: await portabilizeTheme(theme, projectId),
  };
}

/** Downloads the current theme as a standalone `.lt-theme` file (JSON, assets inlined as data: URLs). */
export async function exportThemeToFile(
  name: string,
  theme: Theme,
  projectId: string,
): Promise<void> {
  const file = await buildThemeExportFile(name, theme, projectId);
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  saveAs(blob, `${slugify(name)}.lt-theme`);
}

/**
 * Validates and materializes an imported `.lt-theme`/JSON file's text for
 * `projectId`, and also saves the portable theme to the local library (per
 * the spec: an import lands on both the current project and the library).
 */
export async function importThemeFile(
  text: string,
  projectId: string,
): Promise<{ theme: Theme; preset: ThemePreset }> {
  const file = parseThemeExportFile(text);
  const theme = await materializeTheme(file.theme, projectId);
  const now = new Date().toISOString();
  const preset: ThemePreset = {
    id: uid("theme"),
    name: file.name,
    theme: file.theme,
    createdAt: now,
    updatedAt: now,
  };
  await writeLibrary([...(await readLibrary()), preset]);
  return { theme, preset };
}
