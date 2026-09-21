import { type TourProject, uid, defaultTheme } from "@/types/tour";
import { isTauri } from "./environment";
import {
  readProjectFile,
  readProjectBackup,
  writeProjectFile,
  deleteProjectFile,
  listProjectFiles,
  ensureDirectories,
} from "./tauri-storage";
import { cloneBlob, deleteBlob } from "./idb";

const KEY = "opentour.projects.v1";

/**
 * Reads and parses a project from disk (Tauri mode). If the main file is
 * missing or corrupted, falls back to the last known-good `.bak` copy.
 */
async function readProject(id: string): Promise<TourProject | null> {
  for (const [label, read] of [
    ["main", readProjectFile],
    ["backup", readProjectBackup],
  ] as const) {
    const json = await read(id);
    if (!json) continue;
    try {
      const project = JSON.parse(json) as TourProject;
      if (label === "backup") console.warn(`Project ${id}: recovered from backup`);
      return project;
    } catch {
      console.warn(`Project ${id}: ${label} file is corrupted`);
    }
  }
  return null;
}

/**
 * Load all projects. In Tauri mode, reads from $APPDATA/projects/.
 * In browser mode, reads from localStorage.
 */
export async function loadProjects(): Promise<TourProject[]> {
  if (typeof window === "undefined") return [];

  if (isTauri()) {
    try {
      await ensureDirectories();
      const ids = await listProjectFiles();
      const projects: TourProject[] = [];
      for (const id of ids) {
        const project = await readProject(id);
        if (project) projects.push(project);
      }
      // Sort by updatedAt descending
      projects.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      return projects;
    } catch {
      return [];
    }
  }

  // Browser fallback: localStorage
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TourProject[]) : [];
  } catch {
    return [];
  }
}

/**
 * Synchronous version for browser-only code paths.
 * Only works in browser mode; in Tauri mode returns an empty array.
 */
export function loadProjectsSync(): TourProject[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TourProject[]) : [];
  } catch {
    return [];
  }
}

export async function getProject(id: string): Promise<TourProject | null> {
  if (isTauri()) return await readProject(id);
  return loadProjectsSync().find((p) => p.id === id) ?? null;
}

export async function upsertProject(project: TourProject): Promise<TourProject> {
  const next = { ...project, updatedAt: new Date().toISOString() };

  if (isTauri()) {
    await ensureDirectories();
    await writeProjectFile(next.id, JSON.stringify(next, null, 2));
    return next;
  }

  // Browser fallback
  const projects = loadProjectsSync();
  const i = projects.findIndex((p) => p.id === project.id);
  if (i === -1) projects.unshift(next);
  else projects[i] = next;
  window.localStorage.setItem(KEY, JSON.stringify(projects));
  return next;
}

export async function deleteProject(id: string) {
  if (isTauri()) {
    await deleteProjectFile(id);
    return;
  }

  // Browser fallback
  const projects = loadProjectsSync();
  window.localStorage.setItem(
    KEY,
    JSON.stringify(projects.filter((p) => p.id !== id)),
  );
}

export async function duplicateProject(id: string): Promise<TourProject | null> {
  const source = await getProject(id);
  if (!source) return null;

  // Panoramas are physically copied: the duplicate must never share files with
  // the original, otherwise deleting a scene in one would break the other.
  const copiedRefs: string[] = [];
  try {
    const scenes = [];
    for (const scene of source.scenes) {
      const ref = await cloneBlob(scene.panoramaUrl, uid("pano"));
      if (ref && ref !== scene.panoramaUrl) copiedRefs.push(ref);
      // Missing source asset (already broken in the original): keep the ref as is.
      scenes.push({ ...scene, panoramaUrl: ref ?? scene.panoramaUrl });
    }
    const copy = cloneWithNewIds({ ...source, name: `${source.name} (copy)`, scenes });
    await upsertProject(copy);
    return copy;
  } catch (e) {
    await Promise.all(copiedRefs.map((ref) => deleteBlob(ref).catch(() => {})));
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
      ? sceneIdMap.get(project.initialSceneId) ?? null
      : null,
    scenes: project.scenes.map((scene) => ({
      ...scene,
      id: sceneIdMap.get(scene.id)!,
      hotspots: (scene.hotspots ?? []).map((h) => ({
        ...h,
        id: uid("hs"),
        targetSceneId: h.targetSceneId ? sceneIdMap.get(h.targetSceneId) ?? null : null,
      })),
    })),
  };
}

export function normalizeImported(raw: unknown): TourProject | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<TourProject>;
  if (!Array.isArray(candidate.scenes) || typeof candidate.name !== "string") return null;
  return cloneWithNewIds({
    ...(candidate as TourProject),
    scenes: candidate.scenes.map((s) => ({
      ...s,
      defaultZoom: s.defaultZoom ?? 1,
      hotspots: s.hotspots ?? [],
    })),
  });
}