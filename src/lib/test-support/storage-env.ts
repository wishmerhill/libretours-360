/**
 * Helpers for the storage tests: a fake browser environment, a fake Tauri
 * runtime backed by a real temporary folder, and small fixtures.
 */
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION, type TourProject } from "@/types/tour";
import { subscribeStorageIssues, type StorageIssue } from "../storage-errors";
import { setTauriApisForTesting } from "../tauri-storage";

// ─── Browser-like globals ──────────────────────────────────────────────────

/** In-memory localStorage (the one Node ships needs a file and warns). */
export function installLocalStorage(): Storage {
  const data = new Map<string, string>();
  const storage = {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  } as Storage;
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  return storage;
}

/** `window` exists (the code treats a missing window as server-side rendering). */
export function installWindow(options: { tauri: boolean }): void {
  (globalThis as Record<string, unknown>)["window"] = globalThis;
  if (options.tauri) (globalThis as Record<string, unknown>)["__TAURI_INTERNALS__"] = {};
  else delete (globalThis as Record<string, unknown>)["__TAURI_INTERNALS__"];
}

// ─── Fake Tauri runtime over a real folder ─────────────────────────────────

export interface FakeTauri {
  /** The $APPDATA folder. */
  root: string;
  /** Every file below projects/, as `projects/<...>` paths, sorted. */
  tree(): Promise<string[]>;
  cleanup(): Promise<void>;
}

async function walk(dir: string, prefix: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await walk(join(dir, entry.name), `${prefix}${entry.name}/`, out);
    else out.push(prefix + entry.name);
  }
}

/**
 * Installs Tauri APIs implemented with node:fs on a fresh temporary $APPDATA.
 * The errors are Node's own (ENOENT, ...), which the storage layer classifies.
 */
export async function installFakeTauri(): Promise<FakeTauri> {
  installWindow({ tauri: true });
  const root = await mkdtemp(join(tmpdir(), "opentour-storage-"));

  const fs = {
    mkdir: (p: string, o?: { recursive?: boolean }) => mkdir(p, o).then(() => undefined),
    writeTextFile: (p: string, text: string) => writeFile(p, text),
    writeFile: (p: string, bytes: Uint8Array) => writeFile(p, bytes),
    readTextFile: (p: string) => readFile(p, "utf8"),
    readFile: async (p: string) => new Uint8Array(await readFile(p)),
    exists: (p: string) =>
      stat(p).then(
        () => true,
        () => false,
      ),
    rename: (from: string, to: string) => rename(from, to),
    remove: (p: string, o?: { recursive?: boolean }) => rm(p, { recursive: o?.recursive ?? false }),
    copyFile: (from: string, to: string) => copyFile(from, to),
    readDir: async (p: string) =>
      (await readdir(p, { withFileTypes: true })).map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
        isSymlink: e.isSymbolicLink(),
      })),
  };
  const path = {
    appDataDir: async () => root,
    join: async (...parts: string[]) => join(...parts),
  };
  const core = { convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}` };

  setTauriApisForTesting({ fs, path, core } as never);

  return {
    root,
    async tree() {
      const out: string[] = [];
      await walk(join(root, "projects"), "projects/", out);
      return out.sort();
    },
    async cleanup() {
      setTauriApisForTesting(null);
      await rm(root, { recursive: true, force: true });
    },
  };
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

/** A tiny "image" whose bytes identify it. */
export function imageBlob(label: string, type = "image/png"): Blob {
  return new Blob([new TextEncoder().encode(`fake image ${label}`)], { type });
}

export async function textOf(blob: Blob | null): Promise<string | null> {
  return blob ? await blob.text() : null;
}

export function makeProject(id: string, overrides: Partial<TourProject> = {}): TourProject {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id,
    name: `Project ${id}`,
    createdAt: now,
    updatedAt: now,
    initialSceneId: null,
    scenes: [],
    theme: { showNavbar: true, showTitleOverlay: true, logoUrl: "", overlays: [] },
    floorplans: [],
    ...overrides,
  };
}

/** Records every storage issue reported while it is active. */
export function captureIssues(): { issues: StorageIssue[]; stop: () => void } {
  const issues: StorageIssue[] = [];
  const stop = subscribeStorageIssues((i) => issues.push(i));
  return { issues, stop };
}
