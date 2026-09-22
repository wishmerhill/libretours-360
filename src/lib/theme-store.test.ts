import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@/types/tour";
import { setStorageProvider } from "./storage-provider";
import { createWebStorage } from "./web-storage";
import { installLocalStorage, installWindow, imageBlob, textOf } from "./test-support/storage-env";
import { putThemeAsset } from "./theme-assets";
import {
  applyThemePreset,
  BUILTIN_THEME_PRESETS,
  buildThemeExportFile,
  deleteThemePreset,
  importThemeFile,
  isBuiltInThemePreset,
  listThemePresets,
  materializeTheme,
  portabilizeTheme,
  renameThemePreset,
  saveThemePreset,
} from "./theme-store";

installWindow({ tauri: false });
installLocalStorage();

let counter = 0;
function freshProvider() {
  const provider = createWebStorage({ dbName: `theme-store-${counter++}` });
  setStorageProvider(provider);
  return provider;
}

function baseTheme(overrides: Partial<Theme> = {}): Theme {
  return { showNavbar: true, showTitleOverlay: true, logoUrl: "", overlays: [], ...overrides };
}

// ─── Built-ins & listing ────────────────────────────────────────────────────

test("listThemePresets returns the built-in presets when the library is empty", async () => {
  freshProvider();
  const presets = await listThemePresets();
  assert.deepEqual(
    presets.map((p) => p.id),
    BUILTIN_THEME_PRESETS.map((p) => p.id),
  );
  assert.ok(presets.every((p) => isBuiltInThemePreset(p.id)));
});

// ─── portabilizeTheme / materializeTheme round trip ────────────────────────

test("portabilizeTheme inlines a local asset ref as a data: URL; materializeTheme turns it back into a local ref", async () => {
  freshProvider();
  const ref = await putThemeAsset("proj-a", "logo", imageBlob("logo-bytes", "image/png"));
  const theme = baseTheme({
    logoUrl: ref,
    overlays: [
      { id: "o1", type: "image", position: "top-left", offsetX: 0, offsetY: 0, offsetUnit: "px", style: {}, content: ref },
      { id: "o2", type: "text", position: "top-right", offsetX: 0, offsetY: 0, offsetUnit: "px", style: {}, content: "{{scene.title}}" },
    ],
  });

  const portable = await portabilizeTheme(theme, "proj-a");
  assert.match(portable.logoUrl, /^data:image\/png;base64,/);
  assert.match(portable.overlays[0]!.content, /^data:image\/png;base64,/);
  assert.equal(portable.overlays[1]!.content, "{{scene.title}}"); // text passes through unchanged

  const materialized = await materializeTheme(portable, "proj-b");
  assert.ok(materialized.logoUrl.startsWith("asset:"));
  assert.notEqual(materialized.logoUrl, ref); // a fresh key under the destination project
});

test("materializeTheme stores the actual bytes under the destination project and gives overlays fresh ids", async () => {
  const provider = freshProvider();
  const theme = baseTheme({
    overlays: [
      {
        id: "original-id",
        type: "image",
        position: "top-left",
        offsetX: 0,
        offsetY: 0,
        offsetUnit: "px",
        style: {},
        content: "data:image/png;base64," + Buffer.from("fake image inline").toString("base64"),
      },
    ],
  });

  const materialized = await materializeTheme(theme, "proj-x");
  const el = materialized.overlays[0]!;
  assert.notEqual(el.id, "original-id");
  assert.ok(el.content.startsWith("asset:"));
  const key = el.content.slice("asset:".length);
  assert.equal(await textOf(await provider.readAsset("proj-x", key)), "fake image inline");
});

test("a legacy http(s) reference is dropped (not embedded) when portabilizing, to keep the result self-contained", async () => {
  freshProvider();
  const theme = baseTheme({ logoUrl: "https://example.com/logo.svg" });
  const portable = await portabilizeTheme(theme, "proj-a");
  assert.equal(portable.logoUrl, "");
});

// ─── Save / rename / delete ─────────────────────────────────────────────────

test("saveThemePreset adds a portable preset to the library, listed after the built-ins", async () => {
  freshProvider();
  const ref = await putThemeAsset("proj-a", "logo", imageBlob("saved-logo"));
  const saved = await saveThemePreset("My theme", baseTheme({ logoUrl: ref }), "proj-a");

  assert.equal(saved.name, "My theme");
  assert.match(saved.theme.logoUrl, /^data:/);

  const all = await listThemePresets();
  assert.equal(all.length, BUILTIN_THEME_PRESETS.length + 1);
  assert.equal(all.at(-1)!.id, saved.id);
});

test("renameThemePreset updates a saved preset's name; deleteThemePreset removes it", async () => {
  freshProvider();
  const saved = await saveThemePreset("Original name", baseTheme(), "proj-a");

  await renameThemePreset(saved.id, "Renamed");
  let all = await listThemePresets();
  assert.equal(all.find((p) => p.id === saved.id)!.name, "Renamed");

  await deleteThemePreset(saved.id);
  all = await listThemePresets();
  assert.equal(all.some((p) => p.id === saved.id), false);
});

test("renameThemePreset and deleteThemePreset are no-ops on a built-in preset", async () => {
  freshProvider();
  const builtinId = BUILTIN_THEME_PRESETS[0]!.id;
  await renameThemePreset(builtinId, "Hacked name");
  await deleteThemePreset(builtinId);

  const all = await listThemePresets();
  assert.equal(all.find((p) => p.id === builtinId)!.name, BUILTIN_THEME_PRESETS[0]!.name);
});

// ─── applyThemePreset ────────────────────────────────────────────────────────

test("applyThemePreset materializes a built-in preset (no assets) for the target project", async () => {
  freshProvider();
  const corporate = BUILTIN_THEME_PRESETS.find((p) => p.id === "builtin:corporate")!;
  const theme = await applyThemePreset(corporate, "proj-a");
  assert.equal(theme.overlays.length, 1);
  assert.notEqual(theme.overlays[0]!.id, corporate.theme.overlays[0]!.id);
  assert.equal(theme.overlays[0]!.content, "{{project.name}}");
});

// ─── .lt-theme export / import ──────────────────────────────────────────────

test("buildThemeExportFile produces a self-contained, portable file", async () => {
  freshProvider();
  const ref = await putThemeAsset("proj-a", "logo", imageBlob("export-logo"));
  const file = await buildThemeExportFile("Exported theme", baseTheme({ logoUrl: ref }), "proj-a");

  assert.equal(file.name, "Exported theme");
  assert.match(file.theme.logoUrl, /^data:/);
  assert.ok(file.exportedAt);
});

test("importThemeFile materializes the file's theme for the project and also saves it to the library", async () => {
  freshProvider();
  const dataUrl = "data:image/png;base64," + Buffer.from("fake image imported").toString("base64");
  const fileText = JSON.stringify({
    formatVersion: 1,
    name: "Imported theme",
    exportedAt: new Date().toISOString(),
    theme: baseTheme({ logoUrl: dataUrl }),
  });

  const { theme, preset } = await importThemeFile(fileText, "proj-a");
  assert.ok(theme.logoUrl.startsWith("asset:"));
  assert.equal(preset.name, "Imported theme");
  assert.match(preset.theme.logoUrl, /^data:/); // the library keeps the portable form

  const all = await listThemePresets();
  assert.ok(all.some((p) => p.id === preset.id));
});

test("importThemeFile rejects a file that fails schema validation", async () => {
  freshProvider();
  await assert.rejects(importThemeFile("not json", "proj-a"));
  await assert.rejects(importThemeFile(JSON.stringify({ formatVersion: 999 }), "proj-a"));
});
