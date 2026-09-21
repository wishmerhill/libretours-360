/*
 * Standalone CSS 3D cubemap viewer. No dependencies, no network, no WebGL:
 * the six faces of every scene are plain <img> elements positioned with CSS 3D
 * transforms (matrix3d under a `perspective`), so it works from file:// (WebGL
 * refuses to use images loaded from file:// as textures, CSS does not care).
 *
 * The tour comes from window.TOUR (see build-html.ts). Deep link / debugging:
 *   index.html#scene=<id>&yaw=<deg>&pitch=<deg>&fov=<deg>
 */
(function () {
  "use strict";

  var TOUR = window.TOUR;
  var SCENES = (TOUR && TOUR.scenes) || [];

  // Half the edge of the cube, in CSS pixels. Only the ratio to the perspective matters.
  var HALF = 512;
  // Every face is cut into TILES x TILES tiles, and only the tiles that can be seen are shown.
  // Two things are deliberate, both found by rendering the tour in Chrome and looking for holes:
  //  - No `transform-style: preserve-3d`. In a 3D rendering context Chrome sorts and splits the
  //    layers, and it drops or mangles the big ones that reach behind the camera (whole sides of
  //    the view go blank, seams open between faces). Instead every tile carries the complete
  //    camera transform and is projected on its own by the container's `perspective`. Seen from
  //    inside the cube tiles never hide each other, so no depth sorting is needed.
  //  - Tiles instead of one quad per face, culled when near or behind the camera.
  // TILES must be a power of two, so tile edges fall on whole pixels (no gaps between tiles).
  var TILES = 8;
  var TILE = (HALF * 2) / TILES;
  // Pixels a tile extends over the next one of its face. Edges of two tiles are anti-aliased
  // separately, so they must overlap by more than a screen pixel or a faint line shows between them.
  var OVERLAP = 4;
  // Pixels the border tiles of each face extend past the face, so neighbouring faces overlap.
  var BLEED = 4;
  // Tiles with a corner this close to the camera plane (or behind it) are not shown: they are
  // more than ~85 degrees away from the view axis, outside any realistic field of view.
  var NEAR = 30;
  // Screen margin in pixels around the viewport inside which tiles are still shown.
  var CULL_MARGIN = 64;
  var MIN_FOV = 30;
  var MAX_FOV = 90;
  var MAX_PITCH = 89;
  var DEG = Math.PI / 180;

  // Face order matches FACE_NAMES in core.ts. Each entry: right, down, forward (CSS axes: x right, y down, z to the viewer).
  var FACE_BASIS = [
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, -1],
    ], // front
    [
      [0, 0, 1],
      [0, 1, 0],
      [1, 0, 0],
    ], // right
    [
      [-1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ], // back
    [
      [0, 0, -1],
      [0, 1, 0],
      [-1, 0, 0],
    ], // left
    [
      [1, 0, 0],
      [0, 0, -1],
      [0, -1, 0],
    ], // top
    [
      [1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ], // bottom
  ];

  var stage = document.getElementById("stage");
  var world = document.getElementById("world");
  var hotspotLayer = document.getElementById("hotspots");
  var titleEl = document.getElementById("title");
  var sceneListEl = document.getElementById("scene-list");
  var loaderEl = document.getElementById("loader");
  var errorEl = document.getElementById("error");
  var modalEl = document.getElementById("modal");
  var modalTitleEl = document.getElementById("modal-title");
  var modalBodyEl = document.getElementById("modal-body");

  var view = { yaw: 0, pitch: 0, fov: 75 };
  var velocity = { yaw: 0, pitch: 0 };
  var currentScene = null;
  var hotspotEls = [];
  var tiles = [];
  var loadToken = 0;
  var dirty = true;

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function sceneById(id) {
    for (var i = 0; i < SCENES.length; i++) if (SCENES[i].id === id) return SCENES[i];
    return null;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** The editor stores zoom as a 0.6..3 multiplier; the editor viewer maps it to a 90..30 degree field of view. */
  function zoomToFov(zoom) {
    var z = typeof zoom === "number" && isFinite(zoom) ? zoom : 1;
    return clamp(MAX_FOV - ((z - 0.6) / 2.4) * (MAX_FOV - MIN_FOV), MIN_FOV, MAX_FOV);
  }

  // ─── Minimal, safe markdown for info hotspots ────────────────────────────

  function inlineMarkdown(escaped) {
    return escaped
      .split(/(`[^`]+`)/)
      .map(function (part, index) {
        if (index % 2 === 1) return "<code>" + part.slice(1, -1) + "</code>";
        return part
          .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
          .replace(/\*([^*]+)\*/g, "<em>$1</em>")
          .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (match, label, url) {
            // The text is already escaped; only web and mail links are allowed.
            if (!/^(https?:\/\/|mailto:)/i.test(url)) return label;
            return (
              '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + "</a>"
            );
          });
      })
      .join("");
  }

  function renderMarkdown(source) {
    var lines = escapeHtml(source).split(/\r?\n/);
    var html = [];
    var paragraph = [];
    var list = null; // "ul" | "ol"
    var code = null; // array while inside a fenced block

    function flushParagraph() {
      if (paragraph.length) html.push("<p>" + inlineMarkdown(paragraph.join(" ")) + "</p>");
      paragraph = [];
    }
    function closeList() {
      if (list) html.push("</" + list + ">");
      list = null;
    }

    lines.forEach(function (line) {
      if (/^```/.test(line)) {
        if (code) {
          html.push("<pre><code>" + code.join("\n") + "</code></pre>");
          code = null;
        } else {
          flushParagraph();
          closeList();
          code = [];
        }
        return;
      }
      if (code) {
        code.push(line);
        return;
      }

      var heading = /^(#{1,3}) (.+)$/.exec(line);
      var bullet = /^[-*] (.+)$/.exec(line);
      var numbered = /^\d+\. (.+)$/.exec(line);
      var quote = /^&gt; ?(.*)$/.exec(line);

      if (heading) {
        flushParagraph();
        closeList();
        html.push(
          "<h" +
            heading[1].length +
            ">" +
            inlineMarkdown(heading[2]) +
            "</h" +
            heading[1].length +
            ">",
        );
      } else if (bullet || numbered) {
        flushParagraph();
        var kind = bullet ? "ul" : "ol";
        if (list !== kind) {
          closeList();
          html.push("<" + kind + ">");
          list = kind;
        }
        html.push("<li>" + inlineMarkdown((bullet || numbered)[1]) + "</li>");
      } else if (quote) {
        flushParagraph();
        closeList();
        html.push("<blockquote>" + inlineMarkdown(quote[1]) + "</blockquote>");
      } else if (line.trim() === "") {
        flushParagraph();
        closeList();
      } else {
        closeList();
        paragraph.push(line);
      }
    });
    if (code) html.push("<pre><code>" + code.join("\n") + "</code></pre>");
    flushParagraph();
    closeList();
    return html.join("");
  }

  function showModal(title, markdown) {
    modalTitleEl.textContent = title;
    modalBodyEl.innerHTML = renderMarkdown(markdown);
    modalEl.classList.add("open");
  }

  function closeModal() {
    modalEl.classList.remove("open");
  }

  // ─── Cube ────────────────────────────────────────────────────────────────

  function faceMatrix(basis) {
    var r = basis[0];
    var d = basis[1];
    var f = basis[2];
    // Columns: image of the element's x (right), y (down) and z (its normal, towards the viewer inside the cube), then the translation.
    return (
      "matrix3d(" +
      [
        r[0],
        r[1],
        r[2],
        0,
        d[0],
        d[1],
        d[2],
        0,
        -f[0],
        -f[1],
        -f[2],
        0,
        f[0] * HALF,
        f[1] * HALF,
        f[2] * HALF,
        1,
      ].join(",") +
      ")"
    );
  }

  /**
   * Builds the tiles of the six faces from their URLs (already loaded, so served from cache).
   * Coordinates below are local to a face: x along its right axis, y along its down axis,
   * origin at the face centre, the face itself spanning [-HALF, HALF].
   */
  function buildTiles(urls) {
    var fragment = document.createDocumentFragment();
    var imageSize = HALF * 2 + BLEED * 2;
    tiles = [];
    urls.forEach(function (url, face) {
      var basis = FACE_BASIS[face];
      var matrix = faceMatrix(basis);
      for (var j = 0; j < TILES; j++) {
        for (var i = 0; i < TILES; i++) {
          // The tile's box. Tiles overlap the next one (same plane) and the tiles on the
          // border of the face bleed past it, so faces overlap and no seam shows between them.
          var x0 = -HALF + i * TILE - (i === 0 ? BLEED : 0);
          var x1 = -HALF + (i + 1) * TILE + (i === TILES - 1 ? BLEED : OVERLAP);
          var y0 = -HALF + j * TILE - (j === 0 ? BLEED : 0);
          var y1 = -HALF + (j + 1) * TILE + (j === TILES - 1 ? BLEED : OVERLAP);
          var cx = (x0 + x1) / 2;
          var cy = (y0 + y1) / 2;

          var el = document.createElement("div");
          el.className = "tile";
          el.style.width = x1 - x0 + "px";
          el.style.height = y1 - y0 + "px";
          // Centred on the middle of the view; the camera transform is prepended by render().
          el.style.left = "calc(50% - " + (x1 - x0) / 2 + "px)";
          el.style.top = "calc(50% - " + (y1 - y0) / 2 + "px)";
          el.style.display = "none";

          // The image is the whole face plus its bleed; the tile shows the part under its box.
          var img = document.createElement("img");
          img.alt = "";
          img.draggable = false;
          img.style.left = -HALF - BLEED - x0 + "px";
          img.style.top = -HALF - BLEED - y0 + "px";
          img.style.width = imageSize + "px";
          img.style.height = imageSize + "px";
          img.src = url;
          el.appendChild(img);
          fragment.appendChild(el);

          // Corners in world space: face centre + local offsets along the face's right and down axes.
          var corners = [];
          [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1],
          ].forEach(function (c) {
            corners.push([
              basis[0][0] * c[0] + basis[1][0] * c[1] + basis[2][0] * HALF,
              basis[0][1] * c[0] + basis[1][1] * c[1] + basis[2][1] * HALF,
              basis[0][2] * c[0] + basis[1][2] * c[1] + basis[2][2] * HALF,
            ]);
          });
          tiles.push({
            el: el,
            corners: corners,
            local: matrix + " translate(" + cx + "px," + cy + "px)",
            shown: false,
          });
        }
      }
    });
    world.textContent = "";
    world.appendChild(fragment);
  }

  /** Loads and decodes an image; rejects with the URL that failed. */
  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var done = function () {
          resolve(img);
        };
        if (img.decode) img.decode().then(done, done);
        else done();
      };
      img.onerror = function () {
        reject(new Error(url));
      };
      img.src = url;
    });
  }

  // ─── Camera ──────────────────────────────────────────────────────────────

  function perspective() {
    var height = stage.clientHeight || 1;
    return height / 2 / Math.tan((view.fov * DEG) / 2);
  }

  /** Screen position of a direction, or null when it is behind the camera. */
  function project(yawDeg, pitchDeg, perspectivePx) {
    var lon = yawDeg * DEG;
    var lat = pitchDeg * DEG;
    var x = Math.sin(lon) * Math.cos(lat);
    var y = -Math.sin(lat);
    var z = -Math.cos(lon) * Math.cos(lat);

    // Same rotations the CSS transform applies to the world: first yaw around y, then pitch around x.
    var cy = Math.cos(view.yaw * DEG);
    var sy = Math.sin(view.yaw * DEG);
    var x1 = x * cy + z * sy;
    var z1 = -x * sy + z * cy;
    var cp = Math.cos(view.pitch * DEG);
    var sp = Math.sin(view.pitch * DEG);
    var y2 = y * cp - z1 * sp;
    var z2 = y * sp + z1 * cp;

    if (z2 >= -0.01) return null;
    return {
      x: stage.clientWidth / 2 + (perspectivePx * x1) / -z2,
      y: stage.clientHeight / 2 + (perspectivePx * y2) / -z2,
    };
  }

  /** Shows only the tiles that can be on screen: in front of the camera and overlapping the viewport. */
  function cullTiles(perspectivePx, cameraTransform) {
    var w = stage.clientWidth;
    var h = stage.clientHeight;
    var cy = Math.cos(view.yaw * DEG);
    var sy = Math.sin(view.yaw * DEG);
    var cp = Math.cos(view.pitch * DEG);
    var sp = Math.sin(view.pitch * DEG);

    for (var t = 0; t < tiles.length; t++) {
      var tile = tiles[t];
      var visible = true;
      var minX = Infinity;
      var maxX = -Infinity;
      var minY = Infinity;
      var maxY = -Infinity;
      for (var c = 0; c < 4 && visible; c++) {
        var p = tile.corners[c];
        // The same rotation the CSS transform applies to the world (yaw around y, then pitch around x).
        var x1 = p[0] * cy + p[2] * sy;
        var z1 = -p[0] * sy + p[2] * cy;
        var y2 = p[1] * cp - z1 * sp;
        var z2 = p[1] * sp + z1 * cp;
        if (z2 >= -NEAR) {
          visible = false;
          break;
        }
        var sx = w / 2 + (perspectivePx * x1) / -z2;
        var sy2 = h / 2 + (perspectivePx * y2) / -z2;
        minX = Math.min(minX, sx);
        maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy2);
        maxY = Math.max(maxY, sy2);
      }
      if (visible) {
        visible =
          maxX >= -CULL_MARGIN &&
          minX <= w + CULL_MARGIN &&
          maxY >= -CULL_MARGIN &&
          minY <= h + CULL_MARGIN;
      }
      if (visible !== tile.shown) {
        tile.shown = visible;
        tile.el.style.display = visible ? "" : "none";
      }
      if (visible) tile.el.style.transform = cameraTransform + tile.local;
    }
  }

  function render() {
    var p = perspective();
    world.style.perspective = p + "px";
    // The camera sits at the centre of the cube: push the scene towards it by the perspective
    // distance, then rotate it the opposite way the camera turns (yaw first, then pitch).
    var camera =
      "translateZ(" + p + "px) rotateX(" + view.pitch + "deg) rotateY(" + view.yaw + "deg) ";
    cullTiles(p, camera);

    for (var i = 0; i < hotspotEls.length; i++) {
      var entry = hotspotEls[i];
      var pos = project(entry.data.yaw, entry.data.pitch, p);
      if (pos) {
        entry.el.style.display = "flex";
        entry.el.style.transform =
          "translate(" + pos.x + "px," + pos.y + "px) translate(-50%,-50%)";
      } else {
        entry.el.style.display = "none";
      }
    }
  }

  function requestRender() {
    dirty = true;
  }

  function frame() {
    // Inertia only runs once every pointer is up: while dragging, the pointer itself moves the view.
    if (
      pointerCount() === 0 &&
      (Math.abs(velocity.yaw) > 0.01 || Math.abs(velocity.pitch) > 0.01)
    ) {
      view.yaw += velocity.yaw;
      view.pitch = clamp(view.pitch + velocity.pitch, -MAX_PITCH, MAX_PITCH);
      velocity.yaw *= 0.92;
      velocity.pitch *= 0.92;
      dirty = true;
    }
    if (dirty) {
      dirty = false;
      render();
    }
    requestAnimationFrame(frame);
  }

  // ─── Hotspots ────────────────────────────────────────────────────────────

  var ICONS = {
    door: {
      color: "#10b981",
      svg: '<path d="M10 13a2 2 0 1 0 4 0 2 2 0 0 0-4 0"/><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/><path d="M17 17.5v-11"/>',
    },
    info: {
      color: "#6366f1",
      svg: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    },
    arrow: {
      color: "#4f46e5",
      svg: '<circle cx="12" cy="12" r="10"/><path d="m12 8 4 4-4 4"/><path d="M8 12h8"/>',
    },
  };

  function activateHotspot(hotspot) {
    if (hotspot.type === "info") {
      if (hotspot.content) showModal(hotspot.tooltip || "Info", hotspot.content);
      else if (hotspot.tooltip) showModal("Info", hotspot.tooltip);
      return;
    }
    if (hotspot.targetSceneId && sceneById(hotspot.targetSceneId)) {
      loadScene(hotspot.targetSceneId);
    } else if (hotspot.tooltip) {
      showModal("Info", hotspot.tooltip);
    }
  }

  function buildHotspots(scene) {
    hotspotLayer.textContent = "";
    hotspotEls = [];
    (scene.hotspots || []).forEach(function (hotspot) {
      var icon = ICONS[hotspot.type] || ICONS.arrow;
      var el = document.createElement("button");
      el.type = "button";
      el.className = "hs";
      el.style.background = icon.color;
      el.setAttribute("aria-label", hotspot.tooltip || hotspot.type);
      if (hotspot.tooltip) el.setAttribute("data-tip", hotspot.tooltip);
      el.innerHTML =
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
        icon.svg +
        "</svg>";
      el.addEventListener("click", function () {
        activateHotspot(hotspot);
      });
      hotspotLayer.appendChild(el);
      hotspotEls.push({ el: el, data: hotspot });
    });
  }

  // ─── Scenes ──────────────────────────────────────────────────────────────

  function buildSceneList() {
    sceneListEl.textContent = "";
    if (SCENES.length < 2) return;
    SCENES.forEach(function (scene) {
      var button = document.createElement("button");
      button.type = "button";
      button.dataset.scene = scene.id;
      if (scene.thumbnail) {
        var thumb = document.createElement("img");
        thumb.src = scene.thumbnail;
        thumb.alt = "";
        thumb.draggable = false;
        button.appendChild(thumb);
      }
      var label = document.createElement("span");
      label.textContent = scene.name;
      button.appendChild(label);
      button.addEventListener("click", function () {
        loadScene(scene.id);
      });
      sceneListEl.appendChild(button);
    });
  }

  function markActiveScene(id) {
    var buttons = sceneListEl.children;
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle("active", buttons[i].dataset.scene === id);
    }
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.add("open");
  }

  function loadScene(id, initialView) {
    var scene = sceneById(id);
    if (!scene) return Promise.resolve();
    var token = ++loadToken;
    errorEl.classList.remove("open");
    loaderEl.classList.add("open");

    return Promise.all(scene.faces.map(loadImage)).then(
      function (images) {
        if (token !== loadToken) return; // a newer scene was requested meanwhile
        buildTiles(scene.faces);
        currentScene = scene;
        velocity.yaw = velocity.pitch = 0;
        view.yaw = initialView ? initialView.yaw : 0;
        view.pitch = initialView ? initialView.pitch : 0;
        view.fov = initialView && initialView.fov ? initialView.fov : zoomToFov(scene.defaultZoom);
        titleEl.textContent = scene.name;
        document.title = TOUR.name + " - " + scene.name;
        buildHotspots(scene);
        markActiveScene(scene.id);
        loaderEl.classList.remove("open");
        // Draw right away: the scene must not be shown (or reported ready) before it is placed.
        render();
        document.documentElement.setAttribute("data-scene", scene.id);
        document.documentElement.setAttribute("data-ready", "1");
      },
      function (error) {
        if (token !== loadToken) return;
        loaderEl.classList.remove("open");
        showError(
          'Could not load the images of "' +
            scene.name +
            '" (' +
            error.message +
            "). " +
            "Keep index.html together with the panoramas folder.",
        );
        document.documentElement.setAttribute("data-error", "1");
      },
    );
  }

  // ─── Input ───────────────────────────────────────────────────────────────

  var pointers = {};
  var pinchDistance = 0;
  var lastMove = 0;

  function pointerCount() {
    return Object.keys(pointers).length;
  }

  function currentPinchDistance() {
    var ids = Object.keys(pointers);
    var a = pointers[ids[0]];
    var b = pointers[ids[1]];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  document.addEventListener("pointerdown", function (e) {
    if (e.target.closest(".hs, #scene-list, #modal, #controls")) return;
    if (e.button !== undefined && e.button > 0) return;
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    stage.classList.add("dragging");
    velocity.yaw = velocity.pitch = 0;
    if (pointerCount() === 2) pinchDistance = currentPinchDistance();
    try {
      stage.setPointerCapture(e.pointerId);
    } catch (err) {
      /* the pointer may already be gone */
    }
  });

  stage.addEventListener("pointermove", function (e) {
    var previous = pointers[e.pointerId];
    if (!previous) return;
    var dx = e.clientX - previous.x;
    var dy = e.clientY - previous.y;
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };

    if (pointerCount() >= 2) {
      var distance = currentPinchDistance();
      if (pinchDistance > 0 && distance > 0) {
        view.fov = clamp(view.fov * (pinchDistance / distance), MIN_FOV, MAX_FOV);
      }
      pinchDistance = distance;
    } else {
      var perPixel = view.fov / (stage.clientHeight || 1);
      // Dragging moves the scene with the pointer, so the camera turns the other way.
      var dYaw = -dx * perPixel;
      var dPitch = dy * perPixel;
      view.yaw += dYaw;
      view.pitch = clamp(view.pitch + dPitch, -MAX_PITCH, MAX_PITCH);
      velocity.yaw = dYaw;
      velocity.pitch = dPitch;
      lastMove = e.timeStamp;
    }
    requestRender();
  });

  function endPointer(e) {
    if (!pointers[e.pointerId]) return;
    delete pointers[e.pointerId];
    if (pointerCount() < 2) pinchDistance = 0;
    if (pointerCount() === 0) {
      stage.classList.remove("dragging");
      // A pause before release means the user stopped: no fling.
      if (e.timeStamp - lastMove > 80) velocity.yaw = velocity.pitch = 0;
    }
  }
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", endPointer);

  stage.addEventListener(
    "wheel",
    function (e) {
      e.preventDefault();
      var delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      view.fov = clamp(view.fov * Math.exp(delta * 0.0012), MIN_FOV, MAX_FOV);
      requestRender();
    },
    { passive: false },
  );

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") return closeModal();
    var step = view.fov / 12;
    var handled = true;
    if (e.key === "ArrowLeft") view.yaw -= step;
    else if (e.key === "ArrowRight") view.yaw += step;
    else if (e.key === "ArrowUp") view.pitch = clamp(view.pitch + step, -MAX_PITCH, MAX_PITCH);
    else if (e.key === "ArrowDown") view.pitch = clamp(view.pitch - step, -MAX_PITCH, MAX_PITCH);
    else if (e.key === "+" || e.key === "=") view.fov = clamp(view.fov * 0.9, MIN_FOV, MAX_FOV);
    else if (e.key === "-") view.fov = clamp(view.fov / 0.9, MIN_FOV, MAX_FOV);
    else handled = false;
    if (handled) requestRender();
  });

  modalEl.addEventListener("click", function (e) {
    if (e.target === modalEl) closeModal();
  });
  document.getElementById("modal-close").addEventListener("click", closeModal);

  var fullscreenButton = document.getElementById("fullscreen");
  if (document.documentElement.requestFullscreen) {
    fullscreenButton.addEventListener("click", function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    });
  } else {
    fullscreenButton.style.display = "none";
  }

  window.addEventListener("resize", requestRender);

  // ─── Start ───────────────────────────────────────────────────────────────

  function parseHash() {
    var out = {};
    location.hash
      .replace(/^#/, "")
      .split("&")
      .forEach(function (pair) {
        var kv = pair.split("=");
        if (kv[0]) out[kv[0]] = decodeURIComponent(kv[1] || "");
      });
    return out;
  }

  if (!SCENES.length) {
    showError("This tour has no scenes.");
    return;
  }

  var hash = parseHash();
  var startScene = sceneById(hash.scene) || sceneById(TOUR.initialSceneId) || SCENES[0];
  var startView = null;
  if (hash.yaw || hash.pitch || hash.fov) {
    startView = {
      yaw: parseFloat(hash.yaw) || 0,
      pitch: clamp(parseFloat(hash.pitch) || 0, -MAX_PITCH, MAX_PITCH),
      fov: hash.fov ? clamp(parseFloat(hash.fov), MIN_FOV, MAX_FOV) : 0,
    };
  }

  if (!(TOUR.theme && TOUR.theme.showTitleOverlay === false)) titleEl.classList.add("visible");
  buildSceneList();
  requestAnimationFrame(frame);
  loadScene(startScene.id, startView);
})();
