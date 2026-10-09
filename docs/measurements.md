# Measurement lines

A measurement line is a segment drawn by hand on a panorama, from point A to point B, with a label you type yourself, for example `3,45 m`. Use it to show the size of a wall, a door or a room in the tour.

LibreTours 360 does not measure anything: the panoramas carry no scale information, so the label is plain text and you write the value you know.

## Drawing a line

In the editor, with a scene open in **Edit** mode:

1. Click **Measure** in the toolbar.
2. Click the first point on the panorama.
3. Move the mouse: a line follows the cursor. Click the second point.

The new line is selected and the **Label** field in the properties panel gets the focus, so you can type the value straight away.

While you draw:

- you can still drag the panorama to look around, and scroll to zoom in for a precise point;
- **Esc** removes the first point; pressing it again leaves the tool.

Clicking **Measure** again, switching to **Preview** or changing scene also leaves the tool.

## Editing a line

- **Move an end:** drag one of the two dots. The end follows the mouse exactly, and the line and its label move with it.
- **Select a line:** click the line or its label, or pick it from **Measurements in this scene** in the properties panel.
- **Fine-tune:** the properties panel shows the pitch and yaw of point A and point B, in degrees, and you can type new values.
- **Delete:** use **Delete measurement** in the properties panel, or the bin next to the line in the list.

The selected line is pink; the others are white.

## Showing and hiding the lines

When a scene has at least one line, every viewer shows a **Measurements** button with an eye icon, which shows or hides all the lines:

| Where | Button position |
|-------|-----------------|
| Editor and Preview | Bottom right, next to the zoom bar |
| Web 3D export | Top right |
| Standalone 3D export | Top right, next to the fullscreen button |

In the editor the button only changes what you see while you work; switching between Edit and Preview keeps its state. Starting the **Measure** tool shows the lines again if they were hidden.

### In the exported tours

The setting **Show measurements in the exported tour**, in the Measurements section of the properties panel, decides whether the lines are visible when an exported tour opens. Visitors can still use the button to change it. The setting applies to the whole project, not to one scene.

In the exported tours the lines are read-only: they cannot be moved, and they do not get in the way of navigation or of the hotspots. A line without a label is shown without the label pill.

## Why the lines stay straight

Every line belongs to one scene and is seen from the point where the panorama was taken. Seen from there, a straight segment in the real world, such as the edge of a wall, lies on a *great circle* of the panorama sphere: the circle whose centre is the camera.

So each line is stored as two directions (yaw and pitch of A and B) and drawn as the arc of the great circle between them. Drawn this way, a line placed on the edge of a wall stays on that edge whatever the view direction and zoom, in the editor and in both exports.

## Data format

Lines are saved in `project.json`, in the scene they belong to:

```json
{
  "schemaVersion": 2,
  "showMeasurements": true,
  "scenes": [
    {
      "id": "scene_…",
      "measurements": [
        {
          "id": "ms_…",
          "a": { "yaw": -26.432, "pitch": 12.061 },
          "b": { "yaw": 35.222, "pitch": 7.072 },
          "label": "3,45 m"
        }
      ]
    }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `measurements[].a`, `.b` | The two ends, in degrees, the same convention as hotspots: `yaw` from -180 to 180 (0 = centre of the image, positive to the right), `pitch` from -90 to 90 (0 = horizon, positive up). |
| `measurements[].label` | Free text. May be empty. |
| `showMeasurements` | Project-wide: whether the lines are visible when an exported tour opens. |

Measurements arrived with project format version 2. Projects saved by earlier versions open normally: their scenes get an empty list of measurements and `showMeasurements` is `true`.

The `.ltproj` package and the JSON export carry the measurements as part of the project data. The standalone export also writes them to its own `project.json`.

## Limits

- The label is free text: the app does not compute any length.
- A line can only join two points of the same scene.
- While the **Measure** tool is on, a click on a hotspot selects the hotspot instead of placing a point.
- The style is fixed (white dashed line with a dark outline): there is no per-line colour.

## For developers

- Geometry: `src/lib/measure-geometry.ts` (`greatCirclePoints`, `midpoint`). It samples the slerp between the two ends, handles ends that are opposite each other, and keeps yaw continuous when a line crosses ±180°. Tests: `src/lib/measure-geometry.test.ts`.
- The two exported viewers cannot import that module, so each carries a plain-JS copy of the same math: the Web 3D template in `src/lib/export.ts` and the standalone viewer in `src/lib/cubemap/viewer/viewer.js`. **Keep the three in sync.**
- Editor: `src/components/studio/PanoCanvas.tsx` draws the lines as Photo Sphere Viewer markers (ids `ms-<measurement id>-halo|line|a|b|label`, and `mstmp-…` for the line being drawn). Drag positions come from `viewer.dataHelper.viewerCoordsToSphericalCoords`. Photo Sphere Viewer reports click yaw from 0 to 360°, which the editor converts to -180..180. State and callbacks live in `src/routes/editor.$id.tsx`; the properties panel is `src/components/studio/PropertiesPanel.tsx`.
- Web 3D export: Photo Sphere Viewer polylines, with `pointer-events: none` so the lines never take clicks.
- Standalone export: no Photo Sphere Viewer and no WebGL, so `viewer.js` draws the arcs on an SVG layer. Each arc is cut where it passes behind the camera.
- Schema and migration: `src/types/tour.ts` and `src/lib/project-schema.ts` (`migrateProject`, step v1 → v2).
- Tests: `src/lib/export.test.ts` covers the Web 3D lines, labels and toggle, and that labels cannot inject HTML. `src/lib/cubemap/export.test.ts` covers the standalone tour data. `src/lib/project-schema.test.ts` covers the migration.
