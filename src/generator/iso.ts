/** Marching squares iso-lines, plus polyline smoothing/simplification. */
import type { Pt } from "../symbols/geometry";
import type { Grid } from "./grid";

export interface Line {
  pts: Pt[];
  closed: boolean;
}

// Edge indices within a cell: 0 top, 1 right, 2 bottom, 3 left.
// Corners: 0 = (i,j) top-left, 1 = (i+1,j), 2 = (i+1,j+1), 3 = (i,j+1).
const EDGE_CORNERS: [number, number][] = [
  [0, 1],
  [1, 2],
  [3, 2],
  [0, 3],
];
/** Corner shared by two adjacent edges, or a corner of the first edge for opposite edges. */
function testCorner(a: number, b: number): number {
  const [a0, a1] = EDGE_CORNERS[a];
  const [b0, b1] = EDGE_CORNERS[b];
  if (a0 === b0 || a0 === b1) return a0;
  if (a1 === b0 || a1 === b1) return a1;
  return a0;
}

/**
 * Extracts iso-lines of `g` at `level`, oriented so that values above the level lie on the LEFT
 * of the direction of travel (y-down screen coordinates).
 * With `closeAtBorder`, the grid is padded with low values so every line becomes a closed ring;
 * the rings then describe the region {g >= level} exactly under the even-odd fill rule.
 */
export function isolines(g: Grid, level: number, closeAtBorder = false): Line[] {
  const { nx, ny, cell } = g;
  const LOW = level - 1e6;
  const v = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= ny ? LOW : g.data[j * nx + i]);
  const W = nx + 3;
  const ekey = (i: number, j: number, vertical: number) => ((j + 2) * W + (i + 2)) * 2 + vertical;

  const next = new Map<number, number>();
  const pos = new Map<number, Pt>();
  const lo = closeAtBorder ? -1 : 0;
  const hiI = closeAtBorder ? nx : nx - 1;
  const hiJ = closeAtBorder ? ny : ny - 1;

  const cv = [0, 0, 0, 0];
  const ci = [0, 0, 0, 0];
  const cj = [0, 0, 0, 0];
  for (let j = lo; j < hiJ; j++) {
    for (let i = lo; i < hiI; i++) {
      cv[0] = v(i, j);
      cv[1] = v(i + 1, j);
      cv[2] = v(i + 1, j + 1);
      cv[3] = v(i, j + 1);
      const b0 = cv[0] >= level;
      const b1 = cv[1] >= level;
      const b2 = cv[2] >= level;
      const b3 = cv[3] >= level;
      if (b0 === b1 && b1 === b2 && b2 === b3) continue;
      ci[0] = i; cj[0] = j;
      ci[1] = i + 1; cj[1] = j;
      ci[2] = i + 1; cj[2] = j + 1;
      ci[3] = i; cj[3] = j + 1;
      const high = [b0, b1, b2, b3];
      const keys = [ekey(i, j, 0), ekey(i + 1, j, 1), ekey(i, j + 1, 0), ekey(i, j, 1)];
      const crossed: number[] = [];
      for (let e = 0; e < 4; e++) {
        const [ca, cb] = EDGE_CORNERS[e];
        if (high[ca] !== high[cb]) {
          crossed.push(e);
          if (!pos.has(keys[e])) {
            // Keep crossings strictly inside the edge so orientation tests never degenerate.
            const t = Math.min(0.999, Math.max(0.001, (level - cv[ca]) / (cv[cb] - cv[ca])));
            pos.set(keys[e], {
              x: (ci[ca] + (ci[cb] - ci[ca]) * t) * cell,
              y: (cj[ca] + (cj[cb] - cj[ca]) * t) * cell,
            });
          }
        }
      }
      let pairs: [number, number][];
      if (crossed.length === 2) {
        pairs = [[crossed[0], crossed[1]]];
      } else {
        const centreHigh = (cv[0] + cv[1] + cv[2] + cv[3]) / 4 >= level;
        // Isolate the corners that are NOT connected through the centre.
        const isolateHigh = !centreHigh;
        const isolated = [0, 1, 2, 3].filter((c) => high[c] === isolateHigh);
        pairs = isolated.map((c) => {
          const es = [0, 1, 2, 3].filter((e) => EDGE_CORNERS[e].includes(c));
          return [es[0], es[1]] as [number, number];
        });
      }
      for (const [ea, eb] of pairs) {
        const pa = pos.get(keys[ea])!;
        const pb = pos.get(keys[eb])!;
        const c = testCorner(ea, eb);
        const cx = ci[c] * cell;
        const cy = cj[c] * cell;
        const cross = (pb.x - pa.x) * (cy - pa.y) - (pb.y - pa.y) * (cx - pa.x);
        // cross > 0: corner on the right. We want high values on the left.
        const swap = high[c] ? cross > 0 : cross < 0;
        if (swap) next.set(keys[eb], keys[ea]);
        else next.set(keys[ea], keys[eb]);
      }
    }
  }

  // Chain segments.
  const hasPrev = new Set<number>(next.values());
  const visited = new Set<number>();
  const lines: Line[] = [];
  const walk = (start: number): Line => {
    const pts: Pt[] = [pos.get(start)!];
    visited.add(start);
    let k = start;
    for (;;) {
      const n = next.get(k);
      if (n === undefined) return { pts, closed: false };
      if (n === start) return { pts, closed: true };
      if (visited.has(n)) return { pts, closed: false };
      visited.add(n);
      pts.push(pos.get(n)!);
      k = n;
    }
  };
  for (const k of next.keys()) if (!hasPrev.has(k) && !visited.has(k)) lines.push(walk(k));
  for (const k of next.keys()) if (!visited.has(k)) lines.push(walk(k));
  return lines.filter((l) => l.pts.length >= 2);
}

/** Chaikin corner cutting. Open lines keep their end points. */
export function chaikin(pts: Pt[], closed: boolean, iterations = 2): Pt[] {
  let p = pts;
  for (let it = 0; it < iterations; it++) {
    if (p.length < 3) return p;
    const out: Pt[] = [];
    const n = p.length;
    if (!closed) out.push(p[0]);
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = p[i];
      const b = p[(i + 1) % n];
      out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      out.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    if (!closed) out.push(p[n - 1]);
    p = out;
  }
  return p;
}

/** Douglas–Peucker simplification. */
export function simplify(pts: Pt[], tol: number, closed = false): Pt[] {
  if (pts.length < 4) return pts;
  if (closed) {
    // Split at the vertex farthest from the first one and simplify both halves.
    let far = 0;
    let best = -1;
    for (let i = 1; i < pts.length; i++) {
      const d = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2;
      if (d > best) {
        best = d;
        far = i;
      }
    }
    const a = simplify(pts.slice(0, far + 1), tol);
    const b = simplify([...pts.slice(far), pts[0]], tol);
    return [...a.slice(0, -1), ...b.slice(0, -1)];
  }
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const a = pts[s];
    const b = pts[e];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1e-12;
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const p = pts[i];
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
      const d = (a.x + t * dx - p.x) ** 2 + (a.y + t * dy - p.y) ** 2;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export function lineLength(pts: Pt[], closed = false): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (closed && pts.length > 2) l += Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  return l;
}

/** Shoelace area; positive for clockwise rings in y-down coordinates. */
export function ringArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x + pts[i].x) * (pts[i].y - pts[j].y);
  return a / 2;
}

export function pointInRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Splits a polyline into runs where `keep(point)` holds; runs shorter than minLen are dropped. */
export function splitWhere(pts: Pt[], closed: boolean, keep: (p: Pt) => boolean, minLen = 0): Pt[][] {
  const flags = pts.map(keep);
  if (flags.every(Boolean)) return [closed ? [...pts, pts[0]] : pts];
  const runs: Pt[][] = [];
  let cur: Pt[] = [];
  const n = pts.length;
  // For closed lines start at a dropped vertex so runs don't wrap around.
  const start = closed ? Math.max(0, flags.indexOf(false)) : 0;
  const count = closed ? n + 1 : n;
  for (let k = 0; k < count; k++) {
    const i = (start + k) % n;
    if (flags[i]) cur.push(pts[i]);
    else {
      if (cur.length > 1) runs.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) runs.push(cur);
  return runs.filter((r) => lineLength(r) >= minLen);
}
