import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getBlob } from "./assets";
import { hasNativeImport, importPanoramaPaths } from "./panorama-import";
import { setStorageProvider } from "./storage-provider";
import { tauriProvider } from "./tauri-storage";
import { installFakeTauri, textOf } from "./test-support/storage-env";
import { defineStorageSuite } from "./test-support/storage-suite";

defineStorageSuite({
  driver: "desktop (Tauri file system)",
  async create() {
    const tauri = await installFakeTauri();
    return { provider: tauriProvider, tree: () => tauri.tree(), cleanup: () => tauri.cleanup() };
  },
});

describe("desktop driver specifics", () => {
  const cleanups: Array<() => Promise<void>> = [];
  after(async () => {
    for (const c of cleanups) await c();
  });

  it("imports picked files by copying them natively", async () => {
    const tauri = await installFakeTauri();
    cleanups.push(tauri.cleanup);
    setStorageProvider(tauriProvider);
    try {
      assert.equal(hasNativeImport(), true);
      const src = join(tauri.root, "outside");
      await mkdir(src, { recursive: true });
      await writeFile(join(src, "Hall.JPEG"), "fake image hall");
      await writeFile(join(src, "notes.txt"), "not an image");

      const imported = await importPanoramaPaths("p1", [
        join(src, "Hall.JPEG"),
        join(src, "notes.txt"),
      ]);
      assert.equal(imported.length, 1);
      assert.equal(imported[0]!.name, "Hall");
      assert.match(imported[0]!.ref, /^tauri:pano_.+\.jpg$/);
      assert.equal(await textOf(await getBlob("p1", imported[0]!.ref)), "fake image hall");
      await assert.rejects(
        importPanoramaPaths("p1", [join(src, "notes.txt")]),
        /Only JPG, PNG or WebP/,
      );
    } finally {
      setStorageProvider(null);
    }
  });

  it("the theme library lives outside projects/, and round-trips through read/writeThemeLibrary", async () => {
    const tauri = await installFakeTauri();
    cleanups.push(tauri.cleanup);
    setStorageProvider(tauriProvider);
    try {
      await assert.rejects(
        tauriProvider.readThemeLibrary(),
        (e: unknown) => e instanceof Error && (e as { code?: string }).code === "FileNotFound",
      );

      await tauriProvider.writeThemeLibrary(JSON.stringify({ presets: [{ id: "t1" }] }));
      assert.equal(
        await tauriProvider.readThemeLibrary(),
        JSON.stringify({ presets: [{ id: "t1" }] }),
      );

      const tree: string[] = [];
      const themesRoot = join(tauri.root, "themes");
      const { readdir } = await import("node:fs/promises");
      for (const entry of await readdir(themesRoot)) tree.push(entry);
      assert.deepEqual(tree, ["library.json"]);

      // Not inside projects/: confirmed by the existing tree() helper, which only walks that folder.
      assert.equal((await tauri.tree()).length, 0);
    } finally {
      setStorageProvider(null);
    }
  });
});
