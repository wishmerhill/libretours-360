import assert from "node:assert/strict";
import { test } from "node:test";
import type { MeasurePoint } from "@/types/tour";
import { fromVec, greatCirclePoints, midpoint, toVec, type Vec3 } from "./measure-geometry";

const DEG = Math.PI / 180;
const close = (actual: number, expected: number, eps = 1e-9, msg?: string) =>
  assert.ok(Math.abs(actual - expected) < eps, msg ?? `${actual} ≉ ${expected}`);

/** Same direction, ignoring full turns of yaw. */
function sameDirection(yawRad: number, pitchRad: number, p: MeasurePoint, eps = 1e-9) {
  const v = toVec(yawRad, pitchRad);
  const w = toVec(p.yaw * DEG, p.pitch * DEG);
  for (let i = 0; i < 3; i++) close(v[i]!, w[i]!, eps);
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

test("toVec/fromVec round-trip", () => {
  for (const [yaw, pitch] of [
    [0, 0],
    [1.2, 0.3],
    [-2.9, -1.1],
    [Math.PI - 0.01, 0.7],
  ] as const) {
    const [y, p] = fromVec(toVec(yaw, pitch));
    close(y, yaw);
    close(p, pitch);
  }
});

test("the arc starts at A and ends at B", () => {
  const a = { yaw: 30, pitch: -10 };
  const b = { yaw: -120, pitch: 40 };
  const pts = greatCirclePoints(a, b, 16);
  assert.equal(pts.length, 17);
  sameDirection(pts[0]![0], pts[0]![1], a);
  sameDirection(pts[16]![0], pts[16]![1], b);
});

test("every sample lies on the great circle through A and B", () => {
  const a = { yaw: 10, pitch: 5 };
  const b = { yaw: 100, pitch: -35 };
  const normal = cross(toVec(a.yaw * DEG, a.pitch * DEG), toVec(b.yaw * DEG, b.pitch * DEG));
  for (const [yaw, pitch] of greatCirclePoints(a, b)) {
    close(dot(normal, toVec(yaw, pitch)), 0, 1e-12);
  }
});

test("samples are evenly spaced along the arc", () => {
  const pts = greatCirclePoints({ yaw: -50, pitch: 20 }, { yaw: 60, pitch: -15 }, 8).map(([y, p]) =>
    toVec(y, p),
  );
  const first = dot(pts[0]!, pts[1]!);
  for (let i = 1; i < pts.length - 1; i++) close(dot(pts[i]!, pts[i + 1]!), first, 1e-12);
});

test("yaw stays continuous when the arc crosses ±180°", () => {
  const pts = greatCirclePoints({ yaw: 170, pitch: 0 }, { yaw: -170, pitch: 0 }, 10);
  for (let i = 1; i < pts.length; i++) {
    assert.ok(Math.abs(pts[i]![0] - pts[i - 1]![0]) < 5 * DEG, "no jump between samples");
  }
  // It goes the short way, through 180°, not round the back through 0°.
  close(Math.abs(pts[5]![0]), Math.PI, 1e-9);
});

test("coincident points give a degenerate but valid arc", () => {
  const a = { yaw: 45, pitch: 10 };
  const pts = greatCirclePoints(a, a, 4);
  assert.equal(pts.length, 5);
  for (const [y, p] of pts) sameDirection(y, p, a);
});

test("antipodal points still produce a finite half circle", () => {
  const a = { yaw: 0, pitch: 0 };
  const b = { yaw: 180, pitch: 0 };
  const pts = greatCirclePoints(a, b, 8);
  for (const [y, p] of pts) assert.ok(Number.isFinite(y) && Number.isFinite(p));
  sameDirection(pts[0]![0], pts[0]![1], a);
  sameDirection(pts[8]![0], pts[8]![1], b, 1e-6);
  // Each step covers 180°/8.
  const vs = pts.map(([y, p]) => toVec(y, p));
  close(dot(vs[0]!, vs[1]!), Math.cos(Math.PI / 8), 1e-6);
});

test("nearly antipodal points stay on their great circle", () => {
  const pts = greatCirclePoints({ yaw: 0, pitch: 0.0001 }, { yaw: 180, pitch: 0 }, 8);
  for (const [y, p] of pts) assert.ok(Number.isFinite(y) && Number.isFinite(p));
});

test("antipodal points at the poles are handled too", () => {
  const pts = greatCirclePoints({ yaw: 0, pitch: 90 }, { yaw: 0, pitch: -90 }, 4);
  for (const [y, p] of pts) assert.ok(Number.isFinite(y) && Number.isFinite(p));
  close(pts[2]![1], 0, 1e-6);
});

test("midpoint is equidistant from A and B", () => {
  const a = { yaw: -20, pitch: 30 };
  const b = { yaw: 80, pitch: -10 };
  const m = midpoint(a, b);
  const vm = toVec(m.yaw, m.pitch);
  const va = toVec(a.yaw * DEG, a.pitch * DEG);
  const vb = toVec(b.yaw * DEG, b.pitch * DEG);
  close(dot(vm, va), dot(vm, vb), 1e-12);
  close(dot(cross(va, vb), vm), 0, 1e-12);
});
