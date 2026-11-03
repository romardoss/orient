/** Polyline geometry helpers used by the symbol renderer. Units are arbitrary (µm in practice). */
import { CoordFlag, type Coord } from "./types";

export interface Pt {
  x: number;
  y: number;
}

export interface PathPart {
  pts: Pt[];
  closed: boolean;
  /** Indices into `pts` of vertices flagged as dash points (for dash symbols). */
  dashIdx: number[];
}

/** Affine transform [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** Rotation by `angle` (screen-space atan2 angle, y-down), then scale, then translation. */
export function placement(x: number, y: number, angle: number, scale = 1): Mat {
  const c = Math.cos(angle) * scale;
  const s = Math.sin(angle) * scale;
  return [c, s, -s, c, x, y];
}

export function mul(m: Mat, n: Mat): Mat {
  // m ∘ n : apply n first, then m
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Mat, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** Uniform scale factor of a similarity transform. */
export function matScale(m: Mat): number {
  return Math.hypot(m[0], m[1]);
}

export function matAngle(m: Mat): number {
  return Math.atan2(m[1], m[0]);
}

function bezierSteps(p0: Pt, p1: Pt, p2: Pt, p3: Pt, tol: number): number {
  const len = dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
  return Math.max(2, Math.min(64, Math.ceil(len / tol)));
}

/**
 * Converts Mapper coordinates (with CurveStart / ClosePoint / HolePoint flags) into flattened parts.
 * `tol` is the approximate segment length (in output units) used when flattening Bézier curves.
 */
export function coordsToParts(coords: Coord[], m: Mat = IDENTITY, tol = 150): PathPart[] {
  const parts: PathPart[] = [];
  let cur: PathPart = { pts: [], closed: false, dashIdx: [] };
  const scaledTol = tol / Math.max(1e-9, matScale(m));
  let i = 0;
  while (i < coords.length) {
    const [x, y, flags] = coords[i];
    // A vertex is appended when the segment leading to it is emitted; only part starts are added here.
    if (cur.pts.length === 0) cur.pts.push(apply(m, { x, y }));
    if (flags & CoordFlag.DashPoint) cur.dashIdx.push(cur.pts.length - 1);
    if (flags & CoordFlag.ClosePoint) cur.closed = true;
    if (flags & CoordFlag.HolePoint || i === coords.length - 1) {
      finishPart(cur);
      if (cur.pts.length > 0) parts.push(cur);
      cur = { pts: [], closed: false, dashIdx: [] };
      i++;
      continue;
    }
    if (flags & CoordFlag.CurveStart && i + 3 < coords.length) {
      const q0 = { x, y };
      const q1 = { x: coords[i + 1][0], y: coords[i + 1][1] };
      const q2 = { x: coords[i + 2][0], y: coords[i + 2][1] };
      const q3 = { x: coords[i + 3][0], y: coords[i + 3][1] };
      const n = bezierSteps(q0, q1, q2, q3, scaledTol);
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const u = 1 - t;
        cur.pts.push(
          apply(m, {
            x: u * u * u * q0.x + 3 * u * u * t * q1.x + 3 * u * t * t * q2.x + t * t * t * q3.x,
            y: u * u * u * q0.y + 3 * u * u * t * q1.y + 3 * u * t * t * q2.y + t * t * t * q3.y,
          }),
        );
      }
      i += 3;
      continue;
    }
    const nx = coords[i + 1];
    cur.pts.push(apply(m, { x: nx[0], y: nx[1] }));
    i++;
  }
  return parts;
}

function finishPart(part: PathPart) {
  const pts = part.pts;
  if (pts.length > 2) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    // A part whose last vertex repeats the first is closed; drop the duplicate.
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) {
      part.closed = true;
      pts.pop();
    }
  }
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Polyline with pre-computed cumulative arc length. */
export class Measured {
  readonly pts: Pt[];
  readonly cum: number[];
  readonly length: number;
  readonly closed: boolean;

  constructor(pts: Pt[], closed: boolean) {
    this.closed = closed;
    this.pts = closed && pts.length > 1 ? [...pts, pts[0]] : pts.slice();
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i++) this.cum.push(this.cum[i - 1] + dist(this.pts[i - 1], this.pts[i]));
    this.length = this.cum[this.cum.length - 1] ?? 0;
  }

  private seg(s: number): number {
    // binary search for segment containing arc length s
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Point and tangent angle (screen atan2) at arc length s. */
  at(s: number): { x: number; y: number; angle: number } {
    if (this.pts.length < 2) return { x: this.pts[0]?.x ?? 0, y: this.pts[0]?.y ?? 0, angle: 0 };
    s = Math.max(0, Math.min(this.length, s));
    let i = this.seg(s);
    // skip zero-length segments
    while (i < this.pts.length - 2 && this.cum[i + 1] - this.cum[i] < 1e-9) i++;
    const a = this.pts[i];
    const b = this.pts[i + 1];
    const l = this.cum[i + 1] - this.cum[i];
    const t = l > 0 ? (s - this.cum[i]) / l : 0;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  /** Arc length at vertex index i. */
  lengthAt(i: number): number {
    return this.cum[Math.max(0, Math.min(this.cum.length - 1, i))];
  }

  /** Sub-polyline between arc lengths s0 < s1. */
  slice(s0: number, s1: number): Pt[] {
    s0 = Math.max(0, s0);
    s1 = Math.min(this.length, s1);
    if (s1 <= s0) return [];
    const out: Pt[] = [];
    const a = this.at(s0);
    out.push({ x: a.x, y: a.y });
    let i = this.seg(s0) + 1;
    while (i < this.pts.length && this.cum[i] < s1) {
      out.push(this.pts[i]);
      i++;
    }
    const b = this.at(s1);
    out.push({ x: b.x, y: b.y });
    return out;
  }
}

/**
 * Offsets a polyline by d (positive = right-hand side in y-down screen coordinates).
 * Uses mitred joins limited to `miterLimit * |d|`.
 */
export function offsetPolyline(pts: Pt[], closed: boolean, d: number, miterLimit = 3): Pt[] {
  const n = pts.length;
  if (n < 2 || d === 0) return pts.slice();
  const normals: Pt[] = [];
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const l = dist(a, b) || 1;
    normals.push({ x: -(b.y - a.y) / l, y: (b.x - a.x) / l });
  }
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    let n1: Pt | undefined;
    let n2: Pt | undefined;
    if (closed) {
      n1 = normals[(i - 1 + segCount) % segCount];
      n2 = normals[i % segCount];
    } else {
      n1 = normals[i - 1];
      n2 = normals[i];
    }
    const na = n1 ?? n2!;
    const nb = n2 ?? n1!;
    let mx = na.x + nb.x;
    let my = na.y + nb.y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) {
      mx = nb.x;
      my = nb.y;
    } else {
      mx /= ml;
      my /= ml;
    }
    const cos = mx * nb.x + my * nb.y;
    let len = d / Math.max(cos, 1e-3);
    const lim = Math.abs(d) * miterLimit;
    if (Math.abs(len) > lim) len = Math.sign(len) * lim;
    out.push({ x: pts[i].x + mx * len, y: pts[i].y + my * len });
  }
  return out;
}

export function polylineLength(pts: Pt[], closed = false): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 1) l += dist(pts[pts.length - 1], pts[0]);
  return l;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function extend(b: Bounds, x: number, y: number, r = 0): void {
  if (x - r < b.minX) b.minX = x - r;
  if (y - r < b.minY) b.minY = y - r;
  if (x + r > b.maxX) b.maxX = x + r;
  if (y + r > b.maxY) b.maxY = y + r;
}

export function isEmpty(b: Bounds): boolean {
  return !(b.maxX >= b.minX && b.maxY >= b.minY);
}

/** Signed area (positive = clockwise in y-down screen space). */
export function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x - pts[i].x) * (pts[j].y + pts[i].y);
  return a / 2;
}
