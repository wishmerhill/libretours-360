/**
 * Converts an equirectangular (2:1) image into the six JPEG faces of a cube,
 * using only Canvas 2D. The heavy lifting (per-pixel sampling) lives in ./core.
 *
 * Memory: a 16K panorama is 512 MB as raw pixels, so the source is never
 * materialized as a whole. It is decoded once as an ImageBitmap (kept by the
 * browser, outside the JS heap) and, for every slice of a face, only the thin
 * horizontal band of the source that slice reads is copied out as pixels.
 */
import {
  FACE_NAMES,
  chooseFaceSize,
  renderFaceRows,
  sourceRowRange,
  type FaceName,
  type SourceBand,
} from "./core";

export interface CubeFace {
  name: FaceName;
  blob: Blob;
}

export interface ConvertOptions {
  /** Upper bound for the face size in pixels (default 4096). */
  maxFaceSize?: number;
  /** JPEG quality, 0..1 (default 0.9). */
  quality?: number;
  /** Called with the completed fraction, 0..1. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** Tolerance on the 2:1 aspect ratio before the image is refused. */
const ASPECT_TOLERANCE = 0.05;
/** Face rows rendered per band read, and between two yields to the UI thread. */
const ROWS_PER_SLICE = 128;

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas: AnyCanvas) {
  const ctx = canvas.getContext("2d") as
    OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("Canvas 2D context is not available");
  return ctx;
}

async function encodeJpeg(canvas: AnyCanvas, quality: number): Promise<Blob> {
  let blob: Blob | null;
  if (canvas instanceof HTMLCanvasElement) {
    blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
  } else {
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  }
  if (!blob) throw new Error("Could not encode a cube face as JPEG");
  return blob;
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
}

/** Copies rows [first, end) of the bitmap out as RGBA pixels. */
function readBand(bitmap: ImageBitmap, first: number, end: number): SourceBand {
  const rows = end - first;
  const canvas = createCanvas(bitmap.width, rows);
  const ctx = context2d(canvas);
  ctx.drawImage(bitmap, 0, first, bitmap.width, rows, 0, 0, bitmap.width, rows);
  const { data } = ctx.getImageData(0, 0, bitmap.width, rows);
  return { data, width: bitmap.width, fullHeight: bitmap.height, firstRow: first, rows };
}

/**
 * Splits `source` into the faces named in FACE_NAMES order. Throws if the image
 * cannot be decoded, is not (roughly) 2:1, or the signal is aborted.
 */
export async function equirectToCubeFaces(
  source: Blob,
  options: ConvertOptions = {},
): Promise<CubeFace[]> {
  const { maxFaceSize, quality = 0.9, onProgress, signal } = options;
  throwIfAborted(signal);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    throw new Error("The image could not be decoded");
  }

  try {
    const ratio = bitmap.width / bitmap.height;
    if (Math.abs(ratio - 2) > 2 * ASPECT_TOLERANCE) {
      throw new Error(
        `The image is ${bitmap.width}x${bitmap.height}: a 360° panorama must be 2:1 (equirectangular)`,
      );
    }

    const size = chooseFaceSize(bitmap.width, maxFaceSize);
    const faceCanvas = createCanvas(size, size);
    const faceCtx = context2d(faceCanvas);
    const pixels = new ImageData(size, size);

    const faces: CubeFace[] = [];

    for (const [index, name] of FACE_NAMES.entries()) {
      for (let row = 0; row < size; row += ROWS_PER_SLICE) {
        throwIfAborted(signal);
        const rowEnd = Math.min(size, row + ROWS_PER_SLICE);
        const { first, end } = sourceRowRange(name, bitmap.height, size, row, rowEnd);
        renderFaceRows(readBand(bitmap, first, end), name, size, pixels.data, row, rowEnd);
        onProgress?.((index + rowEnd / size) / FACE_NAMES.length);
        await yieldToUi();
      }

      faceCtx.putImageData(pixels, 0, 0);
      faces.push({ name, blob: await encodeJpeg(faceCanvas, quality) });
    }
    return faces;
  } finally {
    bitmap.close();
  }
}
