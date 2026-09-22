import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DoorOpen,
  Eye,
  Info,
  LayoutGrid,
  Maximize2,
  MoveRight,
  Pencil,
  Crosshair,
  Target,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Hotspot, Scene } from "@/types/tour";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Viewer } from "@photo-sphere-viewer/core";
import { MarkersPlugin } from "@photo-sphere-viewer/markers-plugin";
import "@photo-sphere-viewer/core/index.css";
import "@photo-sphere-viewer/markers-plugin/index.css";
import ReactMarkdown from "react-markdown";

const MIN_ZOOM = 0.6;
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
  /** Called with a partial patch (rotationX/Y/Z, degrees) when the on-canvas 3D gizmo rotates a hotspot. */
  onRotateHotspot: (
    id: string,
    patch: { rotationX?: number; rotationY?: number; rotationZ?: number },
  ) => void;
  onNavigate: (sceneId: string) => void;
  onModeChange: (mode: "editor" | "preview") => void;
  /** Called with the camera's current yaw/pitch (degrees) and zoom (multiplier) when the user captures it as the scene's default view. */
  onSetDefaultView: (view: { yaw: number; pitch: number; zoom: number }) => void;
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
  onRotateHotspot,
  onNavigate,
  onModeChange,
  onSetDefaultView,
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
  const [zoom, setZoom] = useState(scene?.defaultZoom ?? 1);
  // Raw PSV zoom level (0–100), used only to drive the % badge in the toolbar.
  // Kept separate from `zoom` (the 0.6x–3x multiplier persisted as the scene's
  // default view) so the badge reads a natural 0–100% scale.
  const [zoomPercent, setZoomPercent] = useState(() =>
    Math.round(multiplierToPsv(scene?.defaultZoom ?? 1)),
  );
  const [toast, setToast] = useState<string | null>(null);
  const [infoPopup, setInfoPopup] = useState<{ title: string; content: string } | null>(null);

  // 1. Inizializzazione Viewer (Eseguito una sola volta per URL immagine)
  useEffect(() => {
    const currentSceneUrl = imageUrl;
    const el = containerRef.current;
    if (!el || !currentSceneUrl) return;

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

    // Convert the app's multiplier zoom (0.6–3) to PSV zoom level (0–100)
    const initialMultiplier = scene?.defaultZoom ?? 1;
    const initialPsvZoom = multiplierToPsv(initialMultiplier);

    const viewer = new Viewer({
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

    try {
      if (viewer.isAutorotateEnabled?.()) {
        viewer.stopAutorotate?.();
      }
    } catch (e) {
      // ignore
    }

    viewerRef.current = viewer;

    const onClick = (data: any) => {
      const pitchRad =
        data?.latitude ?? data?.pitch ?? data?.data?.latitude ?? data?.data?.pitch ?? 0;
      const yawRad = data?.longitude ?? data?.yaw ?? data?.data?.longitude ?? data?.data?.yaw ?? 0;

      const pitch = (pitchRad * 180) / Math.PI;
      const yaw = (yawRad * 180) / Math.PI;

      if (modeRef.current === "editor") {
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
  }, [imageUrl]);

  // Icona SVG per tipo di hotspot (senza wrapper, riusata sia dal marker piatto che da quello inclinato)
  const getMarkerIconSvg = (type: string): { bg: string; svg: string } => {
    switch (type) {
      case "door":
        return {
          bg: "#10b981",
          svg: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a2 2 0 1 0 4 0 2 2 0 0 0-4 0"/><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/><path d="M17 17.5v-11"/></svg>',
        };
      case "info":
        return {
          bg: "#6366f1",
          svg: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
        };
      case "arrow":
      default:
        return {
          bg: "#4f46e5",
          svg: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m12 8 4 4-4 4"/><path d="M8 12h8"/></svg>',
        };
    }
  };

  // Marker box side (px) when the on-canvas rotation gizmo is shown around a selected nav hotspot.
  const GIZMO_BOX = 110;
  const GIZMO_RADIUS = 40;
  const HANDLE_SIZE = 18;

  /**
   * Builds the marker HTML. Navigation hotspots (door/arrow) get a `perspective` +
   * `rotateX/Y/Z` CSS3D transform on the icon itself, so they read as a decal tilted
   * onto the panorama surface (e.g. a floor arrow) instead of a flat camera-facing
   * billboard. Info markers stay flat billboards — they aren't spatial hotspots.
   * When selected, nav hotspots also get two draggable gizmo handles (yaw ring +
   * tilt track) baked into the marker's own HTML so they track its screen position
   * for free as the viewer's marker plugin repositions it every frame.
   */
  const getMarkerHtml = (hotspot: Hotspot, selected: boolean): string => {
    const borderColor = selected ? "#ff69b4" : "#fff";
    const glow = selected
      ? "0 0 12px 4px rgba(255,105,180,0.7),0 10px 15px -3px rgba(0,0,0,0.3)"
      : "0 10px 15px -3px rgba(0,0,0,0.3)";
    const baseStyle = `width:36px;height:36px;border:3px solid ${borderColor};border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:${glow};cursor:grab;user-select:none`;
    const { bg, svg } = getMarkerIconSvg(hotspot.type);
    const isNav = hotspot.type !== "info";
    const rx = isNav ? (hotspot.rotationX ?? 0) : 0;
    const ry = isNav ? (hotspot.rotationY ?? 0) : 0;
    const rz = isNav ? (hotspot.rotationZ ?? 0) : 0;
    const tiltTransform =
      rx || ry || rz ? `transform:rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg);` : "";
    const iconHtml = `<div style="${baseStyle};background:${bg};${tiltTransform}">${svg}</div>`;

    if (!(selected && isNav)) {
      return `<div style="width:36px;height:36px;perspective:500px;">${iconHtml}</div>`;
    }

    // Gizmo: yaw handle sits on a ring around the marker, at the angle described by
    // rotationY (0 = up/north, clockwise), so its position also shows the current
    // pointing direction. The tilt handle rides a vertical track mapping -90..90deg
    // of rotationX to +/-GIZMO_RADIUS px.
    const yawRad = (ry * Math.PI) / 180;
    const center = GIZMO_BOX / 2;
    const half = HANDLE_SIZE / 2;
    const yawX = center + GIZMO_RADIUS * Math.sin(yawRad) - half;
    const yawY = center - GIZMO_RADIUS * Math.cos(yawRad) - half;
    const tiltY = center - (Math.max(-90, Math.min(90, rx)) / 90) * GIZMO_RADIUS - half;

    return `<div style="width:${GIZMO_BOX}px;height:${GIZMO_BOX}px;position:relative;perspective:500px;">
      <div style="position:absolute;left:${center - GIZMO_RADIUS}px;top:${center - GIZMO_RADIUS}px;width:${GIZMO_RADIUS * 2}px;height:${GIZMO_RADIUS * 2}px;border:1px dashed rgba(255,255,255,0.5);border-radius:50%;pointer-events:none;"></div>
      <div style="position:absolute;left:${center - 18}px;top:${center - 18}px;">${iconHtml}</div>
      <div data-gizmo="yaw" title="Direzione (trascina per ruotare)" style="position:absolute;left:${yawX}px;top:${yawY}px;width:${HANDLE_SIZE}px;height:${HANDLE_SIZE}px;border-radius:50%;background:#22d3ee;border:2px solid #fff;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.4);"></div>
      <div data-gizmo="tilt" title="Inclinazione (trascina su/giù)" style="position:absolute;left:${center - half}px;top:${tiltY}px;width:${HANDLE_SIZE}px;height:${HANDLE_SIZE}px;border-radius:4px;background:#f59e0b;border:2px solid #fff;cursor:ns-resize;box-shadow:0 2px 6px rgba(0,0,0,.4);"></div>
    </div>`;
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

      try {
        markersRef.current.clearMarkers();
      } catch (e) {
        // ignore
      }

      hotspots.forEach((h) => {
        const pitchDeg = typeof h.pitch === "number" ? h.pitch : parseFloat(h.pitch || "0");
        const yawDeg = typeof h.yaw === "number" ? h.yaw : parseFloat(h.yaw || "0");
        const pitchRad = (pitchDeg * Math.PI) / 180;
        const yawRad = (yawDeg * Math.PI) / 180;

        // Aggiorna la mappa delle posizioni con i dati correnti della scena
        posMap.set(h.id, { yaw: yawRad, pitch: pitchRad });

        const isSelected = h.id === selectedHotspotId;
        const showGizmo = isSelected && modeRef.current === "editor" && h.type !== "info";
        const boxSize = showGizmo ? GIZMO_BOX : 36;

        try {
          markersRef.current.addMarker({
            id: h.id,
            position: { yaw: yawRad, pitch: pitchRad },
            size: { width: boxSize, height: boxSize },
            anchor: "center center",
            tooltip: {
              content: h.tooltip || h.type,
              position: "top center",
              trigger: "hover",
            },
            data: { hotspotId: h.id },
            html: getMarkerHtml(h, isSelected),
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
              const el = m.element as HTMLElement | undefined;
              if (!el) return;

              if (modeRef.current === "editor") {
                el.style.cursor = "grab";

                // Gizmo di rotazione 3D (solo per l'hotspot selezionato, tipi navigazione).
                // Attaccati prima del listener di trascinamento posizione: essendo figli di
                // `el` e fermando la propagazione, intercettano il mousedown prima che
                // raggiunga il listener sotto, che gestisce invece il drag di pitch/yaw.
                const yawHandle = el.querySelector<HTMLElement>('[data-gizmo="yaw"]');
                const tiltHandle = el.querySelector<HTMLElement>('[data-gizmo="tilt"]');

                if (yawHandle) {
                  yawHandle.addEventListener("mousedown", (e: MouseEvent) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const baseHotspot = sceneRef.current?.hotspots.find((h) => h.id === m.id);
                    if (!baseHotspot) return;
                    const rect = el.getBoundingClientRect();
                    const cx = rect.left + rect.width / 2;
                    const cy = rect.top + rect.height / 2;
                    let lastAngle = baseHotspot.rotationY ?? 0;

                    const onMove = (ev: MouseEvent) => {
                      const dx = ev.clientX - cx;
                      const dy = ev.clientY - cy;
                      // 0deg = up, clockwise, matching the ring drawn in getMarkerHtml.
                      let angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
                      if (angle > 180) angle -= 360;
                      if (angle < -180) angle += 360;
                      lastAngle = Number(angle.toFixed(1));
                      // Live preview only: rebuild the marker's own HTML so the icon tilt and
                      // gizmo redraw immediately, without touching project state mid-drag.
                      try {
                        markersRef.current?.updateMarker?.({
                          id: m.id,
                          html: getMarkerHtml({ ...baseHotspot, rotationY: lastAngle }, true),
                        });
                      } catch (_) {
                        // ignore
                      }
                    };
                    const onUp = () => {
                      onRotateHotspot(m.id, { rotationY: lastAngle });
                      window.removeEventListener("mousemove", onMove);
                      window.removeEventListener("mouseup", onUp);
                    };
                    window.addEventListener("mousemove", onMove);
                    window.addEventListener("mouseup", onUp);
                  });
                }

                if (tiltHandle) {
                  tiltHandle.addEventListener("mousedown", (e: MouseEvent) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const baseHotspot = sceneRef.current?.hotspots.find((h) => h.id === m.id);
                    if (!baseHotspot) return;
                    const startRotationX = baseHotspot.rotationX ?? 0;
                    const startY = e.clientY;
                    let lastRotationX = startRotationX;

                    const onMove = (ev: MouseEvent) => {
                      const deltaY = ev.clientY - startY;
                      // Drag down -> more negative tilt (arrow lies flatter on the floor).
                      lastRotationX = Number(
                        Math.max(-90, Math.min(90, startRotationX - deltaY * 0.5)).toFixed(1),
                      );
                      try {
                        markersRef.current?.updateMarker?.({
                          id: m.id,
                          html: getMarkerHtml({ ...baseHotspot, rotationX: lastRotationX }, true),
                        });
                      } catch (_) {
                        // ignore
                      }
                    };
                    const onUp = () => {
                      onRotateHotspot(m.id, { rotationX: lastRotationX });
                      window.removeEventListener("mousemove", onMove);
                      window.removeEventListener("mouseup", onUp);
                    };
                    window.addEventListener("mousemove", onMove);
                    window.addEventListener("mouseup", onUp);
                  });
                }

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
      try {
        markersRef.current?.clearMarkers?.();
      } catch (e) {
        // ignore
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene?.hotspots, imageUrl, mode, selectedHotspotId]);

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

  return (
    <div className="relative flex-1 overflow-hidden bg-background">
      <div
        ref={containerRef}
        className={cn(
          "relative w-full h-full min-h-[500px] overflow-hidden touch-none select-none",
        )}
      />

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

      {/* Zoom toolbar */}
      <div className="absolute bottom-4 right-4 z-10 flex items-center gap-3 rounded-full border border-slate-700/50 bg-slate-900/80 px-4 py-2 text-sm text-slate-200 backdrop-blur-md">
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
  );
}
