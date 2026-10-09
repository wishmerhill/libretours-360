# Project package (`.ltproj`)

A `.ltproj` file holds a whole LibreTours 360 project: its data **and** its images. Use it to:

- back up a project;
- move a project between the browser and the desktop app;
- move a project to another computer or another browser.

## Why not just JSON?

The editor stores images apart from the project data:

- **in the browser**, in the browser's own storage (IndexedDB), separately for each site address;
- **in the desktop app**, in the app's data folder (`$APPDATA/projects/<project id>/`). On macOS that is `~/Library/Application Support/com.libretours.studio/projects/`.

The project data does not contain the images. It only *refers* to them by name: `tauri:pano_….jpg` for a panorama and `asset:asset_….png` for a theme image. A JSON export contains only those references, so a project imported from a JSON in another place has no panoramas, no logo and no overlay images, even though its scenes, hotspots and theme settings are all there.

A `.ltproj` package carries the image files along with the references.

## Using it

### Export

On the dashboard, open a project's menu (⋮) and choose **Export project (.ltproj)**. The quick download button on the project card does the same thing. The file is saved as `<project-name>.ltproj`.

If some image the project refers to cannot be found, the export still completes and a warning says how many images are missing. Those images are listed in the package's `manifest.json`.

### Import

On the dashboard, click **Import project** and choose the `.ltproj` file. The same button still accepts plain `.json` files, and the app tells the two apart by their content, not by the file extension.

The package becomes a **new project**. Projects that are already there are never changed, so importing the same package twice gives two separate copies.

### Example: from the browser to the desktop app

1. In the web app, export the project as `.ltproj`.
2. In the desktop app, choose **Import project** and pick the file.

The other direction works the same way.

## What happens on import

1. The file is checked: it must be a zip with a valid `manifest.json` and a `project.json` that passes the same validation as any project. If it does not, the import is refused and nothing is written.
2. The project, its scenes and its hotspots get new ids, as with a JSON import. Hotspot links and the initial scene follow the new ids.
3. Each image is written into the new project **under the same name** it had in the package, so the project's references still point to the right files.
4. A thumbnail is created for each panorama. Thumbnails are not stored in the package. If one cannot be created, the import still succeeds and the project simply shows no preview.
5. The project is saved.

The import is all or nothing: if something fails after the first file has been written, the half-imported project is removed.

If the package itself lacks some images (because they were already missing at export time), the project is imported anyway and a warning says how many are missing. Those scenes or theme elements show no image until you replace it in the editor.

## File format

A `.ltproj` file is a standard zip archive, so you can open it with any zip tool:

```
<project-name>.ltproj
├── manifest.json
├── project.json
├── panoramas/<key>      one file per panorama   ("tauri:<key>" in project.json)
└── assets/<key>         one file per theme image ("asset:<key>" in project.json)
```

`panoramas/` and `assets/` have the same layout the app uses in its own storage (see `src/lib/storage-layout.ts`).

### `manifest.json`

```json
{
  "format": "libretours-project",
  "formatVersion": 1,
  "exportedAt": "2026-10-09T10:00:00.000Z",
  "missing": ["tauri:pano_ab12cd.jpg"]
}
```

| Field | Meaning |
|-------|---------|
| `format` | Always `"libretours-project"`. Any other value is refused. |
| `formatVersion` | Version of the package layout, currently `1`. A package from a newer version of the app is refused with an "unsupported version" error. |
| `exportedAt` | When the package was created. |
| `missing` | References in `project.json` whose file could not be found at export time. |

### `project.json`

The project exactly as it is stored by the app, with the same schema as a JSON export. It has its own `schemaVersion`, and older project versions are migrated on import as usual.

### Which images are included

- the panorama of every scene whose `panoramaUrl` is a `tauri:` reference;
- the theme logo (`theme.logoUrl`) and every image or logo overlay (`theme.overlays[].content`) that is an `asset:` reference;
- floorplan images (`floorplans[].imageUrl`) that are `asset:` references.

Images given as a web address (`https://…`) or embedded as `data:` URLs are left as they are and are not copied into the package.

Images are stored without further compression, since JPEG, PNG and WebP are already compressed. Only the two JSON files are compressed.

## Limits

- The package is built and read in memory. A tour with many high-resolution panoramas can take a lot of memory while it is exported or imported, especially in the browser.
- Browser projects can only be exported from the site address where they were created, because each address has its own separate storage.
- `.lt-theme` files are a different thing: they hold a single theme (with its images inlined) for the theme library, not a project.

## For developers

- Code: `src/lib/project-package.ts` (`buildProjectPackage`, `exportProjectPackage`, `importProjectPackage`, `looksLikePackage`, `hasLocalImages`).
- Dashboard wiring: `src/routes/index.tsx`.
- Tests: the shared storage suite in `src/lib/test-support/storage-suite.ts`, which runs on both the browser and the desktop storage. It covers the round trip, missing images, invalid files, unsafe names and a package from a newer version.
- If the layout changes, increase `PACKAGE_FORMAT_VERSION` and keep reading older packages.
