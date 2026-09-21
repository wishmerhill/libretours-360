import { type TourProject, uid, defaultTheme } from "@/types/tour";
import { isTauri } from "./environment";
import {
  readProjectFile,
  readProjectBackup,
  writeProjectFile,
  deleteProjectDir,
  quarantineProjectFile,
  quarantineProjectDir,
  copyProjectDir,
  listProjectIds,
  ensureDirectories,
} from "./tauri-storage";
import { cloneBlob, deleteBlob } from "./idb";
import { parseProjectJson, validateOrMigrateProject } from "./project-schema";
import {
  ProjectValidationError,
  StorageError,
  describeStorageError,
  isStorageError,
  reportStorageIssue,
} from "./storage-errors";

const KEY = "opentour.projects.v1";

// ─── Tauri: reading a project with validation, backup recovery, quarantine ──

type Attempt =
  | { state: "ok"; project: TourProject }
  | { state: "missing" }
  | { state: "corrupt"; reason: string };

/**
 * Reads one file (main or backup) and validates it.
 *  - file absent          -> "missing"
 *  - not JSON / bad schema -> "corrupt"
 *  - permission / I/O error, or a project written by a newer app version -> thrown
 */
async function attempt(id: string, read: (id: string) => Promise<string>): Promise<Attempt> {
  let text: string;
  try {
    text = await read(id);
  } catch (e) {
    if (isStorageError(e, "FileNotFound")) return { state: "missing" };
    throw e;
  }

  try {
    const project = parseProjectJson(text);
    if (project.id !== id) {
      throw new ProjectValidationError([
        `id "${project.id}" does not match its folder name "${id}"`,
      ]);
    }
    return { state: "ok", project };
  } catch (e) {
    // A file from a newer app version is valid, just not readable by us: never
    // treat it as corrupted (it must not be quarantined).
    if (e instanceof ProjectValidationError && e.reason === "Invalid") {
      return { state: "corrupt", reason: e.message };
    }
    throw e;
  }
}

/** After recovering from the backup, put a valid main file back in place. */
async function repairMainFromBackup(id: string, project: TourProject, main: Attempt) {
  const why = main.state === "corrupt" ? "was damaged" : "was missing";
  try {
    if (main.state === "corrupt") await quarantineProjectFile(id);
    await writeProjectFile(id, JSON.stringify(project, null, 2));
    reportStorageIssue({
      level: "warning",
      id: `recovered:${id}`,
      title: `"${project.name}" was restored from its backup`,
      description: `The project file ${why}. Your most recent changes may be missing.${
        main.state === "corrupt" ? " The damaged file was kept in projects/_corrupt/." : ""
      }`,
    });
  } catch (e) {
    reportStorageIssue({
      level: "error",
      id: `recovered:${id}`,
      title: `"${project.name}" was restored from its backup, but the file could not be repaired`,
      description: describeStorageError(e),
    });
  }
}

/**
 * Reads and validates a project from disk (Tauri mode).
 *
 * If project.json is missing or invalid, the last known-good `.bak` is used and
 * project.json is repaired. If neither is usable, the WHOLE project folder (with
 * its panoramas) is moved to `$APPDATA/projects/_corrupt/` and a CorruptFile
 * error is thrown. Throws FileNotFound if the project does not exist at all, and
 * PermissionDenied / IoError / InvalidKey / ProjectValidationError (unsupported
 * version) without touching any file.
 */
async function readProject(id: string): Promise<TourProject> {
  const main = await attempt(id, readProjectFile);
  if (main.state === "ok") return main.project;

  const backup = await attempt(id, readProjectBackup);
  if (backup.state === "ok") {
    await repairMainFromBackup(id, backup.project, main);
    return backup.project;
  }

  if (main.state === "missing" && backup.state === "missing") {
    throw new StorageError("FileNotFound", `Project "${id}" was not found`);
  }

  const reasons = [main, backup]
    .filter((a): a is Extract<Attempt, { state: "corrupt" }> => a.state === "corrupt")
    .map((a) => a.reason);
  let destination = "";
  try {
    if (await quarantineProjectDir(id))
      destination = " and its folder was moved to projects/_corrupt/";
  } catch (e) {
    reportStorageIssue({
      level: "error",
      id: `quarantine-failed:${id}`,
      title: `Project "${id}" is corrupted and could not be set aside`,
      description: describeStorageError(e),
    });
  }
  const message = `Project "${id}" is corrupted${destination}. ${reasons[0] ?? ""}`.trim();
  reportStorageIssue({
    level: "error",
    id: `corrupt:${id}`,
    title: "A project file was corrupted",
    description: message,
  });
  throw new StorageError("CorruptFile", message);
}

/** One unreadable project must not hide the others: report it and move on. */
function reportProjectLoadFailure(id: string, e: unknown) {
  if (isStorageError(e, "FileNotFound")) return; // deleted while loading
  if (isStorageError(e, "CorruptFile")) return; // already reported by readProject
  reportStorageIssue({
    level: "error",
    id: `load-failed:${id}`,
    title: `Project "${id}" could not be opened`,
    description: describeStorageError(e),
  });
}

// ─── Browser fallback (localStorage) ────────────────────────────────────────

/**
 * Raw entries of the browser store. Entries are kept as `unknown` so that ones
 * failing validation are never dropped when the array is written back.
 * A store that is not a JSON array is moved aside (not deleted) and reported.
 */
function readBrowserEntries(): unknown[] {
  const raw = window.localStorage.getItem(KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through: corrupted
  }
  const aside = `${KEY}.corrupt.${Date.now()}`;
  window.localStorage.setItem(aside, raw);
  window.localStorage.removeItem(KEY);
  reportStorageIssue({
    level: "error",
    id: "browser-store-corrupt",
    title: "Browser storage was corrupted",
    description: `The saved project list could not be read. A copy was kept under "${aside}".`,
  });
  return [];
}

function entryId(entry: unknown): unknown {
  return entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
}

function writeBrowserEntries(entries: unknown[]) {
  window.localStorage.setItem(KEY, JSON.stringify(entries));
}

/**
 * Synchronous read for browser-only code paths (returns [] in Tauri mode, where
 * projects live on disk). Invalid entries are skipped and reported, not deleted.
 */
export function loadProjectsSync(): TourProject[] {
  if (typeof window === "undefined") return [];
  const projects: TourProject[] = [];
  for (const entry of readBrowserEntries()) {
    try {
      projects.push(validateOrMigrateProject(entry));
    } catch (e) {
      const id = String(entryId(entry) ?? "?");
      reportStorageIssue({
        level: "error",
        id: `load-failed:${id}`,
        title: `Project "${id}" could not be opened`,
        description: describeStorageError(e),
      });
    }
  }
  return projects;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Load all projects, newest first. In Tauri mode, reads from $APPDATA/projects/.
 * In browser mode, reads from localStorage.
 *
 * Projects that cannot be read are skipped and reported through
 * reportStorageIssue; a failure of the projects folder itself is thrown.
 */
export async function loadProjects(): Promise<TourProject[]> {
  if (typeof window === "undefined") return [];

  const projects: TourProject[] = [];
  if (isTauri()) {
    await ensureDirectories();
    for (const id of await listProjectIds()) {
      try {
        projects.push(await readProject(id));
      } catch (e) {
        reportProjectLoadFailure(id, e);
      }
    }
  } else {
    projects.push(...loadProjectsSync());
  }

  projects.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return projects;
}

/**
 * Returns the project, or null if it does not exist. Throws for anything else
 * (CorruptFile, PermissionDenied, IoError, ProjectValidationError, ...), so the
 * caller can tell "not found" apart from "found but unusable".
 */
export async function getProject(id: string): Promise<TourProject | null> {
  if (isTauri()) {
    try {
      return await readProject(id);
    } catch (e) {
      if (isStorageError(e, "FileNotFound")) return null;
      throw e;
    }
  }

  const entry = readBrowserEntries().find((e) => entryId(e) === id);
  return entry === undefined ? null : validateOrMigrateProject(entry);
}

/**
 * Validates and saves a project, bumping updatedAt. Refuses to persist data that
 * does not match the schema (throws ProjectValidationError).
 */
export async function upsertProject(project: TourProject): Promise<TourProject> {
  const next = validateOrMigrateProject({ ...project, updatedAt: new Date().toISOString() });

  if (isTauri()) {
    // Creates projects/<id>/ on first save; the write itself is serialized per project.
    await writeProjectFile(next.id, JSON.stringify(next, null, 2));
    return next;
  }

  // Browser fallback
  const entries = readBrowserEntries();
  const i = entries.findIndex((e) => entryId(e) === next.id);
  if (i === -1) entries.unshift(next);
  else entries[i] = next;
  writeBrowserEntries(entries);
  return next;
}

/**
 * Deletes a project. In Tauri mode this is the recursive removal of its folder,
 * which takes project.json, the backup, all panoramas and thumbnails with it.
 * In browser mode the project's blobs are removed from IndexedDB first.
 */
export async function deleteProject(id: string) {
  if (isTauri()) {
    await deleteProjectDir(id);
    return;
  }

  // Browser fallback
  const entries = readBrowserEntries();
  const entry = entries.find((e) => entryId(e) === id);
  if (entry !== undefined) {
    try {
      for (const scene of validateOrMigrateProject(entry).scenes)
        await deleteBlob(id, scene.panoramaUrl);
    } catch (e) {
      // An invalid entry (or a blob that cannot be removed) must not block deletion.
      console.warn(`[storage] Could not remove the images of project ${id}:`, e);
    }
  }
  writeBrowserEntries(entries.filter((e) => entryId(e) !== id));
}

/**
 * Duplicates a project.
 *
 * Tauri: the project's folder is copied (natively, file by file) into a new
 * `projects/<new-id>/`, and only the copy's project.json differs: new id, name
 * "<name> (copy)" and fresh dates. Panorama references are relative to the
 * project folder, so they stay valid untouched.
 * Browser: blobs live in one global IndexedDB store, so each one is copied
 * under a new key.
 */
export async function duplicateProject(id: string): Promise<TourProject | null> {
  const source = await getProject(id);
  if (!source) return null;

  const now = new Date().toISOString();
  const copy: TourProject = {
    ...source,
    id: uid("tour"),
    name: `${source.name} (copy)`,
    createdAt: now,
    updatedAt: now,
  };

  if (isTauri()) {
    const validated = validateOrMigrateProject(copy);
    await copyProjectDir(source.id, validated.id, JSON.stringify(validated, null, 2));
    return validated;
  }

  const copiedRefs: string[] = [];
  try {
    const scenes = [];
    for (const scene of source.scenes) {
      const ref = await cloneBlob(scene.panoramaUrl, uid("pano"));
      if (ref && ref !== scene.panoramaUrl) copiedRefs.push(ref);
      // Missing source asset (already broken in the original): keep the ref as is.
      scenes.push({ ...scene, panoramaUrl: ref ?? scene.panoramaUrl });
    }
    return await upsertProject({ ...copy, scenes });
  } catch (e) {
    await Promise.all(
      copiedRefs.map((ref) =>
        deleteBlob(copy.id, ref).catch((cleanupError) =>
          console.warn(`[storage] Could not remove partial copy ${ref}:`, cleanupError),
        ),
      ),
    );
    throw e;
  }
}

export function cloneWithNewIds(project: TourProject): TourProject {
  const now = new Date().toISOString();
  const sceneIdMap = new Map<string, string>();
  project.scenes.forEach((s) => sceneIdMap.set(s.id, uid("scene")));
  return {
    ...project,
    id: uid("tour"),
    createdAt: now,
    updatedAt: now,
    theme: { ...defaultTheme(), ...project.theme },
    floorplans: project.floorplans ?? [],
    initialSceneId: project.initialSceneId
      ? (sceneIdMap.get(project.initialSceneId) ?? null)
      : null,
    scenes: project.scenes.map((scene) => ({
      ...scene,
      id: sceneIdMap.get(scene.id)!,
      hotspots: (scene.hotspots ?? []).map((h) => ({
        ...h,
        id: uid("hs"),
        targetSceneId: h.targetSceneId ? (sceneIdMap.get(h.targetSceneId) ?? null) : null,
      })),
    })),
  };
}

/**
 * Validates untrusted, already-parsed data (an imported project) and gives it
 * fresh ids. Throws ProjectValidationError describing what is wrong.
 */
export function normalizeImported(raw: unknown): TourProject {
  return cloneWithNewIds(validateOrMigrateProject(raw));
}

/** Same as normalizeImported for the text of a JSON file. */
export function importProjectJson(text: string): TourProject {
  return cloneWithNewIds(parseProjectJson(text));
}
