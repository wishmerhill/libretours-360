/**
 * Equirectangular -> cubemap math, with no dependency on the DOM.
 *
 * Coordinate system (the same one the CSS 3D viewer uses): x right, y down,
 * z towards the viewer, so "straight ahead" is (0, 0, -1). A panorama direction
 * is described by a yaw (longitude, positive to the right, 0 = centre of the
 * equirectangular image) and a pitch (latitude, positive up), exactly like the
 * hotspots stored in the project.
 *
 * Each cube face is described by a forward vector `f` (where the face is), a
 * `right` vector and a `down` vector. The pixel (u, v) in [-1, 1] of a face
 * looks in the direction `f + u * right + v * down`. Faces are chosen so that
 * `right x down = -f`, i.e. the image is seen unmirrored from inside the cube.
 */

export type Vec3 = readonly [number, number, number];

export const FACE_NAMES = ["front", "right", "back", "left", "top", "bottom"] as const;
export type FaceName = (typeof FACE_NAMES)[number];

export interface FaceBasis {
  forward: Vec3;
  right: Vec3;
  down: Vec3;
}

export const FACES: Record<FaceName, FaceBasis> = {
  front: { forward: [0, 0, -1], right: [1, 0, 0], down: [0, 1, 0] },
  right: { forward: [1, 0, 0], right: [0, 0, 1], down: [0, 1, 0] },
  back: { forward: [0, 0, 1], right: [-1, 0, 0], down: [0, 1, 0] },
  left: { forward: [-1, 0, 0], right: [0, 0, -1], down: [0, 1, 0] },
  top: { forward: [0, -1, 0], right: [1, 0, 0], down: [0, 0, -1] },
  bottom: { forward: [0, 1, 0], right: [1, 0, 0], down: [0, 0, 1] },
};

const TWO_PI = Math.PI * 2;

/** Direction (not normalized) seen by pixel (u, v) in [-1, 1] of a face. */
export function faceDirection(face: FaceName, u: number, v: number): Vec3 {
  const { forward: f, right: r, down: d } = FACES[face];
  return [f[0] + u * r[0] + v * d[0], f[1] + u * r[1] + v * d[1], f[2] + u * r[2] + v * d[2]];
}

/**
 * Position in the equirectangular image, both in [0, 1], seen in a direction.
 * x = 0.5 is yaw 0, y = 0 is straight up.
 */
export function directionToEquirect(x: number, y: number, z: number): { s: number; t: number } {
  const lon = Math.atan2(x, -z);
  const lat = Math.atan2(-y, Math.hypot(x, z));
  return { s: lon / TWO_PI + 0.5, t: 0.5 - lat / Math.PI };
}

/** Face sizes are multiples of this (keeps GPU-friendly sizes and predictable output). */
const FACE_SIZE_STEP = 256;
const MIN_FACE_SIZE = 512;
export const MAX_FACE_SIZE = 4096;

/**
 * Face size that keeps the detail of the source: at the centre of a face one
 * pixel covers the same angle as one pixel of an equirectangular image of
 * width `faceSize * PI`. Larger faces would only enlarge, smaller ones lose detail.
 */
export function chooseFaceSize(sourceWidth: number, maxFaceSize = MAX_FACE_SIZE): number {
  const ideal = Math.floor(sourceWidth / Math.PI / FACE_SIZE_STEP) * FACE_SIZE_STEP;
  return Math.min(maxFaceSize, Math.max(MIN_FACE_SIZE, ideal));
}

/**
 * Rows of the source image (inclusive `first`, exclusive `end`) that face rows
 * [rowStart, rowEnd) read, including what bilinear filtering needs. Lets the
 * converter decode only a thin band of a 16K image instead of the whole thing:
 * all of a side face spans half the image height, a slice of 128 rows a few percent.
 */
export function sourceRowRange(
  face: FaceName,
  sourceHeight: number,
  faceSize: number,
  rowStart = 0,
  rowEnd = faceSize,
): { first: number; end: number } {
  const v0 = (rowStart / faceSize) * 2 - 1;
  const v1 = (rowEnd / faceSize) * 2 - 1;
  let minT = 1;
  let maxT = 0;
  const visit = (u: number, v: number) => {
    const [x, y, z] = faceDirection(face, u, v);
    const { t } = directionToEquirect(x, y, z);
    minT = Math.min(minT, t);
    maxT = Math.max(maxT, t);
  };
  // Latitude is smooth on a face, so its extremes are on the border of the slice,
  // on its centre line (side faces peak at u = 0) or at a pole: a dense sample of
  // the border plus an interior grid finds them, and the margin absorbs the rest.
  const steps = 32;
  for (let i = 0; i <= steps; i++) {
    const k = (i / steps) * 2 - 1;
    const v = v0 + (i / steps) * (v1 - v0);
    visit(k, v0);
    visit(k, v1);
    visit(-1, v);
    visit(1, v);
    visit(0, v);
  }
  // A pole is the one place the border sampling cannot see: the slice contains it.
  if (face === "top" && v0 <= 0 && v1 >= 0) minT = 0;
  if (face === "bottom" && v0 <= 0 && v1 >= 0) maxT = 1;
  // One face pixel spans up to ~2 source rows at the widest; keep a margin.
  const margin = Math.ceil(sourceHeight / faceSize) + 3;
  return {
    first: Math.max(0, Math.floor(minT * sourceHeight) - margin),
    end: Math.min(sourceHeight, Math.ceil(maxT * sourceHeight) + margin),
  };
}

/** RGBA pixels of a horizontal band of the source, starting at `firstRow`. */
export interface SourceBand {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  /** Height of the whole source image (not of the band). */
  fullHeight: number;
  firstRow: number;
  rows: number;
}

/**
 * Renders rows [rowStart, rowEnd) of a face into `out` (RGBA, `size` x `size`),
 * sampling `band` with bilinear filtering (wrapping horizontally, clamping at the poles).
 */
export function renderFaceRows(
  band: SourceBand,
  face: FaceName,
  size: number,
  out: Uint8ClampedArray | Uint8Array,
  rowStart: number,
  rowEnd: number,
): void {
  const { forward: f, right: r, down: d } = FACES[face];
  const { data, width: sw, fullHeight: sh, firstRow, rows } = band;
  const lastRow = firstRow + rows - 1;

  for (let j = rowStart; j < rowEnd; j++) {
    const v = ((j + 0.5) / size) * 2 - 1;
    for (let i = 0; i < size; i++) {
      const u = ((i + 0.5) / size) * 2 - 1;
      const x = f[0] + u * r[0] + v * d[0];
      const y = f[1] + u * r[1] + v * d[1];
      const z = f[2] + u * r[2] + v * d[2];

      const s = Math.atan2(x, -z) / TWO_PI + 0.5;
      const t = 0.5 - Math.atan2(-y, Math.hypot(x, z)) / Math.PI;

      // Pixel centres sit at +0.5, hence the -0.5 to get the top-left neighbour.
      const px = s * sw - 0.5;
      const py = t * sh - 0.5;
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const fx = px - x0;
      const fy = py - y0;
      const xa = ((x0 % sw) + sw) % sw;
      const xb = (xa + 1) % sw;
      const ya = Math.min(lastRow, Math.max(firstRow, y0)) - firstRow;
      const yb = Math.min(lastRow, Math.max(firstRow, y0 + 1)) - firstRow;

      const i00 = (ya * sw + xa) * 4;
      const i10 = (ya * sw + xb) * 4;
      const i01 = (yb * sw + xa) * 4;
      const i11 = (yb * sw + xb) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const o = (j * size + i) * 4;
      for (let c = 0; c < 3; c++) {
        out[o + c] =
          data[i00 + c]! * w00 + data[i10 + c]! * w10 + data[i01 + c]! * w01 + data[i11 + c]! * w11;
      }
      out[o + 3] = 255;
    }
  }
}
