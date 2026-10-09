import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  DoorOpen,
  Eye,
  EyeOff,
  Info,
  LayoutGrid,
  Maximize2,
  MoveRight,
  Pencil,
  Crosshair,
  Ruler,
  RotateCcw,
  Target,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { MeasurePoint, Measurement, Scene } from "@/types/tour";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { greatCirclePoints, midpoint } from "@/lib/measure-geometry";
import { Viewer } from "@photo-sphere-viewer/core";
import { MarkersPlugin } from "@photo-sphere-viewer/markers-plugin";
import "@photo-sphere-viewer/core/index.css";
import "@photo-sphere-viewer/markers-plugin/index.css";
import ReactMarkdown from "react-markdown";

const MIN_ZOOM = 0.6;
const DEG = Math.PI / 180;

/** Marker ids of saved measurements: `ms-<measurementId>-<part>`. */
const MEASURE_PREFIX = "ms-";
/** Marker ids of the line being drawn (first point placed, second pending). */
const MEASURE_TMP_PREFIX = "mstmp-";
const isMeasureMarkerId = (id: string) =>
  id.startsWith(MEASURE_PREFIX) || id.startsWith(MEASURE_TMP_PREFIX);

const MEASURE_COLOR = "#ffffff";
const MEASURE_SELECTED_COLOR = "#ff69b4";

const toRad = (p: MeasurePoint) => ({ yaw: p.yaw * DEG, pitch: p.pitch * DEG });

/** PSV reports yaw in 0..360°; the project model uses -180..180°. */
const normalizeYawDeg = (yaw: number) => (yaw > 180 ? yaw - 360 : yaw);

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function measureLineStyle(selected: boolean): Record<string, string> {
  return {
    stroke: selected ? MEASURE_SELECTED_COLOR : MEASURE_COLOR,
    strokeWidth: selected ? "3px" : "2px",
    strokeDasharray: "8 6",
    strokeLinecap: "round",
  };
}

/** Wider dark stroke under the dashed line, so it reads on light and dark walls alike. */
const MEASURE_HALO_STYLE: Record<string, string> = {
  stroke: "rgba(0,0,0,0.55)",
  strokeWidth: "6px",
  strokeLinecap: "round",
};

function measureDotHtml(selected: boolean): string {
  const bg = selected ? MEASURE_SELECTED_COLOR : MEASURE_COLOR;
  return `<div style="width:12px;height:12px;box-sizing:border-box;border-radius:50%;background:${bg};border:2px solid rgba(0,0,0,0.7);box-shadow:0 1px 4px rgba(0,0,0,0.5)"></div>`;
}

function measureLabelHtml(label: string, selected: boolean): string {
  const border = selected ? MEASURE_SELECTED_COLOR : "rgba(255,255,255,0.35)";
  const text = label.trim() ? escapeHtml(label) : "…";
  return `<div style="padding:2px 8px;border-radius:999px;background:rgba(15,23,42,0.85);border:1px solid ${border};color:#fff;font:600 12px/1.5 system-ui,sans-serif;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.4)">${text}</div>`;
}

/** Removes the markers matching `pred`, leaving the others alone. */
function removeMarkersWhere(markers: MarkersPlugin | null, pred: (id: string) => boolean) {
  if (!markers) return;
  try {
    const ids = markers
      .getMarkers()
      .map((m) => m.id)
      .filter(pred);
    if (ids.length) markers.removeMarkers(ids);
  } catch (e) {
    // ignore
  }
}
const MAX_ZOOM = 3;

/**
 * Converts a zoom multiplier (0.6x–3x) to PSV zoom level (0–100).
 */
function multiplierToPsv(multiplier: number): number {
  return ((multiplier - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * 100;
}

/**
 * Converts a PSV zoom level (0–100) to a zoom multiplier (0.6x–3x).
 */
function psvToMultiplier(psvLevel: number): number {
  return MIN_ZOOM + (psvLevel / 100) * (MAX_ZOOM - MIN_ZOOM);
}

interface Props {
  scene: Scene | null;
  imageUrl: string;
  mode: "editor" | "preview";
  placing: boolean;
  selectedHotspotId: string | null;
  onSelectHotspot: (id: string | null) => void;
  onAddHotspot: (pitch: number, yaw: number) => void;
  onMoveHotspot: (id: string, pitch: number, yaw: number) => void;
  onNavigate: (sceneId: string) => void;
  onModeChange: (mode: "editor" | "preview") => void;
  /** Called with the camera's current yaw/pitch (degrees) and zoom (multiplier) when the user captures it as the scene's default view. */
  onSetDefaultView: (view: { yaw: number; pitch: number; zoom: number }) => void;
  /** Measurement tool active: clicks place the two endpoints of a new line. */
  measuring: boolean;
  onCancelMeasuring: () => void;
  showMeasurements: boolean;
  onToggleMeasurements: () => void;
  selectedMeasurementId: string | null;
  onSelectMeasurement: (id: string | null) => void;
  onAddMeasurement: (a: MeasurePoint, b: MeasurePoint) => void;
  onMoveMeasurementPoint: (id: string, end: "a" | "b", pos: MeasurePoint) => void;
}

export function PanoCanvas({
  scene,
  imageUrl,
  mode,
  placing,
  selectedHotspotId,
  onSelectHotspot,
  onAddHotspot,
  onMoveHotspot,
  onNavigate,
  onModeChange,
  onSetDefaultView,
  measuring,
  onCancelMeasuring,
  showMeasurements,
  onToggleMeasurements,
  selectedMeasurementId,
  onSelectMeasurement,
  onAddMeasurement,
  onMoveMeasurementPoint,
}: Props) {
  const { t } = useTranslation();
  // Handlers registered inside effects capture this at mount time; the ref keeps
  // them reading the current translation function even if the language changes
  // without the effect (deps: hotspots/imageUrl/mode/selection) re-running.
  const tRef = useRef(t);
  tRef.current = t;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any | null>(null);
  const markersRef = useRef<any | null>(null);
  // Mappa che tiene traccia della posizione corrente di ogni marker in radianti
  const markerPositionsRef = useRef<Map<string, { yaw: number; pitch: number }>>(new Map());
  // refs to avoid stale closures in viewer event handlers
  const placingRef = useRef(placing);
  placingRef.current = placing;

  const modeRef = useRef(mode);
  modeRef.current = mode;

  const selectedHotspotIdRef = useRef<string | null>(selectedHotspotId);
  selectedHotspotIdRef.current = selectedHotspotId;
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  const measuringRef = useRef(measuring);
  measuringRef.current = measuring;
  // Latest callbacks, for listeners registered once per viewer or per marker.
  const measureCallbacksRef = useRef({
    onSelectMeasurement,
    onAddMeasurement,
    onMoveMeasurementPoint,
  });
  measureCallbacksRef.current = { onSelectMeasurement, onAddMeasurement, onMoveMeasurementPoint };
  // First endpoint of the line being drawn, until the second click.
  const [pendingA, setPendingA] = useState<MeasurePoint | null>(null);
  const pendingARef = useRef<MeasurePoint | null>(null);
  pendingARef.current = pendingA;
  // Removes the window listeners of an endpoint drag in progress.
  const measureDragCleanupRef = useRef<(() => void) | null>(null);
  const [zoom, setZoom] = useState(scene?.defaultZoom ?? 1);
  // Raw PSV zoom level (0–100), used only to drive the % badge in the toolbar.
  // Kept separate from `zoom` (the 0.6x–3x multiplier persisted as the scene's
  // default view) so the badge reads a natural 0–100% scale.
  const [zoomPercent, setZoomPercent] = useState(() =>
    Math.round(multiplierToPsv(scene?.defaultZoom ?? 1)),
  );
  const [toast, setToast] = useState<string | null>(null);
  const [infoPopup, setInfoPopup] = useState<{ title: string; content: string } | null>(null);
  // Set when WebGL context creation/rendering fails (seen on some Windows/WebView2
  // machines lacking hardware GL acceleration) so we can show a recoverable
  // message instead of leaving a black, silently-broken canvas.
  const [renderError, setRenderError] = useState<string | null>(null);
  // Bumped by the container-size watcher (below) and by the "retry" button to
  // force the init effect to run again without changing imageUrl.
  const [retryTick, setRetryTick] = useState(0);

  // 0. Attende che il contenitore abbia dimensioni valide (>0x0) prima di
  // inizializzare il Viewer. Su WebView2/Windows un contesto WebGL creato
  // contro un canvas 0x0 può fallire silenziosamente invece di lanciare,
  // lasciando uno schermo nero permanente.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (el.clientWidth > 0 && el.clientHeight > 0) return;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        setRetryTick((t) => t + 1);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [imageUrl]);

  // 1. Inizializzazione Viewer (Eseguito una sola volta per URL immagine)
  useEffect(() => {
    const currentSceneUrl = imageUrl;
    const el = containerRef.current;
    if (!el || !currentSceneUrl) return;
    if (el.clientWidth === 0 || el.clientHeight === 0) return;

    if (viewerRef.current) {
      try {
        const existing = viewerRef.current.getPanorama?.();
        if (existing === currentSceneUrl) return;
      } catch (e) {
        // ignore
      }
      try {
        viewerRef.current.destroy();
      } catch (e) {
        // ignore
      }
      viewerRef.current = null;
      markersRef.current = null;
    }

    console.log("Inizializzazione Viewer per:", currentSceneUrl);
    setRenderError(null);

    let viewer: Viewer;
    try {
      // Convert the app's multiplier zoom (0.6–3) to PSV zoom level (0–100)
      const initialMultiplier = scene?.defaultZoom ?? 1;
      const initialPsvZoom = multiplierToPsv(initialMultiplier);

      viewer = new Viewer({
        container: el,
        panorama: currentSceneUrl,
        // Plain numbers are radians to PSV; degrees are passed as a "<deg>deg" string.
        defaultYaw: `${scene?.defaultYaw ?? 0}deg`,
        defaultPitch: `${scene?.defaultPitch ?? 0}deg`,
        navbar: false,
        mousewheel: true,
        mousewheelCtrlKey: false,
        zoomSpeed: 1,
        minFov: 30,
        maxFov: 90,
        defaultZoomLvl: initialPsvZoom,
        mousemove: true,
        moveSpeed: 1,
        plugins: [MarkersPlugin],
      });
    } catch (e) {
      // WebGL context creation failed synchronously (e.g. no GPU/ANGLE backend
      // available to WebView2). Clear any partial canvas Three.js may have
      // appended and surface a recoverable error instead of crashing the tree.
      console.error("Impossibile inizializzare il viewer 3D:", e);
      el.innerHTML = "";
      setRenderError(tRef.current("editor.viewer.renderError"));
      return;
    }

    try {
      if (viewer.isAutorotateEnabled?.()) {
        viewer.stopAutorotate?.();
      }
    } catch (e) {
      // ignore
    }

    viewerRef.current = viewer;

    // Some WebView2/Windows setups (VMs, remote desktop, blocked GPU) create a
    // WebGL context that is immediately lost or never backed by real hardware.
    // Without this, the canvas just stays black with no error anywhere.
    const canvasEl = el.querySelector("canvas");
    const onContextLost = (ev: Event) => {
      ev.preventDefault();
      console.error("Contesto WebGL perso per:", currentSceneUrl);
      setRenderError(tRef.current("editor.viewer.contextLost"));
    };
    canvasEl?.addEventListener("webglcontextlost", onContextLost);

    const onClick = (data: any) => {
      const pitchRad =
        data?.latitude ?? data?.pitch ?? data?.data?.latitude ?? data?.data?.pitch ?? 0;
      const yawRad = data?.longitude ?? data?.yaw ?? data?.data?.longitude ?? data?.data?.yaw ?? 0;

      const pitch = (pitchRad * 180) / Math.PI;
      const yaw = (yawRad * 180) / Math.PI;

      if (modeRef.current === "editor") {
        if (measuringRef.current) {
          const point = {
            yaw: Number(normalizeYawDeg(yaw).toFixed(3)),
            pitch: Number(pitch.toFixed(3)),
          };
          const a = pendingARef.current;
          if (!a) {
            pendingARef.current = point;
            setPendingA(point);
          } else {
            pendingARef.current = null;
            setPendingA(null);
            measureCallbacksRef.current.onAddMeasurement(a, point);
          }
          return;
        }
        if (placingRef.current) {
          onAddHotspot(Number(pitch.toFixed?.(3) ?? pitch), Number(yaw.toFixed?.(3) ?? yaw));
          return;
        }
        // Se c'è un marker selezionato e clicchiamo sulla scena, deseleziona
        if (selectedHotspotIdRef.current) {
          onSelectHotspot(null);
          return;
        }
      }
    };

    viewer.addEventListener("click", onClick);

    const onZoom = (ev: any) => {
      // PSV v5's Viewer extends EventTarget, so this must be wired via
      // addEventListener — it has no .on()/.off() (that was the v4 API). The
      // ZoomUpdatedEvent fires every animation frame with the real zoomLevel
      // (0–100), whether triggered by wheel, pinch, buttons, or code, making
      // this the single source of truth for the `zoom` state driving the badge.
      const psvLevel = ev?.zoomLevel ?? 50;
      setZoom(psvToMultiplier(psvLevel));
      setZoomPercent(Math.round(Math.min(100, Math.max(0, psvLevel))));
    };
    viewer.addEventListener("zoom-updated", onZoom);

    setTimeout(() => {
      try {
        viewer.needsUpdate?.();
      } catch (e) {
        try {
          viewer.resize?.();
        } catch (er) {
          // ignore
        }
      }
    }, 100);

    return () => {
      console.log("Distruzione istanza Viewer per:", currentSceneUrl);
      try {
        canvasEl?.removeEventListener("webglcontextlost", onContextLost);
        viewer.removeEventListener("click", onClick);
        viewer.removeEventListener("zoom-updated", onZoom);
        viewer.destroy?.();
      } catch (e) {
        // ignore
      }
      viewerRef.current = null;
      markersRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, retryTick]);

  // Helper per generare l'HTML del marker in base al tipo e allo stato di selezione
  const getMarkerHtml = (type: string, selected: boolean = false): string => {
    const borderColor = selected ? "#ff69b4" : "#fff";
    const glow = selected
      ? "0 0 12px 4px rgba(255,105,180,0.7),0 10px 15px -3px rgba(0,0,0,0.3)"
      : "0 10px 15px -3px rgba(0,0,0,0.3)";
    const baseStyle = `width:36px;height:36px;border:3px solid ${borderColor};border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:${glow};cursor:grab;user-select:none`;

    switch (type) {
      case "door":
        return `<div style="${baseStyle};background:#10b981"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a2 2 0 1 0 4 0 2 2 0 0 0-4 0"/><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/><path d="M17 17.5v-11"/></svg></div>`;
      case "info":
        return `<div style="${baseStyle};background:#6366f1"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg></div>`;
      case "arrow":
      default:
        return `<div style="${baseStyle};background:#4f46e5"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m12 8 4 4-4 4"/><path d="M8 12h8"/></svg></div>`;
    }
  };

  // 2. Sincronizzazione Marker e Gestione Interazioni Hotspot
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    let markers = null;
    try {
      markers = viewer.getPlugin(MarkersPlugin);
    } catch (e) {
      console.log("getPlugin(MarkersPlugin) fallito", e);
    }
    markersRef.current = markers;

    const dragState: {
      markerId: string | null;
      dragging: boolean;
      initYawRad: number;
      initPitchRad: number;
      mouseStartX: number;
      mouseStartY: number;
      finalYawRad?: number;
      finalPitchRad?: number;
    } = {
      markerId: null,
      dragging: false,
      initYawRad: 0,
      initPitchRad: 0,
      mouseStartX: 0,
      mouseStartY: 0,
    };

    const syncMarkers = () => {
      if (!markersRef.current) return;

      const hotspots = scene?.hotspots ?? [];
      const posMap = markerPositionsRef.current;

      removeMarkersWhere(markersRef.current, (id) => !isMeasureMarkerId(id));

      hotspots.forEach((h) => {
        const pitchDeg = typeof h.pitch === "number" ? h.pitch : parseFloat(h.pitch || "0");
        const yawDeg = typeof h.yaw === "number" ? h.yaw : parseFloat(h.yaw || "0");
        const pitchRad = (pitchDeg * Math.PI) / 180;
        const yawRad = (yawDeg * Math.PI) / 180;

        // Aggiorna la mappa delle posizioni con i dati correnti della scena
        posMap.set(h.id, { yaw: yawRad, pitch: pitchRad });

        try {
          markersRef.current.addMarker({
            id: h.id,
            position: { yaw: yawRad, pitch: pitchRad },
            size: { width: 36, height: 36 },
            anchor: "center center",
            tooltip: {
              content: h.tooltip || h.type,
              position: "top center",
              trigger: "hover",
            },
            data: { hotspotId: h.id },
            html: getMarkerHtml(h.type, h.id === selectedHotspotId),
          });
        } catch (err) {
          console.error("Errore aggiunta marker:", err);
        }
      });
    };

    const onSelectMarker = (e: any) => {
      const markerId = e?.marker?.id ?? e?.id ?? null;
      if (!markerId) return;
      // Usa sceneRef per evitare stale closure
      const currentScene = sceneRef.current;
      if (!currentScene) return;
      const hs = currentScene.hotspots.find((h) => h.id === markerId) ?? null;
      if (!hs) return;

      if (modeRef.current === "editor") {
        onSelectHotspot(markerId);
        return;
      }

      // Preview mode
      if (hs.type === "info") {
        // Info marker: show popup with Markdown content
        if (hs.content) {
          setInfoPopup({
            title: hs.tooltip || tRef.current("editor.viewer.info"),
            content: hs.content,
          });
        } else {
          setToast(hs.tooltip || tRef.current("editor.viewer.noInformation"));
          window.setTimeout(() => setToast(null), 2600);
        }
        return;
      }

      // Navigation markers (door, arrow)
      if (hs.targetSceneId) {
        onNavigate(hs.targetSceneId);
        return;
      }
      setToast(hs.tooltip || tRef.current("editor.viewer.noInformation"));
      window.setTimeout(() => setToast(null), 2600);
    };

    // Sincronizza i marker dopo un breve ritardo per assicurare che il panorama sia caricato
    const initialSyncTimer = window.setTimeout(() => {
      syncMarkers();

      // Dopo aver creato i marker, attacha i listener in base alla modalità
      if (markersRef.current) {
        try {
          const allMarkers = markersRef.current.getMarkers?.();
          if (allMarkers) {
            allMarkers.forEach((m: any) => {
              // Measurement markers handle their own interactions (effect 3).
              if (!m.data?.hotspotId) return;
              const el = m.element as HTMLElement | undefined;
              if (!el) return;

              if (modeRef.current === "editor") {
                el.style.cursor = "grab";

                el.addEventListener("mousedown", (e: MouseEvent) => {
                  if (modeRef.current !== "editor") return;
                  e.stopPropagation();
                  e.preventDefault();

                  // Seleziona il marker — apre la sidebar
                  onSelectHotspot(m.id);

                  const viewer = viewerRef.current;
                  if (!viewer) return;

                  // Disabilita la rotazione della camera durante il drag
                  try {
                    viewer.setOption("mousemove", false);
                  } catch (_) {}

                  // Leggi posizione corrente dalla mappa (ref, sempre aggiornata)
                  const saved = markerPositionsRef.current.get(m.id);
                  const initYawRad = saved?.yaw ?? 0;
                  const initPitchRad = saved?.pitch ?? 0;

                  // Salva stato iniziale
                  dragState.markerId = m.id;
                  dragState.dragging = true;
                  dragState.initYawRad = initYawRad;
                  dragState.initPitchRad = initPitchRad;
                  dragState.mouseStartX = e.clientX;
                  dragState.mouseStartY = e.clientY;

                  // Sensibilità: 0.3° per pixel di movimento mouse
                  const radPerPx = (0.3 * Math.PI) / 180;

                  const onMouseMove = (ev: MouseEvent) => {
                    if (!dragState.dragging || !dragState.markerId || !containerRef.current) return;

                    const dx = ev.clientX - dragState.mouseStartX;
                    const dy = ev.clientY - dragState.mouseStartY;

                    const containerWidth = containerRef.current.clientWidth || 1000;
                    const containerHeight = containerRef.current.clientHeight || 600;

                    const viewer = viewerRef.current;
                    if (!viewer) return;

                    // 1. Recupera il FOV verticale REALE corrente di PSV v5 (in radianti)
                    let vFovRad = Math.PI / 3; // Fallback ~60°
                    try {
                      const defaultFovDeg = viewer.getOption?.("defaultFov") ?? 60;
                      vFovRad = viewer.state?.vFov ?? (defaultFovDeg * Math.PI) / 180;
                    } catch (_) {}

                    // 2. Calcolo trigonomerico dell'angolo di spostamento esatto
                    const halfH = containerHeight / 2;
                    const tanHalfVFov = Math.tan(vFovRad / 2);

                    const yawDelta = Math.atan((dx / halfH) * tanHalfVFov);
                    const pitchDelta = Math.atan((dy / halfH) * tanHalfVFov);

                    // 3. Nuove coordinate traslate
                    const newYawRad = dragState.initYawRad + yawDelta;
                    const newPitchRad = Math.max(
                      -Math.PI / 2 + 0.01,
                      Math.min(Math.PI / 2 - 0.01, dragState.initPitchRad - pitchDelta),
                    );

                    try {
                      markersRef.current?.updateMarker?.({
                        id: dragState.markerId,
                        position: { yaw: newYawRad, pitch: newPitchRad },
                      });

                      markerPositionsRef.current.set(dragState.markerId, {
                        yaw: newYawRad,
                        pitch: newPitchRad,
                      });
                      dragState.finalYawRad = newYawRad;
                      dragState.finalPitchRad = newPitchRad;
                    } catch (er) {
                      // ignore
                    }
                  };

                  const onMouseUp = () => {
                    dragState.dragging = false;

                    // Riabilita la rotazione della camera
                    try {
                      viewer.setOption("mousemove", true);
                    } catch (_) {}

                    if (
                      dragState.markerId &&
                      dragState.finalYawRad !== undefined &&
                      dragState.finalPitchRad !== undefined
                    ) {
                      const yawDeg = (dragState.finalYawRad * 180) / Math.PI;
                      const pitchDeg = (dragState.finalPitchRad * 180) / Math.PI;
                      onMoveHotspot(
                        dragState.markerId,
                        Number(pitchDeg.toFixed(3)),
                        Number(yawDeg.toFixed(3)),
                      );
                    }
                    dragState.markerId = null;
                    delete dragState.finalYawRad;
                    delete dragState.finalPitchRad;
                    window.removeEventListener("mousemove", onMouseMove);
                    window.removeEventListener("mouseup", onMouseUp);
                  };

                  window.addEventListener("mousemove", onMouseMove);
                  window.addEventListener("mouseup", onMouseUp);
                });
              } else {
                // Preview mode: cursore pointer su qualsiasi marker
                el.style.cursor = "pointer";

                // Hover glow in preview: evidenzia il marker con bordo glow azzurro
                el.addEventListener("mouseenter", () => {
                  el.style.filter = "brightness(1.3) drop-shadow(0 0 6px rgba(59,130,246,0.9))";
                });
                el.addEventListener("mouseleave", () => {
                  el.style.filter = "";
                });

                // Click diretto sul marker in preview per navigare
                // (fallback nel caso select-marker di PSV non venga emesso)
                el.addEventListener("click", (e: MouseEvent) => {
                  if (modeRef.current !== "preview") return;
                  e.stopPropagation();
                  e.preventDefault();

                  const currentScene = sceneRef.current;
                  if (!currentScene) return;
                  const hs = currentScene.hotspots.find((h) => h.id === m.id);
                  if (!hs) return;

                  if (hs.type === "info") {
                    // Info marker: show popup with Markdown content
                    if (hs.content) {
                      setInfoPopup({
                        title: hs.tooltip || tRef.current("editor.viewer.info"),
                        content: hs.content,
                      });
                    } else {
                      setToast(hs.tooltip || tRef.current("editor.viewer.noInformation"));
                      window.setTimeout(() => setToast(null), 2600);
                    }
                    return;
                  }

                  if (hs.targetSceneId) {
                    onNavigate(hs.targetSceneId);
                  } else {
                    setToast(hs.tooltip || tRef.current("editor.viewer.noInformation"));
                    window.setTimeout(() => setToast(null), 2600);
                  }
                });
              }
            });
          }
        } catch (e) {
          // ignore
        }
      }
    }, 500);
    viewer.on?.("panorama-loaded", syncMarkers);

    try {
      markersRef.current?.on?.("select-marker", onSelectMarker);
      markersRef.current?.on?.("click-marker", onSelectMarker);
    } catch (e) {
      // ignore
    }

    return () => {
      window.clearTimeout(initialSyncTimer);
      dragState.dragging = false;
      dragState.markerId = null;
      try {
        markersRef.current?.off?.("select-marker", onSelectMarker);
        markersRef.current?.off?.("click-marker", onSelectMarker);
        viewer.off?.("panorama-loaded", syncMarkers);
      } catch (e) {
        // ignore
      }
      removeMarkersWhere(markersRef.current, (id) => !isMeasureMarkerId(id));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene?.hotspots, imageUrl, mode, selectedHotspotId]);

  // Exact panorama direction under a viewport point, or null outside the viewer.
  const pointerToSpherical = useCallback((clientX: number, clientY: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return null;
    try {
      const rect = (viewer.container as HTMLElement).getBoundingClientRect();
      const pos = viewer.dataHelper.viewerCoordsToSphericalCoords({
        x: clientX - rect.left,
        y: clientY - rect.top,
      });
      if (!Number.isFinite(pos?.yaw) || !Number.isFinite(pos?.pitch)) return null;
      const yaw = normalizeYawDeg(pos.yaw / DEG);
      return { yaw: Number(yaw.toFixed(3)), pitch: Number((pos.pitch / DEG).toFixed(3)) };
    } catch (e) {
      return null;
    }
  }, []);

  // Runs `fn` once the viewer can render markers (polylines need the renderer).
  const whenViewerReady = (viewer: Viewer, fn: () => void): (() => void) => {
    if (viewer.state?.ready) {
      fn();
      return () => {};
    }
    viewer.addEventListener("ready", fn, { once: true });
    return () => viewer.removeEventListener("ready", fn);
  };

  // 3. Measurement lines: saved ones, plus endpoint dragging in editor mode.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    let markers: MarkersPlugin | null = null;
    try {
      markers = viewer.getPlugin(MarkersPlugin) as MarkersPlugin;
    } catch (e) {
      return;
    }
    if (!markers) return;

    const isSaved = (id: string) => id.startsWith(MEASURE_PREFIX);
    const editable = mode === "editor";
    // While drawing a new line, the existing ones must not swallow the clicks.
    const interactive = editable && !measuring;

    // Moves one endpoint on screen (line, halo, dot, label), without saving.
    const redraw = (m: Measurement, end: "a" | "b", pos: MeasurePoint) => {
      const a = end === "a" ? pos : m.a;
      const b = end === "b" ? pos : m.b;
      const polyline = greatCirclePoints(a, b);
      const base = `${MEASURE_PREFIX}${m.id}`;
      try {
        markers.updateMarker({ id: `${base}-halo`, polyline }, false);
        markers.updateMarker({ id: `${base}-line`, polyline }, false);
        markers.updateMarker({ id: `${base}-${end}`, position: toRad(pos) }, false);
        markers.updateMarker({ id: `${base}-label`, position: midpoint(a, b) });
      } catch (e) {
        // ignore
      }
    };

    const startDrag = (m: Measurement, end: "a" | "b", e: MouseEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      measureDragCleanupRef.current?.();
      measureCallbacksRef.current.onSelectMeasurement(m.id);
      try {
        viewer.setOption("mousemove", false);
      } catch (e) {
        // ignore
      }

      let last: MeasurePoint | null = null;
      const onMove = (ev: MouseEvent) => {
        const pos = pointerToSpherical(ev.clientX, ev.clientY);
        if (!pos) return;
        last = pos;
        // Read the other endpoint from the latest scene: the markers may have
        // been rebuilt (selection changed) since the drag started.
        const current = sceneRef.current?.measurements.find((x) => x.id === m.id) ?? m;
        redraw(current, end, pos);
      };
      const cleanup = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        try {
          viewer.setOption("mousemove", true);
        } catch (e) {
          // ignore
        }
        measureDragCleanupRef.current = null;
      };
      const onUp = () => {
        cleanup();
        if (last) measureCallbacksRef.current.onMoveMeasurementPoint(m.id, end, last);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      measureDragCleanupRef.current = cleanup;
    };

    const select = (m: Measurement) => (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      measureCallbacksRef.current.onSelectMeasurement(m.id);
    };

    const render = () => {
      removeMarkersWhere(markers, isSaved);
      if (!showMeasurements) return;
      const style = interactive ? { cursor: "pointer" } : { pointerEvents: "none" };

      for (const m of scene?.measurements ?? []) {
        const selected = editable && m.id === selectedMeasurementId;
        const base = `${MEASURE_PREFIX}${m.id}`;
        const polyline = greatCirclePoints(m.a, m.b);
        const data = { measurementId: m.id };
        try {
          markers.addMarker({
            id: `${base}-halo`,
            polyline,
            svgStyle: MEASURE_HALO_STYLE,
            style,
            data,
          });
          markers.addMarker({
            id: `${base}-line`,
            polyline,
            svgStyle: measureLineStyle(selected),
            style,
            data,
          });
          for (const end of ["a", "b"] as const) {
            markers.addMarker({
              id: `${base}-${end}`,
              position: toRad(m[end]),
              size: { width: 12, height: 12 },
              anchor: "center center",
              html: measureDotHtml(selected),
              style: interactive ? { cursor: "move" } : { pointerEvents: "none" },
              data,
            });
          }
          if (editable || m.label.trim()) {
            markers.addMarker({
              id: `${base}-label`,
              position: midpoint(m.a, m.b),
              anchor: "center center",
              html: measureLabelHtml(m.label, selected),
              style,
              data,
            });
          }
        } catch (err) {
          console.error("Errore aggiunta misura:", err);
        }
      }

      if (!interactive) return;
      for (const m of scene?.measurements ?? []) {
        const base = `${MEASURE_PREFIX}${m.id}`;
        const el = (id: string) => {
          try {
            return markers.getMarker(id)?.domElement as HTMLElement | SVGElement | undefined;
          } catch (e) {
            return undefined;
          }
        };
        el(`${base}-a`)?.addEventListener("mousedown", (e) => startDrag(m, "a", e as MouseEvent));
        el(`${base}-b`)?.addEventListener("mousedown", (e) => startDrag(m, "b", e as MouseEvent));
        for (const part of ["halo", "line", "label"]) {
          el(`${base}-${part}`)?.addEventListener("mousedown", select(m));
        }
      }
    };

    const cancelReady = whenViewerReady(viewer, render);
    return () => {
      cancelReady();
      removeMarkersWhere(markers, isSaved);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    scene?.measurements,
    showMeasurements,
    selectedMeasurementId,
    measuring,
    mode,
    imageUrl,
    retryTick,
  ]);

  // An endpoint drag must not outlive the component.
  useEffect(() => () => measureDragCleanupRef.current?.(), []);

  // 3a. Line being drawn: first endpoint placed, rubber band to the cursor.
  useEffect(() => {
    if (!measuring && pendingA) setPendingA(null);
  }, [measuring, pendingA]);

  useEffect(() => {
    setPendingA(null);
  }, [imageUrl]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !pendingA) return;
    let markers: MarkersPlugin | null = null;
    try {
      markers = viewer.getPlugin(MarkersPlugin) as MarkersPlugin;
    } catch (e) {
      return;
    }
    if (!markers) return;

    const lineId = `${MEASURE_TMP_PREFIX}line`;
    const passThrough = { pointerEvents: "none" };
    try {
      markers.addMarker(
        {
          id: `${MEASURE_TMP_PREFIX}halo`,
          polyline: greatCirclePoints(pendingA, pendingA, 1),
          svgStyle: MEASURE_HALO_STYLE,
          style: passThrough,
        },
        false,
      );
      markers.addMarker(
        {
          id: lineId,
          polyline: greatCirclePoints(pendingA, pendingA, 1),
          svgStyle: measureLineStyle(true),
          style: passThrough,
        },
        false,
      );
      markers.addMarker({
        id: `${MEASURE_TMP_PREFIX}a`,
        position: toRad(pendingA),
        size: { width: 12, height: 12 },
        anchor: "center center",
        html: measureDotHtml(true),
        style: passThrough,
      });
    } catch (e) {
      console.error("Errore marker misura temporanea:", e);
    }

    let frame = 0;
    let lastEvent: MouseEvent | null = null;
    const onMove = (e: MouseEvent) => {
      lastEvent = e;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!lastEvent) return;
        const pos = pointerToSpherical(lastEvent.clientX, lastEvent.clientY);
        if (!pos) return;
        const polyline = greatCirclePoints(pendingA, pos);
        try {
          markers.updateMarker({ id: `${MEASURE_TMP_PREFIX}halo`, polyline }, false);
          markers.updateMarker({ id: lineId, polyline });
        } catch (err) {
          // ignore
        }
      });
    };
    const container = viewer.container as HTMLElement;
    container.addEventListener("mousemove", onMove);

    return () => {
      container.removeEventListener("mousemove", onMove);
      if (frame) cancelAnimationFrame(frame);
      removeMarkersWhere(markers, (id) => id.startsWith(MEASURE_TMP_PREFIX));
    };
  }, [pendingA, pointerToSpherical]);

  // Esc: first drops the pending endpoint, then leaves the tool.
  useEffect(() => {
    if (!measuring) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pendingARef.current) setPendingA(null);
      else onCancelMeasuring();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [measuring, onCancelMeasuring]);

  // 3b. Chiusura popup info con tasto ESC
  useEffect(() => {
    if (!infoPopup) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setInfoPopup(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [infoPopup]);

  // 4. Gestione Zoom e Resize
  // zoomIn/zoomOut trigger PSV's animated zoom dynamic (see Viewer.zoomIn/zoomOut).
  // The resulting level is picked up by the "zoom-updated" listener registered in
  // the init effect, which is the single source of truth for the `zoom` state —
  // reading getZoomLevel() synchronously here would only return the pre-animation
  // value and fight with that listener.
  const zoomIn = useCallback(() => {
    try {
      viewerRef.current?.zoomIn(10);
    } catch (e) {
      // ignore
    }
  }, []);

  const zoomOut = useCallback(() => {
    try {
      viewerRef.current?.zoomOut(10);
    } catch (e) {
      // ignore
    }
  }, []);

  const currentZoom = useRef(zoom);
  currentZoom.current = zoom;

  // Captures the camera's current yaw/pitch/zoom and hands it up as the new default
  // view for this scene. Navigation (wheel, drag, pinch) never writes here on its own.
  const captureCurrentView = useCallback(() => {
    const v = viewerRef.current;
    if (!v) return;
    try {
      const position = v.getPosition?.();
      const yaw = ((position?.yaw ?? 0) * 180) / Math.PI;
      const pitch = ((position?.pitch ?? 0) * 180) / Math.PI;
      onSetDefaultView({
        yaw: Number(yaw.toFixed(2)),
        pitch: Number(pitch.toFixed(2)),
        zoom: Number(currentZoom.current.toFixed(2)),
      });
    } catch (e) {
      // ignore
    }
  }, [onSetDefaultView]);

  // Forces the init effect to recreate the viewer: needed because a context-loss
  // (as opposed to a fresh imageUrl) leaves viewerRef.current pointing at a "live"
  // but broken instance, which the init effect would otherwise treat as up to date
  // and skip recreating.
  const handleRetry = useCallback(() => {
    if (viewerRef.current) {
      try {
        viewerRef.current.destroy();
      } catch (e) {
        // ignore
      }
      viewerRef.current = null;
      markersRef.current = null;
    }
    if (containerRef.current) containerRef.current.innerHTML = "";
    setRenderError(null);
    setRetryTick((t) => t + 1);
  }, []);

  return (
    <div className="relative flex-1 overflow-hidden bg-background">
      <div
        ref={containerRef}
        className={cn(
          "relative w-full h-full min-h-[500px] overflow-hidden touch-none select-none",
        )}
      />

      {renderError && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-background">
          <div className="mx-4 max-w-sm rounded-xl border border-border bg-card px-6 py-5 text-center shadow-2xl">
            <AlertTriangle className="mx-auto h-8 w-8 text-amber-500" />
            <p className="mt-3 text-sm font-medium text-foreground">{renderError}</p>
            <Button size="sm" className="mt-4 gap-1.5" onClick={handleRetry}>
              <RotateCcw className="h-3.5 w-3.5" />
              {t("editor.viewer.retry")}
            </Button>
          </div>
        </div>
      )}

      {/* Floating Edit/Preview toggle */}
      <div className="absolute right-4 top-4 z-10 flex items-center gap-1 rounded-full border border-slate-700/50 bg-slate-900/80 p-1 backdrop-blur-md">
        {(["editor", "preview"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => onModeChange(value)}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium transition-all",
              mode === value ? "bg-cyan-400 text-slate-950" : "text-slate-400 hover:text-white",
            )}
          >
            {value === "editor" ? (
              <Pencil className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
            {value === "editor" ? t("editor.viewer.edit") : t("editor.viewer.preview")}
          </button>
        ))}
      </div>

      {/* Captures yaw/pitch/zoom into the scene's saved default view (project.json) */}
      {mode === "editor" && scene && (
        <button
          type="button"
          onClick={captureCurrentView}
          className="absolute bottom-4 left-4 z-10 flex items-center gap-1.5 rounded-full border border-cyan-400/40 bg-slate-900/80 px-3 py-1.5 text-xs font-medium text-cyan-300 backdrop-blur-md transition-colors hover:bg-slate-800/80 hover:text-cyan-200"
        >
          <Target className="h-3.5 w-3.5" />
          {t("editor.viewer.setDefaultView")}
        </button>
      )}

      {placing && mode === "editor" && (
        <div className="pointer-events-none absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-2 rounded-full border border-primary/60 bg-card/90 px-3 py-1.5 text-xs text-foreground z-10">
          <Crosshair className="h-3.5 w-3.5 text-primary" />
          {t("editor.viewer.placeHotspotHint")}
        </div>
      )}

      {measuring && mode === "editor" && (
        <div className="pointer-events-none absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-2 rounded-full border border-primary/60 bg-card/90 px-3 py-1.5 text-xs text-foreground z-10">
          <Ruler className="h-3.5 w-3.5 text-primary" />
          {pendingA ? t("editor.viewer.measureSecondPoint") : t("editor.viewer.measureFirstPoint")}
        </div>
      )}

      {toast && (
        <div className="pointer-events-none absolute bottom-20 left-1/2 max-w-sm -translate-x-1/2 rounded-lg border border-border bg-card/95 px-4 py-2.5 text-sm text-foreground shadow-lg z-10">
          {toast}
        </div>
      )}

      {/* Info marker popup */}
      {infoPopup && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/40"
          onClick={() => setInfoPopup(null)}
        >
          <div
            className="mx-4 max-h-[80vh] max-w-lg overflow-y-auto rounded-xl border border-border bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">{infoPopup.title}</h3>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => setInfoPopup(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="prose prose-sm prose-invert max-w-none px-4 py-3">
              <ReactMarkdown>{infoPopup.content}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}

      <div className="absolute bottom-4 right-4 z-10 flex items-center gap-2">
        {/* Measurements visibility: same control in editor and preview */}
        {(scene?.measurements.length ?? 0) > 0 && (
          <button
            type="button"
            onClick={onToggleMeasurements}
            title={
              showMeasurements
                ? t("editor.viewer.hideMeasurements")
                : t("editor.viewer.showMeasurements")
            }
            aria-pressed={showMeasurements}
            className={cn(
              "flex items-center gap-1.5 rounded-full border bg-slate-900/80 px-3 py-2 text-xs font-medium backdrop-blur-md transition-colors",
              showMeasurements
                ? "border-cyan-400/40 text-cyan-300 hover:text-cyan-200"
                : "border-slate-700/50 text-slate-400 hover:text-white",
            )}
          >
            {showMeasurements ? (
              <Eye className="h-3.5 w-3.5" />
            ) : (
              <EyeOff className="h-3.5 w-3.5" />
            )}
            {t("editor.viewer.measurements")}
          </button>
        )}

        {/* Zoom toolbar */}
        <div className="flex items-center gap-3 rounded-full border border-slate-700/50 bg-slate-900/80 px-4 py-2 text-sm text-slate-200 backdrop-blur-md">
          <button
            type="button"
            onClick={zoomOut}
            className="flex items-center justify-center text-slate-400 transition-colors hover:text-white"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="min-w-[3ch] text-center text-xs tabular-nums">{zoomPercent}%</span>
          <button
            type="button"
            onClick={zoomIn}
            className="flex items-center justify-center text-slate-400 transition-colors hover:text-white"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <div className="h-4 w-px bg-slate-700/60" />
          <button
            type="button"
            className="flex items-center justify-center text-slate-400 transition-colors hover:text-white disabled:opacity-40"
            disabled
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="flex items-center justify-center text-slate-400 transition-colors hover:text-white disabled:opacity-40"
            disabled
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
