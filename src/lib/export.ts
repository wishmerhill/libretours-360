import type { Theme, TourProject } from "@/types/tour";
import { getBlob, isLocalAssetRef } from "./assets";
import { openExportSink, type ExportResult, type ExportSink } from "./export-sink";
import { saveFile } from "./save-file";
import { resolveOverlaysForExport, resolveThemeImageDataUrl } from "./theme-assets";

const slug = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tour";

/** Resolves with where the file went, or null if the user cancelled. */
export async function exportJson(project: TourProject): Promise<string | null> {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  return await saveFile(blob, `${slug(project.name)}.json`, {
    name: "JSON",
    extensions: ["json"],
  });
}

// ─── Export 3D (Photo Sphere Viewer via ES Modules) ────────────────────────

/** JSON safe to inline in a <script>: "<" can never close the tag or open a comment. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

/**
 * `project.theme` with the logo and every overlay image resolved to a data:
 * URL, so the exported tour does not depend on the studio's local storage.
 * Best-effort: an image that cannot be read is simply left out.
 */
async function resolveThemeForExport(project: TourProject): Promise<Theme> {
  const { theme } = project;
  let logoUrl = "";
  try {
    logoUrl = await resolveThemeImageDataUrl(project.id, theme.logoUrl);
  } catch (e) {
    console.warn("[export] Could not embed the theme logo:", e);
  }
  let overlays = theme.overlays.filter((el) => el.type === "text");
  try {
    overlays = await resolveOverlaysForExport(project.id, theme.overlays);
  } catch (e) {
    console.warn("[export] Could not embed the theme's custom overlays:", e);
  }
  return { ...theme, logoUrl, overlays };
}

export function viewerHtml3D(project: TourProject) {
  // scriptJson, not JSON.stringify: hotspot tooltips and measurement labels are
  // free text and must not be able to close the inline <script>.
  const scenesJson = scriptJson(project.scenes.map((s) => ({
    id: s.id,
    name: s.name,
    panoramaUrl: s.panoramaUrl,
    defaultZoom: s.defaultZoom,
    hotspots: s.hotspots,
    measurements: s.measurements ?? [],
  })));

  const initialSceneId = project.initialSceneId || project.scenes[0]?.id || "";
  const themeJson = scriptJson(project.theme);
  const projectNameJson = scriptJson(project.name);
  const showMeasurementsJson = scriptJson(project.showMeasurements !== false);

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${project.name}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@photo-sphere-viewer/core@5/index.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@photo-sphere-viewer/markers-plugin@5/index.css" />
  <style>
    *{box-sizing:border-box}
    body{margin:0;overflow:hidden;background:#09090b;font-family:system-ui,sans-serif}
    #viewer{width:100vw;height:100vh}
    #title{display:none;position:absolute;top:20px;left:20px;z-index:10;padding:10px 16px;border-radius:12px;
      background:rgba(24,24,27,.75);border:1px solid rgba(63,63,70,.9);color:#f4f4f5;font-size:14px;font-weight:600;
      pointer-events:none;backdrop-filter:blur(6px)}
    #title.visible{display:block}
    #title.with-navbar{top:78px}
    #navbar{display:none;position:absolute;top:20px;left:20px;z-index:11;padding:8px 12px;border-radius:12px;
      background:rgba(24,24,27,.75);border:1px solid rgba(63,63,70,.9);backdrop-filter:blur(6px)}
    #navbar.visible{display:flex;align-items:center}
    #logo{display:block;max-height:32px;max-width:160px;object-fit:contain}
    #theme-overlays{position:absolute;inset:0;z-index:9;pointer-events:none;overflow:hidden}
    .theme-overlay-text{white-space:pre-wrap;font-size:13px;color:#f4f4f5}
    .theme-overlay-image{display:block;object-fit:contain}
    #scene-list{position:absolute;bottom:20px;left:50%;transform:translateX(-50%);z-index:10;
      display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
    #scene-list button{padding:8px 14px;border-radius:10px;border:1px solid #3f3f46;
      background:rgba(24,24,27,.8);color:#d4d4d8;font-size:12px;cursor:pointer;backdrop-filter:blur(4px)}
    #scene-list button.active{background:#4f46e5;color:#fff;border-color:#4f46e5}
    #info-modal-overlay{position:fixed;inset:0;z-index:100;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.5)}
    #info-modal-overlay.open{display:flex}
    #info-modal{max-width:32rem;max-height:80vh;width:90%;overflow-y:auto;border-radius:12px;border:1px solid #3f3f46;background:#18181b;box-shadow:0 25px 50px -12px rgba(0,0,0,.5)}
    #info-modal-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #3f3f46}
    #info-modal-title{font-size:14px;font-weight:600;color:#f4f4f5}
    #info-modal-close{width:28px;height:28px;display:flex;align-items:center;justify-content:center;border:none;border-radius:6px;background:transparent;color:#a1a1aa;cursor:pointer;font-size:18px}
    #info-modal-close:hover{background:#27272a;color:#f4f4f5}
    #info-modal-body{padding:12px 16px;font-size:14px;line-height:1.6;color:#d4d4d8}
    #info-modal-body h1,#info-modal-body h2,#info-modal-body h3{color:#f4f4f5;margin:12px 0 6px}
    #info-modal-body h1{font-size:18px}
    #info-modal-body h2{font-size:16px}
    #info-modal-body h3{font-size:14px}
    #info-modal-body p{margin:6px 0}
    #info-modal-body ul,#info-modal-body ol{padding-left:20px;margin:6px 0}
    #info-modal-body li{margin:2px 0}
    #info-modal-body a{color:#818cf8;text-decoration:underline}
    #info-modal-body strong{color:#f4f4f5}
    #info-modal-body code{background:#27272a;padding:1px 4px;border-radius:4px;font-size:13px}
    #info-modal-body pre{background:#27272a;padding:12px;border-radius:8px;overflow-x:auto;font-size:13px}
    #info-modal-body blockquote{border-left:3px solid #52525b;padding-left:12px;margin:8px 0;color:#a1a1aa}
    #measure-toggle{display:none;position:absolute;top:20px;right:20px;z-index:10;height:38px;padding:0 12px;gap:6px;
      align-items:center;border-radius:10px;border:1px solid #3f3f46;background:rgba(24,24,27,.8);color:#a1a1aa;
      font:600 13px/1 system-ui,sans-serif;cursor:pointer;backdrop-filter:blur(4px)}
    #measure-toggle:hover{background:#27272a}
    #measure-toggle.available{display:flex}
    #measure-toggle.on{color:#67e8f9;border-color:rgba(103,232,249,.5)}
  </style>
</head>
<body>
  <div id="viewer"></div>
  <div id="navbar"><img id="logo" alt="" /></div>
  <div id="title"></div>
  <div id="theme-overlays"></div>
  <div id="scene-list"></div>
  <button id="measure-toggle" type="button" aria-pressed="false"></button>
  <div id="info-modal-overlay">
    <div id="info-modal">
      <div id="info-modal-header">
        <span id="info-modal-title"></span>
        <button id="info-modal-close">&times;</button>
      </div>
      <div id="info-modal-body"></div>
    </div>
  </div>

  <script type="module">
    function showInfoModal(title, markdown) {
      document.getElementById("info-modal-title").textContent = title;
      document.getElementById("info-modal-body").innerHTML = simpleMarkdown(markdown);
      document.getElementById("info-modal-overlay").classList.add("open");
    }

    function simpleMarkdown(text) {
      var bt = String.fromCharCode(96);
      var html = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
      html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
      html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
      html = html.replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>");
      html = html.replace(/\\*(.+?)\\*/g, "<em>$1</em>");
      html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      html = html.replace(/^\\- (.+)$/gm, "<li>$1</li>");
      html = html.replace(/(<li>.*<\\/li>\\n?)+/g, "<ul>$&</ul>");
      html = html.replace(/^(\\d+)\\. (.+)$/gm, "<oli>$2</oli>");
      html = html.replace(/(<oli>.*<\\/oli>\\n?)+/g, function(m) { return "<ol>" + m.replace(/oli>/g, "li>") + "</ol>"; });
      html = html.replace(new RegExp(bt+bt+bt+'([\\s\\S]*?)'+bt+bt+bt, 'g'), "<pre><code>$1</code></pre>");
      html = html.replace(new RegExp(bt+'([^'+bt+']+)'+bt, 'g'), "<code>$1</code>");
      html = html.replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>");
      html = html.replace(/\\n\\n/g, "</p><p>");
      html = "<p>" + html + "</p>";
      html = html.replace(/<p><\\/p>/g, "");
      return html;
    }

    document.getElementById("info-modal-overlay").addEventListener("click", function(e) {
      if (e.target === this) this.classList.remove("open");
    });
    document.getElementById("info-modal-close").addEventListener("click", function() {
      document.getElementById("info-modal-overlay").classList.remove("open");
    });
    document.addEventListener("keydown", function(e) {
      if (e.key === "Escape") document.getElementById("info-modal-overlay").classList.remove("open");
    });
    import { Viewer } from 'https://esm.sh/@photo-sphere-viewer/core@5';
    import { MarkersPlugin } from 'https://esm.sh/@photo-sphere-viewer/markers-plugin@5';

    const SCENES = ${scenesJson};
    const THEME = ${themeJson};
    const PROJECT_NAME = ${projectNameJson};
    let currentSceneId = "${initialSceneId}";
    let viewer = null;
    let markersPlugin = null;
    let measurementsVisible = ${showMeasurementsJson};

    // ─── Measurements (same math as src/lib/measure-geometry.ts) ──────────

    var DEG = Math.PI / 180;

    function toVec(yaw, pitch) {
      var c = Math.cos(pitch);
      return [c * Math.sin(yaw), Math.sin(pitch), c * Math.cos(yaw)];
    }

    function fromVec(v) {
      var len = Math.hypot(v[0], v[1], v[2]) || 1;
      return [Math.atan2(v[0], v[2]), Math.asin(Math.max(-1, Math.min(1, v[1] / len)))];
    }

    function slerp(va, vb, t) {
      var d = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
      var omega = Math.acos(d);
      if (omega < 1e-9) return va;
      var u;
      if (Math.PI - omega < 1e-6) {
        var ref = Math.abs(va[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        var c1 = [va[1] * ref[2] - va[2] * ref[1], va[2] * ref[0] - va[0] * ref[2], va[0] * ref[1] - va[1] * ref[0]];
        u = [c1[1] * va[2] - c1[2] * va[1], c1[2] * va[0] - c1[0] * va[2], c1[0] * va[1] - c1[1] * va[0]];
      } else {
        u = [vb[0] - d * va[0], vb[1] - d * va[1], vb[2] - d * va[2]];
      }
      var ul = Math.hypot(u[0], u[1], u[2]) || 1;
      var c = Math.cos(omega * t), s = Math.sin(omega * t);
      return [c * va[0] + s * u[0] / ul, c * va[1] + s * u[1] / ul, c * va[2] + s * u[2] / ul];
    }

    function pointVec(p) {
      return toVec(p.yaw * DEG, p.pitch * DEG);
    }

    function greatCirclePoints(a, b, n) {
      var va = pointVec(a), vb = pointVec(b), out = [], prev = null;
      for (var i = 0; i <= n; i++) {
        var p = fromVec(slerp(va, vb, i / n));
        if (prev !== null) {
          while (p[0] - prev > Math.PI) p[0] -= 2 * Math.PI;
          while (p[0] - prev < -Math.PI) p[0] += 2 * Math.PI;
        }
        prev = p[0];
        out.push(p);
      }
      return out;
    }

    function midpoint(a, b) {
      var p = fromVec(slerp(pointVec(a), pointVec(b), 0.5));
      return { yaw: p[0], pitch: p[1] };
    }

    function escapeHtml(text) {
      var el = document.createElement("div");
      el.textContent = text;
      return el.innerHTML;
    }

    var MEASURE_DOT_HTML = '<div style="width:12px;height:12px;box-sizing:border-box;border-radius:50%;background:#fff;border:2px solid rgba(0,0,0,0.7);box-shadow:0 1px 4px rgba(0,0,0,0.5)"></div>';

    function measureLabelHtml(label) {
      return '<div style="padding:2px 8px;border-radius:999px;background:rgba(15,23,42,0.85);border:1px solid rgba(255,255,255,0.35);color:#fff;font:600 12px/1.5 system-ui,sans-serif;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.4)">' + escapeHtml(label) + '</div>';
    }

    function renderMeasurements(scene) {
      if (!markersPlugin) return;
      var stale = markersPlugin.getMarkers().filter(function(m) { return m.id.indexOf("ms-") === 0; });
      if (stale.length) markersPlugin.removeMarkers(stale.map(function(m) { return m.id; }));
      if (!measurementsVisible) return;
      var passive = { pointerEvents: "none" };
      (scene.measurements || []).forEach(function(m) {
        var base = "ms-" + m.id;
        var polyline = greatCirclePoints(m.a, m.b, 32);
        markersPlugin.addMarker({ id: base + "-halo", polyline: polyline, style: passive,
          svgStyle: { stroke: "rgba(0,0,0,0.55)", strokeWidth: "6px", strokeLinecap: "round" } });
        markersPlugin.addMarker({ id: base + "-line", polyline: polyline, style: passive,
          svgStyle: { stroke: "#ffffff", strokeWidth: "2px", strokeDasharray: "8 6", strokeLinecap: "round" } });
        ["a", "b"].forEach(function(end) {
          markersPlugin.addMarker({ id: base + "-" + end, style: passive,
            position: { yaw: m[end].yaw * DEG, pitch: m[end].pitch * DEG },
            size: { width: 12, height: 12 }, anchor: "center center", html: MEASURE_DOT_HTML });
        });
        if (m.label && m.label.trim()) {
          markersPlugin.addMarker({ id: base + "-label", style: passive, position: midpoint(m.a, m.b),
            anchor: "center center", html: measureLabelHtml(m.label) });
        }
      });
    }

    var IS_IT = /^it/i.test((typeof navigator !== "undefined" && navigator.language) || "");
    var MEASURE_TEXT = IS_IT
      ? { label: "Misure", show: "Mostra misure", hide: "Nascondi misure" }
      : { label: "Measurements", show: "Show measurements", hide: "Hide measurements" };
    var EYE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/></svg>';
    var EYE_OFF_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c4.36 0 8.07 2.8 9.94 6.65a1 1 0 0 1 0 .7 10.75 10.75 0 0 1-1.44 2.49"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5A10.75 10.75 0 0 1 2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.15"/><path d="m2 2 20 20"/></svg>';

    function updateMeasureToggle(scene) {
      var btn = document.getElementById("measure-toggle");
      var available = !!(scene && scene.measurements && scene.measurements.length);
      if (available) btn.classList.add("available");
      else btn.classList.remove("available");
      if (measurementsVisible) btn.classList.add("on");
      else btn.classList.remove("on");
      btn.setAttribute("aria-pressed", measurementsVisible ? "true" : "false");
      btn.title = measurementsVisible ? MEASURE_TEXT.hide : MEASURE_TEXT.show;
      btn.innerHTML = (measurementsVisible ? EYE_ICON : EYE_OFF_ICON) + "<span>" + MEASURE_TEXT.label + "</span>";
    }

    document.getElementById("measure-toggle").addEventListener("click", function() {
      measurementsVisible = !measurementsVisible;
      var scene = getScene(currentSceneId);
      updateMeasureToggle(scene);
      if (scene) renderMeasurements(scene);
    });

    // ─── Theme (mirrors the standalone viewer, lib/cubemap/viewer/viewer.js) ──

    function applyOverlayPosition(el, ov) {
      var vAnchor = ov.position.indexOf("top") === 0 ? "top" : "bottom";
      var hAnchor = ov.position.indexOf("left") !== -1 ? "left" : ov.position.indexOf("right") !== -1 ? "right" : "center";
      var unit = ov.offsetUnit === "%" ? "%" : "px";
      var offX = ov.offsetX + unit;
      var offY = ov.offsetY + unit;
      el.style.position = "absolute";
      if (vAnchor === "top") el.style.top = offY;
      else el.style.bottom = offY;
      if (hAnchor === "left") {
        el.style.left = offX;
      } else if (hAnchor === "right") {
        el.style.right = offX;
      } else {
        el.style.left = "calc(50% + " + offX + ")";
        el.style.transform = "translateX(-50%)";
      }
    }

    function applyOverlayStyle(el, style) {
      style = style || {};
      if (style.opacity !== undefined) el.style.opacity = style.opacity;
      if (style.width !== undefined) el.style.width = style.width + "px";
      if (style.height !== undefined) el.style.height = style.height + "px";
      if (style.padding !== undefined) el.style.padding = style.padding + "px";
      if (style.backgroundColor !== undefined) el.style.backgroundColor = style.backgroundColor;
      if (style.fontSize !== undefined) el.style.fontSize = style.fontSize + "px";
      if (style.fontFamily !== undefined) el.style.fontFamily = style.fontFamily;
      if (style.color !== undefined) el.style.color = style.color;
      if (style.borderRadius !== undefined) el.style.borderRadius = style.borderRadius + "px";
    }

    function resolveOverlayVariables(content, vars) {
      return String(content).replace(/\\{\\{\\s*([\\w.]+)\\s*\\}\\}/g, function(match, key) {
        return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match;
      });
    }

    function renderThemeOverlays(sceneName) {
      var overlaysEl = document.getElementById("theme-overlays");
      overlaysEl.innerHTML = "";
      var vars = { "scene.title": sceneName || "", "project.name": PROJECT_NAME || "" };
      (THEME.overlays || []).forEach(function(ov) {
        var el;
        if (ov.type === "text") {
          el = document.createElement("div");
          el.className = "theme-overlay theme-overlay-text";
          el.textContent = resolveOverlayVariables(ov.content, vars);
        } else {
          if (!ov.content) return;
          el = document.createElement("img");
          el.className = "theme-overlay theme-overlay-image";
          el.alt = "";
          el.src = ov.content;
        }
        applyOverlayPosition(el, ov);
        applyOverlayStyle(el, ov.style);
        overlaysEl.appendChild(el);
      });
    }

    function applyTheme() {
      var titleEl = document.getElementById("title");
      if (THEME.showTitleOverlay !== false) titleEl.classList.add("visible");
      if (THEME.showNavbar !== false && THEME.logoUrl) {
        document.getElementById("logo").src = THEME.logoUrl;
        document.getElementById("navbar").classList.add("visible");
        titleEl.classList.add("with-navbar");
      }
    }

    function getScene(id) {
      return SCENES.find(s => s.id === id) || null;
    }

    function markerHtml(type) {
      const baseStyle = "width:36px;height:36px;border:3px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 10px 15px -3px rgba(0,0,0,0.3);cursor:pointer;user-select:none";
      if (type === "door") {
        return '<div style="' + baseStyle + ';background:#10b981"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a2 2 0 1 0 4 0 2 2 0 0 0-4 0"/><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/><path d="M17 17.5v-11"/></svg></div>';
      }
      if (type === "info") {
        return '<div style="' + baseStyle + ';background:#6366f1"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg></div>';
      }
      return '<div style="' + baseStyle + ';background:#4f46e5"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m12 8 4 4-4 4"/><path d="M8 12h8"/></svg></div>';
    }

    function updateMarkers(scene) {
      if (!markersPlugin) return;
      markersPlugin.clearMarkers();
      (scene.hotspots || []).forEach(function(h) {
        markersPlugin.addMarker({
          id: h.id,
          position: { yaw: (h.yaw * Math.PI) / 180, pitch: (h.pitch * Math.PI) / 180 },
          size: { width: 36, height: 36 },
          anchor: "center center",
          tooltip: { content: h.tooltip || h.type, position: "top center", trigger: "hover" },
          html: markerHtml(h.type)
        });
      });
      renderMeasurements(scene);
    }

    async function loadScene(sceneId) {
      const scene = getScene(sceneId);
      if (!scene) return;
      currentSceneId = sceneId;

      if (!viewer) {
        viewer = new Viewer({
          container: document.getElementById("viewer"),
          panorama: scene.panoramaUrl,
          navbar: false,
          mousemove: true,
          mousewheel: true,
          plugins: [[MarkersPlugin, {}]]
        });

        markersPlugin = viewer.getPlugin(MarkersPlugin);

        markersPlugin.addEventListener("select-marker", function(e) {
          const activeScene = getScene(currentSceneId);
          const hs = activeScene?.hotspots?.find(function(h) { return h.id === e.marker.id; });
          if (!hs) return;
          if (hs.type === "info") {
            if (hs.content) {
              showInfoModal(hs.tooltip || "Info", hs.content);
            } else if (hs.tooltip) {
              alert(hs.tooltip);
            }
            return;
          }
          if (hs.targetSceneId) {
            loadScene(hs.targetSceneId);
          } else if (hs.tooltip) {
            alert(hs.tooltip);
          }
        });

        viewer.addEventListener("ready", function() { updateMarkers(scene); }, { once: true });
      } else {
        await viewer.setPanorama(scene.panoramaUrl);
        updateMarkers(scene);
      }

      document.getElementById("title").textContent = scene.name;
      renderThemeOverlays(scene.name);
      updateMeasureToggle(scene);

      const listEl = document.getElementById("scene-list");
      listEl.innerHTML = "";
      SCENES.forEach(function(s) {
        const btn = document.createElement("button");
        btn.textContent = s.name;
        if (s.id === sceneId) btn.className = "active";
        btn.onclick = function() { loadScene(s.id); };
        listEl.appendChild(btn);
      });
    }

    applyTheme();
    loadScene(currentSceneId);
  </script>
</body>
</html>
`;
}

function extFromBlob(blob: Blob) {
  if (blob.type.includes("png")) return "png";
  if (blob.type.includes("webp")) return "webp";
  return "jpg";
}

function isInternalRef(url: string): boolean {
  return isLocalAssetRef(url);
}

async function resolvePanoramaForExport(
  projectId: string,
  url: string,
  index: number,
  scene: { name: string },
  sink: ExportSink,
): Promise<string> {
  if (!isInternalRef(url)) return url;
  const blob = await getBlob(projectId, url);
  if (blob) {
    const filename = `${slug(scene.name) || "scene"}-${index + 1}.${extFromBlob(blob)}`;
    await sink.writeFile(`panoramas/${filename}`, new Uint8Array(await blob.arrayBuffer()));
    return `panoramas/${filename}`;
  }
  return "";
}

/** Writes the Web 3D tour (index.html + panoramas/) into `sink`. */
export async function writeWeb3DTour(project: TourProject, sink: ExportSink): Promise<void> {
  const exported: TourProject = {
    ...project,
    scenes: [],
    theme: await resolveThemeForExport(project),
  };
  for (const [index, scene] of project.scenes.entries()) {
    const url = await resolvePanoramaForExport(
      project.id,
      scene.panoramaUrl,
      index,
      scene,
      sink,
    );
    exported.scenes.push({ ...scene, panoramaUrl: url });
  }
  await sink.writeFile("index.html", viewerHtml3D(exported));
}

/**
 * "Server Web (3D)" export: asks where to save (a folder in the desktop app, a
 * zip download in the browser), then writes the tour.
 */
export async function exportWeb3D(project: TourProject): Promise<ExportResult> {
  const sink = await openExportSink(`${slug(project.name)}-tour-3d`);
  if (!sink) return { status: "cancelled" };
  await writeWeb3DTour(project, sink);
  await sink.finish();
  return {
    status: "done",
    location: sink.location,
    ...(sink.indexPath && { indexPath: sink.indexPath }),
  };
}
