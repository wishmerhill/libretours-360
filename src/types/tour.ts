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
  /** degrees, -180 .. 180: camera yaw applied when the scene is opened */
  defaultYaw: number;
  /** degrees, -90 .. 90: camera pitch applied when the scene is opened */
  defaultPitch: number;
  hotspots: Hotspot[];
}

/** Anchor of an overlay element relative to the viewer's stage. */
export type ThemeOverlayAnchor =
  "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";

export type ThemeOverlayElementType = "logo" | "image" | "text";

export type ThemeOverlayOffsetUnit = "px" | "%";

export interface ThemeOverlayElementStyle {
  /** 0 (transparent) .. 1 (opaque) */
  opacity?: number | undefined;
  /** px */
  width?: number | undefined;
  /** px */
  height?: number | undefined;
  /** px */
  padding?: number | undefined;
  backgroundColor?: string | undefined;
  /** px */
  fontSize?: number | undefined;
  fontFamily?: string | undefined;
  color?: string | undefined;
  /** px */
  borderRadius?: number | undefined;
}

export interface ThemeOverlayElement {
  id: string;
  type: ThemeOverlayElementType;
  position: ThemeOverlayAnchor;
  offsetX: number;
  offsetY: number;
  offsetUnit: ThemeOverlayOffsetUnit;
  style: ThemeOverlayElementStyle;
  /**
   * "logo"/"image": empty, a data: URL, or an "asset:<key>" reference to a
   * locally stored image (see storage-layout.ts). "text": literal text,
   * which may contain variables such as "{{scene.title}}".
   */
  content: string;
}

export interface Theme {
  showNavbar: boolean;
  showTitleOverlay: boolean;
  /** Empty, a data: URL, or an "asset:<key>" reference to a locally stored image (never a remote URL). */
  logoUrl: string;
  overlays: ThemeOverlayElement[];
}

/** Alias for the theme, used where the richer (overlay-capable) shape is meant. */
export type ThemeConfig = Theme;

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
  overlays: [],
});

/** A freshly added overlay element, positioned so it is visible without further tweaking. */
export const createThemeOverlayElement = (type: ThemeOverlayElementType): ThemeOverlayElement => ({
  id: uid("overlay"),
  type,
  position: "top-right",
  offsetX: 16,
  offsetY: 16,
  offsetUnit: "px",
  style:
    type === "text"
      ? { fontSize: 14, color: "#f4f4f5", backgroundColor: "rgba(24, 24, 27, 0.75)", padding: 8 }
      : { width: 80, height: 80 },
  content: type === "text" ? "{{scene.title}}" : "",
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
