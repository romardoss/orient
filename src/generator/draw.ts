/** Renders a generated MapModel to a printable SVG sheet using real ISOM symbol definitions. */
import type { DescSymbolSet } from "../symbols/control-descriptions";
import type { Pt } from "../symbols/geometry";
import { SymbolRenderer } from "../symbols/render";
import type { SymbolSet } from "../symbols/types";
import { DescLookup, descriptionSheet } from "./description-sheet";
import { upAngle } from "./features";
import { computeLayout } from "./layout";
import type { Course, MapModel } from "./model";
import { type MapParams, mapPointScale, mapSymbolScale, metresPerMm, symbolScale } from "./params";

export interface DrawOptions {
  /** Simulate overprinted purple (multiply blend) so the map shows through the course. */
  overprint?: boolean;
  showCourse?: boolean;
  showSheet?: boolean;
  showTitle?: boolean;
  /** "print" = ink-based display colours, "mapper" = OpenOrienteering Mapper's RGB values. */
  palette?: "print" | "mapper";
  /** Symbol codes to leave out (layer toggles). */
  hidden?: Set<string>;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const fmtScale = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ");

export function drawMap(model: MapModel, p: MapParams, iso: SymbolSet, desc: DescSymbolSet, opts: DrawOptions = {}): string {
  const l = computeLayout(p);
  const m = metresPerMm(p);
  const k = symbolScale(p);
  const set: SymbolSet = opts.palette === "mapper" ? { ...iso, colors: iso.colors.map((c) => ({ ...c, rgb: c.mapperRgb })) } : iso;
  const X = (x: number) => (l.frame.x0 + x / m) * 1000;
  const Y = (y: number) => (l.frame.y0 + y / m) * 1000;
  const P = (q: Pt): Pt => ({ x: X(q.x), y: Y(q.y) });

  // --- map content
  const ren = new SymbolRenderer(set, { scale: mapSymbolScale(p), pointScale: mapPointScale(p), tolerance: 150, idPrefix: "m" });
  const missing = new Set<string>();
  for (const f of model.features) {
    if (opts.hidden?.has(f.code)) continue;
    if (!ren.has(f.code)) {
      missing.add(f.code);
      continue;
    }
    switch (f.kind) {
      case "point":
        ren.pointScreen(f.code, X(f.x), Y(f.y), f.angle ?? 0);
        break;
      case "line":
        ren.path(f.code, [f.pts.map(P)], !!f.closed);
        break;
      case "area":
        ren.path(f.code, f.rings.map((r) => r.map(P)), true);
        break;
      case "text":
        ren.textScreen(f.code, X(f.x), Y(f.y), f.text, f.angle ?? 0);
        break;
    }
  }
  if (missing.size) console.warn("Symbols not in set:", [...missing].join(", "));

  const F = l.frame;
  const fx = F.x0 * 1000;
  const fy = F.y0 * 1000;
  const fw = (F.x1 - F.x0) * 1000;
  const fh = (F.y1 - F.y0) * 1000;
  const layerStyle = (c: { name: string }) => (opts.overprint !== false && /purple/i.test(c.name) ? "mix-blend-mode:multiply" : undefined);

  let svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${p.widthMm * 1000} ${p.heightMm * 1000}" width="${p.widthMm}mm" height="${p.heightMm}mm">` +
    `<defs><clipPath id="frame"><rect x="${fx}" y="${fy}" width="${fw}" height="${fh}"/></clipPath></defs>` +
    ren.out.defsSvg() +
    `<rect width="100%" height="100%" fill="#fff"/>` +
    `<g id="map" clip-path="url(#frame)"><rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="#fff"/>${ren.out.body(set.colors, { layerIds: true })}</g>` +
    `<rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="none" stroke="#000" stroke-width="250"/>`;

  // --- title box
  if (opts.showTitle !== false) svg += titleBox(p, l.title, model.course, m);

  // --- control description sheet
  const course = opts.showCourse !== false ? model.course : undefined;
  if (course && l.sheet && opts.showSheet !== false) {
    const sheet = descriptionSheet(course, new DescLookup(desc), { title: p.title });
    const s = l.sheet;
    svg += `<svg x="${s.x0 * 1000}" y="${s.y0 * 1000}" width="${(s.x1 - s.x0) * 1000}" height="${(s.y1 - s.y0) * 1000}" viewBox="0 0 ${sheet.width} ${sheet.height}">${sheet.body}</svg>`;
  }

  // --- course overprint
  if (course) {
    const cren = new SymbolRenderer(set, { scale: k, tolerance: 150, idPrefix: "c" });
    drawCourse(cren, course, P, k, p.course.legs !== false);
    svg += `<g id="course">${cren.out.defsSvg()}${cren.out.body(set.colors, { layerIds: true, layerStyle })}</g>`;
  }
  return svg + `</svg>`;
}

function drawCourse(ren: SymbolRenderer, course: Course, P: (q: Pt) => Pt, k: number, legs = true) {
  const um = (mm: number) => mm * 1000 * k;
  const start = P(course.start);
  const ctrls = course.controls.map((c) => P(c));
  const finish = P(course.finish);
  const seq = [start, ...ctrls, finish];
  const radius = (i: number) => (i === 0 ? um(3.45) : i === seq.length - 1 ? um(3.85) : um(2.95));

  // Start triangle points towards the first control.
  const first = seq[1];
  ren.pointScreen("701", start.x, start.y, upAngle(first.x - start.x, first.y - start.y));
  for (const c of ctrls) ren.point("703", c.x, c.y);
  ren.point("706", finish.x, finish.y);

  const ex = course.extras;
  if (ex) {
    for (const r of ex.oobAreas) {
      ren.path("709", [r.map(P)], true);
      ren.path("709.1", [[...r, r[0]].map(P)], false);
    }
    for (const l of ex.oobLines) ren.path("708", [l.map(P)], false);
    for (const l of ex.oobRoutes) ren.path("711", [l.map(P)], false);
    for (const c of ex.crossings) {
      const q = P(c);
      ren.pointScreen("710", q.x, q.y, c.angle + Math.PI / 2);
    }
    if (ex.marked && ex.marked.length > 1) ren.path("707", [ex.marked.map(P)], false);
    if (ex.issue) {
      const q = P(ex.issue);
      ren.point("702", q.x, q.y);
    }
    if (ex.firstAid) {
      const q = P(ex.firstAid);
      ren.point("712", q.x, q.y);
    }
    for (const r of ex.refreshments) {
      const q = P(r);
      ren.point("713", q.x, q.y);
    }
  }

  for (let i = 0; legs && i + 1 < seq.length; i++) {
    const a = seq[i];
    const b = seq[i + 1];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const ra = radius(i);
    const rb = radius(i + 1);
    if (d <= ra + rb + um(0.5)) continue;
    const ux = (b.x - a.x) / d;
    const uy = (b.y - a.y) / d;
    ren.path("705", [[{ x: a.x + ux * ra, y: a.y + uy * ra }, { x: b.x - ux * rb, y: b.y - uy * rb }]], false);
  }

  // Control numbers: placed in the free direction furthest from the in/out legs and other controls.
  ctrls.forEach((c, i) => {
    const dirs: number[] = [];
    const prev = seq[i];
    const next = seq[i + 2];
    dirs.push(Math.atan2(prev.y - c.y, prev.x - c.x), Math.atan2(next.y - c.y, next.x - c.x));
    const dist = um(2.95 + 2.6);
    let best = 0;
    let bestScore = -Infinity;
    for (let a = 0; a < 24; a++) {
      const ang = (a / 24) * Math.PI * 2;
      let score = Math.min(...dirs.map((d) => Math.abs(Math.atan2(Math.sin(ang - d), Math.cos(ang - d)))));
      const tx = c.x + Math.cos(ang) * dist;
      const ty = c.y + Math.sin(ang) * dist;
      for (const o of seq) if (o !== c && Math.hypot(o.x - tx, o.y - ty) < um(5)) score -= 3;
      // Slight preference for the classic upper-right position.
      score += 0.15 * Math.cos(ang + Math.PI / 4);
      if (score > bestScore) {
        bestScore = score;
        best = ang;
      }
    }
    ren.text("704", c.x + Math.cos(best) * dist, c.y + Math.sin(best) * dist, String(i + 1));
  });
}

function titleBox(p: MapParams, r: { x0: number; y0: number; x1: number; y1: number }, course: Course | undefined, m: number): string {
  const x0 = r.x0 * 1000;
  const y0 = r.y0 * 1000;
  const w = (r.x1 - r.x0) * 1000;
  const h = (r.y1 - r.y0) * 1000;
  const font = `font-family="Arial, Helvetica, sans-serif"`;
  let s = `<g id="title"><rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#fff" stroke="#000" stroke-width="250"/>`;
  s += `<text x="${x0 + 2500}" y="${y0 + 6500}" ${font} font-size="5200" font-weight="bold">${esc(p.title)}</text>`;
  s += `<text x="${x0 + 2500}" y="${y0 + 12000}" ${font} font-size="3600">1:${fmtScale(p.scale)}   ·   перетин: ${String(p.contourInterval).replace(".", ",")} м   ·   ISOM 2017-2</text>`;
  if (course) {
    s += `<text x="${x0 + 2500}" y="${y0 + 17000}" ${font} font-size="3400" fill="#97218b">${esc(course.name)}: ${(course.length / 1000).toFixed(1)} km, ${course.controls.length} КП, ↑${course.climb} m</text>`;
  }
  // Scale bar: 500 m in 100 m blocks.
  const block = (100 / m) * 1000;
  const bx = x0 + 2500;
  const by = y0 + h - 7500;
  for (let i = 0; i < 5; i++) {
    s += `<rect x="${bx + i * block}" y="${by}" width="${block}" height="1400" fill="${i % 2 ? "#fff" : "#000"}" stroke="#000" stroke-width="150"/>`;
  }
  for (const v of [0, 100, 500]) {
    s += `<text x="${bx + (v / 100) * block}" y="${by + 4200}" ${font} font-size="2600" text-anchor="middle">${v}</text>`;
  }
  s += `<text x="${bx + 5 * block + 2500}" y="${by + 1300}" ${font} font-size="2600">m</text>`;
  return s + `</g>`;
}
