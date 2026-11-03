/**
 * Builds the playable world from a generated orienteering MapModel: every ISOM feature is
 * rasterised into a 1 m grid of ground types, vegetation density, objects and collision.
 */
import type { Pt } from "../../src/symbols/geometry";
import type { Course, MapModel } from "../../src/generator/model";
import tilesMeta from "../assets/tiles.json";

/** Ground type ids = rows of assets/tiles.png. */
export const GROUND_NAMES: readonly string[] = tilesMeta.names;
const G = Object.fromEntries(GROUND_NAMES.map((n, i) => [n, i])) as Record<string, number>;
export { G as GROUND };

/** Object ids. Trees are drawn per frame (canopies over the player), everything else is baked into the ground. */
export const enum Obj {
  None = 0,
  Tree1,
  Tree2,
  Tree3,
  Bush,
  Boulder,
  BoulderBig,
  Fern,
  Reeds,
  Stones,
  Pit,
  Well,
  Cairn,
  Rack,
  Spring,
  Knoll,
  Tower,
}
export const isTree = (o: number) => o >= Obj.Tree1 && o <= Obj.Tree3;

export interface HeightGrid {
  nx: number;
  ny: number;
  cell: number;
  data: Float32Array;
}

export interface World {
  w: number;
  h: number;
  ground: Uint8Array;
  /** Green vegetation 0..3 (406 / 408 / 410). */
  veg: Uint8Array;
  obj: Uint8Array;
  solid: Uint8Array;
  /** Hill shading incl. cast shadows, -100..100 (low sun in the north-west). */
  shade: Int8Array;
  height: HeightGrid;
  course: Course;
}

/** Sun elevation for cast shadows: tan(≈12°) — low sun, long shadows behind hills. */
const SUN_TAN = 0.21;
/** How much a cast shadow darkens (on the −100..100 shade scale). */
const SHADOW_DARK = 48;

/** Ground speed factors (1 = open land). */
export const GROUND_SPEED: Record<string, number> = {
  forest: 0.85,
  open: 1,
  rough: 0.9,
  marsh: 0.7,
  shallow: 0.4,
  deep: 0,
  stream: 0.5,
  path: 1.04,
  track: 1.1,
  road: 1.16,
  ride: 0.92,
  paved: 1.12,
  stony: 0.72,
  sand: 0.8,
  barerock: 0.9,
  broken: 0.75,
  cultivated: 0.85,
  earthbank: 0.7,
  gully: 0.65,
  wall: 0,
  fence: 0,
  ruin: 0.6,
  rail: 1,
  bridge: 1.04,
  building: 0,
  cliff: 0,
  restricted: 0,
  bigrock: 0,
  deepmarsh: 0,
};
export const VEG_SPEED = [1, 0.8, 0.62, 0.45];

const SOLID_GROUND = new Set(["deep", "building", "cliff", "restricted", "bigrock", "deepmarsh", "wall", "fence"].map((n) => G[n]));

const F_SCATTER_TREES = 1;
const F_SCATTER_BUSHES = 2;
const F_ORCHARD = 4;
const F_VINEYARD = 8;
const F_CLEAR = 16;

// ---------------------------------------------------------------- feature tables
type AreaRule = { rank: number; ground?: string; veg?: number; flag?: number; boulders?: number };
const AREA: Record<string, AreaRule> = {
  "401": { rank: 1, ground: "open" },
  "402": { rank: 1, ground: "open", flag: F_SCATTER_TREES },
  "402.1": { rank: 1, ground: "open", flag: F_SCATTER_BUSHES },
  "403": { rank: 1, ground: "rough" },
  "404": { rank: 1, ground: "rough", flag: F_SCATTER_TREES },
  "404.1": { rank: 1, ground: "rough", flag: F_SCATTER_BUSHES },
  "412": { rank: 1, ground: "cultivated" },
  "412.1": { rank: 1, ground: "cultivated" },
  "413": { rank: 1, ground: "open", flag: F_ORCHARD },
  "413.1": { rank: 1, ground: "rough", flag: F_ORCHARD },
  "414": { rank: 1, ground: "open", flag: F_VINEYARD },
  "414.1": { rank: 1, ground: "rough", flag: F_VINEYARD },
  "213": { rank: 1, ground: "sand" },
  "113": { rank: 2, ground: "broken" },
  "114": { rank: 2, ground: "broken" },
  "210": { rank: 2, ground: "stony" },
  "211": { rank: 2, ground: "stony", boulders: 0.01 },
  "212": { rank: 2, ground: "stony", boulders: 0.025 },
  "214": { rank: 2, ground: "barerock" },
  "208": { rank: 2, ground: "stony", boulders: 0.06 },
  "209": { rank: 2, ground: "stony", boulders: 0.14 },
  "310": { rank: 3, ground: "marsh" },
  "308": { rank: 3, ground: "marsh" },
  "307": { rank: 3, ground: "deepmarsh" },
  "501": { rank: 4, ground: "paved" },
  "501.1": { rank: 4, ground: "paved" },
  "522": { rank: 4, ground: "paved" },
  "302": { rank: 5, ground: "shallow" },
  "302.1": { rank: 5, ground: "shallow" },
  "302.5": { rank: 5, ground: "shallow" },
  "301.1": { rank: 6, ground: "deep" },
  "206": { rank: 7, ground: "bigrock" },
  "520": { rank: 7, ground: "restricted" },
  "520.2": { rank: 7, ground: "restricted" },
  "521": { rank: 7, ground: "building" },
  "521.3": { rank: 7, ground: "building" },
  "406": { rank: 0, veg: 1 },
  "406.1": { rank: 0, veg: 1 },
  "407": { rank: 0, veg: 1 },
  "408": { rank: 0, veg: 2 },
  "408.1": { rank: 0, veg: 2 },
  "408.2": { rank: 0, veg: 2 },
  "409": { rank: 0, veg: 2 },
  "410": { rank: 0, veg: 3 },
  "410.1": { rank: 0, veg: 3 },
  "410.2": { rank: 0, veg: 3 },
  "410.3": { rank: 0, veg: 3 },
};

/** rank: 10 earth/water lines, 11 barriers, 12 paths (cut through barriers = gates), 13 bridges. */
type LineRule = { rank: number; ground?: string; veg?: number; width: number; gates?: boolean };
const LINE: Record<string, LineRule> = {
  "104": { rank: 10, ground: "earthbank", width: 1 },
  "105": { rank: 10, ground: "earthbank", width: 1.5 },
  "106": { rank: 10, ground: "earthbank", width: 1 },
  "107": { rank: 10, ground: "gully", width: 2 },
  "108": { rank: 10, ground: "gully", width: 1 },
  "215": { rank: 10, ground: "gully", width: 1.5 },
  "304": { rank: 10, ground: "stream", width: 2.5 },
  "305": { rank: 10, ground: "stream", width: 1.5 },
  "306": { rank: 10, ground: "stream", width: 1 },
  "309": { rank: 10, ground: "marsh", width: 2.5 },
  "410.4": { rank: 10, veg: 3, width: 2 },
  "201": { rank: 11, ground: "cliff", width: 2 },
  "202": { rank: 11, ground: "cliff", width: 1.2 },
  "202.2": { rank: 11, ground: "cliff", width: 1.2 },
  "513": { rank: 11, ground: "wall", width: 1, gates: true },
  "515": { rank: 11, ground: "wall", width: 1.2 },
  "516": { rank: 11, ground: "fence", width: 1, gates: true },
  "518": { rank: 11, ground: "fence", width: 1 },
  "529": { rank: 11, ground: "wall", width: 1.2 },
  "514": { rank: 11, ground: "ruin", width: 1 },
  "517": { rank: 11, ground: "ruin", width: 1 },
  "523": { rank: 11, ground: "ruin", width: 1 },
  "528": { rank: 11, ground: "ruin", width: 1 },
  "502": { rank: 12, ground: "road", width: 6 },
  "502.2": { rank: 12, ground: "road", width: 8 },
  "503": { rank: 12, ground: "road", width: 4 },
  "504": { rank: 12, ground: "track", width: 3 },
  "505": { rank: 12, ground: "path", width: 2 },
  "506": { rank: 12, ground: "path", width: 1.3 },
  "507": { rank: 12, ground: "path", width: 1 },
  "508": { rank: 12, ground: "ride", width: 2 },
  "508.1": { rank: 12, ground: "ride", width: 2 },
  "508.2": { rank: 12, ground: "ride", width: 2 },
  "508.3": { rank: 12, ground: "ride", width: 2 },
  "508.4": { rank: 12, ground: "ride", width: 2 },
  "509": { rank: 12, ground: "rail", width: 3 },
  "532": { rank: 12, ground: "path", width: 2 },
  "512": { rank: 13, ground: "bridge", width: 3.5 },
};
const GATE_EVERY = 45;
const GATE_WIDTH = 2.5;

// ---------------------------------------------------------------- helpers
function hash(i: number, j: number, salt: number): number {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(salt, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Even-odd scanline fill over all rings; calls fn for every cell whose centre is inside. */
function fillRings(rings: Pt[][], w: number, h: number, fn: (i: number, j: number) => void) {
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const r of rings) for (const q of r) (y0 = Math.min(y0, q.y)), (y1 = Math.max(y1, q.y));
  const j0 = Math.max(0, Math.floor(y0));
  const j1 = Math.min(h - 1, Math.ceil(y1));
  if (j1 < j0) return;
  const rows: number[][] = Array.from({ length: j1 - j0 + 1 }, () => []);
  for (const r of rings) {
    for (let k = 0; k < r.length; k++) {
      const a = r[k];
      const b = r[(k + 1) % r.length];
      if (a.y === b.y) continue;
      const lo = Math.max(j0, Math.ceil(Math.min(a.y, b.y) - 0.5));
      const hi = Math.min(j1, Math.ceil(Math.max(a.y, b.y) - 0.5) - 1);
      for (let j = lo; j <= hi; j++) {
        const yc = j + 0.5;
        rows[j - j0].push(a.x + ((yc - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    }
  }
  rows.forEach((xs, n) => {
    if (xs.length < 2) return;
    xs.sort((p, q) => p - q);
    const j = n + j0;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const i1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let i = i0; i <= i1; i++) fn(i, j);
    }
  });
}

function disk(x: number, y: number, r: number, w: number, h: number, fn: (i: number, j: number) => void) {
  if (r <= 0.5) {
    const i = Math.floor(x);
    const j = Math.floor(y);
    if (i >= 0 && j >= 0 && i < w && j < h) fn(i, j);
    return;
  }
  for (let j = Math.max(0, Math.floor(y - r)); j <= Math.min(h - 1, Math.floor(y + r)); j++)
    for (let i = Math.max(0, Math.floor(x - r)); i <= Math.min(w - 1, Math.floor(x + r)); i++)
      if ((i + 0.5 - x) ** 2 + (j + 0.5 - y) ** 2 <= r * r) fn(i, j);
}

/** Stamps a polyline; `gap(d)` (distance along the line) can leave openings. */
function stampLine(pts: Pt[], width: number, w: number, h: number, fn: (i: number, j: number, gap: boolean) => void, gaps = false) {
  let along = 0;
  const r = width / 2;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / 0.35));
    for (let s = 0; s <= n; s++) {
      const d = along + (len * s) / n;
      const gap = gaps && d % GATE_EVERY > GATE_EVERY - GATE_WIDTH;
      const x = a.x + ((b.x - a.x) * s) / n;
      const y = a.y + ((b.y - a.y) * s) / n;
      disk(x, y, r, w, h, (i, j) => fn(i, j, gap));
    }
    along += len;
  }
}

// ---------------------------------------------------------------- build
export function buildWorld(model: MapModel, height: HeightGrid): World {
  if (!model.course) throw new Error("Карта без дистанції");
  const w = Math.ceil(model.widthM);
  const h = Math.ceil(model.heightM);
  const N = w * h;
  const ground = new Uint8Array(N).fill(G.forest);
  const veg = new Uint8Array(N);
  const obj = new Uint8Array(N);
  const solid = new Uint8Array(N);
  const flags = new Uint8Array(N);
  const boulderP = new Float32Array(N);

  // Areas, lines and points in layer order.
  type Job = { rank: number; run: () => void };
  const jobs: Job[] = [];
  for (const f of model.features) {
    if (f.kind === "area") {
      const r = AREA[f.code];
      if (!r) continue;
      jobs.push({
        rank: r.rank,
        run: () =>
          fillRings(f.rings, w, h, (i, j) => {
            const k = j * w + i;
            if (r.veg) veg[k] = Math.max(veg[k], r.veg);
            if (r.ground) {
              ground[k] = G[r.ground];
              flags[k] = (flags[k] & ~(F_SCATTER_TREES | F_SCATTER_BUSHES | F_ORCHARD | F_VINEYARD)) | (r.flag ?? 0);
              boulderP[k] = r.boulders ?? 0;
            }
          }),
      });
    } else if (f.kind === "line") {
      const r = LINE[f.code];
      if (!r) continue;
      const pts = f.closed ? [...f.pts, f.pts[0]] : f.pts;
      jobs.push({
        rank: r.rank,
        run: () =>
          stampLine(
            pts,
            r.width,
            w,
            h,
            (i, j, gap) => {
              const k = j * w + i;
              if (r.veg) veg[k] = Math.max(veg[k], r.veg);
              if (!r.ground) return;
              if (gap) {
                // a gate: trodden ground through the barrier
                if (SOLID_GROUND.has(ground[k])) ground[k] = G.path;
                return;
              }
              ground[k] = G[r.ground];
              if (r.rank >= 12) veg[k] = 0;
            },
            r.gates,
          ),
      });
    } else if (f.kind === "point") {
      jobs.push({ rank: 20, run: () => point(f.code, f.x, f.y) });
    }
  }
  const ex = model.course.extras;
  if (ex) {
    for (const ring of ex.oobAreas) jobs.push({ rank: 7.5, run: () => fillRings([ring], w, h, (i, j) => (ground[j * w + i] = G.restricted)) });
    for (const l of ex.oobLines) jobs.push({ rank: 11, run: () => stampLine(l, 1, w, h, (i, j) => (ground[j * w + i] = G.fence)) });
    for (const c of ex.crossings) jobs.push({ rank: 12.5, run: () => disk(c.x, c.y, 2, w, h, (i, j) => (ground[j * w + i] = G.path)) });
  }
  jobs.sort((a, b) => a.rank - b.rank);

  const at = (x: number, y: number) => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    return i >= 0 && j >= 0 && i < w && j < h ? j * w + i : -1;
  };
  const setObj = (x: number, y: number, o: Obj, isSolid: boolean) => {
    const k = at(x, y);
    if (k < 0) return;
    obj[k] = o;
    if (isSolid) solid[k] = 1;
  };
  function point(code: string, x: number, y: number) {
    switch (code) {
      case "204":
      case "208.1":
      case "208.2":
        setObj(x, y, Obj.Boulder, true);
        break;
      case "205":
        setObj(x, y, Obj.BoulderBig, true);
        disk(x, y, 1, w, h, (i, j) => (solid[j * w + i] = 1));
        break;
      case "207":
      case "207.1":
        for (let n = 0; n < (code === "207" ? 3 : 5); n++) {
          const a = n * 2.1 + x;
          setObj(x + Math.cos(a) * 1.6, y + Math.sin(a) * 1.6, Obj.Boulder, true);
        }
        break;
      case "109":
      case "110":
      case "115":
        setObj(x, y, Obj.Knoll, false);
        break;
      case "111":
      case "112":
      case "203.1":
      case "203.2":
        setObj(x, y, Obj.Pit, false);
        break;
      case "303":
      case "313":
      case "302.5":
        disk(x, y, 1.5, w, h, (i, j) => (ground[j * w + i] = G.shallow));
        break;
      case "308.1":
      case "310.1":
        disk(x, y, 3, w, h, (i, j) => (ground[j * w + i] = G.marsh));
        break;
      case "311":
        setObj(x, y, Obj.Well, true);
        break;
      case "312":
        setObj(x, y, Obj.Spring, false);
        break;
      case "417":
        setObj(x, y, Obj.Tree1, true);
        break;
      case "418":
      case "419":
        setObj(x, y, Obj.Tree3, true);
        break;
      case "521.1":
        for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
          const k = at(x + i, y + j);
          if (k >= 0) ground[k] = G.building;
        }
        break;
      case "523.1":
        disk(x, y, 1.6, w, h, (i, j) => (ground[j * w + i] = G.ruin));
        break;
      case "524":
      case "525":
        setObj(x, y, Obj.Tower, true);
        disk(x, y, 1, w, h, (i, j) => (solid[j * w + i] = 1));
        break;
      case "526":
      case "530":
      case "531":
        setObj(x, y, Obj.Cairn, true);
        break;
      case "527":
        setObj(x, y, Obj.Rack, true);
        break;
      case "512.1":
      case "512.2":
        disk(x, y, 2, w, h, (i, j) => (ground[j * w + i] = G.bridge));
        break;
      case "210.1":
        setObj(x, y, Obj.Stones, false);
        break;
    }
  }
  for (const j of jobs) j.run();

  // Clear zones around start, controls and finish (feature objects there stay).
  const c = model.course;
  const marks = [c.start, ...c.controls, c.finish];
  marks.forEach((q, n) => {
    // start and finish must be standable; a control may sit on its boulder (punch radius reaches it)
    const hard = n === 0 || n === marks.length - 1;
    disk(q.x, q.y, 2.5, w, h, (i, j) => {
      const k = j * w + i;
      flags[k] |= F_CLEAR;
      if (Math.hypot(i + 0.5 - q.x, j + 0.5 - q.y) > (hard ? 1.6 : 1.2)) return;
      if (SOLID_GROUND.has(ground[k])) ground[k] = G.path;
      if (hard) solid[k] = obj[k] = 0;
    });
  });

  // Scatter trees, bushes, boulders and ground decoration.
  const treeAt = (i: number, j: number) => i >= 0 && j >= 0 && i < w && isTree(obj[j * w + i]);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const g = ground[k];
      if (SOLID_GROUND.has(g)) {
        solid[k] = 1;
        continue;
      }
      if (obj[k]) continue;
      const fl = flags[k];
      const clear = (fl & F_CLEAR) !== 0;
      const v = veg[k];
      const r1 = hash(i, j, 1);
      const r2 = hash(i, j, 2);
      let treeP = 0;
      let bushP = 0;
      if (g === G.forest || g === G.broken) treeP = 0.034;
      else if (g === G.marsh) treeP = 0.006;
      else if (g === G.stony) treeP = 0.012;
      else if (g === G.barerock) treeP = 0.004;
      if (fl & F_SCATTER_TREES) treeP = 0.009;
      if (fl & F_SCATTER_BUSHES) bushP = 0.025;
      const lineGround = g === G.path || g === G.track || g === G.road || g === G.ride || g === G.rail || g === G.bridge || g === G.stream || g === G.paved;
      if (lineGround || g === G.wall || g === G.fence || g === G.ruin) treeP = bushP = 0;
      else bushP = Math.max(bushP, [0, 0.035, 0.08, 0.16][v]);
      if (fl & F_ORCHARD) treeP = i % 7 === 3 && j % 7 === 3 ? 1 : 0;
      if (fl & F_VINEYARD) bushP = j % 3 === 0 && i % 9 !== 0 ? 1 : 0;

      if (!clear && r1 < treeP && !treeAt(i - 1, j) && !treeAt(i - 1, j - 1) && !treeAt(i, j - 1) && !treeAt(i + 1, j - 1) && !treeAt(i - 2, j) && !treeAt(i, j - 2)) {
        obj[k] = [Obj.Tree1, Obj.Tree2, Obj.Tree3][Math.floor(r2 * 3)];
        solid[k] = 1;
      } else if (!clear && r2 < bushP) {
        obj[k] = Obj.Bush;
        solid[k] = 1;
      } else if (!clear && r2 > 1 - boulderP[k]) {
        obj[k] = Obj.Boulder;
        solid[k] = 1;
      } else if (lineGround) {
        // nothing
      } else if (g === G.marsh && r1 > 0.86) obj[k] = Obj.Reeds;
      else if ((g === G.stony || g === G.ruin) && r1 > 0.88) obj[k] = Obj.Stones;
      else if ((g === G.forest || g === G.broken) && r1 > 1 - (0.025 + 0.06 * v)) obj[k] = Obj.Fern;
    }
  }

  // Hill shading from the terrain height field.
  const hs = new Float32Array(N);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) hs[j * w + i] = heightAt(height, i + 0.5, j + 0.5);
  // Cast shadows: a low sun in the north-west. The sun ray runs along the (+1, +1) diagonal, so the
  // horizon can be propagated cell by cell: H = max(height, H) of the NW neighbour, minus the drop
  // of the ray over one diagonal step. A cell lies in shadow where that horizon is above it.
  const drop = Math.SQRT2 * SUN_TAN;
  const horizon = new Float32Array(N).fill(-Infinity);
  const shadow = new Float32Array(N);
  for (let j = 1; j < h; j++) {
    for (let i = 1; i < w; i++) {
      const k = j * w + i;
      const nw = k - w - 1;
      const hz = Math.max(hs[nw], horizon[nw]) - drop;
      horizon[k] = hz;
      // soft-ish edge: full shadow 1.2 m below the horizon
      shadow[k] = Math.max(0, Math.min(1, (hz - hs[k]) / 1.2));
    }
  }
  const shade = new Int8Array(N);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const gx = (hs[j * w + Math.min(w - 1, i + 2)] - hs[j * w + Math.max(0, i - 2)]) / 4;
      const gy = (hs[Math.min(h - 1, j + 2) * w + i] - hs[Math.max(0, j - 2) * w + i]) / 4;
      const lit = -(gx + gy) * 250;
      shade[j * w + i] = Math.max(-100, Math.min(100, Math.round(lit - shadow[j * w + i] * SHADOW_DARK)));
    }
  }

  return { w, h, ground, veg, obj, solid, shade, height, course: c };
}

/** Terrain height at world coordinates (bilinear). */
export function heightAt(g: HeightGrid, x: number, y: number): number {
  const fx = x / g.cell;
  const fy = y / g.cell;
  const i = Math.max(0, Math.min(g.nx - 2, Math.floor(fx)));
  const j = Math.max(0, Math.min(g.ny - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - i));
  const ty = Math.max(0, Math.min(1, fy - j));
  const d = g.data;
  const a = d[j * g.nx + i];
  const b = d[j * g.nx + i + 1];
  const c = d[(j + 1) * g.nx + i];
  const e = d[(j + 1) * g.nx + i + 1];
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + e) * tx * ty;
}
