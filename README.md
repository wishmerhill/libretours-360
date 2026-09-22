# LibreTours 360
## An open-source, self-hosted web editor and viewer for creating interactive 360° virtual tours.

**Create, edit and export interactive 360° virtual tours — locally in your browser, or as a native desktop app.**

LibreTours 360 is a local-first virtual tour editor. Drop in your 360° panoramas, link scenes together with clickable hotspots, preview the result with smooth equirectangular navigation, and export a standalone viewer for sharing.

Built with [TanStack Start](https://tanstack.com/router/latest/docs/framework/react/start/overview), [React](https://react.dev), [Photo Sphere Viewer](https://photo-sphere-viewer.js.org/), and [Tauri](https://v2.tauri.app/).

> This project is the result of **vibe coding** — an experimental approach where the developer describes features in natural language and an AI agent translates them into working code. Every line you see here was generated through iterative prompts, not typed by hand.

---

## Features

- **360° Panorama Viewer** — Navigate equirectangular images with drag-to-look, zoom via scroll, and smooth autorotation.
- **Multi-scene Tours** — Link panoramas into a navigable tour with custom scene ordering.
- **Interactive Hotspots** — Place clickable markers on panoramas. Each hotspot can:
  - Navigate to another scene (scene link)
  - Show an informational tooltip (info popup)
  - Open an external URL
- **Visual Tour Editor** — Drag hotspots directly on the panorama canvas, adjust yaw/pitch/zoom in the properties panel, reorder scenes in the sidebar.
- **Export Formats**:
  - **ZIP** — Self-contained HTML viewer + panoramas + data, ready to host on any static server
  - **JSON** — Project data for backup or sharing with other tools
- **Desktop App** — Package as a native macOS application via Tauri with window controls, fullscreen support, and devtools.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | [TanStack Start](https://tanstack.com/router/latest/docs/framework/react/start/overview) (SSR + SPA) |
| UI Library | [React 19](https://react.dev) |
| Styling | [Tailwind CSS 4](https://tailwindcss.com) + [Radix UI](https://www.radix-ui.com/) primitives |
| Panorama Engine | [Photo Sphere Viewer 5](https://photo-sphere-viewer.js.org/) + [Markers Plugin](https://photo-sphere-viewer.js.org/plugins/markers) |
| State / Routing | [TanStack Router](https://tanstack.com/router/latest) + [TanStack Query](https://tanstack.com/query/latest) |
| Bundler | [Vite 8](https://vite.dev/) |
| Desktop Packaging | [Tauri 2](https://v2.tauri.app/) (Rust backend) |
| Storage | `StorageProvider`: files in `$APPDATA/projects/` (Tauri) or the same tree in IndexedDB (browser) |
| Export | [JSZip](https://stuk.github.io/jszip/) + [FileSaver](https://github.com/eligrey/FileSaver.js) |

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- npm (comes with Node.js)

### Development

```bash
# Clone the repository
git clone https://github.com/wishmerhill/openstudio.git
cd openstudio

# Install dependencies
npm install

# Start the development server
npm run dev
```

The app will be available at `http://localhost:5173`.

### Production Build (Web)

```bash
npm run build
npm run preview
```

The static output (for SSR deployment) is generated in `.output/public/`.

---

## Desktop Build (macOS)

LibreTours 360 can be packaged as a native macOS application using Tauri.

### Prerequisites for Tauri

- [Rust](https://www.rust-lang.org/tools/install) (install via `rustup`)
- macOS: Xcode Command Line Tools (`xcode-select --install`)

### Build the Desktop App

```bash
npm run tauri:build
```

The packaged `.app` bundle will be available in `src-tauri/target/release/bundle/`.

### Development (Desktop)

```bash
npm run tauri:dev
```

This starts the Vite dev server and opens a native window with live-reload.

> **Note:** When running inside Tauri, the app uses hash-based routing (`#/`) for compatibility with the `tauri://` protocol. The `vite.tauri.config.ts` configuration is used exclusively for the desktop build to output a clean SPA bundle to `dist/`.

---

## Export Formats

### ZIP Export

Exports a fully standalone HTML viewer:

```
tour-name-tour.zip
├── index.html          # Standalone viewer (equirectangular navigation, hotspots)
├── tour.json           # Full project data
├── tour-data.js        # Project data as a global `window.TOUR_DATA` variable
└── panoramas/
    ├── scene-1.jpg
    ├── scene-2.jpg
    └── ...
```

The viewer works on any static file server — no backend required.

### JSON Export

Exports just the project data as a portable JSON file for backup or sharing between instances.

---

## Project Structure

```
src/
├── components/
│   ├── studio/
│   │   ├── PanoCanvas.tsx          # 360° viewer with hotspot overlay
│   │   ├── LeftSidebar.tsx         # Scene list and management
│   │   ├── PropertiesPanel.tsx     # Hotspot/scene property editor
│   │   ├── ReverseHotspotModal.tsx # Modal for hotspot details
│   │   └── ExportDesktopModal.tsx  # Tauri build configuration dialog
│   └── ui/                         # Radix UI components (shadcn/ui style)
├── lib/
│   ├── export.ts                   # ZIP and JSON export logic
│   ├── storage.ts                  # Project persistence: Zod validation, backup recovery, quarantine
│   ├── storage-provider.ts         # StorageProvider interface shared by both drivers
│   ├── tauri-storage.ts            # Desktop driver (file system)
│   ├── web-storage.ts              # Browser driver (IndexedDB, path-keyed like the file tree)
│   ├── assets.ts                   # Panorama assets, driver-independent
│   └── utils.ts                    # Shared utilities
├── routes/
│   ├── index.tsx                   # Dashboard (project list)
│   └── editor.$id.tsx              # Tour editor page
├── types/
│   └── tour.ts                     # TourProject type definitions
├── main.tsx                        # SPA entry point (desktop build)
├── router.tsx                      # Router with hash history for Tauri
├── server.ts                       # SSR error boundary (web build)
└── start.ts                        # TanStack Start configuration
vite.config.ts                      # Web build configuration
vite.tauri.config.ts                # Desktop (Tauri) build configuration
src-tauri/                          # Tauri Rust backend
```

---

## How Hotspots Work

Hotspots are positioned on the 360° image using spherical coordinates:

- **`yaw`** — Horizontal rotation in degrees (-180 to 180, 0 = center)
- **`pitch`** — Vertical rotation in degrees (-90 to 90, 0 = horizon)

Each hotspot has a **type** (`scene` for navigation, `info` for information, `url` for external links) and an optional **tooltip** that appears on hover.

In the standalone ZIP export, hotspots are rendered as positioned `<div>` elements over the equirectangular background, with real-time coordinate recalculation on drag/zoom.

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
- Test both export formats (ZIP and JSON) when making changes to the viewer or data pipeline.

---

## License

Copyright (C) 2026 LibreTours 360 contributors

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
