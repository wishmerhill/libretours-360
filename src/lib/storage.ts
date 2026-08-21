import { type TourProject, uid, defaultTheme } from "@/types/tour";
import { isTauri } from "./environment";
import {
  readProjectFile,
  writeProjectFile,
  deleteProjectFile,
  listProjectFiles,
  ensureDirectories,
} from "./tauri-storage";

const KEY = "opentour.projects.v1";

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
        const json = await readProjectFile(id);
        if (json) {
          try {
            const parsed = JSON.parse(json) as TourProject;
            projects.push(parsed);
          } catch {
            // skip corrupted files
          }
        }
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
 * Save all projects. In Tauri mode, writes individual files to $APPDATA/projects/.
 * In browser mode, writes to localStorage.
 */
export async function saveProjects(projects: TourProject[]) {
  if (typeof window === "undefined") return;

  if (isTauri()) {
    try {
      await ensureDirectories();
      // Write each project as its own file
      for (const project of projects) {
        await writeProjectFile(project.id, JSON.stringify(project, null, 2));
      }
      // Remove orphaned files (projects that no longer exist)
      const existingIds = new Set(projects.map((p) => p.id));
      const storedIds = await listProjectFiles();
      for (const id of storedIds) {
        if (!existingIds.has(id)) {
          await deleteProjectFile(id);
        }
      }
    } catch (e) {
      console.error("Tauri storage save failed", e);
    }
    return;
  }

  // Browser fallback
  window.localStorage.setItem(KEY, JSON.stringify(projects));
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
  if (isTauri()) {
    const json = await readProjectFile(id);
    if (!json) return null;
    try {
      return JSON.parse(json) as TourProject;
    } catch {
      return null;
    }
  }
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
  const copy = cloneWithNewIds({ ...source, name: `${source.name} (copy)` });
  await upsertProject(copy);
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