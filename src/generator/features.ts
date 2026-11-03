/** Turns terrain fields into ISOM 2017-2 map features and potential control sites. */
import type { Pt } from "../symbols/geometry";
import type { Grid } from "./grid";
import { chaikin, isolines, lineLength, pointInRing, ringArea, simplify, splitWhere } from "./iso";
import type { ControlDesc, ControlSite, Feature } from "./model";
import { type MapParams, POINT_BOOST, mapSymbolScale, metresPerMm } from "./params";
import type { Rng } from "./rng";
import { densify } from "./paths";
import { type River, offsetRun } from "./river";
import { type Fields, derive } from "./terrain";

/** 8-point compass suffix (as used by IOF column G ids) for a screen-space direction vector. */
export function compass(dx: number, dy: number): string {
  const bearing = (Math.atan2(dx, -dy) * 180) / Math.PI; // 0 = north, clockwise
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[(Math.round(((bearing + 360) % 360) / 45) + 8) % 8];
}

/** Screen angle that makes a symbol's local "up" (−y) point along (dx, dy). */
export function upAngle(dx: number, dy: number): number {
  return Math.atan2(dx, -dy);
}

/** Spatial hash of occupied discs, keeps point symbols legible. */
export class Occupancy {
  private cells = new Map<number, { x: number; y: number; r: number }[]>();

  constructor(private readonly size: number) {}

  private key(i: number, j: number) {
    return (j + 1000) * 100000 + (i + 1000);
  }

  free(x: number, y: number, r: number): boolean {
    const i0 = Math.floor((x - r) / this.size) - 1;
    const i1 = Math.floor((x + r) / this.size) + 1;
    const j0 = Math.floor((y - r) / this.size) - 1;
    const j1 = Math.floor((y + r) / this.size) + 1;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (const d of this.cells.get(this.key(i, j)) ?? []) {
          if (Math.hypot(d.x - x, d.y - y) < d.r + r) return false;
        }
      }
    }
    return true;
  }

  add(x: number, y: number, r: number): void {
    const k = this.key(Math.floor(x / this.size), Math.floor(y / this.size));
    let l = this.cells.get(k);
    if (!l) this.cells.set(k, (l = []));
    l.push({ x, y, r });
  }

  addLine(pts: Pt[], r: number, step: number): void {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
      for (let t = 0; t < n; t++) this.add(a.x + ((b.x - a.x) * t) / n, a.y + ((b.y - a.y) * t) / n, r);
    }
  }
}

/** Contours closer than this on paper (mm) merge visually; such ground becomes a rock wall. */
export const WALL_SPACING_MM = 0.3;

function bbox(r: Pt[]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const q of r) {
    if (q.x < x0) x0 = q.x;
    if (q.y < y0) y0 = q.y;
    if (q.x > x1) x1 = q.x;
    if (q.y > y1) y1 = q.y;
  }
  return { x0, y0, x1, y1 };
}

export class FeatureBuilder {
  readonly features: Feature[] = [];
  readonly sites: ControlSite[] = [];
  readonly occ: Occupancy;
  readonly stats: Record<string, number> = {};
  /** Metres per millimetre of paper. */
  readonly mpm: number;
  /** Symbol enlargement factor. */
  readonly k: number;
  /** Open-land rings, used later (fences, buildings, clearings). */
  openRings: Pt[][] = [];
  streamLines: { pts: Pt[]; code: string }[] = [];
  /** Bridges over rivers (for course legs that cross a river). */
  bridges: Pt[] = [];
  /** Hill tops found while drawing contours (for spot heights). */
  hillTops: { x: number; y: number; h: number; len: number }[] = [];
  /** Slope lines placed so far, to keep them sparse across neighbouring contours. */
  private readonly slopeOcc: Occupancy;
  /**
   * Per-map character: random density multipliers (≈0.25…2.7) for groups of small features, so one map is
   * full of pits and springs while the next has boulders, root stocks or ditches.
   */
  readonly mood: Record<"boulders" | "landforms" | "vegPoints" | "gullies" | "springs" | "ditches" | "manmade", number>;

  constructor(
    readonly p: MapParams,
    readonly f: Fields,
    readonly rng: Rng,
  ) {
    this.mpm = metresPerMm(p);
    this.k = mapSymbolScale(p);
    this.occ = new Occupancy(Math.max(5, 2 * this.mpm));
    this.slopeOcc = new Occupancy(Math.max(10, 4 * this.mpm));
    const mr = rng.fork("mood");
    const m = () => Math.exp(mr.range(-1.4, 1));
    this.mood = { boulders: m(), landforms: m(), vegPoints: m(), gullies: m(), springs: m(), ditches: m(), manmade: m() };
    // One feature group is the map's speciality.
    const keys = Object.keys(this.mood) as (keyof typeof this.mood)[];
    this.mood[keys[mr.int(0, keys.length - 1)]] = mr.range(2.2, 3);
  }

  /** Paper millimetres (at symbol size) to terrain metres. */
  mm(v: number): number {
    return v * this.mpm * this.k;
  }

  count(code: string) {
    this.stats[code] = (this.stats[code] ?? 0) + 1;
  }

  /** True in any water: lakes, ponds and rivers. */
  inLake(x: number, y: number): boolean {
    return this.f.water.sample(x, y) > -0.2;
  }

  /** True in a lake or pond (not a river). */
  isLake(x: number, y: number): boolean {
    return this.f.lake.sample(x, y) > -0.2;
  }

  /** 0 = dry land, 1 = crossable river, 2 = uncrossable river. */
  riverAt(x: number, y: number): 0 | 1 | 2 {
    if (this.f.riverU.sample(x, y) > -0.3) return 2;
    if (this.f.riverC.sample(x, y) > -0.3) return 1;
    return 0;
  }

  inside(x: number, y: number, margin = 0): boolean {
    return x >= margin && y >= margin && x <= this.f.widthM - margin && y <= this.f.heightM - margin;
  }

  line(code: string, pts: Pt[], closed = false) {
    if (pts.length < 2) return;
    this.features.push({ kind: "line", code, pts, closed });
    this.count(code);
  }

  area(code: string, rings: Pt[][]) {
    if (!rings.length) return;
    this.features.push({ kind: "area", code, rings });
    this.count(code);
  }

  /** Places a point symbol if there is room; `rMm` is its footprint radius on paper. */
  point(code: string, x: number, y: number, rMm: number, angle?: number, site?: Omit<ControlSite, "x" | "y">): boolean {
    const r = this.mm(rMm) * POINT_BOOST;
    if (!this.inside(x, y, r) || this.inLake(x, y) || !this.occ.free(x, y, r)) return false;
    this.occ.add(x, y, r);
    this.features.push({ kind: "point", code, x, y, angle });
    this.count(code);
    if (site) this.sites.push({ x, y, ...site });
    return true;
  }

  site(x: number, y: number, desc: ControlDesc, label: string, weight = 1) {
    if (this.inside(x, y) && !this.inLake(x, y)) this.sites.push({ x, y, desc, label, weight });
  }

  /** Closed rings of {g >= level}, smoothed, small rings dropped. */
  regions(g: Grid, level: number, minAreaM2: number): Pt[][] {
    const tol = g.cell * 0.12;
    return isolines(g, level, true)
      .map((l) => simplify(chaikin(l.pts, true, 2), tol, true))
      .filter((r) => r.length > 3 && Math.abs(ringArea(r)) >= minAreaM2);
  }

  /**
   * Scatters up to `n` blob-shaped areas of `code` with mean radius in [r0, r1] (paper mm) where `ok`
   * holds all around the outline. Used for overlay variants (one-direction runnability, vineyards…).
   */
  patches(code: string, n: number, r0: number, r1: number, ok: (x: number, y: number) => boolean, angle?: () => number): Pt[][] {
    const out: Pt[][] = [];
    for (let tries = 0; tries < n * 60 && out.length < n; tries++) {
      const c = { x: this.rng.range(0, this.f.widthM), y: this.rng.range(0, this.f.heightM) };
      const r = this.mm(this.rng.range(r0, r1));
      let ring = blob(c, r, this.rng, 10);
      if (angle) {
        // Elongated patch (e.g. a plantation in rows).
        const a = angle();
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        ring = ring.map((q) => {
          const dx = q.x - c.x;
          const dy = q.y - c.y;
          const u = (dx * ca + dy * sa) * 1.6;
          const v = (-dx * sa + dy * ca) * 0.7;
          return { x: c.x + u * ca - v * sa, y: c.y + u * sa + v * ca };
        });
      }
      if (!ring.every((q) => this.inside(q.x, q.y) && !this.inLake(q.x, q.y) && ok(q.x, q.y)) || !ok(c.x, c.y)) continue;
      if (out.some((o) => Math.hypot(centroid(o).x - c.x, centroid(o).y - c.y) < r * 2.5)) continue;
      out.push(ring);
    }
    if (out.length) this.area(code, out);
    return out;
  }

  /** Visits jittered grid points with spacing `s` metres. */
  scatter(s: number, fn: (x: number, y: number) => void) {
    for (let y = s / 2; y < this.f.heightM; y += s) {
      for (let x = s / 2; x < this.f.widthM; x += s) {
        fn(x + this.rng.range(-0.45, 0.45) * s, y + this.rng.range(-0.45, 0.45) * s);
      }
    }
  }

  // ------------------------------------------------------------------ landforms

  contours() {
    const { f, p } = this;
    const h = f.height;
    const ci = p.contourInterval;
    let minH = Infinity;
    let maxH = -Infinity;
    for (const v of h.data) {
      if (v < minH) minH = v;
      if (v > maxH) maxH = v;
    }
    const tol = h.cell * 0.1;
    const minKnoll = this.mm(1.1);
    const labelEvery = this.mm(140);
    const dry = (q: Pt) => f.water.sample(q.x, q.y) < 0;

    // Rock walls: where contours would be closer than ~0.3 mm on paper they merge into a solid
    // brown band. ISOM shows such ground as an impassable cliff instead of stacked contours.
    const sWall = ci / (WALL_SPACING_MM * this.k * (p.scale / 15000) * this.mpm);
    const steep = derive(f, (kk) => Math.min(f.slope.data[kk] - sWall, -f.water.data[kk] * 0.1 - 0.01));
    const wallRings = this.regions(steep, 0, this.mm(1.2) ** 2).map((r) => ({ r, box: bbox(r) }));
    const inWall = (q: Pt): number => {
      if (!wallRings.length || steep.sample(q.x, q.y) < -sWall * 0.15) return -1;
      return wallRings.findIndex(({ r, box }) => q.x >= box.x0 && q.x <= box.x1 && q.y >= box.y0 && q.y <= box.y1 && pointInRing(q, r));
    };
    const wallRuns: { level: number; pts: Pt[]; ring: number }[] = [];

    for (let level = Math.ceil(minH / ci) * ci; level <= maxH; level += ci) {
      const isIndex = Math.abs(level / (ci * 5) - Math.round(level / (ci * 5))) < 1e-6;
      for (const raw of isolines(h, level)) {
        // Contours stop at lake shores.
        const pieces = raw.closed && raw.pts.every(dry) ? [raw] : splitWhere(raw.pts, raw.closed, dry).map((pts) => ({ pts, closed: false }));
        for (const l of pieces) {
          const pts = simplify(chaikin(l.pts, l.closed, 3), tol, l.closed);
          const len = lineLength(pts, l.closed);
          if (l.closed && len < minKnoll * 2.2) continue;
          if (!l.closed && len < this.mm(1.5)) continue;
          const code = isIndex ? "102" : "101";

          const parts = wallRings.length ? this.splitWalls(pts, l.closed, inWall) : undefined;
          if (parts) {
            for (const r of parts) {
              if (r.ring >= 0) {
                wallRuns.push({ level, pts: r.pts, ring: r.ring });
                continue;
              }
              const rl = lineLength(r.pts);
              if (rl < this.mm(1.5)) continue;
              const pieces = isIndex && rl > labelEvery * 0.8 ? this.labelContour(r.pts, false, level, labelEvery) : [r.pts];
              for (const piece of pieces) {
                this.line(code, piece);
                this.slopeLines("101.1", piece, false);
              }
            }
            continue;
          }

          const depression = l.closed && ringArea(pts) > 0;
          if (isIndex && len > labelEvery * 0.8) {
            for (const piece of this.labelContour(pts, l.closed, level, labelEvery)) {
              this.line(code, piece);
              this.slopeLines("101.1", piece, false);
            }
          } else {
            this.line(code, pts, l.closed);
            this.slopeLines("101.1", pts, l.closed, depression);
          }

          // Depressions (closed rings enclosing lower ground) get slope lines pointing inwards.
          if (depression) {
            if (len < this.mm(9)) {
              const c = centroid(pts);
              this.site(c.x, c.y, { D: "1.12" }, "depression", 1.2);
            }
          } else if (l.closed && len < this.mm(14)) {
            const c = centroid(pts);
            this.site(c.x, c.y, { D: "1.9" }, "hill top", 0.8);
            this.hillTops.push({ x: c.x, y: c.y, h: level, len });
          }
        }
      }

      // Form lines half-way between contours, only where the ground is fairly flat.
      if (ci === 5 && p.detail > 0.2) {
        const half = level + ci / 2;
        for (const l of isolines(h, half)) {
          const pts = simplify(chaikin(l.pts, l.closed, 2), tol, l.closed);
          const len = lineLength(pts, l.closed);
          if (l.closed && len < this.mm(14) && len > minKnoll * 2.5 && pts.every(dry)) {
            this.line("103", pts, true);
            if (ringArea(pts) > 0) this.slopeLines("103.1", pts, true, true);
            continue;
          }
          const flat = (q: Pt) => dry(q) && f.slope.sample(q.x, q.y) < 0.045 + 0.02 * p.detail;
          for (const run of splitWhere(pts, l.closed, flat, this.mm(5))) {
            if (!this.rng.chance(0.55)) continue;
            this.line("103", run);
            this.slopeLines("103.1", run, false);
          }
        }
      }
    }

    this.rockWalls(wallRuns, ci);
  }

  /**
   * Splits a contour into ordinary runs (ring −1) and runs inside a rock wall region (ring ≥ 0).
   * Returns undefined when the line does not touch any wall. Runs share their end points, and
   * very short runs are merged into their neighbours so lines don't flicker in and out of walls.
   */
  private splitWalls(pts: Pt[], closed: boolean, inWall: (q: Pt) => number): { ring: number; pts: Pt[] }[] | undefined {
    let flags = pts.map(inWall);
    if (flags.every((v) => v < 0)) return undefined;
    let path = pts;
    if (closed) {
      const firstWall = flags.find((v) => v >= 0)!;
      if (flags.every((v) => v >= 0)) return [{ ring: firstWall, pts: [...pts, pts[0]] }];
      // Rotate so the path starts at a run boundary, then treat it as an open line.
      let s0 = flags.findIndex((v, i) => (v >= 0) !== (flags[(i - 1 + flags.length) % flags.length] >= 0));
      if (s0 < 0) s0 = 0;
      path = [...pts.slice(s0), ...pts.slice(0, s0), pts[s0]];
      flags = [...flags.slice(s0), ...flags.slice(0, s0)];
      flags.push(flags[flags.length - 1]);
    }
    type Run = { a: number; b: number; ring: number };
    const build = (): Run[] => {
      const runs: Run[] = [];
      for (let i = 0; i < flags.length; i++) {
        const w = flags[i] >= 0;
        const last = runs[runs.length - 1];
        if (last && last.ring >= 0 === w) {
          last.b = i;
          if (last.ring < 0 && w) last.ring = flags[i];
        } else runs.push({ a: i, b: i, ring: w ? flags[i] : -1 });
      }
      return runs;
    };
    const len = (r: Run) => lineLength(path.slice(r.a, Math.min(path.length, r.b + 2)));
    let runs = build();
    // Tiny wall bits stay contour; short contour stubs between two wall runs become wall.
    for (const r of runs) if (r.ring >= 0 && len(r) < this.mm(0.8)) for (let i = r.a; i <= r.b; i++) flags[i] = -1;
    runs = build();
    runs.forEach((r, i) => {
      if (r.ring < 0 && i > 0 && i < runs.length - 1 && len(r) < this.mm(1)) for (let k = r.a; k <= r.b; k++) flags[k] = runs[i - 1].ring;
    });
    runs = build();
    if (runs.every((r) => r.ring < 0)) return [{ ring: -1, pts: closed ? path : pts }];
    return runs.map((r) => ({ ring: r.ring, pts: path.slice(r.a, Math.min(path.length, r.b + 2)) })).filter((r) => r.pts.length >= 2);
  }

  /** Draws impassable cliffs (ISOM 201) in place of the contours removed inside rock walls. */
  private rockWalls(runs: { level: number; pts: Pt[]; ring: number }[], ci: number) {
    const { f } = this;
    const sWall = ci / (WALL_SPACING_MM * this.k * (this.p.scale / 15000) * this.mpm);
    const byRing = new Map<number, typeof runs>();
    for (const r of runs) {
      let l = byRing.get(r.ring);
      if (!l) byRing.set(r.ring, (l = []));
      l.push(r);
    }
    for (const group of byRing.values()) {
      const top = Math.max(...group.map((r) => r.level));
      const bottom = Math.min(...group.map((r) => r.level));
      // Top edge first, then lower steps only where they are clearly separated (~1.2 mm on paper),
      // so a high wall reads as a few terraced cliffs instead of a black band.
      const drawn = new Occupancy(Math.max(5, this.mm(1)));
      const gap = this.mm(1.2);
      let best: { pts: Pt[]; len: number } | undefined;
      for (const r of [...group].sort((a, b) => b.level - a.level)) {
        const pts = simplify(r.pts, f.height.cell * 0.1);
        const L = lineLength(pts);
        if (L < this.mm(0.7)) continue;
        const probe = densify(pts, this.mm(0.4));
        const clash = probe.filter((q) => !drawn.free(q.x, q.y, gap)).length;
        if (r.level !== top && clash > probe.length * 0.25) continue;
        this.line("201", pts);
        drawn.addLine(pts, 0.01, this.mm(0.3));
        this.occ.addLine(pts, this.mm(0.5), this.mm(0.5));
        if (r.level === top && (!best || L > best.len)) best = { pts, len: L };
      }
      if (!best) continue;
      // Control site at the foot of the wall, below the middle of its top edge.
      const m = best.pts[best.pts.length >> 1];
      const g = f.height.grad(m.x, m.y);
      const gn = Math.hypot(g.x, g.y) || 1;
      const down = { x: -g.x / gn, y: -g.y / gn };
      const heightM = Math.max(5, Math.round(top - bottom + ci));
      const depth = (top - bottom + ci) / Math.max(sWall, f.slope.sample(m.x, m.y)) + this.mm(0.8);
      const foot = { x: m.x + down.x * depth, y: m.y + down.y * depth };
      this.site(foot.x, foot.y, { D: "2.1", F: String(Math.min(30, heightM)), G: `11.14${compass(down.x, down.y)}` }, "rock wall foot", 1.3);
    }
  }

  /**
   * Slope lines (ISOM 101.1 / 103.1) on the downhill side of a contour. Contours run with higher
   * ground on the left, so downhill is the right-hand normal (−dy, dx) in y-down coordinates.
   * Placed where the slope direction would otherwise be ambiguous: inside depressions, at the
   * bottom of re-entrants (sharp bends whose concave side faces downhill) and on flat ground
   * where contours are far apart. Map edges also get one so cut-off lines read correctly.
   */
  slopeLines(code: "101.1" | "103.1", pts: Pt[], closed: boolean, depression = false) {
    const { f, p } = this;
    const path = closed ? [...pts, pts[0]] : pts;
    if (path.length < 3) return;
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
    const L = cum[cum.length - 1];
    if (L < this.mm(2)) return;
    const at = (s: number): Pt => {
      s = closed ? ((s % L) + L) % L : Math.max(0, Math.min(L, s));
      let lo = 1;
      let hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < s) lo = mid + 1;
        else hi = mid;
      }
      const a = path[lo - 1];
      const b = path[lo];
      const t = (s - cum[lo - 1]) / (cum[lo] - cum[lo - 1] || 1);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    };
    const placed: number[] = [];
    const put = (s: number, minGap: number): boolean => {
      if (placed.some((q) => Math.min(Math.abs(q - s), closed ? L - Math.abs(q - s) : Infinity) < minGap)) return false;
      const d = this.mm(0.6);
      const a = at(s - d);
      const b = at(s + d);
      const c = at(s);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const n = Math.hypot(dx, dy);
      if (!n) return false;
      const r = this.mm(0.45);
      // The tick itself is ~0.8 mm long on the downhill side; keep it off water and the map edge.
      const tip = { x: c.x - (dy / n) * this.mm(0.8), y: c.y + (dx / n) * this.mm(0.8) };
      if (!this.inside(c.x, c.y, this.mm(1)) || this.inLake(c.x, c.y) || this.inLake(tip.x, tip.y)) return false;
      if (!this.occ.free((c.x + tip.x) / 2, (c.y + tip.y) / 2, r)) return false;
      // Ticks on neighbouring contours of the same re-entrant would stack up; depressions may be denser.
      const spread = this.mm(depression ? 1.2 : 1.9);
      if (!this.slopeOcc.free(c.x, c.y, spread)) return false;
      this.slopeOcc.add(c.x, c.y, spread);
      this.occ.add((c.x + tip.x) / 2, (c.y + tip.y) / 2, r);
      this.features.push({ kind: "point", code, x: c.x, y: c.y, angle: upAngle(-dy / n, dx / n) });
      this.count(code);
      placed.push(s);
      return true;
    };

    // Depressions: one tick on small ones, more spread evenly around larger rings.
    if (depression) {
      const nTicks = Math.max(1, Math.min(4, Math.round(L / this.mm(14))));
      const s0 = this.rng.range(0, L / nTicks);
      for (let t = 0; t < nTicks; t++) {
        // Try a few nearby spots in case the exact one is blocked.
        for (const off of [0, 0.08, -0.08, 0.16, -0.16]) if (put(s0 + (L * (t + off)) / nTicks, this.mm(3))) break;
      }
      return;
    }

    // Re-entrants: the contour turns right (towards downhill) sharply around the valley floor.
    const step = this.mm(0.5);
    const w = this.mm(2.2);
    const turn = (s: number) => {
      const a = at(s - w);
      const b = at(s);
      const c = at(s + w);
      const ux = b.x - a.x;
      const uy = b.y - a.y;
      const vx = c.x - b.x;
      const vy = c.y - b.y;
      return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    };
    const lo = closed ? 0 : w;
    const hi = closed ? L : L - w;
    const minTurn = code === "103.1" ? 0.75 : 0.65 + 0.3 * (1 - p.detail);
    const reGap = this.mm(code === "103.1" ? 9 : 12);
    const cand: { s: number; t: number }[] = [];
    let prev = turn(lo - step);
    let cur = turn(lo);
    for (let s = lo; s <= hi; s += step) {
      const next = turn(s + step);
      if (cur > minTurn && cur >= prev && cur > next) cand.push({ s, t: cur });
      prev = cur;
      cur = next;
    }
    cand.sort((a, b) => b.t - a.t);
    for (const c of cand) if (this.rng.chance(0.95)) put(c.s, reGap);

    // Flat ground: contours far apart make the direction hard to read, add sparse ticks.
    const flatEvery = this.mm(code === "103.1" ? 16 : 26);
    const flatLimit = code === "103.1" ? 0.08 : 0.06;
    for (let s = this.rng.range(0.3, 0.7) * flatEvery; s < L; s += flatEvery) {
      const q = at(s);
      if (f.slope.sample(q.x, q.y) < flatLimit && this.rng.chance(0.6)) put(s, flatEvery * 0.5);
    }

    // Small closed hill tops: a tick pointing outwards makes the knoll read at a glance.
    if (closed && L < this.mm(28) && this.rng.chance(0.45)) put(this.rng.range(0, L), this.mm(6));

    // Now and then a tick on an ordinary slope, so the map keeps its up/down legibility.
    const sparse = this.mm(code === "103.1" ? 30 : 45);
    for (let s = this.rng.range(0.2, 1) * sparse; s < L; s += sparse) if (this.rng.chance(0.3)) put(s, sparse * 0.5);

    // Lines cut by the map edge: one tick near the edge so the slope reads at a glance.
    if (!closed && code === "101.1") {
      const edge = this.mm(6);
      for (const [s, q] of [
        [this.mm(4), path[0]],
        [L - this.mm(4), path[path.length - 1]],
      ] as const) {
        if (L > this.mm(10) && !this.inside(q.x, q.y, edge) && this.rng.chance(0.5)) put(s, this.mm(10));
      }
    }
  }

  /** Cuts gaps into an index contour and places height labels in them. */
  private labelContour(pts: Pt[], closed: boolean, level: number, every: number): Pt[][] {
    // For closed lines walk the ring twice so slices may wrap past the start.
    const ring = closed ? [...pts, pts[0]] : pts;
    const path = closed ? [...ring, ...ring.slice(1)] : ring;
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
    const L = closed ? cum[ring.length - 1] : cum[cum.length - 1];
    const text = String(Math.round(level));
    const halfGap = this.mm(0.75 + text.length * 0.42);
    const at = (s: number) => {
      let i = 1;
      while (i < cum.length - 1 && cum[i] < s) i++;
      const a = path[i - 1];
      const b = path[i];
      const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x) };
    };
    const cuts: number[] = [];
    for (let s = every / 2; s < L - every / 3; s += every) {
      if (s - halfGap < 0 || s + halfGap > L) continue;
      const c = at(s);
      if (!this.inside(c.x, c.y, this.mm(6))) continue;
      // Avoid labels on sharp bends.
      const a0 = at(s - halfGap).angle;
      const a1 = at(s + halfGap).angle;
      if (Math.abs(Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0))) > 0.5) continue;
      cuts.push(s);
      this.features.push({ kind: "text", code: "102.1", x: c.x, y: c.y, text, angle: c.angle });
    }
    if (!cuts.length) return [ring];
    const pieces: Pt[][] = [];
    if (closed) {
      for (let i = 0; i < cuts.length; i++) {
        const next = i + 1 < cuts.length ? cuts[i + 1] : cuts[0] + L;
        pieces.push(slicePath(path, cum, cuts[i] + halfGap, next - halfGap));
      }
    } else {
      let start = 0;
      for (const c of cuts) {
        pieces.push(slicePath(path, cum, start, c - halfGap));
        start = c + halfGap;
      }
      pieces.push(slicePath(path, cum, start, L));
    }
    return pieces.filter((pc) => pc.length > 1);
  }

  /** Spot heights (dot + height) on some hill tops. */
  spotHeights() {
    const { rng } = this;
    const want = Math.round((2 + 4 * this.p.detail) * ((this.f.widthM * this.f.heightM) / 6e6));
    const tops = [...this.hillTops].sort((a, b) => b.len - a.len);
    let done = 0;
    for (const t of tops) {
      if (done >= want) break;
      if (!rng.chance(0.7)) continue;
      const h = this.f.height.sample(t.x, t.y);
      const tx = t.x + this.mm(1.9);
      if (!this.inside(tx, t.y, this.mm(4)) || !this.occ.free(tx, t.y, this.mm(1))) continue;
      if (!this.point("603.0", t.x, t.y, 0.35)) continue;
      this.features.push({ kind: "text", code: "603.1", x: tx, y: t.y + this.mm(0.7), text: String(Math.round(h)) });
      this.occ.add(tx, t.y, this.mm(1.1));
      done++;
    }
  }

  smallLandforms() {
    const { f, p, rng } = this;
    const density = p.detail;
    if (density <= 0) return;
    const s = this.mm(4.5);
    this.scatter(s, (x, y) => {
      const b = f.bumps.sample(x, y);
      const sl = f.slope.sample(x, y);
      if (sl > 0.35) return;
      const g = f.bumps.grad(x, y);
      const flat = Math.hypot(g.x, g.y) * f.bumps.cell < 0.12;
      if (b > 0.3 && flat && rng.chance(Math.min(0.95, (0.25 + 0.6 * density) * this.mood.landforms))) {
        if (b > 0.55 && rng.chance(0.06 * density)) {
          this.point("115", x, y, 0.6, undefined, { desc: { D: "6.1" }, label: "special landform", weight: 0.9 });
        } else if (rng.chance(0.25)) {
          this.point("110", x, y, 0.7, rng.range(0, Math.PI), { desc: { D: "1.10" }, label: "elongated knoll", weight: 1.1 });
        } else {
          this.point("109", x, y, 0.55, undefined, { desc: { D: "1.10" }, label: "knoll", weight: 1.2 });
        }
      } else if (b < -0.32 && flat && rng.chance(Math.min(0.95, (0.2 + 0.5 * density) * this.mood.landforms))) {
        if (rng.chance(0.35)) this.point("112", x, y, 0.6, undefined, { desc: { D: "1.14" }, label: "pit", weight: 1.1 });
        else this.point("111", x, y, 0.6, undefined, { desc: { D: "1.13" }, label: "small depression", weight: 1.1 });
      }
    });

    // Isolated broken-ground dots (single pits/knolls too small to show) and a few at patch edges.
    this.scatter(this.mm(6), (x, y) => {
      const v = f.bumps.sample(x, y);
      if (Math.abs(v) > 0.18 && Math.abs(v) < 0.24 && rng.chance(0.08 * density)) this.point("113.1", x, y, 0.3);
    });

    // Broken ground patches.
    const broken = derive(f, (kk, x, y) => Math.min(f.bumps.data[kk] * 0.5 + 0.4 * Math.sin(x / 61 + y / 47) - 0.5, 0.3 - f.slope.data[kk]));
    const bl = broken.blur(1, 1);
    const rings = this.regions(bl, 0, this.mm(3) ** 2);
    if (density > 0.4) {
      const very = this.regions(bl, 0.05, this.mm(2) ** 2);
      this.area("113", [...rings, ...very]);
      if (density > 0.55) this.area("114", very);
      for (const r of rings) {
        if (Math.abs(ringArea(r)) < this.mm(6) ** 2) {
          const c = centroid(r);
          if (pointInRing(c, r)) this.site(c.x, c.y, { D: "1.15" }, "broken ground", 0.8);
        }
      }
    }
  }

  /** Short line features following the slope direction or contour direction. */
  private trace(
    x0: number,
    y0: number,
    maxLen: number,
    step: number,
    ok: (x: number, y: number) => boolean,
    along: "contour" | "downhill",
  ): Pt[] {
    const f = this.f;
    const dir = (x: number, y: number) => {
      const g = f.height.grad(x, y);
      const n = Math.hypot(g.x, g.y) || 1;
      // Contour direction keeps downhill on the right: d = (-gy, gx).
      return along === "contour" ? { x: -g.y / n, y: g.x / n } : { x: -g.x / n, y: -g.y / n };
    };
    const walk = (sign: number): Pt[] => {
      const pts: Pt[] = [];
      let x = x0;
      let y = y0;
      for (let l = 0; l < maxLen / 2; l += step) {
        const d = dir(x, y);
        x += sign * d.x * step;
        y += sign * d.y * step;
        if (!ok(x, y)) break;
        pts.push({ x, y });
      }
      return pts;
    };
    if (along === "downhill") return [{ x: x0, y: y0 }, ...walk(1), ...walk(1)];
    const back = walk(-1).reverse();
    return [...back, { x: x0, y: y0 }, ...walk(1)];
  }

  rocks() {
    const { f, p, rng } = this;
    if (p.rock <= 0.02) return;
    const tR = f.thresholds.rock;
    const lakeGuard = (kk: number) => -f.water.data[kk] * 0.05 - 0.01;

    // Stony ground in three runnability bands; bare rock and boulder fields as patches.
    const stony = derive(f, (kk) => Math.min(f.rock.data[kk] - tR - 0.06, lakeGuard(kk)));
    const r1 = this.regions(stony, 0, this.mm(2.5) ** 2);
    const r2 = this.regions(stony, 0.1, this.mm(2.5) ** 2);
    const r3 = this.regions(stony, 0.2, this.mm(2.5) ** 2);
    this.area("210", [...r1, ...r2]);
    this.area("211", [...r2, ...r3]);
    this.area("212", r3);

    const bareN = derive(f, (kk, x, y) => Math.min(Math.sin(x / 37 + Math.cos(y / 53) * 2) * 0.5 + f.bumps.data[kk] - 0.55, f.rock.data[kk] - tR, lakeGuard(kk)));
    this.area("214", this.regions(bareN, 0, this.mm(1.6) ** 2));
    const bfield = derive(f, (kk, x, y) => Math.min(Math.cos(x / 29 - y / 41) * 0.5 - f.bumps.data[kk] - 0.65, f.rock.data[kk] - tR - 0.05, lakeGuard(kk)));
    const bf = this.regions(bfield, 0.07, this.mm(1.5) ** 2);
    const dense = this.regions(bfield, 0.2, this.mm(1.2) ** 2);
    this.area("208", [...bf, ...dense]);
    this.area("209", dense);
    for (const ring of bf) {
      if (Math.abs(ringArea(ring)) < this.mm(5) ** 2) {
        const c = centroid(ring);
        this.site(c.x, c.y, { D: "2.5" }, "boulder field", 0.9);
      }
    }

    // Cliffs: contour-parallel lines on steep rocky ground; downhill (tags) on the right.
    const sMin = 0.42;
    const step = Math.max(1.5, f.height.cell * 0.4);
    const okCliff = (x: number, y: number) =>
      this.inside(x, y) && f.rock.sample(x, y) > tR - 0.05 && f.slope.sample(x, y) > sMin * 0.7 && !this.inLake(x, y);
    this.scatter(this.mm(4), (x, y) => {
      if (f.rock.sample(x, y) < tR || f.slope.sample(x, y) < sMin || !rng.chance(0.35 + 0.5 * p.rock)) return;
      if (!this.occ.free(x, y, this.mm(1.2))) return;
      const len = rng.range(this.mm(1.2), this.mm(6));
      const pts = simplify(this.trace(x, y, len, step, okCliff, "contour"), 0.4);
      const L = lineLength(pts);
      const g = f.height.grad(x, y);
      const gn = Math.hypot(g.x, g.y) || 1;
      const down = { x: -g.x / gn, y: -g.y / gn };
      const heightM = Math.max(1, Math.min(12, Math.round(f.slope.sample(x, y) * 6 + rng.range(0, 3))));
      const impassable = heightM >= 5;
      const foot = { x: x + down.x * this.mm(0.9), y: y + down.y * this.mm(0.9) };
      const desc: ControlDesc = { D: "2.1", F: String(heightM), G: `11.14${compass(down.x, down.y)}` };
      if (L < this.mm(1.2)) {
        this.point(impassable ? "201.1" : rng.chance(0.5) ? "202.3" : "202.1", x, y, 0.5, upAngle(down.x, down.y), { desc, label: "cliff", weight: 1.3 });
        return;
      }
      this.line(impassable ? "201" : rng.chance(0.5) ? "202.2" : "202", pts);
      this.occ.addLine(pts, this.mm(0.5), this.mm(0.5));
      this.site(foot.x, foot.y, desc, "cliff foot", 1.4);
    });

    // Boulders.
    this.scatter(this.mm(4.5), (x, y) => {
      const r = f.rock.sample(x, y);
      if (r < tR - 0.1) {
        if (!rng.chance(0.005 * p.rock)) return;
      } else if (!rng.chance(Math.min(0.6, (0.08 + 0.27 * p.rock) * this.mood.boulders))) return;
      const roll = rng.next();
      if (roll < 0.7) {
        const hgt = rng.pick(["1", "1.5", "1.5", "2"]);
        this.point("204", x, y, 0.4, undefined, { desc: { D: "2.4", F: hgt }, label: "boulder", weight: 1.3 });
      } else if (roll < 0.9) {
        this.point("205", x, y, 0.55, undefined, { desc: { D: "2.4", F: rng.pick(["2", "2.5", "3"]) }, label: "large boulder", weight: 1.4 });
      } else if (roll < 0.98) {
        this.point("207", x, y, 0.65, rng.range(0, Math.PI * 2), { desc: { D: "2.6" }, label: "boulder cluster", weight: 1.1 });
      } else {
        this.point("207.1", x, y, 0.8, rng.range(0, Math.PI * 2), { desc: { D: "2.6" }, label: "large boulder cluster", weight: 1.1 });
      }
    });
    // Single boulder-field triangles and stony-ground dots too small for an area.
    this.scatter(this.mm(5), (x, y) => {
      const r = f.rock.sample(x, y);
      if (r < tR - 0.12 || r > tR - 0.02 || !rng.chance(0.08 * p.rock)) return;
      if (rng.chance(0.4)) this.point(rng.chance(0.7) ? "208.1" : "208.2", x, y, 0.45, rng.range(-0.4, 0.4));
      else this.point("210.1", x, y, 0.3);
    });
    // Gigantic boulders: drawn to scale as a black area.
    this.scatter(this.mm(7), (x, y) => {
      if (f.rock.sample(x, y) < tR + 0.05 || !rng.chance(0.08 * p.rock) || this.inLake(x, y)) return;
      const r = rng.range(this.mm(0.45), this.mm(0.75));
      if (!this.inside(x, y, r * 2) || !this.occ.free(x, y, r * 1.6)) return;
      const n = rng.int(5, 8);
      const ph = rng.range(0, 6.3);
      const ring = Array.from({ length: n }, (_, i) => {
        const a = ph + (i / n) * Math.PI * 2;
        const rr = r * rng.range(0.7, 1.15);
        return { x: x + Math.cos(a) * rr, y: y + Math.sin(a) * rr };
      });
      this.area("206", [ring]);
      this.occ.add(x, y, r * 1.6);
      this.sites.push({ x: x + r * 1.8, y, desc: { D: "2.4", F: String(rng.int(4, 7)), G: "11.1E" }, label: "gigantic boulder", weight: 1.3 });
    });
    // Caves in steep rocky slopes, the opening facing downhill.
    this.scatter(this.mm(10), (x, y) => {
      if (f.rock.sample(x, y) < tR || f.slope.sample(x, y) < 0.3 || !rng.chance(0.25 * p.rock)) return;
      const g = f.height.grad(x, y);
      const gn = Math.hypot(g.x, g.y) || 1;
      this.point("203.2", x, y, 0.6, upAngle(-g.x / gn, -g.y / gn), { desc: { D: "2.3" }, label: "cave", weight: 1.2 });
    });
    // Rocky pits.
    this.scatter(this.mm(9), (x, y) => {
      if (f.rock.sample(x, y) > tR && rng.chance(0.25 * p.rock)) {
        this.point("203.1", x, y, 0.6, undefined, { desc: { D: "1.14", E: "8.6" }, label: "rocky pit", weight: 1.1 });
      }
    });
  }

  earthFeatures() {
    const { f, p, rng } = this;
    const tR = f.thresholds.rock;
    // Earth banks: steep but not rocky ground.
    const ok = (x: number, y: number) =>
      this.inside(x, y) && f.slope.sample(x, y) > 0.18 && f.rock.sample(x, y) < tR && !this.inLake(x, y);
    this.scatter(this.mm(10), (x, y) => {
      if (!ok(x, y) || !rng.chance(0.18 * p.detail) || !this.occ.free(x, y, this.mm(1))) return;
      const pts = simplify(this.trace(x, y, rng.range(this.mm(2), this.mm(5)), 2, ok, "contour"), 0.4);
      if (lineLength(pts) < this.mm(1.5)) {
        const g = f.height.grad(x, y);
        const n = Math.hypot(g.x, g.y) || 1;
        this.point("104.1", x, y, 0.5, upAngle(-g.x / n, -g.y / n), { desc: { D: "1.4", G: `11.14${compass(-g.x, -g.y)}` }, label: "earth bank", weight: 1 });
        return;
      }
      this.line("104", pts);
      this.occ.addLine(pts, this.mm(0.4), this.mm(0.5));
      const g = f.height.grad(x, y);
      const n = Math.hypot(g.x, g.y) || 1;
      this.site(x - (g.x / n) * this.mm(0.6), y - (g.y / n) * this.mm(0.6), { D: "1.4", G: `11.14${compass(-g.x, -g.y)}` }, "earth bank foot", 1.1);
    });

    // Old earthworks: earth walls (intact / ruined) and trenches.
    const works = Math.round((0.4 + 2.5 * p.detail * (0.3 + p.manmade)) * ((f.widthM * f.heightM) / 6e6));
    for (let n = 0, tries = 0; n < works && tries < works * 20; tries++) {
      let q = { x: rng.range(0, f.widthM), y: rng.range(0, f.heightM) };
      if (!this.inside(q.x, q.y, this.mm(6)) || f.slope.sample(q.x, q.y) > 0.2 || this.inLake(q.x, q.y) || !this.occ.free(q.x, q.y, this.mm(2))) continue;
      const code = rng.weighted({ "105": 0.35, "106": 0.4, "215": 0.25 });
      let ang = rng.range(0, Math.PI * 2);
      const pts: Pt[] = [q];
      const len = rng.range(this.mm(3), this.mm(code === "215" ? 6 : 12));
      for (let s = 0; s < len; s += 8) {
        ang += rng.range(-0.18, 0.18);
        q = { x: q.x + Math.cos(ang) * 8, y: q.y + Math.sin(ang) * 8 };
        if (!this.inside(q.x, q.y) || this.inLake(q.x, q.y) || f.slope.sample(q.x, q.y) > 0.3) break;
        pts.push(q);
      }
      if (lineLength(pts) < this.mm(2.5)) continue;
      this.line(code, pts);
      this.occ.addLine(pts, this.mm(0.4), this.mm(0.6));
      const e = pts[pts.length - 1];
      const d = pts[pts.length - 2];
      const desc: ControlDesc = { D: code === "215" ? "2.10" : "1.6", G: `11.8${compass(e.x - d.x, e.y - d.y)}` };
      if (code === "106") desc.E = "8.11";
      this.site(e.x, e.y, desc, code === "215" ? "trench end" : "earth wall end", 1.1);
      n++;
    }

    // Erosion gullies: drainage lines on slopes that are too small to be streams.
    const { nx } = f.height;
    const cell = f.height.cell;
    const streamAcc = this.streamThreshold();
    for (let kk = 0; kk < f.flowAcc.length; kk++) {
      const acc = f.flowAcc[kk];
      if (acc < streamAcc * 0.25 || acc > streamAcc * 0.6) continue;
      if (f.slope.data[kk] < 0.08 || !rng.chance(0.03 * (0.3 + p.detail) * this.mood.gullies)) continue;
      const x = (kk % nx) * cell;
      const y = Math.floor(kk / nx) * cell;
      if (!this.occ.free(x, y, this.mm(1.2))) continue;
      const pts: Pt[] = [{ x, y }];
      let c = kk;
      for (let s = 0; s < this.mm(6) / cell && f.flowTo[c] >= 0; s++) {
        c = f.flowTo[c];
        pts.push({ x: (c % nx) * cell, y: Math.floor(c / nx) * cell });
      }
      const sm = chaikin(pts, false, 2);
      if (lineLength(sm) < this.mm(1.6)) continue;
      const code = f.slope.data[kk] > 0.2 && rng.chance(0.6) ? "107" : "108";
      this.line(code, sm);
      this.occ.addLine(sm, this.mm(0.4), this.mm(0.5));
      if (code === "107") this.site(x, y, { D: "1.7", G: "11.9" }, "erosion gully upper part", 0.9);
    }
  }

  // ------------------------------------------------------------------ water

  streamThreshold(): number {
    const cellArea = this.f.height.cell ** 2;
    // Catchment area needed for a stream: smaller with more water.
    return (65_000 * (1.6 - this.p.water)) / cellArea;
  }

  /** Signed distance from q to the water surface of river r (negative inside). */
  private riverDist(r: River, q: Pt): number {
    let best = Infinity;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const a = r.pts[i];
      const b = r.pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(a.x + t * dx - q.x, a.y + t * dy - q.y) - (r.hw[i] + (r.hw[i + 1] - r.hw[i]) * t);
      if (d < best) best = d;
    }
    return best;
  }

  private inRiverGeom(q: Pt, skip?: River): boolean {
    return this.f.rivers.some((r) => r !== skip && this.riverDist(r, q) < 0);
  }

  water() {
    const { f, p, rng } = this;
    const tM = f.thresholds;
    const W = (q: Pt) => this.inside(q.x, q.y, -this.mm(3));

    // Lakes and ponds; the bank line opens where a river flows in or out.
    const lakeRings = this.regions(f.lake, 0, this.mm(2) ** 2);
    this.area("301.1", lakeRings);
    for (const r of lakeRings) {
      for (const run of splitWhere(r, true, (q) => !this.inRiverGeom(q))) this.line("301.4", run);
      this.occ.addLine(r, this.mm(0.4), this.mm(0.6));
    }

    // Rivers as water areas with bank lines, built from the centre line geometry (crisp at any width).
    for (const r of f.rivers) {
      let n = r.pts.length;
      if (r.tributary) {
        // End the tributary where it enters its main river.
        const main = f.rivers.find((o) => !o.tributary);
        if (main) {
          const k = r.pts.findIndex((q) => this.riverDist(main, q) < 0);
          if (k > 1) n = k + 1;
        }
      }
      const left = offsetRun(r, 0, n - 1, 0, (i) => r.hw[i]);
      const right = offsetRun(r, 0, n - 1, 1, (i) => r.hw[i]);
      this.area(r.crossable ? "302.1" : "301.1", [[...left, ...[...right].reverse()]]);
      const bank = r.crossable ? "302.2" : "301.4";
      const keep = (q: Pt) => W(q) && f.lake.sample(q.x, q.y) < 0 && !this.inRiverGeom(q, r);
      for (const side of [left, right]) {
        for (const run of splitWhere(side, false, keep, this.mm(0.8))) {
          this.line(bank, run);
          this.occ.addLine(run, this.mm(0.45), this.mm(0.6));
        }
      }
    }

    if (p.water > 0.05) {
      const marshGuard = (kk: number) => Math.min(-f.water.data[kk] * 0.1 - 0.02, (0.1 - f.slope.data[kk]) * 4);
      const marsh = derive(f, (kk) => Math.min(f.wet.data[kk] - tM.marsh, marshGuard(kk)));
      const indistinct = derive(f, (kk) => Math.min(f.wet.data[kk] - tM.marshIndistinct, marshGuard(kk)));
      const mRings = this.regions(marsh, 0, this.mm(1.5) ** 2);
      const iRings = this.regions(indistinct, 0, this.mm(2) ** 2);
      this.area("308", mRings);
      // Even-odd of both ring sets = the band around the marshes.
      this.area("310", [...iRings, ...mRings]);
      // The wettest cores of big marshes are uncrossable.
      if (p.water > 0.45) {
        const core = derive(f, (kk) => Math.min(f.wet.data[kk] - tM.marsh - 0.5 + 0.25 * (p.water - 0.45), marshGuard(kk)));
        const cRings = this.regions(core.blur(1, 1), 0, this.mm(2.5) ** 2);
        this.area("307", cRings);
        for (const r of cRings) this.occ.addLine(r, this.mm(0.4), this.mm(0.8));
      }
      for (const r of mRings) {
        const a = Math.abs(ringArea(r));
        const c = centroid(r);
        if (!pointInRing(c, r)) continue;
        if (a < this.mm(6) ** 2) {
          this.site(c.x, c.y, { D: "3.7" }, "marsh", 0.9);
        } else if (rng.chance(0.45)) {
          // Waterhole somewhere inside a large marsh.
          this.point("303", c.x, c.y, 0.6, undefined, { desc: { D: "3.3" }, label: "waterhole", weight: 1 });
        } else if (rng.chance(0.6)) {
          // Small pond (shallow water) in the marsh.
          const rad = rng.range(this.mm(0.6), this.mm(1.4));
          if (this.occ.free(c.x, c.y, rad * 1.3)) {
            const ring = blob(c, rad, rng);
            if (rad <= this.mm(1)) this.area("302.5", [ring]);
            else if (rng.chance(0.35)) {
              this.area("302.1", [ring]);
              this.line("302.3", [...ring, ring[0]], true);
            } else this.area("302", [ring]);
            this.occ.add(c.x, c.y, rad * 1.3);
            this.site(c.x + rad * 1.5, c.y, { D: "3.2", G: "11.1E" }, "pond", 0.9);
          }
        }
      }
      // Marsh too small to show as an area: minimum-size marsh symbols in damp hollows.
      this.scatter(this.mm(6), (x, y) => {
        const w = f.wet.sample(x, y);
        if (w < tM.marshIndistinct - 0.12 || w > tM.marshIndistinct || f.slope.sample(x, y) > 0.08) return;
        if (!rng.chance(0.15 + 0.3 * p.water)) return;
        if (rng.chance(0.6)) this.point("308.1", x, y, 0.8, undefined, { desc: { D: "3.7" }, label: "small marsh", weight: 0.9 });
        else this.point("310.1", x, y, 0.8);
      });
    }

    // Streams from flow accumulation.
    const thr = this.streamThreshold();
    const { nx } = f.height;
    const cell = f.height.cell;
    const N = f.flowAcc.length;
    const nearRiver = (kk: number) => Math.max(f.riverU.data[kk], f.riverC.data[kk]) > -4;
    const isStream = new Uint8Array(N);
    for (let kk = 0; kk < N; kk++) {
      const x = (kk % nx) * cell;
      const y = Math.floor(kk / nx) * cell;
      // No streams across filled depressions (D8 runs dead straight over those flats) or along rivers.
      if (f.flowAcc[kk] >= thr && !this.inLake(x, y) && !nearRiver(kk) && f.basinDepth.data[kk] < 1.2) isStream[kk] = 1;
    }
    const hasUpstream = new Uint8Array(N);
    for (let kk = 0; kk < N; kk++) if (isStream[kk] && f.flowTo[kk] >= 0) hasUpstream[f.flowTo[kk]] = 1;
    const visited = new Uint8Array(N);
    const pos = (kk: number): Pt => ({ x: (kk % nx) * cell, y: Math.floor(kk / nx) * cell });
    const junctions: Pt[] = [];
    for (let kk = 0; kk < N; kk++) {
      if (!isStream[kk] || hasUpstream[kk]) continue; // start at stream heads
      let c = kk;
      let cur: Pt[] = [pos(c)];
      let curAcc = f.flowAcc[c];
      const flush = () => {
        if (cur.length < 3) return;
        const pts = simplify(chaikin(cur, false, 3), cell * 0.15);
        if (lineLength(pts) < this.mm(2)) return;
        const code = curAcc > thr * 5 ? "304" : curAcc > thr * 2 ? "305" : "306";
        this.line(code, pts);
        this.streamLines.push({ pts, code });
        this.occ.addLine(pts, this.mm(0.35), this.mm(0.6));
      };
      // Spring at some heads.
      if (rng.chance(Math.min(0.9, 0.4 * (0.3 + p.water) * this.mood.springs))) {
        const nxt = f.flowTo[c] >= 0 ? pos(f.flowTo[c]) : pos(c);
        const a = pos(c);
        this.point("312", a.x, a.y, 0.6, upAngle(nxt.x - a.x, nxt.y - a.y), { desc: { D: "3.10" }, label: "spring", weight: 1.1 });
      }
      for (;;) {
        visited[c] = 1;
        const n = f.flowTo[c];
        if (n < 0 || !isStream[n]) {
          if (n >= 0) {
            cur.push(pos(n)); // run into the lake / river / sink
            // Carry on a few cells so the stream really reaches the river bank.
            let m = n;
            for (let s = 0; s < 3 && f.flowTo[m] >= 0 && nearRiver(m) && !this.inLake(pos(m).x, pos(m).y); s++) {
              m = f.flowTo[m];
              cur.push(pos(m));
            }
          }
          flush();
          break;
        }
        cur.push(pos(n));
        // Change line class where the stream grows.
        const nAcc = f.flowAcc[n];
        const cls = (a: number) => (a > thr * 5 ? 2 : a > thr * 2 ? 1 : 0);
        if (visited[n]) {
          // Joins a stream traced earlier: a stream junction.
          if (curAcc > thr * 1.3) junctions.push(pos(n));
          flush();
          break;
        }
        if (cls(nAcc) !== cls(curAcc) && cur.length > 4) {
          flush();
          cur = [pos(n)];
        }
        curAcc = Math.max(curAcc, nAcc);
        c = n;
      }
    }
    for (const q of junctions) this.site(q.x, q.y, { D: "3.4", E: "3.4", F: "10.2" }, "stream junction", 1.1);

    // Narrow marshes along weak drainage lines on flat, wet ground.
    if (p.water > 0.15) {
      for (let kk = 0; kk < N; kk++) {
        const acc = f.flowAcc[kk];
        if (acc < thr * 0.2 || acc > thr * 0.7 || f.slope.data[kk] > 0.07) continue;
        if (f.wet.data[kk] < tM.marshIndistinct - 0.2 || !rng.chance(0.03 * p.water)) continue;
        const start = pos(kk);
        if (!this.occ.free(start.x, start.y, this.mm(1.2)) || this.inLake(start.x, start.y)) continue;
        const pts: Pt[] = [start];
        let c = kk;
        for (let s = 0; s < this.mm(7) / cell && f.flowTo[c] >= 0; s++) {
          c = f.flowTo[c];
          const q = pos(c);
          if (this.inLake(q.x, q.y) || f.slope.data[c] > 0.09) break;
          pts.push(q);
        }
        const sm = chaikin(pts, false, 2);
        if (lineLength(sm) < this.mm(2)) continue;
        this.line("309", sm);
        this.occ.addLine(sm, this.mm(0.4), this.mm(0.5));
        const e = sm[sm.length - 1];
        const d = sm[sm.length - 2];
        this.site(e.x, e.y, { D: "3.6", G: `11.8${compass(e.x - d.x, e.y - d.y)}` }, "narrow marsh end", 0.9);
      }
    }

    this.riverFeatures();
  }

  /** Cliffs on the outside of river bends and on bluffs, sand bars on the inside. */
  private riverFeatures() {
    const { f, p, rng } = this;
    for (const r of f.rivers) {
      const n = r.pts.length;
      for (let side = 0; side < 2; side++) {
        const sd = side === 0 ? -1 : 1;
        // --- cliffs: runs of steep bank where the ground really rises
        const wallFoot = (i: number) => r.floodW[side][i] + 1.5;
        const rise = (i: number) => {
          const [a] = offsetRun(r, i, i, side, () => wallFoot(i));
          const [b] = offsetRun(r, i, i, side, () => wallFoot(i) + 12);
          return f.height.sample(b.x, b.y) - f.height.sample(a.x, a.y);
        };
        let i = 0;
        while (i < n) {
          if (r.steep[side][i] < 0.7 || rise(i) < 3.5) {
            i++;
            continue;
          }
          let j = i;
          while (j + 1 < n && r.steep[side][j + 1] >= 0.6 && rise(j + 1) >= 3) j++;
          // Break long runs into separate cliffs with gaps.
          for (let a = i; a < j - 2; ) {
            const b = Math.min(j, a + rng.int(4, 14));
            const a0 = a;
            const pts0 = offsetRun(r, a, b, side, wallFoot).filter((q) => this.inside(q.x, q.y, this.mm(1)));
            a = b + rng.int(2, 6);
            if (!rng.chance(0.4 + 0.5 * p.rock)) continue;
            if (pts0.length < 3 || lineLength(pts0) < this.mm(1.2)) continue;
            // Tags (downhill) must lie on the right: towards the river.
            const pts = sd === 1 ? [...pts0].reverse() : pts0;
            if (!pts.every((q) => !this.inLake(q.x, q.y))) continue;
            const mid = Math.floor((a0 + b) / 2);
            const hgt = Math.max(2, Math.min(15, Math.round(rise(Math.min(n - 1, mid)) * rng.range(0.6, 0.9))));
            const code = hgt >= 5 && p.rock > 0.15 ? "201" : rng.chance(0.5) ? "202.2" : "202";
            this.line(code, pts);
            this.occ.addLine(pts, this.mm(0.5), this.mm(0.5));
            const m = pts[Math.floor(pts.length / 2)];
            const [foot] = offsetRun(r, mid, mid, side, () => wallFoot(mid) - this.mm(0.8));
            const toRiver = { x: foot.x - m.x, y: foot.y - m.y };
            this.site(foot.x, foot.y, { D: "2.1", F: String(hgt), G: `11.14${compass(toRiver.x, toRiver.y)}` }, "river cliff foot", 1.4);
            // Fallen blocks below big cliffs.
            if (hgt >= 4 && rng.chance(0.5)) {
              const q = pts[rng.int(0, pts.length - 1)];
              this.point("204", q.x + toRiver.x * 0.8, q.y + toRiver.y * 0.8, 0.4, undefined, { desc: { D: "2.4", F: "1.5" }, label: "boulder", weight: 1.1 });
            }
          }
          i = j + 1;
        }

        // --- sand bars on the inside of bends
        i = 0;
        while (i < n) {
          if (sd * r.curv[i] * 75 < 0.5) {
            i++;
            continue;
          }
          let j = i;
          while (j + 1 < n && sd * r.curv[j + 1] * 75 >= 0.4) j++;
          if (j - i >= 5 && rng.chance(0.65)) {
            const wMax = rng.range(5, 14) + 6 * p.river;
            const len = j - i;
            const inner = offsetRun(r, i, j, side, (k) => r.hw[k] + 0.3);
            const outer = offsetRun(r, i, j, side, (k) => r.hw[k] + 0.3 + wMax * Math.sin((Math.PI * (k - i)) / len));
            const ring = [...inner, ...outer.reverse()];
            if (ring.every((q) => this.inside(q.x, q.y) && f.lake.sample(q.x, q.y) < 0)) {
              this.area("213", [ring]);
              const c = offsetRun(r, Math.floor((i + j) / 2), Math.floor((i + j) / 2), side, (k) => r.hw[k] + wMax * 0.5)[0];
              this.site(c.x, c.y, { D: "4.1", E: "8.8" }, "sandy river bank", 0.8);
            }
          }
          i = j + 1;
        }
      }
    }
  }

  // ------------------------------------------------------------------ vegetation

  vegetation() {
    const { f } = this;
    const t = f.thresholds;
    const notLake = (kk: number) => -f.water.data[kk] * 0.05 - 0.01;
    const notOpen = (kk: number) => t.open - f.open.data[kk];

    const rough = derive(f, (kk) => Math.min(f.open.data[kk] - t.open, notLake(kk)));
    const full = derive(f, (kk) => Math.min(f.open.data[kk] - t.openFull, notLake(kk)));
    const roughRings = this.regions(rough, 0, this.mm(2) ** 2);
    const fullRings = this.regions(full, 0, this.mm(2) ** 2);
    this.area("403", roughRings);
    this.area("401", fullRings);
    this.openRings = roughRings;
    // Scattered trees in parts of the open land (white dots), nested in the open areas.
    {
      const tT = f.thresholds.under - 0.35;
      const roughTrees = derive(f, (kk) => Math.min(rough.data[kk], f.under.data[kk] - tT));
      const fullTrees = derive(f, (kk) => Math.min(full.data[kk], f.under.data[kk] - tT));
      const rt = this.regions(roughTrees, 0, this.mm(2.5) ** 2);
      const ft = this.regions(fullTrees, 0, this.mm(2.5) ** 2);
      this.area("404", [...rt, ...ft]);
      this.area("402", ft);
    }
    // Some bigger fields are cultivated.
    for (const r of fullRings) {
      const a = Math.abs(ringArea(r));
      if (a < this.mm(10) ** 2 || a > this.mm(60) ** 2 || !this.rng.chance(0.45 * this.p.manmade)) continue;
      this.area(this.rng.weighted({ "412": 0.45, "412.1": 0.12, "413": 0.18, "414": 0.25 }), [r]);
      if (this.rng.chance(0.5)) this.line("415", [...r, r[0]]);
    }
    // Rough open land is sometimes an old orchard or vineyard.
    for (const r of roughRings) {
      const a = Math.abs(ringArea(r));
      if (a < this.mm(8) ** 2 || a > this.mm(40) ** 2 || !this.rng.chance(0.25 * this.p.manmade)) continue;
      const c = centroid(r);
      if (f.open.sample(c.x, c.y) > t.openFull) continue;
      this.area(this.rng.chance(0.5) ? "413.1" : "414.1", [r]);
    }
    // Patches of scattered bushes (green dots) in open land.
    {
      const amt = Math.round((1 + 4 * this.p.open) * (f.widthM * f.heightM) / 6e6);
      const inFull = (x: number, y: number) => f.open.sample(x, y) > t.openFull + 0.02;
      const inRough = (x: number, y: number) => f.open.sample(x, y) > t.open + 0.01;
      this.patches("402.1", amt, 1.5, 3.5, inFull);
      this.patches("404.1", amt, 1, 2.5, inRough);
    }
    for (const r of fullRings) {
      const a = Math.abs(ringArea(r));
      if (a < this.mm(7) ** 2 && a > this.mm(2.5) ** 2) {
        const c = centroid(r);
        if (pointInRing(c, r)) this.site(c.x, c.y, { D: "4.4" }, "clearing", 1);
      }
    }

    const green = (thr: number) => derive(f, (kk) => Math.min(f.green.data[kk] - thr, notOpen(kk), notLake(kk)));
    this.area("406", this.regions(green(t.green1), 0, this.mm(1.5) ** 2));
    this.area("408", this.regions(green(t.green2), 0, this.mm(1.2) ** 2));
    const thick = this.regions(green(t.green3), 0, this.mm(1) ** 2);
    this.area("410", thick);
    // Distinct vegetation boundaries along parts of thicket edges.
    for (const r of this.regions(green(t.green2), 0, this.mm(4) ** 2)) {
      if (!this.rng.chance(0.3)) continue;
      const i0 = this.rng.int(0, r.length - 1);
      const len = Math.floor(r.length * this.rng.range(0.2, 0.5));
      const run = Array.from({ length: len }, (_, i) => r[(i0 + i) % r.length]);
      if (lineLength(run) > this.mm(4)) this.line(this.rng.chance(0.6) ? "416" : "416.1", run);
    }
    for (const r of thick) {
      if (Math.abs(ringArea(r)) < this.mm(3) ** 2) {
        const c = centroid(r);
        if (pointInRing(c, r)) this.site(c.x, c.y, { D: "4.5" }, "thicket", 0.8);
      }
    }
    const under = derive(f, (kk) => Math.min(f.under.data[kk] - t.under, t.green1 - f.green.data[kk], notOpen(kk), notLake(kk)));
    this.area("407", this.regions(under, 0, this.mm(3) ** 2));

    // Undergrowth: walk, good visibility, where thick undergrowth meets denser forest.
    const under2 = derive(f, (kk) => Math.min(f.under.data[kk] - t.under - 0.12, notOpen(kk), notLake(kk)));
    this.area("409", this.regions(under2, 0, this.mm(2.5) ** 2));

    // Plantations / felled strips with one good running direction, aligned with a common angle.
    const amt = (k: number) => Math.round(k * (0.3 + this.p.vegetation) * (f.widthM * f.heightM) / 6e6);
    const rowAngle = this.rng.range(0, Math.PI);
    const dir = () => rowAngle + this.rng.range(-0.15, 0.15);
    const gAt = (x: number, y: number) => (f.open.sample(x, y) > t.open ? -9 : f.green.sample(x, y));
    this.patches("406.1", amt(2.5), 0.9, 2, (x, y) => gAt(x, y) > t.green1 - 0.02, dir);
    this.patches(this.rng.chance(0.5) ? "408.1" : "408.2", amt(2), 0.8, 1.6, (x, y) => gAt(x, y) > t.green2 - 0.02, dir);
    this.patches(this.rng.pick(["410.1", "410.2", "410.3"]), amt(1.5), 0.6, 1.2, (x, y) => gAt(x, y) > t.green3 - 0.03, dir);
    // Narrow belts of thicket (minimum width), e.g. along forest edges.
    this.scatter(this.mm(14), (x, y) => {
      if (gAt(x, y) < t.green2 || !this.rng.chance(0.3 * this.p.vegetation)) return;
      const a = this.rng.range(0, Math.PI);
      const len = this.mm(this.rng.range(2, 4.5));
      const pts = densify([{ x: x - Math.cos(a) * len / 2, y: y - Math.sin(a) * len / 2 }, { x: x + Math.cos(a) * len / 2, y: y + Math.sin(a) * len / 2 }], 4)
        .map((q, i) => ({ x: q.x + Math.sin(i * 0.7) * 2, y: q.y + Math.cos(i * 0.9) * 2 }));
      if (pts.every((q) => this.inside(q.x, q.y) && !this.inLake(q.x, q.y))) this.line("410.4", pts);
    });
  }

  vegetationPoints() {
    const { f, rng, p } = this;
    const t = f.thresholds;
    const vm = this.mood.vegPoints;
    // Forest: root stocks (x), distinct bushes / small trees (dot) and large trees (o).
    this.scatter(this.mm(4), (x, y) => {
      if (f.open.sample(x, y) > t.open || f.wet.sample(x, y) > t.marsh) return;
      const roll = rng.next() / vm;
      if (roll < 0.025) this.point("419", x, y, 0.6, rng.range(0, 1.5), { desc: { D: "6.1" }, label: "root stock", weight: 0.9 });
      else if (roll < 0.045) this.point("418", x, y, 0.5, undefined, { desc: { D: "4.9" }, label: "bush", weight: 0.9 });
      else if (roll < 0.052) this.point("417", x, y, 0.8, undefined, { desc: { D: "4.9" }, label: "large tree", weight: 1 });
    });
    // Springs away from streams (seeps on slopes below damp ground) with a short outflow channel.
    this.scatter(this.mm(12), (x, y) => {
      const w = f.wet.sample(x, y);
      if (w < t.marsh - 0.25 || f.slope.sample(x, y) < 0.05 || !rng.chance(0.12 * this.mood.springs * (0.4 + p.water))) return;
      const g = f.height.grad(x, y);
      const n = Math.hypot(g.x, g.y) || 1;
      const dn = { x: -g.x / n, y: -g.y / n };
      if (!this.point("312", x, y, 0.6, upAngle(dn.x, dn.y), { desc: { D: "3.10" }, label: "spring", weight: 1.1 })) return;
      if (rng.chance(0.6)) {
        const pts = this.trace(x + dn.x * this.mm(0.8), y + dn.y * this.mm(0.8), this.mm(rng.range(2, 5)), 3, (qx, qy) => this.inside(qx, qy) && !this.inLake(qx, qy), "downhill");
        if (pts.length > 2) this.line("306", chaikin(pts, false, 2));
      }
    });
    // Drainage ditches: straight-ish channels through damp, flat forest.
    {
      const n = Math.round(3 * this.mood.ditches * (0.3 + p.water) * (f.widthM * f.heightM) / 6e6);
      for (let k = 0, tries = 0; k < n && tries < n * 30; tries++) {
        const c = { x: rng.range(0, f.widthM), y: rng.range(0, f.heightM) };
        if (f.wet.sample(c.x, c.y) < t.marsh - 0.2 || f.slope.sample(c.x, c.y) > 0.08 || !this.inside(c.x, c.y, this.mm(5))) continue;
        const a = rng.range(0, Math.PI);
        const len = this.mm(rng.range(5, 14));
        const pts = densify([{ x: c.x - (Math.cos(a) * len) / 2, y: c.y - (Math.sin(a) * len) / 2 }, { x: c.x + (Math.cos(a) * len) / 2, y: c.y + (Math.sin(a) * len) / 2 }], 8);
        const runs = splitWhere(pts, false, (q) => this.inside(q.x, q.y) && !this.inLake(q.x, q.y), this.mm(2));
        for (const r of runs) {
          this.line("306", r);
          this.occ.addLine(r, this.mm(0.3), this.mm(0.8));
          const e = r[r.length - 1];
          this.site(e.x, e.y, { D: "3.5", G: `11.8${compass(e.x - r[0].x, e.y - r[0].y)}` }, "ditch end", 0.9);
        }
        k++;
      }
    }
    this.scatter(this.mm(5), (x, y) => {
      const o = f.open.sample(x, y);
      if (o > t.open) {
        if (rng.chance(0.18)) this.point("418", x, y, 0.5, undefined, { desc: { D: "4.9" }, label: "distinct tree", weight: 1 });
        else if (rng.chance(0.04)) this.point("417", x, y, 0.8, undefined, { desc: { D: "4.9" }, label: "large tree", weight: 0.9 });
      } else if (f.wet.sample(x, y) > t.marsh - 0.05 && rng.chance(0.05 * (0.4 + p.water))) {
        this.point("313", x, y, 0.6, undefined, { desc: { D: "6.1" }, label: "special water feature", weight: 0.8 });
      } else if (rng.chance(0.01 * (0.5 + p.vegetation))) {
        this.point("419", x, y, 0.6, undefined, { desc: { D: "6.1" }, label: "special vegetation feature", weight: 0.7 });
      }
    });
  }
}

export function centroid(r: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const q of r) {
    x += q.x;
    y += q.y;
  }
  return { x: x / r.length, y: y / r.length };
}

/** Sub-polyline between arc lengths s0 < s1 (cum = cumulative lengths of path). */
function slicePath(path: Pt[], cum: number[], s0: number, s1: number): Pt[] {
  if (s1 <= s0) return [];
  const at = (s: number): Pt => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const a = path[i - 1];
    const b = path[i];
    const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  const out: Pt[] = [at(s0)];
  for (let i = 0; i < path.length; i++) if (cum[i] > s0 && cum[i] < s1) out.push(path[i]);
  out.push(at(s1));
  return out;
}

/** Irregular closed ring around c with mean radius r. */
export function blob(c: Pt, r: number, rng: Rng, n = 12): Pt[] {
  const ph = rng.range(0, Math.PI * 2);
  const a1 = rng.range(0.1, 0.25);
  const a2 = rng.range(0.05, 0.15);
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const rr = r * (1 + a1 * Math.sin(2 * t + ph) + a2 * Math.sin(3 * t - ph));
    pts.push({ x: c.x + Math.cos(t) * rr, y: c.y + Math.sin(t) * rr });
  }
  return chaikin(pts, true, 2);
}
