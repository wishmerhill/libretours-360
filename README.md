# LibreTours 360
## An open-source, local-first editor and viewer for creating interactive 360° virtual tours.

**Create, edit and export interactive 360° virtual tours — locally in your browser, or as a native desktop app for macOS and Windows.**

LibreTours 360 is a local-first virtual tour editor. Drop in your 360° panoramas, link scenes together with clickable hotspots, brand the tour with a theme, preview the result with smooth equirectangular navigation, and export a standalone viewer for sharing.

Built with [TanStack Start](https://tanstack.com/router/latest/docs/framework/react/start/overview), [React](https://react.dev), [Photo Sphere Viewer](https://photo-sphere-viewer.js.org/), and [Tauri](https://v2.tauri.app/).

> This project is the result of **vibe coding** — an experimental approach where the developer describes features in natural language and an AI agent translates them into working code. Every line you see here was generated through iterative prompts, not typed by hand.

---

## Features up to now

- **360° Panorama Viewer** — Navigate equirectangular images with drag-to-look, zoom via scroll, and smooth autorotation.
- **Multi-scene Tours** — Link panoramas into a navigable tour with custom scene ordering.
- **Interactive Hotspots** — Place clickable markers on panoramas. Three hotspot types:
  - **Door** — navigates to another scene
  - **Arrow** — directional navigation marker to another scene
  - **Info** — opens a popup with rich content written in Markdown (bold, italic, links, lists, code)
- **Visual Tour Editor** — Drag hotspots directly on the panorama canvas, adjust yaw/pitch/zoom in the properties panel, set a per-scene default view (yaw/pitch/zoom), reorder scenes in the sidebar.
- **Theme Builder** — Brand your tours:
  - Overlay elements (logo, image, text) anchored to the viewport with px/% offsets
  - A dedicated Theme Canvas mode with responsive preview, plus a live preview over the 3D panorama
  - A theme preset library, with import/export of `.lt-theme` files to reuse themes across projects
- **Internationalization (i18n) and localization (l10n) ready** — See [Internationalization](#internationalization-i18n--localization-l10n).
- **Export Formats**:
  - **Web 3D** — Photo Sphere Viewer-powered ZIP with full 3D navigation (needs a webserver, due to browser CORS restrictions on `file://`)
  - **Standalone 3D** — Folder export using a CSS cubemap renderer: opens `index.html` directly via double-click/`file://`, no webserver needed
  - **JSON** — Project data for backup or sharing with other tools
- **Desktop App** — Native application for **macOS** (`.app`) and **Windows** (NSIS installer) via Tauri, with window controls, fullscreen support, and devtools. On Windows, WebGL crashes are caught and WebView2 falls back to software rendering.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | [TanStack Start](https://tanstack.com/router/latest/docs/framework/react/start/overview) (SSR + SPA) |
| UI Library | [React 19](https://react.dev) |
| Styling | [Tailwind CSS 4](https://tailwindcss.com) + [Radix UI](https://www.radix-ui.com/) primitives |
| Panorama Engine | [Photo Sphere Viewer 5](https://photo-sphere-viewer.js.org/) + [Markers Plugin](https://photo-sphere-viewer.js.org/plugins/markers) |
| State / Routing | [TanStack Router](https://tanstack.com/router/latest) + [TanStack Query](https://tanstack.com/query/latest) |
| Validation | [Zod](https://zod.dev) project schema with versioned migrations |
| Bundler | [Vite 8](https://vite.dev/) |
| Desktop Packaging | [Tauri 2](https://v2.tauri.app/) (Rust backend) |
| Storage | `StorageProvider`: files in `$APPDATA/projects/` (Tauri) or the same tree in IndexedDB (browser) |
| Export | [JSZip](https://stuk.github.io/jszip/) + [FileSaver](https://github.com/eligrey/FileSaver.js) + custom CSS cubemap renderer |
| i18n | [i18next](https://www.i18next.com/) + [react-i18next](https://react.i18next.com/) |

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- npm (comes with Node.js)

### Development

```bash
# Clone the repository
git clone https://github.com/wishmerhill/libretours-360.git
cd libretours-360

# Install dependencies
npm install

# Start the development server
npm run dev
```

The app will be available at `http://localhost:3000`.

### Tests

```bash
npm test
```

Runs the unit and integration tests (`src/**/*.test.ts`) with the Node.js built-in test runner.

### Production Build (Web)

```bash
npm run build
npm run preview
```

> **Note:** In the browser, projects are stored in IndexedDB — i.e. in each user's own browser, not on the server. Deploying the web version to a static server (Docker/nginx, Apache) is not yet verified end-to-end: see the [web deploy plan](docs/future-plans/03-deploy-web.md) for the open points (SPA fallback, asset base path, build target).

---

## Desktop Build (macOS / Windows)

LibreTours 360 can be packaged as a native desktop application using Tauri.

### Prerequisites for Tauri

- [Rust](https://www.rust-lang.org/tools/install) (install via `rustup`)
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Windows: [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and WebView2 (preinstalled on Windows 10/11)

### Build the Desktop App

```bash
npm run tauri:build
```

The packaged bundle (`.app` on macOS, NSIS installer on Windows) will be available in `src-tauri/target/release/bundle/`. Windows builds are also produced in CI by the `build-windows.yml` GitHub Actions workflow.

### Development (Desktop)

```bash
npm run tauri:dev
```

This starts the Vite dev server and opens a native window with live-reload.

> **Note:** When running inside Tauri, the app uses hash-based routing (`#/`) for compatibility with the `tauri://` protocol. The `vite.tauri.config.ts` configuration is used exclusively for the desktop build to output a clean SPA bundle to `dist/`.

---

## Export Formats

The editor's export menu offers three options:

### Web 3D — ZIP

Exports a viewer powered by Photo Sphere Viewer for full 3D navigation, together with the panoramas:

```
tour-name-tour-3d.zip
├── index.html          # Viewer with the tour data embedded (3D navigation, hotspots)
└── panoramas/
    ├── scene-1.jpg
    ├── scene-2.jpg
    └── ...
```

Because the module loading it relies on browser CORS rules, this export **must be served over HTTP(S)** — it will not run directly from `file://`.

The theme (logo, title visibility and custom overlays) is embedded in `index.html`, with images inlined as data URLs.

### Standalone 3D — CSS Cubemap folder

Exports a folder that opens with a plain double-click, no server involved:

```
tour-name/
├── index.html           # Standalone viewer (CSS 3D cubemap, no WebGL/module loading)
├── project.json         # Full project data
├── panoramas/
│   └── <scene>/{front,right,back,left,top,bottom}.jpg
└── thumbnails/
    └── <scene>.jpg
```

Each panorama is converted into six cube faces at export time so the resulting viewer works straight from `file://`, sidestepping the CORS restrictions that Web 3D export runs into. The theme (logo, title visibility and custom overlays) is included, as in Web 3D.

### JSON Export

Exports just the project data as a portable JSON file for backup or sharing between instances.

---

## Internationalization (i18n) & Localization (l10n)

The project is ready for translation: no user-facing string is hardcoded in the editor UI.

- **Editor & dashboard** use [i18next](https://www.i18next.com/) + [react-i18next](https://react.i18next.com/). Strings live in per-language JSON dictionaries under `src/locales/`, organized by area (`common`, `app`, `dashboard`, `editor.*`, `dialogs`).
- **Language selection** is detected from the saved preference or the browser language, and can be changed at runtime with the in-app language switcher (dashboard header and editor toolbar). The choice is persisted in `localStorage`.
- **Standalone 3D viewer** (`src/lib/cubemap/viewer/viewer.js`) carries its own tiny dependency-free dictionary, so it keeps working from `file://`, and picks the language from the visitor's browser.
- **Currently available:** English (`en`), Italian (`it`).

### Adding a language

1. Copy `src/locales/en.json` to `src/locales/<code>.json` and translate the values (keep the keys).
2. Register it in `src/lib/i18n.ts`: import the file, add it to `resources` and to `SUPPORTED_LANGUAGES`. The language switcher picks it up automatically.
3. Add the same language to the `STRINGS` dictionary in `src/lib/cubemap/viewer/viewer.js` and extend its language detection.

> **Known limitation:** the Web 3D export template in `src/lib/export.ts` still contains a few hardcoded strings and are not localized yet.

---

## Project Structure

```
src/
├── components/
│   ├── studio/
│   │   ├── PanoCanvas.tsx          # 360° viewer with hotspot overlay
│   │   ├── LeftSidebar.tsx         # Scenes, theme and floorplans tabs
│   │   ├── PropertiesPanel.tsx     # Hotspot/scene property editor
│   │   ├── ThemeCanvas.tsx         # Theme Canvas 2D editing mode
│   │   ├── ThemeOverlayCanvas.tsx  # Theme overlay rendering (also live over the 3D canvas)
│   │   ├── ThemeElementEditor.tsx  # Overlay element inspector
│   │   └── ReverseHotspotModal.tsx # Modal for hotspot details
│   ├── ui/                         # Radix UI components (shadcn/ui style)
│   └── LanguageSwitcher.tsx        # Runtime language switcher
├── lib/
│   ├── export.ts                   # Web 3D ZIP export + JSON export
│   ├── cubemap/                    # Standalone 3D export: panorama → cube faces, CSS 3D viewer, no webserver
│   ├── project-schema.ts           # Zod schema + versioned project migrations
│   ├── project-saver.ts            # Saves projects, deleting unused images only after a successful save
│   ├── storage.ts                  # Project persistence: validation, backup recovery, quarantine
│   ├── storage-provider.ts         # StorageProvider interface shared by both drivers
│   ├── storage-layout.ts           # On-disk/IndexedDB path layout and asset refs
│   ├── tauri-storage.ts            # Desktop driver (file system)
│   ├── web-storage.ts              # Browser driver (IndexedDB, path-keyed like the file tree)
│   ├── assets.ts                   # Panorama assets, driver-independent
│   ├── panorama-import.ts          # Panorama import pipeline
│   ├── theme-assets.ts             # Theme image assets
│   ├── theme-store.ts              # Theme presets library + .lt-theme import/export
│   ├── theme-overlay-layout.ts     # Overlay anchoring/offset layout
│   ├── i18n.ts                     # i18next setup
│   └── utils.ts                    # Shared utilities
├── locales/
│   ├── en.json                     # English UI strings
│   └── it.json                     # Italian UI strings
├── routes/
│   ├── index.tsx                   # Dashboard (project list)
│   └── editor.$id.tsx              # Tour editor page
├── types/
│   └── tour.ts                     # TourProject type definitions
├── main.tsx                        # SPA entry point (desktop build)
├── router.tsx                      # Router with hash history for Tauri
├── server.ts                       # SSR error boundary (web build)
└── start.ts                        # TanStack Start configuration
docs/future-plans/                  # Roadmap: planned features, to be reviewed before implementation
vite.config.ts                      # Web build configuration
vite.tauri.config.ts                # Desktop (Tauri) build configuration
src-tauri/                          # Tauri Rust backend
```

---

## How Hotspots Work

Hotspots are positioned on the 360° image using spherical coordinates:

- **`yaw`** — Horizontal rotation in degrees (-180 to 180, 0 = center)
- **`pitch`** — Vertical rotation in degrees (-90 to 90, 0 = horizon)

Each hotspot has a **type** (`door` and `arrow` for navigation to a target scene, `info` for a Markdown popup) and an optional **tooltip** that appears on hover.

---

## Roadmap

Planned features are described in [`docs/future-plans/`](docs/future-plans/README.md), including:

- Measurement lines drawn on panoramas
- Multi-level floorplans with scene position and live viewing direction (minimap in the exported tours)
- Web deploy (Docker / Apache) and removal of the Lovable build wrapper
- Localization of the Web 3D export viewer

---

## Contributing

Contributions are welcome! Here's how you can help:

1. **Fork** the repository
2. **Create a feature branch** (`git checkout -b feat/amazing-feature`)
3. **Commit your changes** (`git commit -m 'Add amazing feature'`)
4. **Push to the branch** (`git push origin feat/amazing-feature`)
5. **Open a Pull Request**

### Development Guidelines

- Keep the app **local-first** — everything must work offline with no backend dependency.
- Use **TypeScript** for all new code.
- Follow the existing component patterns (Radix UI primitives, Tailwind classes, `cn()` utility).
- **No hardcoded UI strings** — add new strings to every dictionary in `src/locales/`.
- Run `npm test` and test all export formats (Web 3D, Standalone 3D, JSON) when making changes to the viewer or data pipeline.

---

## License

Copyright (C) 2026 LibreTours 360 contributors

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
