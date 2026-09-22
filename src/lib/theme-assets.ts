/**
 * Generic project assets used by the theme (logo, overlay images, ...).
 *
 * These live in their own folder (`projects/<id>/assets/`), separate from
 * panoramas (see storage-layout.ts): a theme logo is never a panorama and
 * must not share its key space. The theme stores an "asset:<key>" reference
 * (GENERIC_ASSET_REF_PREFIX), never a remote URL.
 *
 * Nothing here knows which driver is in use.
 */
import { getStorageProvider } from "./storage-provider";
import { makeGenericAssetRef, parseGenericAssetRef } from "./storage-layout";

export { isGenericAssetRef } from "./storage-layout";

/**
 * Stores an asset Blob in the project and returns the reference to put in
 * Theme.logoUrl (or an overlay element's content). An image extension is
 * appended to the key when it has none.
 */
export async function putThemeAsset(projectId: string, key: string, blob: Blob): Promise<string> {
  return makeGenericAssetRef(await getStorageProvider().writeAsset(projectId, key, blob));
}

/** Retrieves a Blob by its reference. Returns null if it is not a local reference or does not exist. */
export async function getThemeAsset(projectId: string, ref: string): Promise<Blob | null> {
  const key = parseGenericAssetRef(ref);
  return key ? await getStorageProvider().readAsset(projectId, key) : null;
}

/** Deletes a stored asset by its reference string. Other references (data:/http(s)) are ignored. */
export async function deleteThemeAsset(projectId: string, ref: string): Promise<void> {
  const key = parseGenericAssetRef(ref);
  if (key) await getStorageProvider().deleteAsset(projectId, key);
}

/**
 * Resolves a theme asset reference (http, data, or a local "asset:<key>"
 * reference) into something an <img> tag can load.
 *
 * - local references: whatever the driver serves (an asset URL or an object URL);
 *   "" if the file is missing;
 * - http(s) / data URLs: passed through unchanged (http(s) only for themes
 *   saved by an earlier version, before inline assets existed).
 */
export async function resolveThemeAssetUrl(projectId: string, ref: string): Promise<string> {
  if (!ref) return "";
  if (ref.startsWith("http://") || ref.startsWith("https://") || ref.startsWith("data:"))
    return ref;

  const key = parseGenericAssetRef(ref);
  if (key) return await getStorageProvider().assetUrl(projectId, key);

  return ref;
}

/**
 * Converts a Blob to a base64 data: URL, e.g. to embed an image inline in a
 * standalone export. Works with plain ArrayBuffer bytes (not FileReader), so
 * it runs the same in the browser, in Tauri's WebView and in Node tests.
 */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let base64: string;
  if (typeof Buffer !== "undefined") {
    base64 = Buffer.from(bytes).toString("base64");
  } else {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    base64 = btoa(binary);
  }
  return `data:${blob.type || "application/octet-stream"};base64,${base64}`;
}
