/**
 * Dashboard thumbnails.
 *
 * Panoramas are 8K-16K images; the dashboard only needs a small preview. The
 * thumbnail is generated once, when the panorama is imported, and stored next to
 * it (`projects/<id>/thumbnails/`), so the dashboard never decodes a full-size image.
 */

/** Width in pixels of generated thumbnails (height follows the aspect ratio). */
export const THUMBNAIL_WIDTH = 640;
const THUMBNAIL_QUALITY = 0.8;

/**
 * Downscales an image Blob to a JPEG thumbnail.
 *
 * The decoder is asked to resize while decoding (`resizeWidth`), which avoids
 * materializing the full-size bitmap where the engine supports it; engines that
 * ignore the option still produce a correct result through the canvas step.
 * Throws if the image cannot be decoded or encoded.
 */
export async function generateThumbnail(source: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source, {
      resizeWidth: THUMBNAIL_WIDTH,
      resizeQuality: "medium",
    });
  } catch {
    // Engine without resize options (or refusing them): decode normally.
    bitmap = await createImageBitmap(source);
  }

  try {
    const scale = Math.min(1, THUMBNAIL_WIDTH / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    let blob: Blob | null;
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D context is not available");
      ctx.drawImage(bitmap, 0, 0, width, height);
      blob = await canvas.convertToBlob({ type: "image/jpeg", quality: THUMBNAIL_QUALITY });
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D context is not available");
      ctx.drawImage(bitmap, 0, 0, width, height);
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", THUMBNAIL_QUALITY),
      );
    }
    if (!blob) throw new Error("Could not encode the thumbnail");
    return blob;
  } finally {
    bitmap.close();
  }
}
