import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { getBlob, putBlob, resolveUrl, deleteBlob } from "./assets";
import { hasNativeImport, importPanoramaPaths } from "./panorama-import";
import { StorageError, describeStorageError } from "./storage-errors";
import { setStorageProvider } from "./storage-provider";
import { upsertProject } from "./storage";
import { classifyIdbError, createWebStorage } from "./web-storage";
import {
  imageBlob,
  installLocalStorage,
  installWindow,
  makeProject,
  textOf,
} from "./test-support/storage-env";
import { defineStorageSuite } from "./test-support/storage-suite";

installWindow({ tauri: false });
installLocalStorage();

let counter = 0;
const freshDb = () => `test-${counter++}`;

/** Every key of the database, i.e. the tree of data. */
async function keysOf(dbName: string): Promise<string[]> {
  const db: IDBDatabase = await new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const keys: IDBValidKey[] = await new Promise((resolve, reject) => {
    const r = db.transaction("files").objectStore("files").getAllKeys();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  db.close();
  return keys.map(String).sort();
}

defineStorageSuite({
  driver: "web (IndexedDB)",
  async create() {
    const dbName = freshDb();
    return {
      provider: createWebStorage({ dbName }),
      tree: () => keysOf(dbName),
      async cleanup() {
        Object.assign(globalThis, { indexedDB: new IDBFactory() });
      },
    };
  },
});

describe("web driver specifics", () => {
  it("is not a native-import environment", async () => {
    setStorageProvider(createWebStorage({ dbName: freshDb() }));
    try {
      assert.equal(hasNativeImport(), false);
      await assert.rejects(importPanoramaPaths("p1", ["/tmp/a.jpg"]), /not available/);
    } finally {
      setStorageProvider(null);
    }
  });

  it("a second tab (another connection) sees the same data", async () => {
    const dbName = freshDb();
    const tabA = createWebStorage({ dbName });
    const tabB = createWebStorage({ dbName });
    setStorageProvider(tabA);
    try {
      const ref = await putBlob("p1", "pano_a", imageBlob("a"));
      await upsertProject(makeProject("p1"));
      assert.deepEqual(await tabB.listProjectIds(), ["p1"]);
      assert.equal(await textOf(await tabB.readPanorama("p1", "pano_a.png")), "fake image a");
      assert.ok(ref);
    } finally {
      setStorageProvider(null);
    }
  });

  it("serves a stable object URL per file and forgets it when the file is deleted", async () => {
    setStorageProvider(createWebStorage({ dbName: freshDb() }));
    try {
      const ref = await putBlob("p1", "pano_a", imageBlob("a"));
      const url = await resolveUrl("p1", ref);
      assert.match(url, /^blob:/);
      assert.equal(await resolveUrl("p1", ref), url, "cached");
      const blob = await (await fetch(url)).blob();
      assert.equal(await blob.text(), "fake image a");

      await deleteBlob("p1", ref);
      assert.equal(await resolveUrl("p1", ref), "", "no stale URL for a deleted file");
      assert.equal(await getBlob("p1", ref), null);
    } finally {
      setStorageProvider(null);
    }
  });

  it("classifies browser storage errors", () => {
    const quota = classifyIdbError(new DOMException("full", "QuotaExceededError"));
    assert.ok(quota instanceof StorageError);
    assert.equal(quota.code, "IoError");
    assert.equal(describeStorageError(quota), "Browser storage is full.");

    assert.equal(
      classifyIdbError(new DOMException("no", "SecurityError")).code,
      "PermissionDenied",
    );
    assert.equal(classifyIdbError(new Error("boom")).code, "IoError");
    const already = new StorageError("FileNotFound", "x");
    assert.equal(classifyIdbError(already), already);
  });
});
