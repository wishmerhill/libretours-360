import test from "node:test";
import assert from "node:assert/strict";
import {
  FACES,
  FACE_NAMES,
  chooseFaceSize,
  directionToEquirect,
  faceDirection,
  renderFaceRows,
  sourceRowRange,
  type FaceName,
  type SourceBand,
  type Vec3,
} from "./core";

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

test("every face is an orthonormal basis seen unmirrored from inside (right x down = -forward)", () => {
  for (const name of FACE_NAMES) {
    const { forward, right, down } = FACES[name];
    near(Math.hypot(...forward), 1);
    near(Math.hypot(...right), 1);
    near(Math.hypot(...down), 1);
    near(dot(forward, right), 0);
    near(dot(forward, down), 0);
    near(dot(right, down), 0);
    const c = cross(right, down);
    for (let i = 0; i < 3; i++) near(c[i]!, -forward[i]!);
  }
});

test("face centres look at the expected place of the equirectangular image", () => {
  const centre = (face: FaceName) => {
    const [x, y, z] = faceDirection(face, 0, 0);
    return directionToEquirect(x, y, z);
  };
  near(centre("front").s, 0.5);
  near(centre("front").t, 0.5);
  near(centre("right").s, 0.75);
  near(centre("left").s, 0.25);
  // "back" sits on the seam of the image: s = 0 or 1.
  assert.ok(Math.min(Math.abs(centre("back").s), Math.abs(centre("back").s - 1)) < 1e-9);
  near(centre("top").t, 0);
  near(centre("bottom").t, 1);
  for (const side of ["front", "right", "back", "left"] as const) near(centre(side).t, 0.5);
});

test("neighbouring faces share their edges (no gap, no mirroring)", () => {
  const same = (a: Vec3, b: Vec3) => {
    const na = normalize(a);
    const nb = normalize(b);
    for (let i = 0; i < 3; i++) near(na[i]!, nb[i]!);
  };
  const ring: FaceName[] = ["front", "right", "back", "left"];
  for (let i = 0; i < 4; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % 4]!;
    for (const v of [-1, -0.3, 0, 0.7, 1]) {
      // right edge of a == left edge of the next one
      same(faceDirection(a, 1, v), faceDirection(b, -1, v));
    }
  }
  // Top edge of each side face is an edge of the top face (and the bottom one of the bottom face).
  for (const side of ring) {
    for (const u of [-1, -0.5, 0, 0.5, 1]) {
      const [x, y, z] = normalize(faceDirection(side, u, -1));
      const onTopEdge = ["top"].some((f) =>
        [-1, 1].some((k) => {
          // find the top-face edge point with the same direction
          for (const t of [-1, -0.5, 0, 0.5, 1]) {
            const d = normalize(faceDirection(f as FaceName, k, t));
            if (Math.hypot(d[0] - x, d[1] - y, d[2] - z) < 1e-9) return true;
            const d2 = normalize(faceDirection(f as FaceName, t, k));
            if (Math.hypot(d2[0] - x, d2[1] - y, d2[2] - z) < 1e-9) return true;
          }
          return false;
        }),
      );
      // Only grid points that land on the sampled top-edge points are checked, so require at least the corners.
      if (Math.abs(u) === 1) assert.ok(onTopEdge, `${side} corner not shared with top`);
    }
  }
});

test("chooseFaceSize keeps the detail of the source, in steps of 256, within limits", () => {
  assert.equal(chooseFaceSize(16384), 4096); // ideal 5215, capped
  assert.equal(chooseFaceSize(8192), 2560); // ideal 2607
  assert.equal(chooseFaceSize(4096), 1280);
  assert.equal(chooseFaceSize(1024), 512); // never below the minimum
  assert.equal(chooseFaceSize(16384, 2048), 2048); // caller cap
  for (const w of [2048, 3000, 6000, 12000]) assert.equal(chooseFaceSize(w) % 256, 0);
});

test("sourceRowRange covers every row a slice of a face can sample, and stays thin", () => {
  const H = 4096;
  const size = 1024;
  const slice = 128;
  for (const face of FACE_NAMES) {
    for (let rowStart = 0; rowStart < size; rowStart += slice) {
      const rowEnd = rowStart + slice;
      const { first, end } = sourceRowRange(face, H, size, rowStart, rowEnd);
      assert.ok(first >= 0 && end <= H && first < end);
      for (let j = rowStart; j < rowEnd; j += 2) {
        for (let i = 0; i < size; i += 4) {
          const [x, y, z] = faceDirection(
            face,
            ((i + 0.5) / size) * 2 - 1,
            ((j + 0.5) / size) * 2 - 1,
          );
          const row = directionToEquirect(x, y, z).t * H;
          assert.ok(
            row >= first && row <= end,
            `${face} rows ${rowStart}-${rowEnd}: source row ${row} outside [${first}, ${end})`,
          );
        }
      }
      // The 16K image is 512 MB as pixels: a slice must read a fraction of it. The two
      // slices of a pole face that contain the pole itself read down to 25% of it.
      const hasPole =
        (face === "top" || face === "bottom") && rowStart <= size / 2 && rowEnd >= size / 2;
      const limit = hasPole ? 0.3 : 0.2;
      assert.ok((end - first) / H < limit, `${face} ${rowStart}: band is ${(end - first) / H}`);
    }
  }
  // The whole face is a much bigger band, which is why slicing matters.
  const whole = sourceRowRange("front", H, size);
  assert.ok((whole.end - whole.first) / H > 0.45);
});

/** A source whose pixel colour encodes its own position: R = column, G = row (256 steps). */
function positionSource(width: number, height: number): SourceBand {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = Math.floor((x / width) * 256);
      data[o + 1] = Math.floor((y / height) * 256);
      data[o + 3] = 255;
    }
  }
  return { data, width, fullHeight: height, firstRow: 0, rows: height };
}

test("renderFaceRows samples the right place of the source", () => {
  const W = 1024;
  const H = 512;
  const source = positionSource(W, H);
  const size = 64;

  const centreOf = (face: FaceName) => {
    const out = new Uint8Array(size * size * 4);
    renderFaceRows(source, face, size, out, 0, size);
    const o = ((size / 2) * size + size / 2) * 4; // a pixel next to the exact centre
    return { r: out[o]!, g: out[o + 1]!, a: out[o + 3]!, out };
  };

  const front = centreOf("front");
  assert.ok(Math.abs(front.r - 128) <= 3, `front R ${front.r}`); // s = 0.5
  assert.ok(Math.abs(front.g - 128) <= 3, `front G ${front.g}`); // t = 0.5
  assert.equal(front.a, 255);
  assert.ok(Math.abs(centreOf("right").r - 192) <= 3); // s = 0.75
  assert.ok(Math.abs(centreOf("left").r - 64) <= 3); // s = 0.25
  assert.ok(centreOf("top").g <= 3); // straight up = first row
  assert.ok(centreOf("bottom").g >= 252); // straight down = last row
  // Across the whole front face, the image advances left to right (not mirrored).
  const o = (x: number, y: number) => (y * size + x) * 4;
  assert.ok(front.out[o(size - 4, size / 2)]! > front.out[o(4, size / 2)]!);
  // ... and top to bottom.
  assert.ok(front.out[o(size / 2, size - 4) + 1]! > front.out[o(size / 2, 4) + 1]!);
});

test("renderFaceRows from per-slice bands gives the same pixels as from the full image", () => {
  const W = 512;
  const H = 256;
  const full = positionSource(W, H);
  const size = 48;
  const slice = 16;
  for (const face of FACE_NAMES) {
    const a = new Uint8Array(size * size * 4);
    const b = new Uint8Array(size * size * 4);
    renderFaceRows(full, face, size, a, 0, size);
    for (let row = 0; row < size; row += slice) {
      const { first, end } = sourceRowRange(face, H, size, row, row + slice);
      const band: SourceBand = {
        data: full.data.subarray(first * W * 4, end * W * 4),
        width: W,
        fullHeight: H,
        firstRow: first,
        rows: end - first,
      };
      renderFaceRows(band, face, size, b, row, row + slice);
    }
    assert.deepEqual(b, a, `${face} differs when rendered from bands`);
  }
});

test("renderFaceRows only writes the requested rows", () => {
  const source = positionSource(64, 32);
  const size = 16;
  const out = new Uint8Array(size * size * 4);
  renderFaceRows(source, "front", size, out, 4, 8);
  assert.equal(out[3 * size * 4 + 3], 0);
  assert.equal(out[4 * size * 4 + 3], 255);
  assert.equal(out[7 * size * 4 + 3], 255);
  assert.equal(out[8 * size * 4 + 3], 0);
});
