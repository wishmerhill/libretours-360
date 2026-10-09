/**
 * Geometry for measurement lines.
 *
 * A measurement is seen from the scene's own capture point, so a straight 3D
 * segment projects onto the panorama sphere as an arc of a great circle. We
 * draw it by sampling the spherical linear interpolation (slerp) between the
 * two endpoint directions: the result stays straight and on target from any
 * view direction and zoom level.
 *
 * Inputs are in degrees (like the project model), outputs in radians (like
 * Photo Sphere Viewer). The exported 3D viewer carries a plain-JS copy of
 * greatCirclePoints/midpoint in lib/export.ts: keep the two in sync.
 */
import type { MeasurePoint } from "@/types/tour";

export type Vec3 = [number, number, number];
/** [yaw, pitch] in radians, the polyline format of the PSV markers plugin. */
export type SphericalRad = [number, number];

const DEG = Math.PI / 180;
const EPS = 1e-9;

export function toVec(yawRad: number, pitchRad: number): Vec3 {
  const c = Math.cos(pitchRad);
  return [c * Math.sin(yawRad), Math.sin(pitchRad), c * Math.cos(yawRad)];
}

export function fromVec(v: Vec3): SphericalRad {
  const [x, y, z] = v;
  const len = Math.hypot(x, y, z) || 1;
  const pitch = Math.asin(Math.max(-1, Math.min(1, y / len)));
  const yaw = Math.atan2(x, z);
  return [yaw, pitch];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (v: Vec3): Vec3 => {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
};

const pointVec = (p: MeasurePoint) => toVec(p.yaw * DEG, p.pitch * DEG);

/**
 * Direction at fraction t (0..1) along the great-circle arc from a to b.
 * Antipodal endpoints have no unique arc: we pick one through a stable
 * perpendicular axis (the vertical, or x when a is itself vertical).
 */
function slerp(va: Vec3, vb: Vec3, t: number): Vec3 {
  const d = Math.max(-1, Math.min(1, dot(va, vb)));
  const omega = Math.acos(d);
  if (omega < EPS) return va;

  // Unit vector orthogonal to va in the plane of the arc.
  let u: Vec3;
  if (Math.PI - omega < 1e-6) {
    const ref: Vec3 = Math.abs(va[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    u = normalize(cross(cross(va, ref), va));
  } else {
    u = normalize([vb[0] - d * va[0], vb[1] - d * va[1], vb[2] - d * va[2]]);
  }
  const angle = omega * t;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c * va[0] + s * u[0], c * va[1] + s * u[1], c * va[2] + s * u[2]];
}

/**
 * Samples the arc from a to b as n+1 points (n segments). Yaw is unwrapped so
 * consecutive points never jump by a full turn when the arc crosses ±180°.
 */
export function greatCirclePoints(a: MeasurePoint, b: MeasurePoint, n = 32): SphericalRad[] {
  const va = pointVec(a);
  const vb = pointVec(b);
  const segments = Math.max(1, Math.floor(n));
  const out: SphericalRad[] = [];
  let prevYaw: number | null = null;
  for (let i = 0; i <= segments; i++) {
    const [rawYaw, pitch] = fromVec(slerp(va, vb, i / segments));
    let yaw = rawYaw;
    if (prevYaw !== null) {
      while (yaw - prevYaw > Math.PI) yaw -= 2 * Math.PI;
      while (yaw - prevYaw < -Math.PI) yaw += 2 * Math.PI;
    }
    prevYaw = yaw;
    out.push([yaw, pitch]);
  }
  return out;
}

/** The arc's midpoint, where the label goes. */
export function midpoint(a: MeasurePoint, b: MeasurePoint): { yaw: number; pitch: number } {
  const [yaw, pitch] = fromVec(slerp(pointVec(a), pointVec(b), 0.5));
  return { yaw, pitch };
}
