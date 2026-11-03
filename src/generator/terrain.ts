/** Continuous terrain fields (height, rock, vegetation, wetness, drainage) on a regular grid. */
import { Grid } from "./grid";
import { MinHeap } from "./heap";
import { Noise } from "./noise";
import type { MapParams } from "./params";
import { type River, buildRivers } from "./river";
import type { Rng } from "./rng";

export interface Fields {
  widthM: number;
  heightM: number;
  height: Grid;
  slope: Grid;
  /** Rockiness, roughly [-1, 1]. */
  rock: Grid;
  /** Openness, roughly [-1, 1]. */
  open: Grid;
  /** Green vegetation density, roughly [-1, 1]. */
  green: Grid;
  /** Undergrowth density, roughly [-1, 1]. */
  under: Grid;
  /** Wetness (drainage + moisture). */
  wet: Grid;
  /** Small-scale bumps used for knolls/depressions, roughly [-1, 1]. */
  bumps: Grid;
  /** Depth of closed depressions (filled surface minus terrain), metres. */
  basinDepth: Grid;
  /** Positive inside lakes and ponds (metres of depth, roughly). */
  lake: Grid;
  /** Positive inside any water: lakes, ponds and rivers. */
  water: Grid;
  /** Positive inside uncrossable / crossable rivers (half width minus distance to the centre line). */
  riverU: Grid;
  riverC: Grid;
  /** 1 on river floodplains, fading out up the valley sides. */
  flood: Grid;
  rivers: River[];
  /** Downstream neighbour index per cell, or -1 for sinks/borders. */
  flowTo: Int32Array;
  /** Number of upstream cells (including itself). */
  flowAcc: Float32Array;
  waterLevel: number;
  /** Threshold values for the area classes, computed from coverage quantiles. */
  thresholds: {
    open: number;
    openFull: number;
    green1: number;
    green2: number;
    green3: number;
    under: number;
    rock: number;
    marsh: number;
    marshIndistinct: number;
  };
}

/** Picks a grid resolution that keeps the grid around 300k cells. */
export function cellSize(widthM: number, heightM: number): number {
  return Math.max(4, Math.sqrt((widthM * heightM) / 300_000));
}

export function buildFields(p: MapParams, widthM: number, heightM: number, rng: Rng): Fields {
  const cell = cellSize(widthM, heightM);
  const nx = Math.ceil(widthM / cell) + 1;
  const ny = Math.ceil(heightM / cell) + 1;
  const n = (label: string) => new Noise(rng.fork(label));
  const warpN = n("warp");
  const baseN = n("base");
  const ridgeN = n("ridge");
  const detailN = n("detail");
  const bumpN = n("bumps");

  // --- height
  const relief = p.relief;
  const roughness = 0.4 + p.detail;
  const height = new Grid(nx, ny, cell).fill((x, y) => {
    const wx = warpN.fbm(x / 900, y / 900, 3) * 260;
    const wy = warpN.fbm(x / 900 + 50, y / 900 - 30, 3) * 260;
    const base = baseN.fbm((x + wx) / 750, (y + wy) / 750, 5, 2, 0.5);
    const ridge = ridgeN.ridged((x + wy) / 1300, (y + wx) / 1300, 4);
    const detail = detailN.fbm(x / 140, y / 140, 3);
    return 150 + relief * (0.85 * base + 0.55 * (ridge - 0.5)) + detail * (0.7 + relief * 0.016) * roughness;
  });
  const bumps = new Grid(nx, ny, cell).fill((x, y) => bumpN.fbm(x / 38, y / 38, 2));
  // Lakes are placed on the terrain before the river valleys are carved into it.
  const heightOrig = Grid.like(height);
  heightOrig.data.set(height.data);
  const rv = buildRivers(p, height, widthM, heightM, rng.fork("river"));

  const slope = Grid.like(height).fill((_x, _y, i, j) => {
    const gx = (height.get(i + 1, j) - height.get(i - 1, j)) / (2 * cell);
    const gy = (height.get(i, j + 1) - height.get(i, j - 1)) / (2 * cell);
    return Math.hypot(gx, gy);
  });

  // --- depression filling (priority flood), so that water always drains to the map edge
  const N = nx * ny;
  const filled = Float32Array.from(height.data);
  {
    const done = new Uint8Array(N);
    const heap = new MinHeap();
    for (let i = 0; i < nx; i++) {
      for (const j of [0, ny - 1]) {
        const k = j * nx + i;
        if (!done[k]) {
          done[k] = 1;
          heap.push(k, filled[k]);
        }
      }
    }
    for (let j = 0; j < ny; j++) {
      for (const i of [0, nx - 1]) {
        const k = j * nx + i;
        if (!done[k]) {
          done[k] = 1;
          heap.push(k, filled[k]);
        }
      }
    }
    while (heap.size) {
      const c = heap.pop();
      const ci = c % nx;
      const cj = (c - ci) / nx;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = ci + di;
          const jj = cj + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const n = jj * nx + ii;
          if (done[n]) continue;
          done[n] = 1;
          // Tiny gradient across filled flats keeps flow directions defined.
          if (filled[n] <= filled[c]) filled[n] = filled[c] + 1e-3;
          heap.push(n, filled[n]);
        }
      }
    }
  }

  // --- drainage (D8 steepest descent on the filled surface, accumulation from high to low)
  const flowTo = new Int32Array(N).fill(-1);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const h = filled[k];
      let best = 0;
      let to = -1;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const drop = (h - filled[jj * nx + ii]) / (di && dj ? Math.SQRT2 : 1);
          if (drop > best) {
            best = drop;
            to = jj * nx + ii;
          }
        }
      }
      flowTo[k] = to;
    }
  }
  const order = Array.from({ length: N }, (_, k) => k).sort((a, b) => filled[b] - filled[a]);
  const flowAcc = new Float32Array(N).fill(1);
  for (const k of order) if (flowTo[k] >= 0) flowAcc[flowTo[k]] += flowAcc[k];

  // --- water: the lowest share of the terrain, plus ponds in deep enough closed basins
  const lakeShare = p.water * 0.04;
  const waterLevel = lakeShare > 0.002 ? heightOrig.quantile(lakeShare) : -Infinity;
  // Ponds: the deepest closed basins hold water up to about half of their depth,
  // until the pond area reaches a share of the map controlled by the water parameter.
  const minPondDepth = 4.5 - 2.5 * p.water;
  const pondBudget = N * p.water * 0.03;
  const lake = Grid.like(height);
  for (let k = 0; k < N; k++) lake.data[k] = Number.isFinite(waterLevel) ? waterLevel - heightOrig.data[k] : -100;
  if (p.water > 0.05) {
    const depth = (k: number) => filled[k] - height.data[k];
    const seen = new Uint8Array(N);
    const basins: { cells: number[]; maxD: number }[] = [];
    const stack: number[] = [];
    for (let s = 0; s < N; s++) {
      if (seen[s] || depth(s) < 0.05) continue;
      const cells: number[] = [];
      let maxD = 0;
      stack.push(s);
      seen[s] = 1;
      while (stack.length) {
        const c = stack.pop()!;
        cells.push(c);
        maxD = Math.max(maxD, depth(c));
        const ci = c % nx;
        const cj = (c - ci) / nx;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = ci + di;
          const jj = cj + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const n = jj * nx + ii;
          if (!seen[n] && depth(n) >= 0.05) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
      if (maxD >= minPondDepth) basins.push({ cells, maxD });
    }
    basins.sort((a, b) => b.maxD - a.maxD);
    let used = 0;
    for (const b of basins) {
      const surface = b.maxD * 0.5;
      const wet = b.cells.filter((c) => depth(c) > surface);
      if (used + wet.length > pondBudget) continue;
      used += wet.length;
      for (const c of wet) lake.data[c] = Math.max(lake.data[c], depth(c) - surface);
    }
  }

  const water = Grid.like(height);
  for (let k = 0; k < N; k++) water.data[k] = Math.max(lake.data[k], rv.riverU.data[k], rv.riverC.data[k]);
  // Shores of lakes and rivers are wetter.
  const shore = Grid.like(height);
  for (let k = 0; k < N; k++) shore.data[k] = water.data[k] > 0 ? 1 : 0;
  const nearWater = shore.blur(Math.max(2, Math.round(25 / cell)), 2);

  // --- moisture / wetness
  const moistN = n("moist");
  const accLog = Grid.like(height);
  for (let k = 0; k < N; k++) accLog.data[k] = Math.log1p(flowAcc[k]);
  const accSmooth = accLog.blur(2, 2);
  const maxLog = Math.log1p(N);
  const wet = Grid.like(height).fill((x, y, i, j) => {
    const k = j * nx + i;
    return (
      (accSmooth.data[k] / maxLog) * 1.6 +
      moistN.fbm(x / 500, y / 500, 4) * 0.55 -
      Math.min(1, slope.data[k] * 6) * 0.9 +
      rv.flood.data[k] * (0.35 + 0.3 * moistN.fbm(x / 120 + 7, y / 120, 2)) +
      nearWater.data[k] * 0.6
    );
  });

  // --- vegetation and rock
  const openN = n("open");
  const greenN = n("green");
  const underN = n("under");
  const rockN = n("rock");
  // River meadows: floodplains are often open.
  const open = Grid.like(height).fill(
    (x, y, i, j) =>
      openN.fbm(x / 650, y / 650, 4) +
      0.25 * openN.fbm(x / 160 + 9, y / 160 - 4, 2) +
      rv.flood.data[j * nx + i] * 0.6 * Math.max(0, openN.fbm(x / 220 - 31, y / 220 + 5, 2) + 0.2),
  );
  const green = Grid.like(height).fill((x, y) => greenN.fbm(x / 320, y / 320, 4) + 0.35 * greenN.fbm(x / 90 - 7, y / 90 + 3, 2));
  const under = Grid.like(height).fill((x, y) => underN.fbm(x / 260, y / 260, 3));
  const rock = Grid.like(height).fill((x, y, i, j) => {
    const r = rockN.fbm(x / 420, y / 420, 4) + 0.3 * rockN.fbm(x / 110, y / 110, 2);
    // Rock shows up more on steep ground and hill tops.
    return r + Math.min(0.35, slope.data[j * nx + i] * 0.8) + rv.rockBoost.data[j * nx + i] * 0.55;
  });

  const thresholds = {
    open: open.quantile(1 - (0.03 + 0.3 * p.open)),
    openFull: open.quantile(1 - (0.015 + 0.17 * p.open)),
    green1: green.quantile(1 - (0.06 + 0.3 * p.vegetation)),
    green2: green.quantile(1 - (0.025 + 0.13 * p.vegetation)),
    green3: green.quantile(1 - (0.008 + 0.045 * p.vegetation)),
    under: under.quantile(1 - 0.05 * p.vegetation),
    rock: rock.quantile(1 - (0.02 + 0.3 * p.rock)),
    marsh: wet.quantile(1 - (0.01 + 0.1 * p.water)),
    marshIndistinct: wet.quantile(1 - (0.025 + 0.16 * p.water)),
  };

  const basinDepth = Grid.like(height);
  for (let k = 0; k < N; k++) basinDepth.data[k] = filled[k] - height.data[k];

  return {
    widthM,
    heightM,
    height,
    slope,
    rock,
    open,
    green,
    under,
    wet,
    bumps,
    lake,
    water,
    riverU: rv.riverU,
    riverC: rv.riverC,
    flood: rv.flood,
    rivers: rv.rivers,
    basinDepth,
    flowTo,
    flowAcc,
    waterLevel,
    thresholds,
  };
}

/** Builds a derived grid by evaluating fn for every cell index. */
export function derive(f: Fields, fn: (k: number, x: number, y: number) => number): Grid {
  const g = Grid.like(f.height);
  const { nx, ny, cell } = g;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) g.data[j * nx + i] = fn(j * nx + i, i * cell, j * cell);
  return g;
}
