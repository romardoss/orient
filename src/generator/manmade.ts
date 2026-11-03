/**
 * Man-made features: farmsteads with buildings, yards, gardens, orchards and fields; forest huts,
 * ruins, high seats, fences, enclosures, stone walls, forest rides and power lines.
 */
import type { Pt } from "../symbols/geometry";
import { type FeatureBuilder, blob, centroid, compass, upAngle } from "./features";
import { lineLength, pointInRing, ringArea, simplify, splitWhere } from "./iso";
import type { ControlDesc } from "./model";
import { type PathLine, densify } from "./paths";

/** Oriented local frame: u along the access path, v away from it. */
interface Frame {
  o: Pt;
  u: Pt;
  v: Pt;
}

const at = (F: Frame, a: number, b: number): Pt => ({ x: F.o.x + F.u.x * a + F.v.x * b, y: F.o.y + F.u.y * a + F.v.y * b });
const rect = (F: Frame, a0: number, a1: number, b0: number, b1: number): Pt[] => [at(F, a0, b0), at(F, a1, b0), at(F, a1, b1), at(F, a0, b1)];

function segIntersection(a: Pt, b: Pt, c: Pt, d: Pt): Pt | undefined {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return undefined;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return undefined;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

export function manMade(b: FeatureBuilder, paths: PathLine[]): void {
  const { f, p, rng } = b;
  const M = p.manmade;
  const t = f.thresholds;
  const areaFactor = (f.widthM * f.heightM) / 6e6;
  const amount = (perMap: number) => {
    const v = perMap * areaFactor;
    return Math.floor(v) + (rng.chance(v - Math.floor(v)) ? 1 : 0);
  };
  /** Not in water and at least `margin` metres from it (lakes, ponds and rivers). */
  const dry = (q: Pt, margin = 6) =>
    !b.inLake(q.x, q.y) &&
    !b.inLake(q.x + margin, q.y) &&
    !b.inLake(q.x - margin, q.y) &&
    !b.inLake(q.x, q.y + margin) &&
    !b.inLake(q.x, q.y - margin);
  const isOpen = (q: Pt) => f.open.sample(q.x, q.y) > t.open;
  /** Every point along the closed outline is inside the map and away from water. */
  const allIn = (pts: Pt[], margin = 0) => densify([...pts, pts[0]], 6).every((q) => b.inside(q.x, q.y, margin) && dry(q));
  /** Fences, walls etc. that paths may need crossing points on. */
  const barriers: { pts: Pt[]; code: string }[] = [];
  const settlements: Pt[] = [];

  const building = (ring: Pt[], F: Frame, site?: { label: string; weight: number }) => {
    const c = centroid(ring);
    const w = Math.hypot(ring[1].x - ring[0].x, ring[1].y - ring[0].y);
    const h = Math.hypot(ring[2].x - ring[1].x, ring[2].y - ring[1].y);
    if (Math.min(w, h) < b.mm(0.5)) {
      // Too small to draw to scale: minimum-size building symbol.
      b.features.push({ kind: "point", code: "521.1", x: c.x, y: c.y, angle: Math.atan2(F.u.y, F.u.x) });
      b.count("521.1");
    } else {
      b.area("521", [ring]);
    }
    b.occ.add(c.x, c.y, Math.max(w, h) / 2 + 2);
    if (site) {
      // Control on a free side of the building.
      const dir = rng.chance(0.5) ? F.v : { x: -F.v.x, y: -F.v.y };
      const off = Math.max(w, h) / 2 + 3;
      b.site(c.x + dir.x * off, c.y + dir.y * off, { D: "5.11", G: `11.1${compass(dir.x, dir.y)}` }, site.label, site.weight);
    }
  };

  // ---------------------------------------------------------------- farmsteads
  if (M > 0.05) {
    const want = amount(0.6 + 4.2 * M);
    const cands: { q: Pt; dir: Pt; score: number }[] = [];
    for (const l of paths) {
      if (!["503", "504", "505", "506"].includes(l.code)) continue;
      const dense = densify(l.pts, 30);
      for (let i = 1; i < dense.length - 1; i += 1) {
        const q = dense[i];
        if (!b.inside(q.x, q.y, b.mm(14))) continue;
        const a = dense[i - 1];
        const c = dense[i + 1];
        const d = Math.hypot(c.x - a.x, c.y - a.y) || 1;
        const s = f.slope.sample(q.x, q.y);
        if (s > 0.14 || !dry(q, 25)) continue;
        const open = f.open.sample(q.x, q.y) - t.open;
        cands.push({ q, dir: { x: (c.x - a.x) / d, y: (c.y - a.y) / d }, score: open * 3 - s * 4 + (l.code === "503" || l.code === "504" ? 0.4 : 0) + rng.next() * 0.8 });
      }
    }
    cands.sort((a, c) => c.score - a.score);
    for (const cand of cands) {
      if (settlements.length >= want) break;
      if (settlements.some((s) => Math.hypot(s.x - cand.q.x, s.y - cand.q.y) < 450)) continue;
      const side = rng.chance(0.5) ? 1 : -1;
      const F: Frame = { o: cand.q, u: cand.dir, v: { x: -cand.dir.y * side, y: cand.dir.x * side } };
      const L = rng.range(45, 75);
      const D = rng.range(38, 58);
      const gap = b.mm(0.9) + 4;
      const yard = rect(F, -L / 2, L / 2, gap, gap + D);
      const outer = rect(F, -L / 2 - 10, L / 2 + 10, gap, gap + D + 12);
      if (!allIn(outer, b.mm(3)) || !allIn(yard, b.mm(8))) continue;
      const yc = centroid(yard);
      if (!b.occ.free(yc.x, yc.y, 10)) continue;
      // Steep yards don't exist.
      if (yard.some((q) => Math.abs(f.height.sample(q.x, q.y) - f.height.sample(yc.x, yc.y)) > 4)) continue;
      settlements.push(cand.q);

      // Yard (open land), drawn first so everything else sits on it.
      b.area("401", [rect(F, -L / 2 - 6, L / 2 + 6, gap - 2, gap + D + 6)]);

      // Buildings: a house along the path, then barns and sheds around the yard.
      const placed: [number, number, number, number][] = [];
      const fits = (a0: number, a1: number, b0: number, b1: number) =>
        a0 > -L / 2 + 2 && a1 < L / 2 - 2 && b0 > gap + 2 && b1 < gap + D - 2 && placed.every(([c0, c1, d0, d1]) => a1 + 4 < c0 || a0 > c1 + 4 || b1 + 4 < d0 || b0 > d1 + 4);
      const nb = rng.int(2, 5);
      for (let k = 0, tries = 0; k < nb && tries < 40; tries++) {
        const big = k === 0;
        const w = big ? rng.range(12, 18) : rng.range(6, 16);
        const h = big ? rng.range(9, 12) : rng.range(5, 10);
        const a0 = big ? rng.range(-L / 2 + 3, L / 2 - 3 - w) : rng.range(-L / 2 + 2, L / 2 - 2 - w);
        const b0 = big ? gap + 3 : rng.range(gap + 3, gap + D - 3 - h);
        if (!fits(a0, a0 + w, b0, b0 + h)) continue;
        placed.push([a0, a0 + w, b0, b0 + h]);
        if (big && rng.chance(0.3)) {
          // Large building (e.g. a farm hall) drawn with a dark outline.
          const ring = rect(F, a0, a0 + w, b0, b0 + h);
          b.area("521.3", [ring]);
          b.line("521.4", [...ring, ring[0]]);
          const c = centroid(ring);
          b.occ.add(c.x, c.y, Math.max(w, h) / 2 + 2);
          b.site(c.x + F.v.x * (h / 2 + 3), c.y + F.v.y * (h / 2 + 3), { D: "5.11" }, "building", 1);
        } else building(rect(F, a0, a0 + w, b0, b0 + h), F, big ? { label: "building", weight: 1.1 } : rng.chance(0.4) ? { label: "barn", weight: 0.9 } : undefined);
        k++;
      }
      // Canopy (open-sided shed).
      for (let tries = 0; tries < 10 && rng.chance(0.55); tries++) {
        const a0 = rng.range(-L / 2 + 2, L / 2 - 12);
        const b0 = rng.range(gap + 3, gap + D - 10);
        if (!fits(a0, a0 + rng.range(6, 10), b0, b0 + 6)) continue;
        placed.push([a0, a0 + 8, b0, b0 + 6]);
        b.area("522", [rect(F, a0, a0 + 8, b0, b0 + 6)]);
        break;
      }
      // Paved yard in front of the house, sometimes a proper parking area with an outline.
      if (rng.chance(0.3)) b.area("501", [rect(F, -8, 8, gap + 1, gap + 3)]);
      else if (rng.chance(0.4)) {
        const pk = rect(F, -L / 2 - 6 - rng.range(18, 30), -L / 2 - 8, gap - 1, gap + rng.range(10, 18));
        if (allIn(pk)) {
          b.area("501.1", [pk]);
          b.line("501.2", [...pk, pk[0]]);
          const pc = centroid(pk);
          b.occ.add(pc.x, pc.y, 10);
          b.site(pc.x, pc.y, { D: "5.12" }, "paved area", 0.8);
        }
      }
      // Well in the yard.
      if (rng.chance(0.65)) {
        const w = at(F, rng.range(-L / 4, L / 4), gap + D * 0.7);
        b.point("311", w.x, w.y, 0.5, undefined, { desc: { D: "3.9" }, label: "well", weight: 1 });
      }
      // Fence around the yard with a gate towards the path.
      const fenceCode = rng.chance(0.8) ? "516" : "513";
      const fence = [at(F, -6, gap - 2), at(F, -L / 2 - 6, gap - 2), at(F, -L / 2 - 6, gap + D + 6), at(F, L / 2 + 6, gap + D + 6), at(F, L / 2 + 6, gap - 2), at(F, 6, gap - 2)];
      b.line(fenceCode, fence);
      barriers.push({ pts: fence, code: fenceCode });
      const corner = at(F, L / 2 + 6, gap + D + 6);
      const out = { x: corner.x - yc.x, y: corner.y - yc.y };
      const on = Math.hypot(out.x, out.y) || 1;
      b.site(corner.x + (out.x / on) * 3, corner.y + (out.y / on) * 3, { D: fenceCode === "516" ? "5.9" : "5.8", G: `11.5${compass(out.x, out.y)}` }, "fence corner", 1);
      // Private garden behind the house: out of bounds.
      if (rng.chance(0.55)) {
        const g = rect(F, -L / 2 - 4, -L / 2 + rng.range(14, 24), gap + D - 14, gap + D + 4);
        if (rng.chance(0.4)) {
          b.area("520.2", [g]);
          b.line("520.3", [...g, g[0]]);
        } else {
          b.area("520", [g]);
          if (rng.chance(0.4)) b.line("520.1", [...g, g[0]]);
        }
      }
      // Orchard next to the yard.
      if (rng.chance(0.55)) {
        const s = rng.chance(0.5) ? 1 : -1;
        const a0 = s > 0 ? L / 2 + 10 : -L / 2 - 10 - rng.range(25, 40);
        const orch = rect(F, a0, a0 + rng.range(25, 40), gap + 2, gap + rng.range(30, 50));
        if (allIn(orch)) {
          b.area("413", [orch]);
          const oc = centroid(orch);
          b.occ.add(oc.x, oc.y, 12);
        }
      }
      // Cultivated field beyond the farm, sometimes fenced.
      if (rng.chance(0.6)) {
        const fw = rng.range(80, 180);
        const fd = rng.range(60, 140);
        const a0 = rng.range(-fw / 2, 0);
        const field = rect(F, a0, a0 + fw, gap + D + 14, gap + D + 14 + fd).map((q) => ({ x: q.x + rng.range(-8, 8), y: q.y + rng.range(-8, 8) }));
        if (allIn(field, b.mm(2))) {
          b.area("412", [field]);
          if (rng.chance(0.5)) {
            b.line("516", [...field, field[0]]);
            barriers.push({ pts: [...field, field[0]], code: "516" });
          } else {
            b.line("415", [...field, field[0]]);
          }
          b.point("527", centroid(field).x, centroid(field).y, 0.6);
        }
      }
    }
  }

  // ---------------------------------------------------------------- huts in the forest, ruins
  {
    const huts = amount(0.5 + 3 * M);
    let done = 0;
    for (let tries = 0; tries < huts * 30 && done < huts && paths.length; tries++) {
      const l = rng.pick(paths);
      const q = l.pts[rng.int(0, l.pts.length - 1)];
      const ang = rng.range(0, Math.PI * 2);
      const c = { x: q.x + Math.cos(ang) * rng.range(15, 45), y: q.y + Math.sin(ang) * rng.range(15, 45) };
      if (!b.inside(c.x, c.y, b.mm(8)) || !dry(c, 10) || isOpen(c) || f.slope.sample(c.x, c.y) > 0.2 || !b.occ.free(c.x, c.y, 14)) continue;
      if (settlements.some((s) => Math.hypot(s.x - c.x, s.y - c.y) < 250)) continue;
      const u = { x: Math.cos(ang + 0.5), y: Math.sin(ang + 0.5) };
      const F: Frame = { o: c, u, v: { x: -u.y, y: u.x } };
      const w = rng.range(5, 11);
      const h = rng.range(4, 8);
      // A little clearing around the hut.
      if (rng.chance(0.6)) b.area("401", [blob(c, rng.range(14, 22), rng)]);
      building(rect(F, -w / 2, w / 2, -h / 2, h / 2), F, { label: "hut", weight: 1 });
      if (rng.chance(0.3)) {
        const s = at(F, w / 2 + 8, 0);
        b.point("311", s.x, s.y, 0.5, undefined, { desc: { D: "3.9" }, label: "well", weight: 0.9 });
      }
      settlements.push(c);
      done++;
    }

    const ruins = amount(0.6 + 2.5 * M);
    done = 0;
    for (let tries = 0; tries < ruins * 30 && done < ruins; tries++) {
      const c = { x: rng.range(0, f.widthM), y: rng.range(0, f.heightM) };
      if (!b.inside(c.x, c.y, b.mm(8)) || !dry(c, 10) || f.slope.sample(c.x, c.y) > 0.15 || !b.occ.free(c.x, c.y, 16)) continue;
      const ang = rng.range(0, Math.PI);
      const u = { x: Math.cos(ang), y: Math.sin(ang) };
      const F: Frame = { o: c, u, v: { x: -u.y, y: u.x } };
      const w = rng.range(7, 16);
      const h = rng.range(6, 11);
      if (Math.min(w, h) < b.mm(0.6)) {
        b.point("523.1", c.x, c.y, 0.6, ang, { desc: { D: "5.13" }, label: "ruin", weight: 1.1 });
      } else {
        b.line("523", rect(F, -w / 2, w / 2, -h / 2, h / 2), true);
        b.occ.add(c.x, c.y, Math.max(w, h) / 2 + 3);
        b.site(c.x, c.y, { D: "5.13" }, "ruin", 1.1);
      }
      // Old stone walls / fences around the abandoned farm.
      if (rng.chance(0.55)) {
        const R = rng.range(25, 45);
        const enc = rect(F, -R, R, -R * 0.8, R * 0.8);
        if (allIn(enc)) {
          const code = f.rock.sample(c.x, c.y) > t.rock - 0.15 || rng.chance(0.5) ? "514" : "517";
          const start = rng.int(0, 3);
          const run = [0, 1, 2, 3].slice(0, rng.int(2, 4)).map((i) => enc[(start + i) % 4]);
          b.line(code, run);
          b.occ.addLine(run, b.mm(0.3), b.mm(0.8));
          const e = run[run.length - 1];
          const d = run[run.length - 2];
          b.site(e.x, e.y, { D: code === "514" ? "5.8" : "5.9", E: "8.11", G: `11.8${compass(e.x - d.x, e.y - d.y)}` }, "ruined wall end", 1);
        }
      }
      done++;
    }
  }

  // ---------------------------------------------------------------- fences around open land, enclosures
  for (const r of b.openRings) {
    const a = Math.abs(ringArea(r));
    if (a < b.mm(6) ** 2 || a > b.mm(60) ** 2 || !rng.chance(0.12 + 0.55 * M)) continue;
    const ring = simplify(r, 3, true);
    if (ring.length < 4) continue;
    const closed = [...ring, ring[0]];
    // Often only part of the field edge is fenced.
    let run = closed;
    if (rng.chance(0.45)) {
      const i0 = rng.int(0, ring.length - 1);
      const len = Math.max(3, Math.floor(ring.length * rng.range(0.4, 0.8)));
      run = Array.from({ length: len }, (_, i) => ring[(i0 + i) % ring.length]);
    }
    const code = rng.weighted({ "516": 0.6, "517": 0.25, "513": 0.15 * M });
    for (const piece of splitWhere(run, false, (q) => dry(q, 1), b.mm(2))) {
      b.line(code, piece);
      barriers.push({ pts: piece, code });
      b.occ.addLine(piece, b.mm(0.3), b.mm(1));
    }
  }
  {
    const enclosures = amount(0.3 + 2.2 * M);
    let done = 0;
    for (let tries = 0; tries < enclosures * 25 && done < enclosures; tries++) {
      const c = { x: rng.range(0, f.widthM), y: rng.range(0, f.heightM) };
      const ang = rng.range(0, Math.PI);
      const u = { x: Math.cos(ang), y: Math.sin(ang) };
      const F: Frame = { o: c, u, v: { x: -u.y, y: u.x } };
      const w = rng.range(60, 170);
      const h = rng.range(50, 130);
      const ring = rect(F, -w / 2, w / 2, -h / 2, h / 2).map((q) => ({ x: q.x + rng.range(-6, 6), y: q.y + rng.range(-6, 6) }));
      if (!allIn(ring, b.mm(4)) || !pointInRing(c, ring) || isOpen(c)) continue;
      const code = rng.chance(0.45) ? "518" : "516";
      const closed = [...ring, ring[0]];
      b.line(code, closed);
      barriers.push({ pts: closed, code });
      b.occ.addLine(closed, b.mm(0.3), b.mm(1));
      // Young plantation inside: denser vegetation.
      if (rng.chance(0.5)) b.area(rng.chance(0.5) ? "408" : "406", [ring]);
      const k = rng.int(0, 3);
      const out = { x: ring[k].x - c.x, y: ring[k].y - c.y };
      const on = Math.hypot(out.x, out.y) || 1;
      b.site(ring[k].x + (out.x / on) * 3, ring[k].y + (out.y / on) * 3, { D: "5.9", G: `11.5${compass(out.x, out.y)}` }, "fence corner", 1.1);
      done++;
    }
  }

  // ---------------------------------------------------------------- long boundary fences and stone walls
  {
    const lines = amount(0.5 + 3 * M);
    for (let n = 0; n < lines; n++) {
      let q = { x: rng.range(0, f.widthM), y: rng.range(0, f.heightM) };
      let ang = rng.range(0, Math.PI * 2);
      const pts: Pt[] = [q];
      const len = rng.range(200, 700);
      for (let s = 0; s < len; ) {
        const step = rng.range(35, 80);
        ang += rng.range(-0.25, 0.25);
        q = { x: q.x + Math.cos(ang) * step, y: q.y + Math.sin(ang) * step };
        pts.push(q);
        s += step;
      }
      const rocky = f.rock.sample(pts[0].x, pts[0].y) > t.rock - 0.2;
      const code = rocky
        ? rng.weighted({ "513": 0.35, "514": 0.45, "515": 0.2 })
        : rng.weighted({ "516": 0.45, "517": 0.35, "518": 0.1, "514": 0.1 });
      for (const piece of splitWhere(pts, false, (v) => b.inside(v.x, v.y) && dry(v, 2), b.mm(4))) {
        b.line(code, piece);
        barriers.push({ pts: piece, code });
        b.occ.addLine(piece, b.mm(0.3), b.mm(1));
        const e = piece[piece.length - 1];
        const d = piece[piece.length - 2];
        if (b.inside(e.x, e.y, b.mm(5))) {
          const desc: ControlDesc = { D: ["513", "514", "515"].includes(code) ? "5.8" : "5.9", G: `11.8${compass(e.x - d.x, e.y - d.y)}` };
          if (code === "514" || code === "517") desc.E = "8.11";
          b.site(e.x, e.y, desc, code === "516" || code === "517" || code === "518" ? "fence end" : "wall end", 1);
        }
        // Old boundary stones along stone walls.
        if (code === "514" && rng.chance(0.4)) {
          const s = piece[Math.floor(piece.length / 2)];
          b.point("526", s.x + 4, s.y + 4, 0.5, undefined, { desc: { D: "5.17" }, label: "boundary stone", weight: 0.9 });
        }
      }
    }
  }

  // Crossing points where paths cross impassable fences and walls.
  for (const bar of barriers) {
    if (bar.code !== "518" && bar.code !== "515") continue;
    for (const l of paths) {
      for (let i = 1; i < bar.pts.length; i++) {
        for (let j = 1; j < l.pts.length; j++) {
          const x = segIntersection(bar.pts[i - 1], bar.pts[i], l.pts[j - 1], l.pts[j]);
          if (!x) continue;
          const a = bar.pts[i - 1];
          const c = bar.pts[i];
          b.features.push({ kind: "point", code: "519", x: x.x, y: x.y, angle: upAngle(c.x - a.x, c.y - a.y) + Math.PI / 2 });
          b.count("519");
          b.site(x.x, x.y, { D: "5.10" }, "crossing point", 0.9);
        }
      }
    }
  }

  // ---------------------------------------------------------------- forest rides
  {
    const rides = amount((0.2 + 1.6 * M) * (0.4 + p.paths));
    const base = rng.range(0, Math.PI);
    for (let n = 0; n < rides; n++) {
      const ang = base + (rng.chance(0.5) ? 0 : Math.PI / 2) + rng.range(-0.05, 0.05);
      const c = { x: rng.range(0, f.widthM), y: rng.range(0, f.heightM) };
      const half = rng.range(250, 800);
      const pts = densify([{ x: c.x - Math.cos(ang) * half, y: c.y - Math.sin(ang) * half }, { x: c.x + Math.cos(ang) * half, y: c.y + Math.sin(ang) * half }], 10);
      const forest = (q: Pt) => b.inside(q.x, q.y) && dry(q, 3) && !isOpen(q) && f.wet.sample(q.x, q.y) < t.marsh;
      for (const piece of splitWhere(pts, false, forest, b.mm(5))) {
        const s = simplify(piece, 0.5);
        const fq = s[Math.floor(s.length / 2)];
        const g = f.green.sample(fq.x, fq.y);
        const rideCode = rng.chance(0.4) ? "508" : g > t.green3 ? "508.4" : g > t.green2 ? "508.3" : g > t.green1 ? "508.2" : rng.pick(["508.1", "508.2"]);
        b.line(rideCode, s);
        b.occ.addLine(s, b.mm(0.25), b.mm(1));
        const e = s[s.length - 1];
        const d = s[0];
        if (b.inside(e.x, e.y, b.mm(5))) b.site(e.x, e.y, { D: "5.3", G: `11.8${compass(e.x - d.x, e.y - d.y)}` }, "ride end", 0.8);
      }
    }
  }

  // ---------------------------------------------------------------- power lines
  if (p.paths > 0.3 && rng.chance(0.4 + 0.4 * M)) {
    const y0 = rng.range(0.15, 0.85) * f.heightM;
    const y1 = rng.range(0.15, 0.85) * f.heightM;
    b.line("510", [{ x: -10, y: y0 }, { x: f.widthM + 10, y: y1 }]);
  }
  if (M > 0.45 && rng.chance(0.25 + 0.5 * (M - 0.45))) {
    // Major power line with pylons, crossing the map the other way.
    const x0 = rng.range(0.15, 0.85) * f.widthM;
    const x1 = rng.range(0.15, 0.85) * f.widthM;
    const line = [{ x: x0, y: -10 }, { x: x1, y: f.heightM + 10 }];
    b.line(rng.weighted({ "511.2": 0.5, "511.1": 0.3, "511": 0.2 }), line);
    const L = lineLength(line);
    for (let s = 120; s < L; s += 240) {
      const q = { x: x0 + ((x1 - x0) * s) / L, y: -10 + ((f.heightM + 20) * s) / L };
      b.site(q.x, q.y, { D: "5.6" }, "power line pylon", 0.8);
    }
  }

  // ---------------------------------------------------------------- high seats, towers, small objects
  {
    const seats = amount(1 + 7 * M);
    let done = 0;
    const rings = b.openRings.filter((r) => r.length > 8);
    for (let tries = 0; tries < seats * 20 && done < seats && rings.length; tries++) {
      const r = rng.pick(rings);
      const i = rng.int(0, r.length - 1);
      const a = r[i];
      const c = r[(i + 1) % r.length];
      const d = Math.hypot(c.x - a.x, c.y - a.y) || 1;
      // Open land lies on the left of the ring direction; the forest edge on the right.
      const q = { x: a.x - ((c.y - a.y) / d) * b.mm(0.9), y: a.y + ((c.x - a.x) / d) * b.mm(0.9) };
      if (!dry(q, 5)) continue;
      if (b.point("525", q.x, q.y, 0.7, undefined, { desc: { D: "5.16" }, label: "high seat", weight: 1 })) done++;
    }
  }

  // A tower on the highest hill top.
  let best = { x: 0, y: 0, h: -Infinity };
  b.scatter(b.mm(6), (x, y) => {
    const h = f.height.sample(x, y);
    if (h > best.h && b.inside(x, y, b.mm(12))) best = { x, y, h };
  });
  if (Number.isFinite(best.h)) {
    const high = M > 0.3 && rng.chance(0.7);
    b.point(high ? "524" : "525", best.x, best.y, 0.8, undefined, { desc: { D: "5.15" }, label: "tower", weight: 0.8 });
  }

  // Railway across the map (gentle curve), interrupted over water.
  if (rng.chance(0.15 + 0.45 * M) && M > 0.2) {
    const horiz = rng.chance(0.5);
    const a0 = rng.range(0.1, 0.9);
    const a1 = rng.range(0.1, 0.9);
    const bend = rng.range(-0.12, 0.12);
    const pts: Pt[] = [];
    for (let i = 0; i <= 60; i++) {
      const tt = i / 60;
      const along = -0.02 + tt * 1.04;
      const across = a0 + (a1 - a0) * tt + bend * Math.sin(Math.PI * tt);
      pts.push(horiz ? { x: along * f.widthM, y: across * f.heightM } : { x: across * f.widthM, y: along * f.heightM });
    }
    for (const piece of splitWhere(densify(pts, 8), false, (q) => dry(q, 4) || !b.inside(q.x, q.y), b.mm(3))) {
      b.line("509", piece);
      b.occ.addLine(piece, b.mm(0.5), b.mm(1));
      barriers.push({ pts: piece, code: "509" });
    }
    // Level crossings with the path network.
    let n = 0;
    for (const l of paths) {
      for (let j = 1; j < l.pts.length && n < 6; j++) {
        for (let i = 1; i < pts.length; i++) {
          const x = segIntersection(pts[i - 1], pts[i], l.pts[j - 1], l.pts[j]);
          if (x && b.inside(x.x, x.y, b.mm(4))) {
            b.site(x.x, x.y, { D: "5.26", E: "5.2", F: "10.2" }, "railway crossing", 0.8);
            n++;
          }
        }
      }
    }
  }

  // Prominent line features (old ditches, pipes, ski-lift rails…), some impassable.
  {
    const n = amount(0.5 + 2.5 * M);
    for (let k = 0, tries = 0; k < n && tries < n * 20; tries++) {
      const c = { x: rng.range(0, f.widthM), y: rng.range(0, f.heightM) };
      if (!b.inside(c.x, c.y, b.mm(6)) || !dry(c, 6) || !b.occ.free(c.x, c.y, b.mm(2))) continue;
      const ang = rng.range(0, Math.PI * 2);
      const len = rng.range(b.mm(2), b.mm(7));
      const pts = densify([c, { x: c.x + Math.cos(ang) * len, y: c.y + Math.sin(ang) * len }], 6).map((q, i) => ({ x: q.x + Math.sin(i) * 1.5, y: q.y }));
      if (!pts.every((q) => b.inside(q.x, q.y) && dry(q, 2))) continue;
      const code = rng.chance(0.35) ? "529" : "528";
      b.line(code, pts);
      b.occ.addLine(pts, b.mm(0.4), b.mm(1));
      const e = pts[pts.length - 1];
      b.site(e.x, e.y, { D: "6.1", G: `11.8${compass(Math.cos(ang), Math.sin(ang))}` }, "line feature end", 0.8);
      k++;
    }
  }

  // Scattered man-made point features.
  b.scatter(b.mm(9), (x, y) => {
    const open = f.open.sample(x, y) > t.open;
    const roll = rng.next();
    const k = (0.5 + M) * b.mood.manmade;
    if (open && roll < 0.05 * k) b.point("527", x, y, 0.6, undefined, { desc: { D: "5.18" }, label: "fodder rack", weight: 0.9 });
    else if (roll < 0.012 * k) b.point("531", x, y, 0.6, undefined, { desc: { D: "6.1" }, label: "special item (x)", weight: 0.8 });
    else if (roll < 0.022 * k) b.point("530", x, y, 0.6, undefined, { desc: { D: "6.2" }, label: "special item (o)", weight: 0.8 });
    else if (roll < 0.03 * k) b.point("526", x, y, 0.6, undefined, { desc: { D: "5.17" }, label: "cairn", weight: 0.9 });
    else if (!open && roll < 0.034 * k) b.point("311", x, y, 0.5, undefined, { desc: { D: "3.9" }, label: "well", weight: 0.9 });
  });
}
