/**
 * Runtime validation (Zod) and versioning of project data.
 *
 * Everything that enters the app as untrusted data goes through
 * `validateOrMigrateProject`: files read from disk, imported JSON and the
 * browser fallback storage. Missing optional parts (theme, floorplans,
 * hotspots, zoom) get their defaults here, so the rest of the app can rely on
 * the TourProject type instead of guarding against `undefined` at runtime.
 */
import { z } from "zod";
import { CURRENT_SCHEMA_VERSION, type TourProject } from "@/types/tour";
import { isSafeProjectId, isSafeStorageKey } from "./safe-key";
import { ASSET_REF_PREFIX, GENERIC_ASSET_REF_PREFIX } from "./storage-layout";
import { ProjectValidationError } from "./storage-errors";

/** Ids double as folder names ($APPDATA/projects/<id>/), so they must be safe keys. */
const safeId = z
  .string()
  .refine(
    isSafeProjectId,
    "must only contain letters, digits, '_', '-' or '.' (no '..'), and must not start with '_'",
  );

const finiteNumber = z.number().finite();

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be a valid date");

/** "tauri:<key>" refs are turned into file paths, so the key must be safe. */
const panoramaUrl = z
  .string()
  .refine(
    (url) =>
      !url.startsWith(ASSET_REF_PREFIX) || isSafeStorageKey(url.slice(ASSET_REF_PREFIX.length)),
    "invalid 'tauri:' reference (path separators and '..' are not allowed)",
  );

/** "asset:<key>" refs (theme logo, overlay images) are turned into file paths too. */
function isSafeAssetRef(url: string): boolean {
  return (
    !url.startsWith(GENERIC_ASSET_REF_PREFIX) ||
    isSafeStorageKey(url.slice(GENERIC_ASSET_REF_PREFIX.length))
  );
}
const assetRefUrl = z
  .string()
  .refine(isSafeAssetRef, "invalid 'asset:' reference (path separators and '..' are not allowed)");

const hotspotSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["door", "info", "arrow"]),
  pitch: finiteNumber,
  yaw: finiteNumber,
  tooltip: z.string().default(""),
  targetSceneId: z.string().nullish(),
  content: z.string().optional(),
});

const sceneSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  panoramaUrl,
  defaultZoom: finiteNumber.default(1),
  defaultYaw: finiteNumber.default(0),
  defaultPitch: finiteNumber.default(0),
  hotspots: z.array(hotspotSchema).default([]),
});

const themeOverlayAnchorSchema = z.enum([
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
]);

const themeOverlayElementTypeSchema = z.enum(["logo", "image", "text"]);
const themeOverlayOffsetUnitSchema = z.enum(["px", "%"]);

const themeOverlayElementStyleSchema = z.object({
  opacity: z.number().min(0).max(1).optional(),
  width: finiteNumber.optional(),
  height: finiteNumber.optional(),
  padding: finiteNumber.optional(),
  backgroundColor: z.string().optional(),
  fontSize: finiteNumber.optional(),
  fontFamily: z.string().optional(),
  color: z.string().optional(),
});

const themeOverlayElementSchema = z
  .object({
    id: z.string().min(1),
    type: themeOverlayElementTypeSchema,
    position: themeOverlayAnchorSchema,
    offsetX: finiteNumber.default(0),
    offsetY: finiteNumber.default(0),
    offsetUnit: themeOverlayOffsetUnitSchema.default("px"),
    style: themeOverlayElementStyleSchema.default({}),
    content: z.string().default(""),
  })
  // Only "logo"/"image" content is an asset reference; "text" content is free-form.
  .superRefine((el, ctx) => {
    if (el.type !== "text" && !isSafeAssetRef(el.content)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content"],
        message: "invalid 'asset:' reference (path separators and '..' are not allowed)",
      });
    }
  });

const themeSchema = z.object({
  showNavbar: z.boolean().default(true),
  showTitleOverlay: z.boolean().default(true),
  logoUrl: assetRefUrl.default(""),
  overlays: z.array(themeOverlayElementSchema).default([]),
});

const floorplanSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  imageUrl: z.string(),
});

const projectSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: safeId,
    name: z.string(),
    createdAt: isoDate,
    updatedAt: isoDate,
    initialSceneId: z.string().nullable().default(null),
    scenes: z.array(sceneSchema),
    theme: themeSchema.default({}),
    floorplans: z.array(floorplanSchema).default([]),
  })
  .superRefine((project, ctx) => {
    const overlayIds = new Set<string>();
    project.theme.overlays.forEach((overlay, i) => {
      if (overlayIds.has(overlay.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["theme", "overlays", i, "id"],
          message: `duplicate overlay id "${overlay.id}"`,
        });
      }
      overlayIds.add(overlay.id);
    });

    const seen = new Set<string>();
    project.scenes.forEach((scene, i) => {
      if (seen.has(scene.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scenes", i, "id"],
          message: `duplicate scene id "${scene.id}"`,
        });
      }
      seen.add(scene.id);

      const hotspotIds = new Set<string>();
      scene.hotspots.forEach((h, j) => {
        if (hotspotIds.has(h.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["scenes", i, "hotspots", j, "id"],
            message: `duplicate hotspot id "${h.id}"`,
          });
        }
        hotspotIds.add(h.id);
      });
    });
  })
  // Dangling references are recoverable: drop them instead of rejecting the project.
  .transform((project) => {
    const sceneIds = new Set(project.scenes.map((s) => s.id));
    return {
      ...project,
      initialSceneId:
        project.initialSceneId && sceneIds.has(project.initialSceneId)
          ? project.initialSceneId
          : null,
      scenes: project.scenes.map((scene) => ({
        ...scene,
        hotspots: scene.hotspots.map((h) => ({
          ...h,
          targetSceneId: h.targetSceneId && sceneIds.has(h.targetSceneId) ? h.targetSceneId : null,
        })),
      })),
    };
  });

/**
 * Brings raw data up to CURRENT_SCHEMA_VERSION, one version step at a time.
 * Add a `if (version < N)` block here whenever CURRENT_SCHEMA_VERSION is bumped.
 */
function migrateProject(raw: Record<string, unknown>): Record<string, unknown> {
  let data = raw;
  const declared = data["schemaVersion"];
  let version = declared === undefined ? 0 : declared;

  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new ProjectValidationError([`schemaVersion: must be a non-negative integer`]);
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new ProjectValidationError(
      [
        `this project uses format version ${version}, but this app only understands up to ${CURRENT_SCHEMA_VERSION}. Update the app to open it`,
      ],
      "UnsupportedVersion",
    );
  }

  // v0 -> v1: data written before versioning existed. The structure is the same;
  // missing optional parts are filled in by the schema defaults.
  if (version < 1) {
    data = { ...data, schemaVersion: 1 };
    version = 1;
  }

  return data;
}

function formatPath(path: (string | number)[]): string {
  return path.reduce<string>(
    (acc, part) => (typeof part === "number" ? `${acc}[${part}]` : acc ? `${acc}.${part}` : part),
    "",
  );
}

/**
 * Validates untrusted project data and migrates it to the current schema.
 * Returns a fully-populated TourProject (defaults applied) or throws a
 * ProjectValidationError describing what is wrong.
 */
export function validateOrMigrateProject(data: unknown): TourProject {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ProjectValidationError(["project data must be a JSON object"]);
  }

  const migrated = migrateProject(data as Record<string, unknown>);
  const result = projectSchema.safeParse(migrated);
  if (!result.success) {
    throw new ProjectValidationError(
      result.error.issues.map((i) =>
        i.path.length ? `${formatPath(i.path)}: ${i.message}` : i.message,
      ),
    );
  }
  return result.data;
}

/** Parses JSON text and validates it. JSON syntax errors become ProjectValidationError too. */
export function parseProjectJson(text: string): TourProject {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new ProjectValidationError([
      `not valid JSON (${e instanceof Error ? e.message : String(e)})`,
    ]);
  }
  return validateOrMigrateProject(data);
}

// Compile-time guard: the schema output must stay assignable to TourProject.
type _SchemaMatchesType = z.output<typeof projectSchema> extends TourProject ? true : never;
const _schemaMatchesType: _SchemaMatchesType = true;
void _schemaMatchesType;
