import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronDown,
  Compass,
  Download,
  Eye,
  EyeOff,
  FileArchive,
  FolderOutput,
  MapPin,
  PanelRightClose,
  PanelRightOpen,
  Ruler,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import type {
  Floorplan,
  Hotspot,
  MeasurePoint,
  Measurement,
  Scene,
  ScenePlacement,
  Theme,
  ThemeOverlayElement,
  ThemeOverlayElementStyle,
  ThemeOverlayElementType,
  TourProject,
} from "@/types/tour";
import { createThemeOverlayElement, uid } from "@/types/tour";
import type { ThemePreset } from "@/types/tour";
import { getProject, upsertProject } from "@/lib/storage";
import { ProjectValidationError, describeStorageError } from "@/lib/storage-errors";
import { deleteBlobs, resolveUrl } from "@/lib/assets";
import { deleteThemeAsset, putThemeAsset, resolveThemeAssetUrl } from "@/lib/theme-assets";
import {
  applyThemePreset,
  deleteThemePreset,
  exportThemeToFile,
  importThemeFile,
  listThemePresets,
  renameThemePreset,
  saveThemePreset,
} from "@/lib/theme-store";
import { ProjectSaver } from "@/lib/project-saver";
import {
  importPanoramaFiles,
  importPanoramaPaths,
  pickPanoramaPaths,
  readDroppedFile,
  type ImportedPanorama,
  type ImportProgress,
} from "@/lib/panorama-import";
import { exportWeb3D } from "@/lib/export";
import { exportCubemapStandalone } from "@/lib/cubemap";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { LeftSidebar, type SidebarTab } from "@/components/studio/LeftSidebar";
import { PropertiesPanel } from "@/components/studio/PropertiesPanel";
import { PanoCanvas } from "@/components/studio/PanoCanvas";
import { FloorplanMinimap } from "@/components/studio/FloorplanMinimap";
import { FloorplansPanel } from "@/components/studio/FloorplansPanel";
import { ThemeCanvas } from "@/components/studio/ThemeCanvas";
import { SceneGraphCanvas } from "@/components/studio/SceneGraphCanvas";
import type { GraphPoint } from "@/lib/scene-graph";
import { setViewMenuState } from "@/lib/app-menu";
import { ViewModeSwitch, type ViewMode } from "@/components/studio/ViewModeSwitch";
import { ThemeOverlayCanvas } from "@/components/studio/ThemeOverlayCanvas";
import { ThemeElementEditor } from "@/components/studio/ThemeElementEditor";
import { ReverseHotspotModal } from "@/components/studio/ReverseHotspotModal";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { cn } from "@/lib/utils";
import { getHotspotDefaults } from "@/lib/hotspot-defaults";

export const Route = createFileRoute("/editor/$id")({
  head: () => ({
    meta: [
      { title: "Tour Studio — LibreTours 360" },
      {
        name: "description",
        content:
          "Edit 360° scenes, place navigation and info hotspots, preview the tour and export a standalone viewer package.",
      },
      { property: "og:title", content: "Tour Studio — LibreTours 360" },
      {
        property: "og:description",
        content: "Place hotspots on 360° panoramas and export an interactive virtual tour.",
      },
    ],
  }),
  component: Studio,
});

function Studio() {
  const { t } = useTranslation();
  const { id } = useParams({ from: "/editor/$id" });
  const [project, setProject] = useState<TourProject | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Set when the project exists but cannot be opened (corrupted, no permission, ...).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [selectedHotspotId, setSelectedHotspotId] = useState<string | null>(null);
  const [mode, setMode] = useState<"editor" | "preview">("editor");
  const [placing, setPlacing] = useState(false);
  // Measurement tool: mutually exclusive with `placing`.
  const [measuring, setMeasuring] = useState(false);
  // View-only toggle, shared by editor and preview; the exported tour's default
  // is project.showMeasurements.
  const [showMeasurements, setShowMeasurements] = useState(true);
  const [selectedMeasurementId, setSelectedMeasurementId] = useState<string | null>(null);
  // Floor plan minimap: view-only toggle (the exported tour's default is
  // project.showFloorplan), expanded state, and the view it draws the cone from.
  const [showFloorplan, setShowFloorplan] = useState(true);
  const [floorplanExpanded, setFloorplanExpanded] = useState(false);
  const [panoView, setPanoView] = useState({ yaw: 0, fov: 90 });
  const [floorplanUrls, setFloorplanUrls] = useState<Record<string, string>>({});
  const [sceneUrls, setSceneUrls] = useState<Record<string, string>>({});
  const [logoPreviewUrl, setLogoPreviewUrl] = useState("");
  const [activeSidebarTab, setActiveSidebarTab] = useState<SidebarTab>("scenes");
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [reverseHotspotTargetId, setReverseHotspotTargetId] = useState<string | null>(null);
  // Scene graph view: open state and node positions (session only, not saved
  // with the project), kept here so they survive closing and reopening it.
  const [showGraph, setShowGraph] = useState(false);
  // The properties panel can be collapsed by the user, in Edit and in the graph.
  const [propertiesHidden, setPropertiesHidden] = useState(false);
  const [graphPositions, setGraphPositions] = useState<Record<string, GraphPoint>>({});
  const [themePresets, setThemePresets] = useState<ThemePreset[]>([]);

  // Always points at the latest project state, so saves triggered from timers
  // and lifecycle events never work on a stale closure.
  const projectRef = useRef<TourProject | null>(null);
  projectRef.current = project;
  // Tracks unsaved edits and image files waiting to be deleted. A panorama file is
  // only deleted after a project.json that no longer references it has been saved.
  const [saver] = useState(
    () =>
      new ProjectSaver({
        getProject: () => projectRef.current,
        save: upsertProject,
        deleteAssets: deleteBlobs,
        onAssetDeleteError: (e) => {
          console.error("Could not delete image files", e);
          toast.warning(t("editor.toasts.sceneImageDeleteFailed"), {
            description: describeStorageError(e),
          });
        },
      }),
  );

  /** Persists pending edits (if any). Returns false if the write failed. */
  const flushSave = useCallback(async (): Promise<boolean> => {
    try {
      await saver.flush();
      return true;
    } catch (e) {
      // Everything stays pending so the next flush (edit, unmount, page hide) retries.
      console.error("Autosave failed", e);
      toast.error(t("editor.toasts.autosaveFailed"), {
        id: "autosave-error",
        description: describeStorageError(e),
      });
      return false;
    }
  }, [saver, t]);

  useEffect(() => {
    (async () => {
      let found: TourProject | null = null;
      try {
        found = await getProject(id);
        setLoadError(null);
      } catch (e) {
        console.error("Could not open project", e);
        setLoadError(describeStorageError(e));
      }
      saver.reset();
      setProject(found);
      setActiveSceneId(found?.initialSceneId ?? found?.scenes[0]?.id ?? null);
      setLoaded(true);
    })();
    // Leaving the editor (or switching project) must not drop a pending autosave.
    return () => {
      void flushSave();
    };
  }, [id, flushSave, saver]);

  const refreshThemePresets = useCallback(() => {
    listThemePresets()
      .then(setThemePresets)
      .catch((e) => console.error("Could not load the theme library", e));
  }, []);

  // The theme library is app-wide (not tied to this project), loaded once.
  useEffect(() => {
    refreshThemePresets();
  }, [refreshThemePresets]);

  // Flush when the window is closed or hidden; the debounce timer would be lost.
  useEffect(() => {
    const onHide = () => {
      void flushSave();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    window.addEventListener("beforeunload", onHide);
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flushSave]);

  // Only the scene ids and image references matter here, so edits to names,
  // hotspots, etc. do not re-resolve (and re-check on disk) every panorama.
  const panoramaSignature = project
    ? JSON.stringify(project.scenes.map((s) => [s.id, s.panoramaUrl]))
    : "";

  useEffect(() => {
    const current = projectRef.current;
    if (!current) return;
    const { id: projectId, scenes } = current;
    let active = true;
    (async () => {
      const entries: Record<string, string> = {};
      for (const scene of scenes) {
        try {
          entries[scene.id] = await resolveUrl(projectId, scene.panoramaUrl);
        } catch (e) {
          console.error(`Cannot load panorama of scene "${scene.name}"`, e);
          entries[scene.id] = "";
        }
        if (active && scene.panoramaUrl && !entries[scene.id]) {
          toast.error(t("editor.toasts.sceneImageMissing", { name: scene.name }), {
            id: `pano-missing:${scene.id}`,
            description: t("editor.toasts.sceneImageMissingHint"),
          });
        }
      }
      if (active) setSceneUrls(entries);
    })();
    return () => {
      active = false;
    };
  }, [panoramaSignature, t]);

  useEffect(() => {
    const current = projectRef.current;
    if (!current) return;
    const { id: projectId, theme } = current;
    let active = true;
    (async () => {
      try {
        const url = await resolveThemeAssetUrl(projectId, theme.logoUrl);
        if (active) setLogoPreviewUrl(url);
      } catch (e) {
        console.error("Cannot load the theme logo", e);
        if (active) setLogoPreviewUrl("");
      }
    })();
    return () => {
      active = false;
    };
  }, [project?.theme.logoUrl]);

  const floorplanSignature = project
    ? JSON.stringify(project.floorplans.map((f) => [f.id, f.imageUrl]))
    : "";

  useEffect(() => {
    const current = projectRef.current;
    if (!current) return;
    const { id: projectId, floorplans } = current;
    let active = true;
    (async () => {
      const entries: Record<string, string> = {};
      for (const f of floorplans) {
        try {
          entries[f.id] = await resolveThemeAssetUrl(projectId, f.imageUrl);
        } catch (e) {
          console.error(`Cannot load floor plan "${f.name}"`, e);
          entries[f.id] = "";
        }
      }
      if (active) setFloorplanUrls(entries);
    })();
    return () => {
      active = false;
    };
  }, [floorplanSignature]);

  const sortedFloorplans = useMemo(
    () => [...(project?.floorplans ?? [])].sort((a, b) => a.level - b.level),
    [project?.floorplans],
  );

  const activeScene = useMemo(
    () => project?.scenes.find((s) => s.id === activeSceneId) ?? null,
    [project, activeSceneId],
  );

  // Autosave edits to storage (debounced). Only runs after a real user edit,
  // so merely opening a project never rewrites it or bumps its updatedAt.
  useEffect(() => {
    if (!loaded || !project || !saver.needsSave) return;
    const timer = window.setTimeout(() => {
      void flushSave();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [project, loaded, flushSave, saver]);

  // Only a scene placed on a plan has a minimap.
  const activeScenePlaced = !!(
    activeScene?.floorplanPosition &&
    project?.floorplans.some((f) => f.id === activeScene.floorplanPosition!.floorplanId)
  );

  const selectedHotspot = useMemo(
    () => activeScene?.hotspots.find((h) => h.id === selectedHotspotId) ?? null,
    [activeScene, selectedHotspotId],
  );

  const selectedMeasurement = useMemo(
    () => activeScene?.measurements.find((m) => m.id === selectedMeasurementId) ?? null,
    [activeScene, selectedMeasurementId],
  );

  // A measurement belongs to its scene: leaving the scene drops the selection
  // and any half-drawn line.
  useEffect(() => {
    setSelectedMeasurementId(null);
    setMeasuring(false);
  }, [activeSceneId]);

  const selectedOverlay = useMemo(
    () => project?.theme.overlays.find((el) => el.id === selectedOverlayId) ?? null,
    [project, selectedOverlayId],
  );

  const update = useCallback(
    (updater: (draft: TourProject) => TourProject) => {
      saver.markDirty();
      setProject((prev) => (prev ? updater(prev) : prev));
    },
    [saver],
  );

  /**
   * Explicit save (Save button, exports). Writes the latest state and merges only
   * the new updatedAt back, so edits made while the write is in flight are kept.
   * Throws on I/O failure.
   */
  const saveNow = async (): Promise<TourProject | null> => {
    const saved = await saver.flush({ force: true });
    if (saved) setProject((prev) => (prev ? { ...prev, updatedAt: saved.updatedAt } : prev));
    return saved;
  };

  /** "Show in folder" toast action, for exports written to disk (desktop app). */
  const revealAction = (indexPath: string | undefined) =>
    indexPath
      ? {
          action: {
            label: t("editor.toasts.showInFolder"),
            onClick: () => {
              void import("@tauri-apps/plugin-opener").then((m) => m.revealItemInDir(indexPath));
            },
          },
        }
      : {};

  /** Web 3D export: index.html + panoramas, to upload to a web server. */
  const runWeb3DExport = async () => {
    const toastId = toast.loading(t("editor.toasts.preparingExport"));
    try {
      const saved = await saveNow();
      if (!saved) {
        toast.dismiss(toastId);
        return;
      }
      const result = await exportWeb3D(saved);
      if (result.status === "cancelled") {
        toast.info(t("editor.toasts.exportCancelled"), { id: toastId });
        return;
      }
      toast.success(t("editor.toasts.export3dDone"), {
        id: toastId,
        description: t("editor.toasts.web3dExportLocation", { location: result.location }),
        ...revealAction(result.indexPath),
      });
    } catch (e) {
      console.error("Export failed", e);
      toast.error(t("editor.toasts.exportFailed"), {
        id: toastId,
        description: t("editor.toasts.exportFailedHint", { error: describeStorageError(e) }),
      });
    }
  };

  /** Standalone folder export: index.html + cubemap faces, opens with a double click. */
  const runCubemapExport = async () => {
    const toastId = toast.loading(t("editor.toasts.preparingExport"));
    try {
      const saved = await saveNow();
      if (!saved) {
        toast.dismiss(toastId);
        return;
      }
      const result = await exportCubemapStandalone(saved, {
        onProgress: (p) => {
          const percent = Math.round(p.fraction * 100);
          toast.loading(
            t("editor.toasts.exportingProgress", {
              sceneName: p.sceneName,
              current: p.sceneIndex + 1,
              total: p.sceneCount,
              percent,
            }),
            { id: toastId },
          );
        },
      });
      if (result.status === "cancelled") {
        toast.info(t("editor.toasts.exportCancelled"), { id: toastId });
        return;
      }
      toast.success(t("editor.toasts.standaloneExportDone"), {
        id: toastId,
        description: t("editor.toasts.standaloneExportLocation", { location: result.location }),
        ...revealAction(result.indexPath),
      });
    } catch (e) {
      console.error("Cubemap export failed", e);
      toast.error(t("editor.toasts.exportFailed"), {
        id: toastId,
        description: e instanceof Error ? e.message : describeStorageError(e),
      });
    }
  };

  const patchScene = (sceneId: string, patch: Partial<Scene>) =>
    update((draft) => ({
      ...draft,
      scenes: draft.scenes.map((s) => (s.id === sceneId ? { ...s, ...patch } : s)),
    }));

  const patchHotspot = (hotspotId: string, patch: Partial<Hotspot>) =>
    update((draft) => ({
      ...draft,
      scenes: draft.scenes.map((s) =>
        s.id === activeSceneId
          ? {
              ...s,
              hotspots: s.hotspots.map((h) => (h.id === hotspotId ? { ...h, ...patch } : h)),
            }
          : s,
      ),
    }));

  /**
   * Applies a hotspot edit from the properties panel. When a navigation hotspot
   * gets a new target, its tooltip becomes "Go to {scene}" - but only if the user
   * has not written a custom one (empty, the new-hotspot default, or the previous
   * automatic text are all considered replaceable).
   */
  const handleHotspotChange = (hotspot: Hotspot, patch: Partial<Hotspot>) => {
    const nextTargetId = patch.targetSceneId;
    const type = patch.type ?? hotspot.type;
    if (
      getHotspotDefaults().autoTooltipOnTarget &&
      nextTargetId &&
      nextTargetId !== hotspot.targetSceneId &&
      type === "nav" &&
      patch.tooltip === undefined
    ) {
      const sceneName = (id: string | null | undefined) =>
        project?.scenes.find((s) => s.id === id)?.name;
      const previousName = sceneName(hotspot.targetSceneId);
      const replaceable = [
        "",
        t("editor.defaults.newHotspotTooltip"),
        previousName !== undefined
          ? t("editor.defaults.goToScene", { sceneName: previousName })
          : null,
      ];
      const targetName = sceneName(nextTargetId);
      if (targetName !== undefined && replaceable.includes(hotspot.tooltip.trim())) {
        patch = { ...patch, tooltip: t("editor.defaults.goToScene", { sceneName: targetName }) };
      }
    }
    patchHotspot(hotspot.id, patch);
  };

  /** Adds one scene per imported panorama and tells the user what happened. */
  const addImportedScenes = async (
    importer: (projectId: string, onProgress: ImportProgress) => Promise<ImportedPanorama[]>,
  ) => {
    const projectId = projectRef.current?.id;
    if (!projectId) return;
    // Large panoramas take a while each: keep a visible progress toast so a
    // long import is never mistaken for one that silently did nothing.
    const toastId = toast.loading(t("editor.toasts.importingPanoramas"));
    let imported: ImportedPanorama[];
    try {
      imported = await importer(projectId, (current, total, name) =>
        toast.loading(t("editor.toasts.importingProgress", { name, current, total }), {
          id: toastId,
        }),
      );
    } catch (e) {
      console.error("Could not import panoramas", e);
      toast.error(t("editor.toasts.importPanoramasFailed"), {
        id: toastId,
        description: describeStorageError(e),
      });
      return;
    }
    if (!imported.length) {
      toast.dismiss(toastId);
      return;
    }

    const newScenes: Scene[] = imported.map((p) => ({
      id: uid("scene"),
      name: p.name,
      panoramaUrl: p.ref,
      defaultZoom: 1,
      defaultYaw: 0,
      defaultPitch: 0,
      hotspots: [],
      measurements: [],
      floorplanPosition: null,
    }));
    update((draft) => ({
      ...draft,
      scenes: [...draft.scenes, ...newScenes],
      initialSceneId: draft.initialSceneId ?? newScenes[0]!.id,
    }));
    setActiveSceneId((prev) => prev ?? newScenes[0]!.id);
    toast.success(t("editor.toasts.scenesAdded", { count: newScenes.length }), { id: toastId });
    if (imported.some((p) => p.thumbnailFailed)) {
      toast.warning(t("editor.toasts.previewsFailed"), {
        description: t("editor.toasts.previewsFailedHint"),
      });
    }
  };

  /** Drag & drop and browser file input: File objects. */
  const handleFiles = async (files: FileList | File[]) => {
    const images = Array.from(files).filter((f) => /image\/(jpeg|png|webp)/.test(f.type));
    if (!images.length) {
      toast.error(t("editor.toasts.onlyImagesSupported"));
      return;
    }
    await addImportedScenes((projectId, onProgress) =>
      importPanoramaFiles(projectId, images, onProgress),
    );
  };

  /** Stores the picked logo image locally and points theme.logoUrl at it; the old one is dropped. */
  const handleLogoFile = async (file: File) => {
    const projectId = projectRef.current?.id;
    if (!projectId) return;
    const previousRef = projectRef.current?.theme.logoUrl ?? "";
    try {
      const ref = await putThemeAsset(projectId, uid("logo"), file);
      update((draft) => ({ ...draft, theme: { ...draft.theme, logoUrl: ref } }));
      if (previousRef) {
        deleteThemeAsset(projectId, previousRef).catch((e) =>
          console.warn("Could not delete the previous logo", e),
        );
      }
    } catch (e) {
      console.error("Could not upload the logo", e);
      toast.error(t("editor.toasts.logoUploadFailed"), { description: describeStorageError(e) });
    }
  };

  /** Tauri: a logo dropped onto the window arrives as a path. */
  const handleLogoDropPath = async (path: string) => {
    let file: File;
    try {
      file = await readDroppedFile(path);
    } catch (e) {
      console.error("Could not read the dropped logo", e);
      toast.error(t("editor.toasts.logoUploadFailed"), { description: describeStorageError(e) });
      return;
    }
    await handleLogoFile(file);
  };

  const handleRemoveLogo = () => {
    const projectId = projectRef.current?.id;
    const previousRef = projectRef.current?.theme.logoUrl ?? "";
    update((draft) => ({ ...draft, theme: { ...draft.theme, logoUrl: "" } }));
    if (projectId && previousRef) {
      deleteThemeAsset(projectId, previousRef).catch((e) =>
        console.warn("Could not delete the logo", e),
      );
    }
  };

  const patchFloorplan = (floorplanId: string, patch: Partial<Floorplan>) =>
    update((draft) => ({
      ...draft,
      floorplans: draft.floorplans.map((f) => (f.id === floorplanId ? { ...f, ...patch } : f)),
    }));

  /** Stores a floor plan image and returns its reference, or null (after a toast) on failure. */
  const storeFloorplanImage = async (file: File): Promise<string | null> => {
    const projectId = projectRef.current?.id;
    if (!projectId) return null;
    try {
      return await putThemeAsset(projectId, uid("floorplan-img"), file);
    } catch (e) {
      console.error("Could not upload the floor plan", e);
      toast.error(t("editor.toasts.floorplanUploadFailed"), {
        description: describeStorageError(e),
      });
      return null;
    }
  };

  const handleAddFloorplan = async (file: File) => {
    const ref = await storeFloorplanImage(file);
    if (!ref) return;
    const floorplan: Floorplan = {
      id: uid("floorplan"),
      name: file.name.replace(/\.[^.]+$/, ""),
      imageUrl: ref,
      level: 0,
    };
    update((draft) => {
      const levels = draft.floorplans.map((f) => f.level);
      // The next storey up, so a new plan never lands on an existing level by default.
      const level = levels.length ? Math.floor(Math.max(...levels)) + 1 : 0;
      return { ...draft, floorplans: [...draft.floorplans, { ...floorplan, level }] };
    });
  };

  const handleReplaceFloorplanImage = async (floorplanId: string, file: File) => {
    const projectId = projectRef.current?.id;
    const previousRef =
      projectRef.current?.floorplans.find((f) => f.id === floorplanId)?.imageUrl ?? "";
    const ref = await storeFloorplanImage(file);
    if (!ref) return;
    patchFloorplan(floorplanId, { imageUrl: ref });
    if (projectId && previousRef) {
      deleteThemeAsset(projectId, previousRef).catch((e) =>
        console.warn("Could not delete the previous floor plan image", e),
      );
    }
  };

  /** Removes the floor plan and takes every scene placed on it off the plan. */
  const handleDeleteFloorplan = (floorplanId: string) => {
    const projectId = projectRef.current?.id;
    const previousRef =
      projectRef.current?.floorplans.find((f) => f.id === floorplanId)?.imageUrl ?? "";
    update((draft) => ({
      ...draft,
      floorplans: draft.floorplans.filter((f) => f.id !== floorplanId),
      scenes: draft.scenes.map((s) =>
        s.floorplanPosition?.floorplanId === floorplanId ? { ...s, floorplanPosition: null } : s,
      ),
    }));
    if (projectId && previousRef) {
      deleteThemeAsset(projectId, previousRef).catch((e) =>
        console.warn("Could not delete the floor plan image", e),
      );
    }
  };

  const setScenePlacement = (sceneId: string, placement: ScenePlacement | null) =>
    patchScene(sceneId, { floorplanPosition: placement });

  /** Sidebar floor picker: a newly placed scene starts in the middle, to be moved on the minimap. */
  const handleSceneFloorChange = (floorplanId: string | null) => {
    if (!activeScene) return;
    if (!floorplanId) {
      setScenePlacement(activeScene.id, null);
      return;
    }
    const current = activeScene.floorplanPosition;
    setScenePlacement(activeScene.id, {
      floorplanId,
      x: current?.floorplanId === floorplanId ? current.x : 0.5,
      y: current?.floorplanId === floorplanId ? current.y : 0.5,
      heading: current?.heading ?? 0,
    });
    setShowFloorplan(true);
    setFloorplanExpanded(true);
  };

  const handleActiveSidebarTabChange = (tab: SidebarTab) => {
    setActiveSidebarTab(tab);
    if (tab !== "theme") setSelectedOverlayId(null);
  };

  const patchOverlay = (elementId: string, patch: Partial<ThemeOverlayElement>) =>
    update((draft) => ({
      ...draft,
      theme: {
        ...draft.theme,
        overlays: draft.theme.overlays.map((el) =>
          el.id === elementId ? { ...el, ...patch } : el,
        ),
      },
    }));

  const patchOverlayStyle = (elementId: string, patch: Partial<ThemeOverlayElementStyle>) =>
    update((draft) => ({
      ...draft,
      theme: {
        ...draft.theme,
        overlays: draft.theme.overlays.map((el) =>
          el.id === elementId ? { ...el, style: { ...el.style, ...patch } } : el,
        ),
      },
    }));

  const handleOverlayAdd = (type: ThemeOverlayElementType) => {
    const element = createThemeOverlayElement(type);
    update((draft) => ({
      ...draft,
      theme: { ...draft.theme, overlays: [...draft.theme.overlays, element] },
    }));
    setSelectedOverlayId(element.id);
  };

  const handleOverlayDelete = (elementId: string) => {
    const projectId = projectRef.current?.id;
    const element = projectRef.current?.theme.overlays.find((el) => el.id === elementId);
    update((draft) => ({
      ...draft,
      theme: {
        ...draft.theme,
        overlays: draft.theme.overlays.filter((el) => el.id !== elementId),
      },
    }));
    setSelectedOverlayId((prev) => (prev === elementId ? null : prev));
    if (projectId && element && element.type !== "text" && element.content) {
      deleteThemeAsset(projectId, element.content).catch((e) =>
        console.warn("Could not delete the overlay image", e),
      );
    }
  };

  const handleOverlayReorder = (elementId: string, direction: "up" | "down") => {
    update((draft) => {
      const overlays = [...draft.theme.overlays];
      const index = overlays.findIndex((el) => el.id === elementId);
      const swapWith = direction === "up" ? index - 1 : index + 1;
      if (index < 0 || swapWith < 0 || swapWith >= overlays.length) return draft;
      [overlays[index], overlays[swapWith]] = [overlays[swapWith]!, overlays[index]!];
      return { ...draft, theme: { ...draft.theme, overlays } };
    });
  };

  /** Moves a scene to `toIndex` (index in the list after the scene has been removed). */
  const handleReorderScene = (sceneId: string, toIndex: number) => {
    update((draft) => {
      const scenes = [...draft.scenes];
      const from = scenes.findIndex((s) => s.id === sceneId);
      if (from < 0 || from === toIndex) return draft;
      const [moved] = scenes.splice(from, 1);
      scenes.splice(toIndex, 0, moved!);
      return { ...draft, scenes };
    });
  };

  /** Makes a scene the start scene and moves it to the top of the list. */
  const handleSetInitialScene = (sceneId: string) => {
    update((draft) => {
      const scene = draft.scenes.find((s) => s.id === sceneId);
      if (!scene) return draft;
      const scenes = [scene, ...draft.scenes.filter((s) => s.id !== sceneId)];
      return { ...draft, scenes, initialSceneId: sceneId };
    });
  };

  /** Stores the picked image locally and points the overlay element's content at it; the old one is dropped. */
  const handleOverlayImageFile = async (elementId: string, file: File) => {
    const projectId = projectRef.current?.id;
    if (!projectId) return;
    const previousRef =
      projectRef.current?.theme.overlays.find((el) => el.id === elementId)?.content ?? "";
    try {
      const ref = await putThemeAsset(projectId, uid("overlay-img"), file);
      patchOverlay(elementId, { content: ref });
      if (previousRef) {
        deleteThemeAsset(projectId, previousRef).catch((e) =>
          console.warn("Could not delete the previous overlay image", e),
        );
      }
    } catch (e) {
      console.error("Could not upload the overlay image", e);
      toast.error(t("editor.toasts.logoUploadFailed"), { description: describeStorageError(e) });
    }
  };

  const handleSaveThemePreset = async (name: string) => {
    const proj = projectRef.current;
    if (!proj) return;
    try {
      await saveThemePreset(name, proj.theme, proj.id);
      refreshThemePresets();
      toast.success(t("editor.theme.library.savedToast"));
    } catch (e) {
      console.error("Could not save the theme preset", e);
      toast.error(t("editor.theme.library.saveFailedToast"), {
        description: describeStorageError(e),
      });
    }
  };

  /** Materializes the preset's assets into this project and replaces the current theme with it. */
  const handleApplyThemePreset = async (preset: ThemePreset) => {
    const proj = projectRef.current;
    if (!proj) return;
    const previousLogo = proj.theme.logoUrl;
    const previousOverlayRefs = proj.theme.overlays
      .filter((el) => el.type !== "text" && el.content)
      .map((el) => el.content);
    try {
      const theme = await applyThemePreset(preset, proj.id);
      update((draft) => ({ ...draft, theme }));
      setSelectedOverlayId(null);
      toast.success(t("editor.theme.library.appliedToast", { name: preset.name }));
      if (previousLogo) {
        deleteThemeAsset(proj.id, previousLogo).catch((e) =>
          console.warn("Could not delete the previous logo", e),
        );
      }
      for (const ref of previousOverlayRefs) {
        deleteThemeAsset(proj.id, ref).catch((e) =>
          console.warn("Could not delete a previous overlay image", e),
        );
      }
    } catch (e) {
      console.error("Could not apply the theme preset", e);
      toast.error(t("editor.theme.library.applyFailedToast"), {
        description: describeStorageError(e),
      });
    }
  };

  const handleRenameThemePreset = async (presetId: string, name: string) => {
    try {
      await renameThemePreset(presetId, name);
      refreshThemePresets();
    } catch (e) {
      console.error("Could not rename the theme preset", e);
      toast.error(t("editor.theme.library.renameFailedToast"), {
        description: describeStorageError(e),
      });
    }
  };

  const handleDeleteThemePreset = async (presetId: string) => {
    try {
      await deleteThemePreset(presetId);
      refreshThemePresets();
    } catch (e) {
      console.error("Could not delete the theme preset", e);
      toast.error(t("editor.theme.library.deleteFailedToast"), {
        description: describeStorageError(e),
      });
    }
  };

  const handleExportTheme = async () => {
    const proj = projectRef.current;
    if (!proj) return;
    try {
      const location = await exportThemeToFile(proj.name, proj.theme, proj.id);
      if (location) toast.success(t("common.savedTo", { location }));
    } catch (e) {
      console.error("Could not export the theme", e);
      toast.error(t("editor.theme.library.exportFailedToast"), {
        description: describeStorageError(e),
      });
    }
  };

  const handleImportThemeFile = async (file: File) => {
    const proj = projectRef.current;
    if (!proj) return;
    let result: { theme: Theme; preset: ThemePreset };
    try {
      result = await importThemeFile(await file.text(), proj.id);
    } catch (e) {
      console.error("Theme import rejected", e);
      toast.error(t("editor.theme.library.invalidFileToast"), {
        description:
          e instanceof ProjectValidationError
            ? e.message
            : t("editor.theme.library.importFailedToast"),
      });
      return;
    }
    update((draft) => ({ ...draft, theme: result.theme }));
    setSelectedOverlayId(null);
    refreshThemePresets();
    toast.success(t("editor.theme.library.importedToast", { name: result.preset.name }));
  };

  /** Tauri: native file dialog, files are copied natively into the project folder. */
  const handlePickPanoramas = async () => {
    let paths: string[] | null;
    try {
      paths = await pickPanoramaPaths();
    } catch (e) {
      console.error("File dialog failed", e);
      toast.error(t("editor.toasts.fileDialogFailed"), { description: describeStorageError(e) });
      return;
    }
    if (!paths?.length) return; // cancelled
    await handlePanoramaPaths(paths);
  };

  /** Tauri: paths from the native dialog or dropped onto the window, copied natively. */
  const handlePanoramaPaths = async (paths: string[]) => {
    await addImportedScenes((projectId, onProgress) =>
      importPanoramaPaths(projectId, paths, onProgress),
    );
  };

  const handleDeleteScene = async (sceneId: string) => {
    const current = projectRef.current;
    const scene = current?.scenes.find((s) => s.id === sceneId);
    if (!current || !scene) return;

    const scenes = current.scenes
      .filter((s) => s.id !== sceneId)
      .map((s) => ({
        ...s,
        hotspots: s.hotspots.map((h) =>
          h.targetSceneId === sceneId ? { ...h, targetSceneId: null } : h,
        ),
      }));
    const next: TourProject = {
      ...current,
      scenes,
      initialSceneId:
        current.initialSceneId === sceneId ? (scenes[0]?.id ?? null) : current.initialSceneId,
    };
    // The save below must see the removal before React re-renders.
    projectRef.current = next;
    setProject(next);
    if (activeSceneId === sceneId) {
      setActiveSceneId(scenes[0]?.id ?? null);
      setSelectedHotspotId(null);
    }

    // project.json is written first; the image (and its thumbnail) are deleted by
    // the saver only after that write succeeded, so a crash can never leave a
    // project pointing to a file that is gone. If the write fails they stay queued.
    saver.queueAssetDeletion([scene.panoramaUrl]);
    await flushSave();
  };

  const addHotspot = (pitch: number, yaw: number) => {
    if (!activeSceneId) return;
    const hotspot: Hotspot = {
      id: uid("hs"),
      type: "nav",
      pitch,
      yaw,
      tooltip: t("editor.defaults.newHotspotTooltip"),
      targetSceneId: null,
    };
    update((draft) => ({
      ...draft,
      scenes: draft.scenes.map((s) =>
        s.id === activeSceneId ? { ...s, hotspots: [...s.hotspots, hotspot] } : s,
      ),
    }));
    selectHotspot(hotspot.id);
    setPlacing(false);
  };

  const selectHotspot = (hotspotId: string | null) => {
    setSelectedHotspotId(hotspotId);
    if (hotspotId) setSelectedMeasurementId(null);
  };

  const selectMeasurement = (measurementId: string | null) => {
    setSelectedMeasurementId(measurementId);
    if (measurementId) setSelectedHotspotId(null);
  };

  const patchMeasurements = (fn: (list: Measurement[]) => Measurement[]) =>
    update((draft) => ({
      ...draft,
      scenes: draft.scenes.map((s) =>
        s.id === activeSceneId ? { ...s, measurements: fn(s.measurements) } : s,
      ),
    }));

  const addMeasurement = (a: MeasurePoint, b: MeasurePoint) => {
    if (!activeSceneId) return;
    const measurement: Measurement = { id: uid("ms"), a, b, label: "" };
    patchMeasurements((list) => [...list, measurement]);
    selectMeasurement(measurement.id);
    setMeasuring(false);
  };

  const updateMeasurement = (measurementId: string, patch: Partial<Measurement>) =>
    patchMeasurements((list) => list.map((m) => (m.id === measurementId ? { ...m, ...patch } : m)));

  const moveMeasurementPoint = (measurementId: string, end: "a" | "b", pos: MeasurePoint) =>
    updateMeasurement(measurementId, { [end]: pos });

  const deleteMeasurement = (measurementId: string) => {
    patchMeasurements((list) => list.filter((m) => m.id !== measurementId));
    if (selectedMeasurementId === measurementId) setSelectedMeasurementId(null);
  };

  const toggleMeasuring = () => {
    if (!measuring) {
      setPlacing(false);
      // Drawing an invisible line would be confusing.
      setShowMeasurements(true);
    }
    setMeasuring(!measuring);
  };

  const handleSave = async () => {
    try {
      if (await saveNow()) toast.success(t("editor.toasts.projectSaved"));
    } catch (e) {
      console.error("Save failed", e);
      toast.error(t("editor.toasts.saveFailed"), { description: describeStorageError(e) });
    }
  };

  const handleCreateReverseHotspot = (targetSceneId: string) => {
    setReverseHotspotTargetId(targetSceneId);
  };

  const handleConfirmReverseHotspot = (pitch: number, yaw: number) => {
    if (!reverseHotspotTargetId || !activeSceneId) return;

    const currentSceneName = activeScene?.name ?? t("editor.defaults.previousScene");

    const reverseHotspot: Hotspot = {
      id: uid("hs"),
      type: "nav",
      pitch,
      yaw,
      tooltip: t("editor.defaults.returnToScene", { sceneName: currentSceneName }),
      targetSceneId: activeSceneId,
    };

    update((draft) => ({
      ...draft,
      scenes: draft.scenes.map((s) =>
        s.id === reverseHotspotTargetId ? { ...s, hotspots: [...s.hotspots, reverseHotspot] } : s,
      ),
    }));

    toast.success(t("editor.toasts.returnHotspotCreated"));
  };

  // The graph covers the viewer and keeps `mode` as it was, so leaving it goes
  // back to editing or previewing.
  const viewMode: ViewMode = showGraph ? "graph" : mode;
  const graphAvailable = (project?.scenes.length ?? 0) > 0;
  // Shown while editing and in the graph, whichever mode the graph was opened from.
  const propertiesAvailable = mode === "editor" || showGraph;
  // The theme tab has its own canvas over the viewer: no switching there.
  const viewSwitchAvailable = activeSidebarTab !== "theme";
  const changeViewMode = useCallback((next: ViewMode) => {
    setPlacing(false);
    setMeasuring(false);
    if (next === "graph") {
      setShowGraph(true);
      return;
    }
    setShowGraph(false);
    setMode(next);
    if (next === "preview") {
      setSelectedHotspotId(null);
      setSelectedMeasurementId(null);
    }
  }, []);
  // Double click on a scene, in the graph or in the scene list while the graph is shown.
  const openSceneFromGraph = useCallback((sceneId: string) => {
    setActiveSceneId(sceneId);
    setSelectedHotspotId(null);
    setShowGraph(false);
  }, []);

  // View > Edit / Preview / Scene graph in the macOS menu bar mirror the switch.
  useEffect(() => {
    setViewMenuState({
      active: viewMode,
      enabled: {
        editor: viewSwitchAvailable,
        preview: viewSwitchAvailable,
        graph: viewSwitchAvailable && graphAvailable,
      },
      onSelect: changeViewMode,
    });
  }, [viewMode, viewSwitchAvailable, graphAvailable, changeViewMode]);
  useEffect(() => () => setViewMenuState(null), []);

  if (!loaded) return <div className="min-h-screen bg-background" />;

  if (!project) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4 text-center">
        <h1 className="text-lg font-semibold">
          {loadError ? t("editor.notFound.cannotOpen") : t("editor.notFound.notFound")}
        </h1>
        {loadError && <p className="max-w-md text-sm text-muted-foreground">{loadError}</p>}
        <Button asChild size="sm">
          <Link to="/">{t("editor.notFound.backToProjects")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-sidebar px-3">
        <Button asChild size="sm" variant="ghost">
          <Link to="/">
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> {t("editor.header.backToProjects")}
          </Link>
        </Button>
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Compass className="h-3.5 w-3.5" />
        </span>
        <Input
          value={project.name}
          onChange={(e) => update((draft) => ({ ...draft, name: e.target.value }))}
          className="h-8 w-56 border-transparent bg-transparent text-sm font-semibold hover:border-border focus-visible:border-input"
        />
        <Badge variant="secondary" className="text-[10px]">
          {t("editor.header.scenesCount", { count: project.scenes.length })}
        </Badge>

        <div className="ml-auto flex items-center gap-2">
          <LanguageSwitcher />
          <Button
            size="sm"
            variant={placing ? "default" : "secondary"}
            disabled={viewMode !== "editor" || !activeScene}
            onClick={() => {
              setPlacing((p) => !p);
              setMeasuring(false);
            }}
          >
            <MapPin className="mr-1.5 h-3.5 w-3.5" /> {t("editor.header.addHotspot")}
          </Button>
          <Button
            size="sm"
            variant={measuring ? "default" : "secondary"}
            disabled={viewMode !== "editor" || !activeScene}
            onClick={toggleMeasuring}
          >
            <Ruler className="mr-1.5 h-3.5 w-3.5" /> {t("editor.header.measure")}
          </Button>
          <Button size="sm" variant="secondary" onClick={handleSave}>
            <Save className="mr-1.5 h-3.5 w-3.5" /> {t("editor.header.save")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="default">
                <Download className="mr-1.5 h-3.5 w-3.5" /> {t("editor.header.export")}
                <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuItem onClick={runWeb3DExport}>
                <FileArchive className="mr-2 h-4 w-4" />
                {t("editor.header.exportServerWeb3d")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={runCubemapExport}>
                <FolderOutput className="mr-2 h-4 w-4" />
                {t("editor.header.exportStandalone3d")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <LeftSidebar
          scenes={project.scenes}
          sceneUrls={sceneUrls}
          activeSceneId={activeSceneId}
          initialSceneId={project.initialSceneId}
          theme={project.theme}
          logoPreviewUrl={logoPreviewUrl}
          activeTab={activeSidebarTab}
          onActiveTabChange={handleActiveSidebarTabChange}
          selectedOverlayId={selectedOverlayId}
          onOverlaySelect={setSelectedOverlayId}
          onOverlayAdd={handleOverlayAdd}
          onOverlayReorder={handleOverlayReorder}
          onOverlayDelete={handleOverlayDelete}
          onSelectScene={(sceneId) => {
            setActiveSceneId(sceneId);
            setSelectedHotspotId(null);
          }}
          onOpenScene={showGraph ? openSceneFromGraph : undefined}
          onDeleteScene={handleDeleteScene}
          onReorderScene={handleReorderScene}
          onSetInitialScene={handleSetInitialScene}
          onRenameScene={(sceneId, name) => patchScene(sceneId, { name })}
          onFiles={handleFiles}
          onPickNative={handlePickPanoramas}
          onDropPaths={handlePanoramaPaths}
          onThemeChange={(patch: Partial<Theme>) =>
            update((draft) => ({ ...draft, theme: { ...draft.theme, ...patch } }))
          }
          onLogoFileSelected={handleLogoFile}
          onLogoDropPath={handleLogoDropPath}
          onLogoRemove={handleRemoveLogo}
          themePresets={themePresets}
          onSaveThemePreset={handleSaveThemePreset}
          onApplyThemePreset={handleApplyThemePreset}
          onRenameThemePreset={handleRenameThemePreset}
          onDeleteThemePreset={handleDeleteThemePreset}
          onExportTheme={handleExportTheme}
          onImportThemeFile={handleImportThemeFile}
          floorplansPanel={
            <FloorplansPanel
              floorplans={sortedFloorplans}
              floorplanUrls={floorplanUrls}
              scenes={project.scenes}
              activeScene={activeScene}
              showInExport={project.showFloorplan}
              corner={project.floorplanCorner}
              onAdd={handleAddFloorplan}
              onChange={patchFloorplan}
              onReplaceImage={handleReplaceFloorplanImage}
              onDelete={handleDeleteFloorplan}
              onShowInExportChange={(value) =>
                update((draft) => ({ ...draft, showFloorplan: value }))
              }
              onCornerChange={(corner) =>
                update((draft) => ({ ...draft, floorplanCorner: corner }))
              }
              offset={project.floorplanOffset}
              onOffsetChange={(patch) =>
                update((draft) => ({
                  ...draft,
                  floorplanOffset: { ...draft.floorplanOffset, ...patch },
                }))
              }
              onSceneFloorChange={handleSceneFloorChange}
            />
          }
        />

        <div className="relative flex min-w-0 flex-1 flex-col">
          {activeSidebarTab !== "theme" && (
            <div className="pointer-events-none absolute inset-0 z-10">
              <ThemeOverlayCanvas
                projectId={project.id}
                projectName={project.name}
                sceneName={activeScene?.name ?? null}
                theme={project.theme}
                logoPreviewUrl={logoPreviewUrl}
              />
            </div>
          )}
          <PanoCanvas
            scene={activeScene}
            imageUrl={activeScene ? (sceneUrls[activeScene.id] ?? "") : ""}
            mode={mode}
            placing={placing}
            selectedHotspotId={selectedHotspotId}
            onSelectHotspot={selectHotspot}
            measuring={measuring}
            onCancelMeasuring={() => setMeasuring(false)}
            showMeasurements={showMeasurements}
            onToggleMeasurements={() => setShowMeasurements((v) => !v)}
            selectedMeasurementId={selectedMeasurementId}
            onSelectMeasurement={selectMeasurement}
            onAddMeasurement={addMeasurement}
            onMoveMeasurementPoint={moveMeasurementPoint}
            onViewChange={setPanoView}
            extraControls={
              activeScenePlaced && (
                <button
                  type="button"
                  onClick={() => setShowFloorplan((v) => !v)}
                  title={
                    showFloorplan
                      ? t("editor.viewer.floorplan.hide")
                      : t("editor.viewer.floorplan.show")
                  }
                  aria-pressed={showFloorplan}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border bg-slate-900/80 px-3 py-2 text-xs font-medium backdrop-blur-md transition-colors",
                    showFloorplan
                      ? "border-cyan-400/40 text-cyan-300 hover:text-cyan-200"
                      : "border-slate-700/50 text-slate-400 hover:text-white",
                  )}
                >
                  {showFloorplan ? (
                    <Eye className="h-3.5 w-3.5" />
                  ) : (
                    <EyeOff className="h-3.5 w-3.5" />
                  )}
                  {t("editor.viewer.floorplan.toggle")}
                </button>
              )
            }
            onAddHotspot={addHotspot}
            onMoveHotspot={(hotspotId, pitch, yaw) => patchHotspot(hotspotId, { pitch, yaw })}
            onNavigate={(sceneId) => {
              setActiveSceneId(sceneId);
              setSelectedHotspotId(null);
            }}
            onSetDefaultView={(view) => {
              if (!activeSceneId) return;
              patchScene(activeSceneId, {
                defaultYaw: view.yaw,
                defaultPitch: view.pitch,
                defaultZoom: view.zoom,
              });
              toast.success(t("editor.toasts.defaultViewSaved"));
            }}
          />

          {showFloorplan && activeSidebarTab !== "theme" && activeScenePlaced && (
            <FloorplanMinimap
              floorplans={sortedFloorplans}
              floorplanUrls={floorplanUrls}
              scenes={project.scenes}
              activeSceneId={activeSceneId}
              yaw={panoView.yaw}
              fov={panoView.fov}
              corner={project.floorplanCorner}
              offset={project.floorplanOffset}
              // Never over the Edit/Preview switch (top right), "Set default view"
              // (bottom left, edit mode) or the zoom bar (bottom right).
              clearTop={project.floorplanCorner === "top-right" ? 64 : 16}
              clearBottom={
                project.floorplanCorner === "bottom-right" || mode === "editor" ? 64 : 16
              }
              editable={mode === "editor"}
              expanded={floorplanExpanded}
              onExpandedChange={setFloorplanExpanded}
              onNavigate={(sceneId) => {
                setActiveSceneId(sceneId);
                setSelectedHotspotId(null);
              }}
              onPlaceScene={setScenePlacement}
            />
          )}

          {showGraph && activeSidebarTab !== "theme" && (
            <div className="absolute inset-0 z-20">
              <SceneGraphCanvas
                scenes={project.scenes}
                sceneUrls={sceneUrls}
                initialSceneId={project.initialSceneId}
                activeSceneId={activeSceneId}
                positions={graphPositions}
                onPositionsChange={setGraphPositions}
                onSelectScene={(sceneId) => {
                  setActiveSceneId(sceneId);
                  setSelectedHotspotId(null);
                }}
                onOpenScene={openSceneFromGraph}
              />
            </div>
          )}

          {viewSwitchAvailable && (
            <div className="absolute right-4 top-4 z-30 flex items-center gap-2">
              <ViewModeSwitch
                value={viewMode}
                onChange={changeViewMode}
                graphDisabled={!graphAvailable}
              />
              {propertiesAvailable && (
                <button
                  type="button"
                  onClick={() => setPropertiesHidden((v) => !v)}
                  title={
                    propertiesHidden
                      ? t("editor.viewer.showProperties")
                      : t("editor.viewer.hideProperties")
                  }
                  aria-pressed={!propertiesHidden}
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-700/50 bg-slate-900/80 text-slate-400 backdrop-blur-md transition-colors hover:text-white"
                >
                  {propertiesHidden ? (
                    <PanelRightOpen className="h-4 w-4" />
                  ) : (
                    <PanelRightClose className="h-4 w-4" />
                  )}
                </button>
              )}
            </div>
          )}

          {/* Theme Canvas mode: the 3D viewer stays mounted (avoids a costly re-init)
              but is dimmed/blurred and made non-interactive behind a 2D preview. */}
          {activeSidebarTab === "theme" && (
            <div className="absolute inset-0 z-20">
              <div className="absolute inset-0 bg-background/80 backdrop-blur-md" />
              <ThemeCanvas
                projectId={project.id}
                projectName={project.name}
                sceneName={activeScene?.name ?? null}
                theme={project.theme}
                logoPreviewUrl={logoPreviewUrl}
                selectedElementId={selectedOverlayId}
                onSelectElement={setSelectedOverlayId}
              />
            </div>
          )}
        </div>

        {activeSidebarTab === "theme"
          ? mode === "editor" && (
              <ThemeElementEditor
                projectId={project.id}
                element={selectedOverlay}
                onChange={(patch) => selectedOverlay && patchOverlay(selectedOverlay.id, patch)}
                onStyleChange={(patch) =>
                  selectedOverlay && patchOverlayStyle(selectedOverlay.id, patch)
                }
                onImageFileSelected={(file) =>
                  selectedOverlay && handleOverlayImageFile(selectedOverlay.id, file)
                }
                onDelete={() => selectedOverlay && handleOverlayDelete(selectedOverlay.id)}
              />
            )
          : propertiesAvailable &&
            !propertiesHidden && (
              <PropertiesPanel
                scene={activeScene}
                scenes={project.scenes}
                hotspot={selectedHotspot}
                measurement={selectedMeasurement}
                onMeasurementChange={(patch) =>
                  selectedMeasurement && updateMeasurement(selectedMeasurement.id, patch)
                }
                onSelectMeasurement={selectMeasurement}
                onDeleteMeasurement={deleteMeasurement}
                showMeasurementsInExport={project.showMeasurements}
                onShowMeasurementsInExportChange={(value) =>
                  update((draft) => ({ ...draft, showMeasurements: value }))
                }
                onSceneChange={(patch) => activeSceneId && patchScene(activeSceneId, patch)}
                onHotspotChange={(patch) =>
                  selectedHotspot && handleHotspotChange(selectedHotspot, patch)
                }
                onDeleteSelectedHotspot={() => {
                  if (!selectedHotspot || !activeSceneId) return;
                  update((draft) => ({
                    ...draft,
                    scenes: draft.scenes.map((s) =>
                      s.id === activeSceneId
                        ? { ...s, hotspots: s.hotspots.filter((h) => h.id !== selectedHotspot.id) }
                        : s,
                    ),
                  }));
                  setSelectedHotspotId(null);
                }}
                onSelectHotspot={selectHotspot}
                onDeleteHotspot={(id) => {
                  if (!activeSceneId) return;
                  update((draft) => ({
                    ...draft,
                    scenes: draft.scenes.map((s) =>
                      s.id === activeSceneId
                        ? { ...s, hotspots: s.hotspots.filter((h) => h.id !== id) }
                        : s,
                    ),
                  }));
                  if (selectedHotspotId === id) setSelectedHotspotId(null);
                }}
                onCreateReverseHotspot={handleCreateReverseHotspot}
              />
            )}

        {reverseHotspotTargetId && (
          <ReverseHotspotModal
            open={true}
            onOpenChange={(open) => {
              if (!open) setReverseHotspotTargetId(null);
            }}
            targetImageUrl={sceneUrls[reverseHotspotTargetId] ?? ""}
            targetSceneName={
              project.scenes.find((s) => s.id === reverseHotspotTargetId)?.name ??
              t("editor.defaults.targetSceneFallback")
            }
            onConfirm={handleConfirmReverseHotspot}
          />
        )}
      </div>
    </div>
  );
}
