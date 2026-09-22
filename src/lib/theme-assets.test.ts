import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blobToDataUrl,
  dataUrlToBlob,
  deleteThemeAsset,
  getThemeAsset,
  isGenericAssetRef,
  putThemeAsset,
  resolveThemeAssetUrl,
} from "./theme-assets";
import { setStorageProvider } from "./storage-provider";
import { createWebStorage } from "./web-storage";
import { imageBlob, installLocalStorage, installWindow, textOf } from "./test-support/storage-env";

installWindow({ tauri: false });
installLocalStorage();

let counter = 0;
function freshProvider() {
  const provider = createWebStorage({ dbName: `theme-assets-${counter++}` });
  setStorageProvider(provider);
  return provider;
}

test("putThemeAsset stores the blob under an 'asset:' reference, distinct from panorama refs", async () => {
  freshProvider();
  const ref = await putThemeAsset("p1", "logo", imageBlob("logo", "image/png"));
  assert.equal(isGenericAssetRef(ref), true);
  assert.equal(ref.startsWith("asset:"), true);
  assert.equal(ref.startsWith("tauri:"), false);
});

test("getThemeAsset retrieves what putThemeAsset stored", async () => {
  freshProvider();
  const ref = await putThemeAsset("p1", "logo", imageBlob("hello"));
  assert.equal(await textOf(await getThemeAsset("p1", ref)), "fake image hello");
});

test("getThemeAsset returns null for a ref it does not own (panorama/tauri refs, external URLs)", async () => {
  freshProvider();
  assert.equal(await getThemeAsset("p1", "tauri:some-pano.jpg"), null);
  assert.equal(await getThemeAsset("p1", "https://example.com/logo.svg"), null);
  assert.equal(await getThemeAsset("p1", ""), null);
});

test("deleteThemeAsset removes the file; other references are a no-op", async () => {
  freshProvider();
  const ref = await putThemeAsset("p1", "logo", imageBlob("x"));
  await deleteThemeAsset("p1", ref);
  assert.equal(await getThemeAsset("p1", ref), null);

  // No throw for refs it does not own.
  await deleteThemeAsset("p1", "https://example.com/logo.svg");
  await deleteThemeAsset("p1", "");
});

test("resolveThemeAssetUrl passes http(s)/data URLs through unchanged", async () => {
  freshProvider();
  assert.equal(await resolveThemeAssetUrl("p1", ""), "");
  assert.equal(
    await resolveThemeAssetUrl("p1", "https://example.com/logo.svg"),
    "https://example.com/logo.svg",
  );
  assert.equal(
    await resolveThemeAssetUrl("p1", "data:image/png;base64,AAA="),
    "data:image/png;base64,AAA=",
  );
});

test("resolveThemeAssetUrl resolves a local 'asset:' reference to a loadable URL", async () => {
  freshProvider();
  const ref = await putThemeAsset("p1", "logo", imageBlob("x"));
  const url = await resolveThemeAssetUrl("p1", ref);
  assert.notEqual(url, "");
  assert.notEqual(url, ref);
});

test("blobToDataUrl round-trips through base64", async () => {
  const blob = imageBlob("round-trip", "image/png");
  const dataUrl = await blobToDataUrl(blob);
  assert.match(dataUrl, /^data:image\/png;base64,/);

  const base64 = dataUrl.split(",")[1]!;
  const decoded = Buffer.from(base64, "base64").toString("utf8");
  assert.equal(decoded, "fake image round-trip");
});

test("dataUrlToBlob is the inverse of blobToDataUrl", async () => {
  const original = imageBlob("round-trip-2", "image/webp");
  const dataUrl = await blobToDataUrl(original);
  const blob = dataUrlToBlob(dataUrl);
  assert.equal(blob.type, "image/webp");
  assert.equal(await textOf(blob), "fake image round-trip-2");
});

test("dataUrlToBlob throws for a string that is not a data: URL", () => {
  assert.throws(() => dataUrlToBlob("https://example.com/logo.svg"));
  assert.throws(() => dataUrlToBlob(""));
});

test("theme asset keys are isolated from panorama keys of the same project", async () => {
  const provider = freshProvider();
  await provider.writePanorama("p1", "shared-name.jpg", imageBlob("pano"));
  const ref = await putThemeAsset("p1", "shared-name", imageBlob("logo"));

  assert.equal(
    await textOf(await provider.readPanorama("p1", "shared-name.jpg")),
    "fake image pano",
  );
  assert.equal(await textOf(await getThemeAsset("p1", ref)), "fake image logo");
});
