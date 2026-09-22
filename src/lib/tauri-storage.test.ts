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
});
