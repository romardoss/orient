/** Track and path network: least-cost routes over the terrain that merge into a network. */
import type { Pt } from "../symbols/geometry";
import { type FeatureBuilder, compass, upAngle } from "./features";
import { MinHeap } from "./heap";
import { chaikin, lineLength, simplify } from "./iso";

const NB = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export interface PathLine {
  pts: Pt[];
  code: string;
}

/** Routes tracks/paths, adds them to the builder and returns the final lines. */
export function buildPaths(b: FeatureBuilder): PathLine[] {
  const { f, p, rng } = b;
  if (p.paths <= 0.02) return [];
  const c = Math.max(8, f.height.cell * 2);
  const gx = Math.ceil(f.widthM / c) + 1;
  const gy = Math.ceil(f.heightM / c) + 1;
  const N = gx * gy;
  const t = f.thresholds;
  const streamThr = b.streamThreshold();

  // Static cost per coarse cell.
  const cost = new Float32Array(N);
  const stream = new Uint8Array(N);
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const x = i * c;
      const y = j * c;
      const k = j * gx + i;
      if (b.isLake(x, y)) {
        cost[k] = Infinity;
        continue;
      }
      const s = f.slope.sample(x, y);
      let v = 1 + 40 * s * s;
      // Rivers are crossed on bridges: allowed, but only where really needed.
      const river = b.riverAt(x, y);
      if (river) {
        cost[k] = river === 2 ? 45 : 14;
        continue;
      }
      const nearRiver = Math.max(f.riverU.sample(x, y), f.riverC.sample(x, y)) > -6;
      if (f.green.sample(x, y) > t.green1) v += 1.2;
      if (f.open.sample(x, y) > t.open) v -= 0.25;
      if (f.wet.sample(x, y) > t.marsh) v += 4;
      if (f.rock.sample(x, y) > t.rock) v += 1.5;
      const fi = Math.round(x / f.height.cell);
      const fj = Math.round(y / f.height.cell);
      if (!nearRiver && f.flowAcc[Math.min(f.height.ny - 1, fj) * f.height.nx + Math.min(f.height.nx - 1, fi)] > streamThr) {
        v += 8;
        stream[k] = 1;
      }
      cost[k] = v;
    }
  }
  const owner = new Int32Array(N).fill(-1);

  const route = (from: number, to: number): number[] | undefined => {
    const g = new Float32Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const tx = to % gx;
    const ty = Math.floor(to / gx);
    const heap = new MinHeap();
    g[from] = 0;
    heap.push(from, 0);
    while (heap.size) {
      const u = heap.pop();
      if (closed[u]) continue;
      closed[u] = 1;
      if (u === to) break;
      const ux = u % gx;
      const uy = Math.floor(u / gx);
      for (const [dx, dy] of NB) {
        const vx = ux + dx;
        const vy = uy + dy;
        if (vx < 0 || vy < 0 || vx >= gx || vy >= gy) continue;
        const v = vy * gx + vx;
        if (closed[v] || cost[v] === Infinity) continue;
        const step = (dx && dy ? Math.SQRT2 : 1) * (owner[v] >= 0 ? 0.3 : cost[v]);
        const nd = g[u] + step;
        if (nd < g[v]) {
          g[v] = nd;
          prev[v] = u;
          heap.push(v, nd + 0.3 * Math.hypot(vx - tx, vy - ty));
        }
      }
    }
    if (!closed[to]) return undefined;
    const out: number[] = [];
    for (let u = to; u >= 0; u = prev[u]) out.push(u);
    return out.reverse();
  };

  const randomBorder = (): number => {
    for (let tries = 0; tries < 50; tries++) {
      const side = rng.int(0, 3);
      const i = side < 2 ? rng.int(1, gx - 2) : side === 2 ? 0 : gx - 1;
      const j = side >= 2 ? rng.int(1, gy - 2) : side === 0 ? 0 : gy - 1;
      const k = j * gx + i;
      if (cost[k] !== Infinity) return k;
    }
    return 0;
  };
  const randomInterior = (): number => {
    for (let tries = 0; tries < 50; tries++) {
      const k = rng.int(gx + 1, N - gx - 2);
      if (cost[k] !== Infinity) return k;
    }
    return Math.floor(N / 2);
  };

  const lines: PathLine[] = [];
  const junctionEnds: Pt[] = [];
  // Main routes cross the map; the rest are mostly local paths that branch off the network
  // (reusing existing cells is cheap, so they join it and form junctions and loops).
  const areaKm2 = (f.widthM * f.heightM) / 1e6;
  const routes = 5 + Math.round(p.paths * (34 + 14 * Math.min(2, areaKm2)));
  const addRoute = (r: number, from: number, to: number, code: string) => {
    if (from === to) return;
    const cells = route(from, to);
    if (!cells || cells.length < 4) return;
    // Split into runs over cells not yet used by earlier routes; runs touching the network
    // keep the shared cell so the new path joins it.
    let run: number[] = [];
    const flush = (endsAtJunction: boolean) => {
      if (run.length >= 3) {
        const pts = run.map((k) => ({ x: (k % gx) * c, y: Math.floor(k / gx) * c }));
        lines.push({ pts, code });
        const first = run[0];
        if (owner[first] >= 0 && owner[first] !== r) junctionEnds.push(pts[0]);
        if (endsAtJunction) junctionEnds.push(pts[pts.length - 1]);
      }
      run = [];
    };
    for (let idx = 0; idx < cells.length; idx++) {
      const k = cells[idx];
      if (owner[k] >= 0 && owner[k] !== r) {
        if (run.length) {
          run.push(k);
          flush(true);
        } else {
          run = [k];
        }
      } else {
        run.push(k);
        owner[k] = r;
      }
    }
    // A run consisting only of a single shared cell is not a path.
    if (run.length > 1) flush(false);
  };
  for (let r = 0; r < routes; r++) {
    const local = r >= 4;
    const from = r < 2 || (!local && rng.chance(0.5)) || rng.chance(0.15) ? randomBorder() : randomInterior();
    const to = r === 0 ? randomBorder() : rng.chance(local ? 0.15 : 0.4) ? randomBorder() : randomInterior();
    const code =
      r === 0
        ? p.paths > 0.6 && p.manmade > 0.5 && rng.chance(0.35)
          ? rng.chance(0.3) ? "502.2" : "502"
          : p.paths > 0.5 && rng.chance(0.5)
            ? "503"
            : "504"
        : r === 1
          ? rng.pick(["503", "504", "505"])
          : local
            ? rng.weighted({ "504": 0.08, "505": 0.25, "506": 0.42, "507": 0.25 })
            : rng.weighted({ "504": 0.15, "505": 0.35, "506": 0.35, "507": 0.15 });
    addRoute(r, from, to, code);
  }

  // Paths that cross the rivers, so bridges appear on them now and then.
  let rid = routes + 1;
  for (const rv of f.rivers) {
    const n = rv.pts.length;
    if (n < 10) continue;
    const want = Math.max(1, Math.round((n * 6) / 600 * (0.5 + p.paths)));
    for (let q = 0; q < want; q++) {
      const i = rng.int(Math.floor(n * 0.1), Math.floor(n * 0.9));
      const a = rv.pts[Math.max(0, i - 1)];
      const d = rv.pts[Math.min(n - 1, i + 1)];
      const L = Math.hypot(d.x - a.x, d.y - a.y) || 1;
      const nx = -(d.y - a.y) / L;
      const ny = (d.x - a.x) / L;
      const o = rv.pts[i];
      const reach = rv.hw[i] + rng.range(70, 160);
      const p0 = { x: o.x + nx * reach, y: o.y + ny * reach };
      const p1 = { x: o.x - nx * reach, y: o.y - ny * reach };
      if (!b.inside(p0.x, p0.y, 20) || !b.inside(p1.x, p1.y, 20)) continue;
      const cell = (pt: Pt) => Math.round(pt.y / c) * gx + Math.round(pt.x / c);
      const k0 = cell(p0);
      const k1 = cell(p1);
      if (cost[k0] === Infinity || cost[k1] === Infinity || b.riverAt(p0.x, p0.y) || b.riverAt(p1.x, p1.y)) continue;
      addRoute(++rid, k0, k1, rng.weighted({ "504": 0.35, "505": 0.4, "506": 0.25 }));
    }
  }

  // Smooth, then snap junction ends onto the smoothed lines they join.
  const isJunction = (q: Pt) => junctionEnds.some((j) => j.x === q.x && j.y === q.y);
  const smooth = lines.map((l) => ({ code: l.code, pts: simplify(chaikin(l.pts, false, 3), 0.8) }));
  smooth.forEach((l, li) => {
    const raw = lines[li].pts;
    for (const [end, rawEnd] of [[0, raw[0]], [l.pts.length - 1, raw[raw.length - 1]]] as const) {
      if (!isJunction(rawEnd)) continue;
      const q = l.pts[end];
      let best: Pt | undefined;
      let bd = c * 2;
      smooth.forEach((other, oi) => {
        if (oi === li) return;
        for (const o of other.pts) {
          const d = Math.hypot(o.x - q.x, o.y - q.y);
          if (d < bd) {
            bd = d;
            best = o;
          }
        }
      });
      if (best) l.pts[end] = { x: best.x, y: best.y };
    }
  });

  for (const l of smooth) {
    if (lineLength(l.pts) < b.mm(3)) continue;
    b.line(l.code, l.pts);
    b.occ.addLine(l.pts, b.mm(0.35), b.mm(0.6));
  }

  // Stairways where footpaths climb steep slopes.
  for (const l of smooth) {
    if (!["505", "506"].includes(l.code) || lineLength(l.pts) < b.mm(6)) continue;
    const dense = densify(l.pts, 3);
    for (let i = 2; i < dense.length - 8; i++) {
      const q = dense[i];
      if (f.slope.sample(q.x, q.y) < 0.4 || f.rock.sample(q.x, q.y) > t.rock || !rng.chance(0.25)) continue;
      const run = dense.slice(i, i + Math.max(3, Math.round(b.mm(1.6) / 3)));
      b.line("532", run);
      b.site(run[0].x, run[0].y, { D: "5.24", G: "11.10" }, "stairway foot", 0.8);
      i += 40;
    }
  }

  // Junction control sites (path/track junctions), deduplicated.
  const seen: Pt[] = [];
  for (const l of smooth) {
    for (const q of [l.pts[0], l.pts[l.pts.length - 1]]) {
      const onOther = smooth.some((o) => o !== l && o.pts.some((v) => Math.hypot(v.x - q.x, v.y - q.y) < 1));
      if (!onOther || seen.some((s) => Math.hypot(s.x - q.x, s.y - q.y) < b.mm(4))) continue;
      seen.push(q);
      b.site(q.x, q.y, { D: "5.2", E: "5.2", F: "10.2" }, "path junction", 1.2);
    }
  }

  // Bridge symbols sit on the path/stream crossing, so they skip the occupancy check.
  const bridgePt = (code: string, q: Pt, angle: number) => {
    b.features.push({ kind: "point", code, x: q.x, y: q.y, angle });
    b.count(code);
  };

  // Footbridges where small paths cross streams, short bridges on tracks.
  for (const l of smooth) {
    if (lineLength(l.pts) < b.mm(3)) continue;
    const small = ["505", "506", "507"].includes(l.code);
    const tracky = ["503", "504"].includes(l.code);
    for (let i = 1; i < l.pts.length; i++) {
      const a = l.pts[i - 1];
      const q = l.pts[i];
      const k = Math.round(q.y / c) * gx + Math.round(q.x / c);
      if (!stream[k] || b.riverAt(q.x, q.y)) continue;
      if (small) {
        if (rng.chance(0.75)) {
          bridgePt("512.2", q, upAngle(q.x - a.x, q.y - a.y));
          b.site(q.x, q.y, { D: "5.4" }, "footbridge", 1);
          i += 6;
        }
      } else if (tracky && rng.chance(0.35)) {
        bridgePt("512.1", q, upAngle(q.x - a.x, q.y - a.y) + Math.PI / 2);
        b.site(q.x, q.y, { D: "5.4" }, "bridge", 1);
        i += 6;
      } else if (b.occ.free(q.x, q.y, b.mm(0.3))) {
        const d = Math.hypot(q.x - a.x, q.y - a.y) || 1;
        const half = b.mm(0.9);
        b.line("512", [
          { x: q.x - ((q.x - a.x) / d) * half, y: q.y - ((q.y - a.y) / d) * half },
          { x: q.x + ((q.x - a.x) / d) * half, y: q.y + ((q.y - a.y) / d) * half },
        ]);
        b.site(q.x + ((q.x - a.x) / d) * (half + 4), q.y + ((q.y - a.y) / d) * (half + 4), { D: "5.4" }, "bridge", 1);
        i += 6;
      }
    }
  }

  // Bridges where roads and paths cross rivers.
  for (const l of smooth) {
    if (lineLength(l.pts) < b.mm(3)) continue;
    const dense = densify(l.pts, 1.5);
    for (let i = 0; i < dense.length; i++) {
      if (!b.riverAt(dense[i].x, dense[i].y)) continue;
      let j = i;
      let kind = b.riverAt(dense[i].x, dense[i].y);
      while (j + 1 < dense.length && b.riverAt(dense[j + 1].x, dense[j + 1].y)) {
        j++;
        kind = Math.max(kind, b.riverAt(dense[j].x, dense[j].y)) as 1 | 2;
      }
      const s0 = dense[Math.max(0, i - 3)];
      const s1 = dense[Math.min(dense.length - 1, j + 3)];
      const mid = dense[Math.floor((i + j) / 2)];
      const span = Math.hypot(s1.x - s0.x, s1.y - s0.y);
      if (span < b.mm(1.6) && ["506", "507"].includes(l.code)) {
        bridgePt("512.2", mid, upAngle(s1.x - s0.x, s1.y - s0.y));
      } else {
        b.line("512", dense.slice(Math.max(0, i - 3), Math.min(dense.length, j + 4)));
      }
      b.bridges.push(mid);
      b.occ.add(mid.x, mid.y, span / 2);
      b.site(s1.x, s1.y, { D: "5.4", G: `11.8${compass(s1.x - mid.x, s1.y - mid.y)}` }, "bridge", 1.1);
      i = j + 3;
    }
  }

  return smooth;
}

export function northLines(b: FeatureBuilder): void {
  // ISOM: magnetic north lines 450 m apart in the terrain (30 mm at 1:15 000).
  const spacing = 450;
  const off = (b.f.widthM % spacing) / 2;
  for (let x = off; x <= b.f.widthM; x += spacing) {
    b.features.push({ kind: "line", code: "601.1", pts: [{ x, y: -5 }, { x, y: b.f.heightM + 5 }] });
  }
}


/** Inserts points so that no segment is longer than `step`. */
export function densify(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let t = 1; t <= n; t++) out.push({ x: a.x + ((b.x - a.x) * t) / n, y: a.y + ((b.y - a.y) * t) / n });
  }
  return out;
}
