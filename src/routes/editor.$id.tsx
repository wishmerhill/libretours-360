import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronDown,
  Compass,
  Download,
  FileArchive,
  FolderOutput,
  MapPin,
  Monitor,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import type {
  Hotspot,
  Scene,
  Theme,
  ThemeOverlayElement,
  ThemeOverlayElementStyle,
  ThemeOverlayElementType,
  TourProject,
} from "@/types/tour";
import { createThemeOverlayElement, uid } from "@/types/tour";
import { getProject, upsertProject } from "@/lib/storage";
import { describeStorageError } from "@/lib/storage-errors";
import { deleteBlobs, resolveUrl } from "@/lib/assets";
import { deleteThemeAsset, putThemeAsset, resolveThemeAssetUrl } from "@/lib/theme-assets";
import { ProjectSaver } from "@/lib/project-saver";
import {
  importPanoramaFiles,
  importPanoramaPaths,
  pickPanoramaPaths,
  type ImportedPanorama,
} from "@/lib/panorama-import";
import { exportZip3D, exportZip2D } from "@/lib/export";
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
import { ThemeCanvas } from "@/components/studio/ThemeCanvas";
import { ThemeElementEditor } from "@/components/studio/ThemeElementEditor";
import { ReverseHotspotModal } from "@/components/studio/ReverseHotspotModal";
import { ExportDesktopModal } from "@/components/studio/ExportDesktopModal";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { cn } from "@/lib/utils";

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
  const [sceneUrls, setSceneUrls] = useState<Record<string, string>>({});
  const [logoPreviewUrl, setLogoPreviewUrl] = useState("");
  const [activeSidebarTab, setActiveSidebarTab] = useState<SidebarTab>("scenes");
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [reverseHotspotTargetId, setReverseHotspotTargetId] = useState<string | null>(null);
  const [exportDesktopOpen, setExportDesktopOpen] = useState(false);

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

  const selectedHotspot = useMemo(
    () => activeScene?.hotspots.find((h) => h.id === selectedHotspotId) ?? null,
    [activeScene, selectedHotspotId],
  );

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

  const runExport = async (
    exporter: (saved: TourProject) => Promise<void>,
    doneMessage: string,
  ) => {
    try {
      const saved = await saveNow();
      if (!saved) return;
      await exporter(saved);
      toast.success(doneMessage);
    } catch (e) {
      console.error("Export failed", e);
      toast.error(t("editor.toasts.exportFailed"), {
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
        toast.dismiss(toastId);
        return;
      }
      const { indexPath } = result;
      toast.success(t("editor.toasts.standaloneExportDone"), {
        id: toastId,
        description: t("editor.toasts.standaloneExportLocation", { location: result.location }),
        ...(indexPath && {
          action: {
            label: t("editor.toasts.showInFolder"),
            onClick: () => {
              void import("@tauri-apps/plugin-opener").then((m) => m.revealItemInDir(indexPath));
            },
          },
        }),
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

  /** Adds one scene per imported panorama and tells the user what happened. */
  const addImportedScenes = async (
    importer: (projectId: string) => Promise<ImportedPanorama[]>,
  ) => {
    const projectId = projectRef.current?.id;
    if (!projectId) return;
    let imported: ImportedPanorama[];
    try {
      imported = await importer(projectId);
    } catch (e) {
      console.error("Could not import panoramas", e);
      toast.error(t("editor.toasts.importPanoramasFailed"), {
        description: describeStorageError(e),
      });
      return;
    }
    if (!imported.length) return;

    const newScenes: Scene[] = imported.map((p) => ({
      id: uid("scene"),
      name: p.name,
      panoramaUrl: p.ref,
      defaultZoom: 1,
      defaultYaw: 0,
      defaultPitch: 0,
      hotspots: [],
    }));
    update((draft) => ({
      ...draft,
      scenes: [...draft.scenes, ...newScenes],
      initialSceneId: draft.initialSceneId ?? newScenes[0]!.id,
    }));
    setActiveSceneId((prev) => prev ?? newScenes[0]!.id);
    toast.success(t("editor.toasts.scenesAdded", { count: newScenes.length }));
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
    await addImportedScenes((projectId) => importPanoramaFiles(projectId, images));
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
    await addImportedScenes((projectId) => importPanoramaPaths(projectId, paths));
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
      type: "door",
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
    setSelectedHotspotId(hotspot.id);
    setPlacing(false);
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
      type: "door",
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
            disabled={mode !== "editor" || !activeScene}
            onClick={() => setPlacing((p) => !p)}
          >
            <MapPin className="mr-1.5 h-3.5 w-3.5" /> {t("editor.header.addHotspot")}
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
              <DropdownMenuItem
                onClick={() => runExport(exportZip2D, t("editor.toasts.export2dDone"))}
              >
                <FileArchive className="mr-2 h-4 w-4" />
                {t("editor.header.exportOffline2d")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setExportDesktopOpen(true)}>
                <Monitor className="mr-2 h-4 w-4" />
                {t("editor.header.exportDesktopApp")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => runExport(exportZip3D, t("editor.toasts.export3dDone"))}
              >
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
          onDeleteScene={handleDeleteScene}
          onSetInitialScene={(sceneId) =>
            update((draft) => ({ ...draft, initialSceneId: sceneId }))
          }
          onFiles={handleFiles}
          onPickNative={handlePickPanoramas}
          onThemeChange={(patch: Partial<Theme>) =>
            update((draft) => ({ ...draft, theme: { ...draft.theme, ...patch } }))
          }
          onLogoFileSelected={handleLogoFile}
          onLogoRemove={handleRemoveLogo}
        />

        <div className="relative flex min-w-0 flex-1 flex-col">
          {project.theme.showTitleOverlay && activeScene && activeSidebarTab !== "theme" && (
            <div className="pointer-events-none absolute left-4 top-4 z-10 rounded-lg border border-border bg-card/85 px-3 py-2 backdrop-blur">
              <p className="text-xs font-semibold">{project.name}</p>
              <p className="text-[11px] text-muted-foreground">{activeScene.name}</p>
            </div>
          )}
          <PanoCanvas
            scene={activeScene}
            imageUrl={activeScene ? (sceneUrls[activeScene.id] ?? "") : ""}
            mode={mode}
            placing={placing}
            selectedHotspotId={selectedHotspotId}
            onSelectHotspot={setSelectedHotspotId}
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
            onModeChange={(newMode) => {
              setMode(newMode);
              setPlacing(false);
              if (newMode === "preview") setSelectedHotspotId(null);
            }}
          />

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

        {mode === "editor" &&
          (activeSidebarTab === "theme" ? (
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
          ) : (
            <PropertiesPanel
              scene={activeScene}
              scenes={project.scenes}
              hotspot={selectedHotspot}
              onSceneChange={(patch) => activeSceneId && patchScene(activeSceneId, patch)}
              onHotspotChange={(patch) =>
                selectedHotspot && patchHotspot(selectedHotspot.id, patch)
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
              onSelectHotspot={(id) => setSelectedHotspotId(id)}
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
          ))}

        <ExportDesktopModal
          open={exportDesktopOpen}
          onOpenChange={setExportDesktopOpen}
          project={project}
        />

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
