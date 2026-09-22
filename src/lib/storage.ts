import { type TourProject, uid, defaultTheme } from "@/types/tour";
import { getStorageProvider } from "./storage-provider";
import { parseProjectJson, validateOrMigrateProject } from "./project-schema";
import {
  ProjectValidationError,
  StorageError,
  describeStorageError,
  isStorageError,
  reportStorageIssue,
} from "./storage-errors";

// ─── Reading a project: validation, backup recovery, quarantine ─────────────
//
// Everything below runs on top of a StorageProvider, so it is identical for the
// desktop app and the browser: the drivers only move bytes.

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
  const storage = getStorageProvider();
  const why = main.state === "corrupt" ? "was damaged" : "was missing";
  try {
    if (main.state === "corrupt") await storage.quarantineProjectFile(id);
    await storage.writeProjectFile(id, JSON.stringify(project, null, 2));
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
 * Reads and validates a project from storage.
 *
 * If project.json is missing or invalid, the last known-good `.bak` is used and
 * project.json is repaired. If neither is usable, the WHOLE project folder (with
 * its panoramas) is moved to `projects/_corrupt/` and a CorruptFile error is
 * thrown. Throws FileNotFound if the project does not exist at all, and
 * PermissionDenied / IoError / InvalidKey / ProjectValidationError (unsupported
 * version) without touching any file.
 */
async function readProject(id: string): Promise<TourProject> {
  const storage = getStorageProvider();
  const main = await attempt(id, (i) => storage.readProjectFile(i));
  if (main.state === "ok") return main.project;

  const backup = await attempt(id, (i) => storage.readProjectBackup(i));
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
    if (await storage.quarantineProjectDir(id))
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

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Load all projects, newest first, from the storage of the current runtime
 * (`$APPDATA/projects/` in the desktop app, the same tree in IndexedDB in a browser).
 *
 * Projects that cannot be read are skipped and reported through
 * reportStorageIssue; a failure of the projects folder itself is thrown.
 */
export async function loadProjects(): Promise<TourProject[]> {
  if (typeof window === "undefined") return [];

  const storage = getStorageProvider();
  await storage.init();
  const projects: TourProject[] = [];
  for (const id of await storage.listProjectIds()) {
    try {
      projects.push(await readProject(id));
    } catch (e) {
      reportProjectLoadFailure(id, e);
    }
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
  try {
    return await readProject(id);
  } catch (e) {
    if (isStorageError(e, "FileNotFound")) return null;
    throw e;
  }
}

/**
 * Validates and saves a project, bumping updatedAt. Refuses to persist data that
 * does not match the schema (throws ProjectValidationError).
 *
 * Creates projects/<id>/ on first save; the write itself is atomic and
 * serialized per project.
 */
export async function upsertProject(project: TourProject): Promise<TourProject> {
  const next = validateOrMigrateProject({ ...project, updatedAt: new Date().toISOString() });
  await getStorageProvider().writeProjectFile(next.id, JSON.stringify(next, null, 2));
  return next;
}

/**
 * Deletes a project: the removal of its whole folder, which takes project.json,
 * the backup, all panoramas and thumbnails with it. There is nothing left to
 * garbage-collect.
 */
export async function deleteProject(id: string) {
  await getStorageProvider().deleteProject(id);
}

/**
 * Duplicates a project.
 *
 * The project's folder is copied into a new `projects/<new-id>/`, and only the
 * copy's project.json differs: new id, name "<name> (copy)" and fresh dates.
 * Panorama references are relative to the project folder, so they stay valid
 * untouched.
 */
export async function duplicateProject(id: string): Promise<TourProject | null> {
  const source = await getProject(id);
  if (!source) return null;

  const now = new Date().toISOString();
  const copy = validateOrMigrateProject({
    ...source,
    id: uid("tour"),
    name: `${source.name} (copy)`,
    createdAt: now,
    updatedAt: now,
  });
  await getStorageProvider().copyProject(source.id, copy.id, JSON.stringify(copy, null, 2));
  return copy;
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
