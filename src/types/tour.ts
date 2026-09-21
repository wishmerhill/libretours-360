export type HotspotType = "door" | "info" | "arrow";

export interface Hotspot {
  id: string;
  type: HotspotType;
  /** degrees, -90 (down) .. 90 (up) */
  pitch: number;
  /** degrees, -180 .. 180 */
  yaw: number;
  tooltip: string;
  targetSceneId?: string | null;
  /** Markdown content for info-type hotspots */
  content?: string | undefined;
}

export interface Scene {
  id: string;
  name: string;
  /** http(s) url, data url, or "idb:<key>" / "tauri:<key>" reference to a locally stored image */
  panoramaUrl: string;
  defaultZoom: number;
  hotspots: Hotspot[];
}

export interface Theme {
  showNavbar: boolean;
  showTitleOverlay: boolean;
  logoUrl: string;
}

export interface Floorplan {
  id: string;
  name: string;
  imageUrl: string;
}

/**
 * Version of the on-disk project format. Bump it when the shape of TourProject
 * changes and add a step to `migrateProject` in lib/project-schema.ts.
 */
export const CURRENT_SCHEMA_VERSION = 1;

export interface TourProject {
  /** On-disk format version, see CURRENT_SCHEMA_VERSION. */
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  initialSceneId: string | null;
  scenes: Scene[];
  theme: Theme;
  floorplans: Floorplan[];
}

export const uid = (prefix = "id") =>
  `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;

export const defaultTheme = (): Theme => ({
  showNavbar: true,
  showTitleOverlay: true,
  logoUrl: "",
});

export const createProject = (name = "Untitled Tour"): TourProject => {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: uid("tour"),
    name,
    createdAt: now,
    updatedAt: now,
    initialSceneId: null,
    scenes: [],
    theme: defaultTheme(),
    floorplans: [],
  };
};