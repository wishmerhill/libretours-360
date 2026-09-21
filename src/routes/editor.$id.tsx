import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronDown,
  Compass,
  Download,
  FileArchive,
  MapPin,
  Monitor,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import type { Hotspot, Scene, Theme, TourProject } from "@/types/tour";
import { uid } from "@/types/tour";
import { getProject, upsertProject } from "@/lib/storage";
import { deleteBlob, putBlob, resolveUrl } from "@/lib/idb";
import { exportZip3D, exportZip2D } from "@/lib/export";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { LeftSidebar } from "@/components/studio/LeftSidebar";
import { PropertiesPanel } from "@/components/studio/PropertiesPanel";
import { PanoCanvas } from "@/components/studio/PanoCanvas";
import { ReverseHotspotModal } from "@/components/studio/ReverseHotspotModal";
import { ExportDesktopModal } from "@/components/studio/ExportDesktopModal";
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
  const { id } = useParams({ from: "/editor/$id" });
  const [project, setProject] = useState<TourProject | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [selectedHotspotId, setSelectedHotspotId] = useState<string | null>(null);
  const [mode, setMode] = useState<"editor" | "preview">("editor");
  const [placing, setPlacing] = useState(false);
  const [sceneUrls, setSceneUrls] = useState<Record<string, string>>({});
  const [reverseHotspotTargetId, setReverseHotspotTargetId] = useState<string | null>(null);
  const [exportDesktopOpen, setExportDesktopOpen] = useState(false);

  // Always points at the latest project state, so saves triggered from timers
  // and lifecycle events never work on a stale closure.
  const projectRef = useRef<TourProject | null>(null);
  projectRef.current = project;
  // True only when the user changed something that has not been written yet.
  const dirtyRef = useRef(false);

  /** Persists pending edits (if any). Returns false if the write failed. */
  const flushSave = useCallback(async (): Promise<boolean> => {
    const current = projectRef.current;
    if (!current || !dirtyRef.current) return true;
    dirtyRef.current = false;
    try {
      await upsertProject(current);
      return true;
    } catch (e) {
      // Stay dirty so the next flush (edit, unmount, page hide) retries.
      dirtyRef.current = true;
      console.error("Autosave failed", e);
      toast.error("Autosave failed: your latest changes are not saved yet.", {
        id: "autosave-error",
      });
      return false;
    }
  }, []);

  useEffect(() => {
    (async () => {
      const found = await getProject(id);
      dirtyRef.current = false;
      setProject(found);
      setActiveSceneId(found?.initialSceneId ?? found?.scenes[0]?.id ?? null);
      setLoaded(true);
    })();
    // Leaving the editor (or switching project) must not drop a pending autosave.
    return () => {
      void flushSave();
    };
  }, [id, flushSave]);

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

  useEffect(() => {
    if (!project) return;
    let active = true;
    (async () => {
      const entries: Record<string, string> = {};
      for (const scene of project.scenes) {
        entries[scene.id] = await resolveUrl(scene.panoramaUrl);
      }
      if (active) setSceneUrls(entries);
    })();
    return () => {
      active = false;
    };
  }, [project]);

  const activeScene = useMemo(
    () => project?.scenes.find((s) => s.id === activeSceneId) ?? null,
    [project, activeSceneId],
  );

  // Autosave edits to storage (debounced). Only runs after a real user edit,
  // so merely opening a project never rewrites it or bumps its updatedAt.
  useEffect(() => {
    if (!loaded || !project || !dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void flushSave();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [project, loaded, flushSave]);

  const selectedHotspot = useMemo(
    () => activeScene?.hotspots.find((h) => h.id === selectedHotspotId) ?? null,
    [activeScene, selectedHotspotId],
  );

  const update = useCallback((updater: (draft: TourProject) => TourProject) => {
    dirtyRef.current = true;
    setProject((prev) => (prev ? updater(prev) : prev));
  }, []);

  /**
   * Explicit save (Save button, exports). Writes the latest state and merges only
   * the new updatedAt back, so edits made while the write is in flight are kept.
   * Throws on I/O failure.
   */
  const saveNow = async (): Promise<TourProject | null> => {
    const current = projectRef.current;
    if (!current) return null;
    dirtyRef.current = false;
    try {
      const saved = await upsertProject(current);
      setProject((prev) => (prev ? { ...prev, updatedAt: saved.updatedAt } : prev));
      return saved;
    } catch (e) {
      dirtyRef.current = true;
      throw e;
    }
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
      toast.error("Export failed. Your project could not be saved or exported.");
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

  const handleFiles = async (files: FileList | File[]) => {
    const images = Array.from(files).filter((f) => /image\/(jpeg|png|webp)/.test(f.type));
    if (!images.length) {
      toast.error("Only JPG, PNG or WebP panoramas are supported.");
      return;
    }
    const newScenes: Scene[] = [];
    for (const file of images) {
      const ref = await putBlob(uid("pano"), file);
      newScenes.push({
        id: uid("scene"),
        name: file.name.replace(/\.[^.]+$/, ""),
        panoramaUrl: ref,
        defaultZoom: 1,
        hotspots: [],
      });
    }
    update((draft) => ({
      ...draft,
      scenes: [...draft.scenes, ...newScenes],
      initialSceneId: draft.initialSceneId ?? newScenes[0]!.id,
    }));
    setActiveSceneId((prev) => prev ?? newScenes[0]!.id);
    toast.success(`${newScenes.length} scene${newScenes.length === 1 ? "" : "s"} added`);
  };

  const handleDeleteScene = async (sceneId: string) => {
    const scene = project?.scenes.find((s) => s.id === sceneId);
    if (scene) await deleteBlob(scene.panoramaUrl);
    update((draft) => {
      const scenes = draft.scenes
        .filter((s) => s.id !== sceneId)
        .map((s) => ({
          ...s,
          hotspots: s.hotspots.map((h) =>
            h.targetSceneId === sceneId ? { ...h, targetSceneId: null } : h,
          ),
        }));
      return {
        ...draft,
        scenes,
        initialSceneId:
          draft.initialSceneId === sceneId ? (scenes[0]?.id ?? null) : draft.initialSceneId,
      };
    });
    if (activeSceneId === sceneId) {
      setActiveSceneId(project?.scenes.find((s) => s.id !== sceneId)?.id ?? null);
      setSelectedHotspotId(null);
    }
  };

  const addHotspot = (pitch: number, yaw: number) => {
    if (!activeSceneId) return;
    const hotspot: Hotspot = {
      id: uid("hs"),
      type: "door",
      pitch,
      yaw,
      tooltip: "New hotspot",
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
      if (await saveNow()) toast.success("Project saved");
    } catch (e) {
      console.error("Save failed", e);
      toast.error("Could not save the project. Check disk space and permissions.");
    }
  };

  const handleCreateReverseHotspot = (targetSceneId: string) => {
    setReverseHotspotTargetId(targetSceneId);
  };

  const handleConfirmReverseHotspot = (pitch: number, yaw: number) => {
    if (!reverseHotspotTargetId || !activeSceneId) return;

    const currentSceneName = activeScene?.name ?? "previous scene";

    const reverseHotspot: Hotspot = {
      id: uid("hs"),
      type: "door",
      pitch,
      yaw,
      tooltip: `Return to ${currentSceneName}`,
      targetSceneId: activeSceneId,
    };

    update((draft) => ({
      ...draft,
      scenes: draft.scenes.map((s) =>
        s.id === reverseHotspotTargetId
          ? { ...s, hotspots: [...s.hotspots, reverseHotspot] }
          : s,
      ),
    }));

    toast.success("Return hotspot created");
  };

  if (!loaded) return <div className="min-h-screen bg-background" />;

  if (!project) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background">
        <h1 className="text-lg font-semibold">Project not found</h1>
        <Button asChild size="sm">
          <Link to="/">Back to projects</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-sidebar px-3">
        <Button asChild size="sm" variant="ghost">
          <Link to="/">
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Projects
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
          {project.scenes.length} scenes
        </Badge>

        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant={placing ? "default" : "secondary"}
            disabled={mode !== "editor" || !activeScene}
            onClick={() => setPlacing((p) => !p)}
          >
            <MapPin className="mr-1.5 h-3.5 w-3.5" /> Add Hotspot
          </Button>
          <Button size="sm" variant="secondary" onClick={handleSave}>
            <Save className="mr-1.5 h-3.5 w-3.5" /> Save
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="default">
                <Download className="mr-1.5 h-3.5 w-3.5" /> Export
                <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => runExport(exportZip2D, "Export 2D completato")}>
                <FileArchive className="mr-2 h-4 w-4" />
                Offline (2D)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setExportDesktopOpen(true)}>
                <Monitor className="mr-2 h-4 w-4" />
                Desktop App
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => runExport(exportZip3D, "Export 3D completato")}>
                <FileArchive className="mr-2 h-4 w-4" />
                Server Web (3D)
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
          onSelectScene={(sceneId) => {
            setActiveSceneId(sceneId);
            setSelectedHotspotId(null);
          }}
          onDeleteScene={handleDeleteScene}
          onSetInitialScene={(sceneId) =>
            update((draft) => ({ ...draft, initialSceneId: sceneId }))
          }
          onFiles={handleFiles}
          onThemeChange={(patch: Partial<Theme>) =>
            update((draft) => ({ ...draft, theme: { ...draft.theme, ...patch } }))
          }
        />

        <div className="relative flex min-w-0 flex-1 flex-col">
          {project.theme.showTitleOverlay && activeScene && (
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
            onZoomChange={(zoom) => {
              if (mode !== "editor" || !activeSceneId) return;
              // The viewer also reports its initial zoom: ignore no-op changes.
              const current = projectRef.current?.scenes.find((s) => s.id === activeSceneId);
              if (current?.defaultZoom === zoom) return;
              patchScene(activeSceneId, { defaultZoom: zoom });
            }}
            onModeChange={(newMode) => {
              setMode(newMode);
              setPlacing(false);
              if (newMode === "preview") setSelectedHotspotId(null);
            }}
          />
        </div>

        {mode === "editor" && (
          <PropertiesPanel
            scene={activeScene}
            scenes={project.scenes}
            hotspot={selectedHotspot}
            onSceneChange={(patch) => activeSceneId && patchScene(activeSceneId, patch)}
            onHotspotChange={(patch) => selectedHotspot && patchHotspot(selectedHotspot.id, patch)}
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
                  s.id === activeSceneId ? { ...s, hotspots: s.hotspots.filter((h) => h.id !== id) } : s,
                ),
              }));
              if (selectedHotspotId === id) setSelectedHotspotId(null);
            }}
            onCreateReverseHotspot={handleCreateReverseHotspot}
          />
        )}

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
              project.scenes.find((s) => s.id === reverseHotspotTargetId)?.name ?? "Target scene"
            }
            onConfirm={handleConfirmReverseHotspot}
          />
        )}
      </div>
    </div>
  );
}