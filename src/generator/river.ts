/**
 * Rivers: a least-cost route through low ground, meandered, then carved into the height field
 * as a valley with a floodplain, steep (often rocky) banks on the outside of bends and bluffs.
 */
import type { Pt } from "../symbols/geometry";
import { Grid } from "./grid";
import { MinHeap } from "./heap";
import { chaikin, lineLength } from "./iso";
import { Noise } from "./noise";
import type { MapParams } from "./params";
import type { Rng } from "./rng";

export interface River {
  /** Centre line, upstream → downstream, resampled every STEP metres. Runs a little past the map edge. */
  pts: Pt[];
  /** Half width of the water surface (m). */
  hw: number[];
  /** Water level (m), never rising downstream. */
  level: number[];
  /** Signed curvature (1/m); > 0 turns right on screen (clockwise in y-down coordinates). */
  curv: number[];
  /** Per side (0 = left of the flow, 1 = right): steepness of the valley wall 0..1. */
  steep: [number[], number[]];
  /** Per side: distance from the centre line to the foot of the valley wall (m). */
  floodW: [number[], number[]];
  /** Shallow river that can be crossed on foot (ISOM 302) vs uncrossable (301). */
  crossable: boolean;
  /** Tributaries end inside their main river. */
  tributary: boolean;
}

export interface RiverFields {
  rivers: River[];
  /** Positive inside uncrossable rivers (half width minus distance, m), negative outside. */
  riverU: Grid;
  /** Same for crossable rivers. */
  riverC: Grid;
  /** 1 on the floodplain, fading out up the valley walls; 0 elsewhere. */
  flood: Grid;
  /** Extra rockiness on steep valley walls. */
  rockBoost: Grid;
}

const STEP = 6;
const REACH = 320;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Polynomial smooth minimum. */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b + (a - b) * h - k * h * (1 - h);
}

function resample(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    let s = step - carry;
    while (s <= L) {
      out.push({ x: a.x + ((b.x - a.x) * s) / L, y: a.y + ((b.y - a.y) * s) / L });
      s += step;
    }
    carry = L - (s - step);
  }
  const last = pts[pts.length - 1];
  if (Math.hypot(out[out.length - 1].x - last.x, out[out.length - 1].y - last.y) > step * 0.3) out.push(last);
  return out;
}

/** A* over a coarse grid; cost favours low ground so the river follows valleys. */
function route(h: Grid, from: Pt, to: Pt | ((x: number, y: number) => boolean), goalPt: Pt, coarse: number): Pt[] | undefined {
  const gx = Math.ceil((h.nx * h.cell) / coarse) + 1;
  const gy = Math.ceil((h.ny * h.cell) / coarse) + 1;
  const N = gx * gy;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of h.data) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = Math.max(1, hi - lo);
  const cost = new Float32Array(N);
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const x = i * coarse;
      const y = j * coarse;
      const t = (h.sample(x, y) - lo) / span;
      // Keep away from the map edge: a river along the border is wasted.
      const edge = Math.min(x, y, h.nx * h.cell - x, h.ny * h.cell - y);
      cost[j * gx + i] = 1 + 60 * t * t + 30 * Math.exp(-edge / 160);
    }
  }
  const idx = (q: Pt) => Math.min(gy - 1, Math.max(0, Math.round(q.y / coarse))) * gx + Math.min(gx - 1, Math.max(0, Math.round(q.x / coarse)));
  const start = idx(from);
  const goalIdx = idx(goalPt);
  const isGoal = typeof to === "function" ? (k: number) => to((k % gx) * coarse, Math.floor(k / gx) * coarse) : (k: number) => k === goalIdx;
  const tx = goalPt.x / coarse;
  const ty = goalPt.y / coarse;
  const g = new Float32Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const heap = new MinHeap();
  g[start] = 0;
  heap.push(start, 0);
  let found = -1;
  while (heap.size) {
    const u = heap.pop();
    if (closed[u]) continue;
    closed[u] = 1;
    if (isGoal(u)) {
      found = u;
      break;
    }
    const ux = u % gx;
    const uy = (u - ux) / gx;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const vx = ux + dx;
        const vy = uy + dy;
        if (vx < 0 || vy < 0 || vx >= gx || vy >= gy) continue;
        const v = vy * gx + vx;
        if (closed[v]) continue;
        const nd = g[u] + (dx && dy ? Math.SQRT2 : 1) * 0.5 * (cost[u] + cost[v]);
        if (nd < g[v]) {
          g[v] = nd;
          prev[v] = u;
          heap.push(v, nd + Math.hypot(vx - tx, vy - ty));
        }
      }
    }
  }
  if (found < 0) return undefined;
  const out: Pt[] = [];
  for (let u = found; u >= 0; u = prev[u]) out.push({ x: (u % gx) * coarse, y: Math.floor(u / gx) * coarse });
  return out.reverse();
}

/** A point on the map border: side 0 top, 1 right, 2 bottom, 3 left; t along the side. */
function borderPt(side: number, t: number, w: number, h: number): Pt {
  switch (side) {
    case 0:
      return { x: t * w, y: 0 };
    case 1:
      return { x: w, y: t * h };
    case 2:
      return { x: t * w, y: h };
    default:
      return { x: 0, y: t * h };
  }
}

function extend(pts: Pt[], by: number): Pt[] {
  const ext = (a: Pt, b: Pt): Pt => {
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    return { x: a.x + ((a.x - b.x) / d) * by, y: a.y + ((a.y - b.y) / d) * by };
  };
  const n = pts.length;
  const k = Math.min(n - 1, 4);
  return [ext(pts[0], pts[k]), ...pts, ext(pts[n - 1], pts[n - 1 - k])];
}

function curvature(pts: Pt[]): number[] {
  const n = pts.length;
  const raw = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 2)];
    const b = pts[i];
    const c = pts[Math.min(n - 1, i + 2)];
    const t0 = Math.atan2(b.y - a.y, b.x - a.x);
    const t1 = Math.atan2(c.y - b.y, c.x - b.x);
    const d = Math.atan2(Math.sin(t1 - t0), Math.cos(t1 - t0));
    const len = Math.hypot(b.x - a.x, b.y - a.y) / 2 + Math.hypot(c.x - b.x, c.y - b.y) / 2 || 1;
    return d / len;
  });
  // Moving average over ~±40 m.
  const w = 7;
  return raw.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) {
      s += raw[j];
      c++;
    }
    return s / c;
  });
}

interface RiverSpec {
  start: Pt;
  goal: Pt;
  goalFn?: (x: number, y: number) => boolean;
  hwBase: number;
  crossable: boolean;
  tributary: boolean;
  /** Level of the main river where a tributary joins it. */
  joinLevel?: number;
}

function buildRiver(h: Grid, spec: RiverSpec, p: MapParams, rng: Rng, noise: Noise): River | undefined {
  const raw = route(h, spec.start, spec.goalFn ?? spec.goal, spec.goal, Math.max(14, h.cell * 3));
  if (!raw || raw.length < 4) return undefined;
  let pts = resample(chaikin(raw, false, 3), STEP);
  const smooth = h.blur(3, 2);
  // Flow from the higher end to the lower one (tributaries always flow into the main river).
  if (!spec.tributary && smooth.sample(pts[0].x, pts[0].y) < smooth.sample(pts[pts.length - 1].x, pts[pts.length - 1].y)) pts.reverse();

  // Meanders: sideways displacement by 1D noise along the route, stronger for bigger rivers.
  const L = lineLength(pts);
  const amp = (spec.crossable ? 10 : 18) + 40 * p.river;
  const lambda = rng.range(170, 260);
  const phase = rng.range(0, 1000);
  const n = pts.length;
  const disp: Pt[] = pts.map((q, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const s = i * STEP;
    // Fade in/out at the ends so tributaries still meet their river and borders stay crossed.
    const fade = Math.min(1, s / 80, (L - s) / 80);
    const o = amp * fade * (noise.n2(s / lambda, phase) + 0.35 * noise.n2(s / (lambda * 0.4), phase + 17));
    return { x: q.x - ((b.y - a.y) / d) * o, y: q.y + ((b.x - a.x) / d) * o };
  });
  pts = resample(chaikin(disp, false, 3), STEP);
  // Run past the map edge(s); a tributary ends inside its main river instead.
  const ext = extend(pts, 40);
  pts = resample(spec.tributary ? ext.slice(0, -1) : ext, STEP);

  const m = pts.length;
  const total = (m - 1) * STEP;
  const hw = pts.map((_, i) => {
    const s = i * STEP;
    return Math.max(1.6, spec.hwBase * (0.75 + (0.5 * s) / total) * (1 + 0.22 * noise.n2(s / 140, phase + 3)));
  });
  const incision = 1.2 + 2 * p.river;
  const level: number[] = [];
  for (let i = 0; i < m; i++) {
    const g = smooth.sample(pts[i].x, pts[i].y) - incision;
    level.push(i === 0 ? g : Math.min(level[i - 1] - STEP * 0.0006, g));
  }
  if (spec.joinLevel !== undefined) {
    // Do not cut below the main river at the confluence.
    for (let i = 0; i < m; i++) level[i] = Math.max(level[i], spec.joinLevel + 0.2 * (1 - i / m));
  }
  const curv = curvature(pts);
  const steep: [number[], number[]] = [[], []];
  const floodW: [number[], number[]] = [[], []];
  for (let side = 0; side < 2; side++) {
    const sd = side === 0 ? -1 : 1;
    for (let i = 0; i < m; i++) {
      const s = i * STEP;
      // Outer bank of a bend: the centre of curvature lies on the other side.
      const outer = smoothstep(0.15, 0.9, -sd * curv[i] * 75);
      const inner = smoothstep(0.1, 0.8, sd * curv[i] * 75);
      const bluff = smoothstep(0.25, 0.55, noise.n2(s / 320, phase + 40 * sd)) * (0.35 + 0.65 * p.rock) * (1 - inner);
      const st = Math.max(outer, bluff);
      steep[side].push(st);
      const plain = 12 + 55 * (0.5 + 0.5 * noise.n2(s / 260, phase - 60 * sd)) + 35 * inner;
      floodW[side].push(hw[i] + 2 + plain * (1 - st));
    }
  }
  return { pts, hw, level, curv, steep, floodW, crossable: spec.crossable, tributary: spec.tributary };
}

/** Carves the river into `h` and accumulates its masks. */
function carve(r: River, h: Grid, out: RiverFields) {
  const { nx, ny, cell } = h;
  const N = nx * ny;
  const dist = new Float32Array(N).fill(Infinity);
  const seg = new Int32Array(N).fill(-1);
  const segT = new Float32Array(N);
  const sideArr = new Int8Array(N);
  const pts = r.pts;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - REACH) / cell));
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x) + REACH) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - REACH) / cell));
    const j1 = Math.min(ny - 1, Math.ceil((Math.max(a.y, b.y) + REACH) / cell));
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    for (let j = j0; j <= j1; j++) {
      for (let ii = i0; ii <= i1; ii++) {
        const x = ii * cell;
        const y = j * cell;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
        const d = Math.hypot(a.x + t * dx - x, a.y + t * dy - y);
        const k = j * nx + ii;
        if (d < dist[k]) {
          dist[k] = d;
          seg[k] = i;
          segT[k] = t;
          sideArr[k] = dx * (y - a.y) - dy * (x - a.x) > 0 ? 1 : 0;
        }
      }
    }
  }
  const before = Float32Array.from(h.data);
  const mask = r.crossable ? out.riverC : out.riverU;
  const lerp = (arr: number[], i: number, t: number) => arr[i] + (arr[Math.min(arr.length - 1, i + 1)] - arr[i]) * t;
  for (let k = 0; k < N; k++) {
    const d = dist[k];
    if (d >= REACH) continue;
    const i = seg[k];
    const t = segT[k];
    const side = sideArr[k];
    const hw = lerp(r.hw, i, t);
    const lv = lerp(r.level, i, t);
    const fw = Math.max(hw + 1.5, lerp(r.floodW[side], i, t));
    const st = lerp(r.steep[side], i, t);
    // Channel and flat floodplain; beyond it the valley side blends back into the natural
    // terrain over a short (steep bank) or long (gentle valley side) distance.
    const floor = d < hw ? lv - (0.8 + hw * 0.12) * (1 - (d / hw) ** 2) : lv + 0.25 + 0.6 * Math.min(1, (d - hw) / (fw - hw));
    const wall = 8 + 190 * (1 - st) ** 1.5;
    const h0 = h.data[k];
    const w = smoothstep(fw, Math.min(REACH, fw + wall), d);
    h.data[k] = smin(h0, floor, 1) * (1 - w) + h0 * w;
    mask.data[k] = Math.max(mask.data[k], hw - d);
    const fl = d < fw ? 1 : Math.exp(-(d - fw) / 18);
    out.flood.data[k] = Math.max(out.flood.data[k], fl);
    if (d > hw) out.rockBoost.data[k] = Math.max(out.rockBoost.data[k], st * Math.exp(-Math.max(0, d - fw) / 22) * (d > fw - 3 ? 1 : 0.3));
  }
  // Soften creases where the nearest centre-line segment switches (inside of bends).
  const delta = Grid.like(h);
  for (let k = 0; k < N; k++) delta.data[k] = h.data[k] - before[k];
  const soft = delta.blur(Math.max(1, Math.round(6 / cell)), 2);
  for (let k = 0; k < N; k++) {
    if (dist[k] >= REACH) continue;
    // Keep the channel itself crisp.
    const keep = smoothstep(lerp(r.hw, seg[k], segT[k]) + 2, lerp(r.hw, seg[k], segT[k]) + 12, dist[k]);
    h.data[k] = before[k] + delta.data[k] * (1 - keep) + soft.data[k] * keep;
  }
}

export function buildRivers(p: MapParams, h: Grid, widthM: number, heightM: number, rng: Rng): RiverFields {
  const out: RiverFields = {
    rivers: [],
    riverU: Grid.like(h),
    riverC: Grid.like(h),
    flood: Grid.like(h),
    rockBoost: Grid.like(h),
  };
  out.riverU.data.fill(-100);
  out.riverC.data.fill(-100);
  if (p.river < 0.08) return out;
  const noise = new Noise(rng.fork("river-noise"));
  const crossable = p.river < 0.4;
  // Main river from one side of the map to the opposite one, preferably along the long axis.
  const horizontal = rng.chance(widthM / (widthM + heightM));
  const sa = horizontal ? 3 : 0;
  const start = borderPt(sa, rng.range(0.2, 0.8), widthM, heightM);
  const goal = borderPt((sa + 2) % 4, rng.range(0.2, 0.8), widthM, heightM);
  const hwBase = crossable ? 1.8 + 4 * p.river : 4 + 11 * (p.river - 0.4);
  const main = buildRiver(h, { start, goal, hwBase, crossable, tributary: false }, p, rng, noise);
  if (!main) return out;
  carve(main, h, out);
  out.rivers.push(main);

  // A tributary for bigger rivers, from another border into the middle part of the main river.
  if (p.river >= 0.6) {
    const m = main.pts.length;
    const ji = Math.floor(rng.range(0.35, 0.65) * m);
    const join = main.pts[ji];
    const sides = horizontal ? [0, 2] : [1, 3];
    const tStart = borderPt(rng.pick(sides), rng.range(0.25, 0.75), widthM, heightM);
    const hwMain = main.hw[ji];
    // The tributary ends wherever it first reaches the main river.
    const mainMask = main.crossable ? out.riverC : out.riverU;
    const near = (x: number, y: number) => mainMask.sample(x, y) > -8;
    const trib = buildRiver(
      h,
      {
        start: tStart,
        goal: join,
        goalFn: near,
        hwBase: Math.max(1.6, hwMain * 0.5),
        crossable: crossable || p.river < 0.85,
        tributary: true,
      },
      p,
      rng,
      noise,
    );
    if (trib) {
      // Never cut below the main river where it really joins.
      const e = trib.pts[trib.pts.length - 1];
      let bi = 0;
      for (let i = 0; i < m; i++) if (Math.hypot(main.pts[i].x - e.x, main.pts[i].y - e.y) < Math.hypot(main.pts[bi].x - e.x, main.pts[bi].y - e.y)) bi = i;
      for (let i = 0; i < trib.level.length; i++) trib.level[i] = Math.max(trib.level[i], main.level[bi] + 0.2);
    }
    if (trib && lineLength(trib.pts) > 300) {
      carve(trib, h, out);
      out.rivers.push(trib);
    }
  }
  return out;
}

/** Offsets a run of the centre line sideways: side 0 = left of the flow, 1 = right. */
export function offsetRun(r: River, i0: number, i1: number, side: number, dist: (i: number) => number): Pt[] {
  const sd = side === 0 ? -1 : 1;
  const out: Pt[] = [];
  const n = r.pts.length;
  for (let i = i0; i <= i1; i++) {
    const a = r.pts[Math.max(0, i - 1)];
    const b = r.pts[Math.min(n - 1, i + 1)];
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    // Right-hand normal in y-down coordinates is (-dy, dx).
    const nx = (-(b.y - a.y) / d) * sd;
    const ny = ((b.x - a.x) / d) * sd;
    const o = dist(i);
    out.push({ x: r.pts[i].x + nx * o, y: r.pts[i].y + ny * o });
  }
  return out;
}
