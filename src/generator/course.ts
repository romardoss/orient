/** Simple automatic course setting on the generated control sites. */
import type { Pt } from "../symbols/geometry";
import type { FeatureBuilder } from "./features";
import { blob } from "./features";
import type { ControlSite, Course, CourseControl, CourseExtras } from "./model";

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Codes that read the same upside down are avoided (IOF practice). */
const AMBIGUOUS = new Set([66, 68, 86, 89, 98, 69, 96]);

function legOk(b: FeatureBuilder, a: Pt, c: Pt): boolean {
  const n = Math.ceil(Math.hypot(c.x - a.x, c.y - a.y) / 15);
  for (let i = 1; i < n; i++) {
    const x = a.x + ((c.x - a.x) * i) / n;
    const y = a.y + ((c.y - a.y) * i) / n;
    if (b.isLake(x, y)) return false;
    // Uncrossable rivers only where a bridge is reasonably close to the line.
    const river = b.riverAt(x, y);
    if (river === 2 && !b.bridges.some((q) => Math.hypot(q.x - x, q.y - y) < 300)) return false;
  }
  return true;
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}

function climb(b: FeatureBuilder, a: Pt, c: Pt): number {
  const n = Math.max(2, Math.ceil(Math.hypot(c.x - a.x, c.y - a.y) / 10));
  let up = 0;
  let prev = b.f.height.sample(a.x, a.y);
  for (let i = 1; i <= n; i++) {
    const h = b.f.height.sample(a.x + ((c.x - a.x) * i) / n, a.y + ((c.y - a.y) * i) / n);
    if (h > prev) up += h - prev;
    prev = h;
  }
  return up;
}

export function setCourse(b: FeatureBuilder, avoid: Rect[]): Course | undefined {
  const { p, rng } = b;
  const cp = p.course;
  if (!cp.enabled || cp.controls < 1) return undefined;
  const margin = b.mm(9);
  const blocked = (q: Pt) => avoid.some((r) => q.x > r.x0 - margin && q.x < r.x1 + margin && q.y > r.y0 - margin && q.y < r.y1 + margin);
  const sites = b.sites.filter((s) => b.inside(s.x, s.y, margin) && !blocked(s));
  if (sites.length < cp.controls + 1) return undefined;

  const leg = (cp.lengthKm * 1000) / (cp.controls + 1);
  const minSep = Math.max(b.mm(8), 60);
  let best: { start: Pt; startSite: ControlSite; ctrls: ControlSite[]; finish: Pt; score: number } | undefined;

  const junctions = sites.filter((s) => s.label === "path junction");
  for (let attempt = 0; attempt < 160; attempt++) {
    const startSite = junctions.length && rng.chance(0.7) ? rng.pick(junctions) : rng.pick(sites);
    const start = { x: startSite.x, y: startSite.y };
    const chosen: ControlSite[] = [];
    let cur: Pt = start;
    let prevDir: Pt | undefined;
    let failed = false;
    for (let i = 0; i < cp.controls; i++) {
      const cands: { s: ControlSite; w: number }[] = [];
      for (const s of sites) {
        if (chosen.includes(s) || s === startSite) continue;
        const d = Math.hypot(s.x - cur.x, s.y - cur.y);
        if (d < leg * 0.45 || d > leg * 1.8) continue;
        if (chosen.some((c) => Math.hypot(c.x - s.x, c.y - s.y) < minSep)) continue;
        if (Math.hypot(start.x - s.x, start.y - s.y) < minSep) continue;
        const dir = { x: (s.x - cur.x) / d, y: (s.y - cur.y) / d };
        // Avoid dog-legs: the next leg should not run back along the previous one.
        if (prevDir && dir.x * prevDir.x + dir.y * prevDir.y < -0.75) continue;
        if (!legOk(b, cur, s)) continue;
        // Legs should not cross earlier legs (the adjacent one shares an end point).
        const path = [start, ...chosen];
        let crosses = false;
        for (let q = 0; q + 2 < path.length; q++) if (segmentsCross(path[q], path[q + 1], cur, s)) crosses = true;
        if (crosses) continue;
        // The leg must not run through another circle (or the start triangle).
        const clearance = b.mm(4.5);
        if (path.slice(0, -1).some((q) => distToSegment(q, cur, s) < clearance)) continue;
        // …and the new control must stay clear of earlier legs.
        let nearLeg = false;
        for (let q = 0; q + 1 < path.length; q++) if (distToSegment(s, path[q], path[q + 1]) < clearance) nearLeg = true;
        if (nearLeg) continue;
        const fit = Math.exp(-(((d - leg) / (leg * 0.5)) ** 2));
        // Prefer variety: each earlier control of the same feature type lowers the weight.
        const repeats = chosen.filter((c) => c.desc.D === s.desc.D).length;
        cands.push({ s, w: s.weight * fit * 0.55 ** repeats * (0.5 + rng.next()) });
      }
      if (!cands.length) {
        failed = true;
        break;
      }
      cands.sort((a, c) => c.w - a.w);
      const pick = cands[Math.min(cands.length - 1, Math.floor(rng.next() ** 2 * Math.min(5, cands.length)))].s;
      prevDir = { x: (pick.x - cur.x) / Math.hypot(pick.x - cur.x, pick.y - cur.y), y: (pick.y - cur.y) / Math.hypot(pick.x - cur.x, pick.y - cur.y) };
      chosen.push(pick);
      cur = pick;
    }
    if (failed) continue;

    // Finish: 150–300 m from the last control, preferably towards the start.
    const last = chosen[chosen.length - 1];
    let finish: Pt | undefined;
    for (let tries = 0; tries < 40 && !finish; tries++) {
      const toStart = Math.atan2(start.y - last.y, start.x - last.x);
      const ang = toStart + rng.range(-0.9, 0.9);
      const dist = rng.range(150, 300);
      const q = { x: last.x + Math.cos(ang) * dist, y: last.y + Math.sin(ang) * dist };
      const legs = [start, ...chosen];
      let clear = legs.slice(0, -1).every((c) => Math.hypot(c.x - q.x, c.y - q.y) > b.mm(12) && distToSegment(c, last, q) > b.mm(4.5));
      for (let i = 0; i + 2 < legs.length; i++) {
        if (segmentsCross(legs[i], legs[i + 1], last, q) || distToSegment(q, legs[i], legs[i + 1]) < b.mm(5)) clear = false;
      }
      if (clear && b.inside(q.x, q.y, margin) && !blocked(q) && !b.inLake(q.x, q.y) && legOk(b, last, q)) finish = q;
    }
    if (!finish) continue;

    let total = 0;
    let prev: Pt = start;
    for (const c of [...chosen, finish]) {
      total += Math.hypot(c.x - prev.x, c.y - prev.y);
      prev = c;
    }
    const score = -Math.abs(total - cp.lengthKm * 1000) + chosen.reduce((s, c) => s + c.weight * 30, 0);
    if (!best || score > best.score) best = { start, startSite, ctrls: chosen, finish, score };
  }
  if (!best) return undefined;

  const codes: number[] = [];
  while (codes.length < best.ctrls.length) {
    const c = rng.int(31, 99);
    if (!codes.includes(c) && !AMBIGUOUS.has(c)) codes.push(c);
  }
  codes.sort((a, c) => a - c);
  // Shuffle so codes don't follow the course order.
  for (let i = codes.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [codes[i], codes[j]] = [codes[j], codes[i]];
  }

  const controls: CourseControl[] = best.ctrls.map((s, i) => ({ x: s.x, y: s.y, code: codes[i], desc: s.desc, label: s.label }));
  let length = 0;
  let up = 0;
  let prev: Pt = best.start;
  for (const c of [...controls, best.finish]) {
    length += Math.hypot(c.x - prev.x, c.y - prev.y);
    up += climb(b, prev, c);
    prev = c;
  }
  const last = controls[controls.length - 1];
  const extras = courseExtras(b, best.start, controls, best.finish, blocked, margin);
  return {
    extras,
    name: cp.name,
    start: best.start,
    startDesc: best.startSite.desc,
    controls,
    finish: best.finish,
    length,
    climb: Math.round(up / 5) * 5,
    finishDistance: Math.round(Math.hypot(best.finish.x - last.x, best.finish.y - last.y) / 10) * 10,
  };
}

/** Places the extra overprint: map issue point with a marked route, out-of-bounds, first aid, drinks. */
function courseExtras(b: FeatureBuilder, start: Pt, ctrls: Pt[], finish: Pt, blocked: (q: Pt) => boolean, margin: number): CourseExtras {
  const { rng } = b;
  const seq = [start, ...ctrls, finish];
  const legClear = (q: Pt, r: number) => {
    for (let i = 0; i + 1 < seq.length; i++) if (distToSegment(q, seq[i], seq[i + 1]) < r) return false;
    return seq.every((c) => Math.hypot(c.x - q.x, c.y - q.y) > r + b.mm(3));
  };
  const ok = (q: Pt, r: number) => b.inside(q.x, q.y, margin) && !blocked(q) && !b.inLake(q.x, q.y) && legClear(q, r);
  const out: CourseExtras = { oobAreas: [], oobLines: [], oobRoutes: [], crossings: [], refreshments: [] };

  // Map issue point 120–250 m before the start, joined by a marked (taped) route.
  // Each extra only on some maps, so they don't all look alike.
  const want = { issue: rng.chance(0.45), oob: rng.chance(0.3), oobLine: rng.chance(0.15), oobRoute: rng.chance(0.15), crossings: rng.chance(0.6), firstAid: rng.chance(0.2), drinks: rng.chance(0.3) };
  for (let tries = 0; tries < 40 && want.issue && !out.issue; tries++) {
    const first = seq[1];
    const away = Math.atan2(start.y - first.y, start.x - first.x) + rng.range(-1, 1);
    const d = rng.range(120, 250);
    const q = { x: start.x + Math.cos(away) * d, y: start.y + Math.sin(away) * d };
    if (!b.inside(q.x, q.y, margin) || blocked(q) || b.inLake(q.x, q.y)) continue;
    const route: Pt[] = [];
    const n = 12;
    const wig = rng.range(-0.12, 0.12) * d;
    let fine = true;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const nx = -(start.y - q.y) / d;
      const ny = (start.x - q.x) / d;
      const w = Math.sin(Math.PI * t) * wig;
      const p = { x: q.x + (start.x - q.x) * t + nx * w, y: q.y + (start.y - q.y) * t + ny * w };
      if (b.inLake(p.x, p.y)) fine = false;
      route.push(p);
    }
    if (!fine) continue;
    // Stop short of the start triangle and the issue point symbol.
    const cut = (pts: Pt[], from: Pt, r: number) => pts.filter((p) => Math.hypot(p.x - from.x, p.y - from.y) > r);
    out.issue = q;
    out.marked = cut(cut(route, start, b.mm(4.5)), q, b.mm(2.5));
  }

  // Out-of-bounds areas near some legs (not on them).
  const nOob = want.oob ? rng.int(1, 2) : 0;
  for (let tries = 0; tries < 60 && out.oobAreas.length < nOob; tries++) {
    const i = rng.int(0, seq.length - 2);
    const a = seq[i];
    const c = seq[i + 1];
    const L = Math.hypot(c.x - a.x, c.y - a.y) || 1;
    const t = rng.range(0.3, 0.7);
    const side = rng.chance(0.5) ? 1 : -1;
    const r = b.mm(rng.range(2, 3.5));
    const off = r + b.mm(rng.range(4, 7));
    const q = { x: a.x + (c.x - a.x) * t - ((c.y - a.y) / L) * off * side, y: a.y + (c.y - a.y) * t + ((c.x - a.x) / L) * off * side };
    const ring = blob(q, r, rng, 10);
    if (!ring.every((p) => ok(p, b.mm(3)))) continue;
    if (out.oobAreas.some((o) => Math.hypot(o[0].x - q.x, o[0].y - q.y) < r * 4)) continue;
    out.oobAreas.push(ring);
  }
  // An out-of-bounds boundary (708) and a forbidden route (711) along a path.
  for (let tries = 0; tries < 40 && want.oobLine && !out.oobLines.length; tries++) {
    const q = { x: rng.range(0, b.f.widthM), y: rng.range(0, b.f.heightM) };
    const ang = rng.range(0, Math.PI);
    const len = b.mm(rng.range(8, 16));
    const pts = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ x: q.x + Math.cos(ang) * len * (t - 0.5), y: q.y + Math.sin(ang) * len * (t - 0.5) + Math.sin(t * 6) * b.mm(0.6) }));
    if (pts.every((p) => ok(p, b.mm(4)))) out.oobLines.push(pts);
  }
  const paths = b.features.filter((f): f is Extract<typeof f, { kind: "line" }> => f.kind === "line" && ["503", "504", "505"].includes(f.code));
  for (let tries = 0; tries < 40 && want.oobRoute && !out.oobRoutes.length && paths.length; tries++) {
    const l = rng.pick(paths);
    if (l.pts.length < 6) continue;
    const i0 = rng.int(0, l.pts.length - 4);
    const run: Pt[] = [l.pts[i0]];
    let len = 0;
    for (let i = i0 + 1; i < l.pts.length && len < b.mm(12); i++) {
      len += Math.hypot(l.pts[i].x - l.pts[i - 1].x, l.pts[i].y - l.pts[i - 1].y);
      run.push(l.pts[i]);
    }
    if (len > b.mm(5) && run.every((p) => ok(p, b.mm(4)))) out.oobRoutes.push(run);
  }
  // Crossing points on railways / impassable fences that a leg crosses.
  const barriers = b.features.filter((f): f is Extract<typeof f, { kind: "line" }> => f.kind === "line" && ["509", "518", "515", "529"].includes(f.code));
  for (const bar of want.crossings ? barriers : []) {
    for (let j = 1; j < bar.pts.length; j++) {
      for (let i = 0; i + 1 < seq.length; i++) {
        if (!segmentsCross(bar.pts[j - 1], bar.pts[j], seq[i], seq[i + 1])) continue;
        const A = bar.pts[j - 1];
        const B = bar.pts[j];
        const C = seq[i];
        const D = seq[i + 1];
        const den = (B.x - A.x) * (D.y - C.y) - (B.y - A.y) * (D.x - C.x);
        if (!den) continue;
        const t = ((C.x - A.x) * (D.y - C.y) - (C.y - A.y) * (D.x - C.x)) / den;
        const x = { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t };
        if (seq.some((c) => Math.hypot(c.x - x.x, c.y - x.y) < b.mm(5))) continue;
        if (out.crossings.some((c) => Math.hypot(c.x - x.x, c.y - x.y) < b.mm(5))) continue;
        out.crossings.push({ ...x, angle: Math.atan2(B.y - A.y, B.x - A.x) });
      }
    }
  }
  // Refreshment point next to a control in the middle of the course, first aid next to the finish.
  const beside = (c: Pt, d: number): Pt | undefined => {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2 + 0.3;
      const q = { x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d };
      let free = b.inside(q.x, q.y, b.mm(3)) && !blocked(q);
      for (let i = 0; i + 1 < seq.length; i++) if (distToSegment(q, seq[i], seq[i + 1]) < b.mm(2)) free = false;
      if (free && seq.every((s) => s === c || Math.hypot(s.x - q.x, s.y - q.y) > b.mm(6))) return q;
    }
    return undefined;
  };
  if (want.drinks && ctrls.length >= 4) {
    const r = beside(ctrls[Math.floor(ctrls.length / 2)], b.mm(5.5));
    if (r) out.refreshments.push(r);
  }
  if (want.firstAid) out.firstAid = beside(finish, b.mm(6.5));
  return out;
}
