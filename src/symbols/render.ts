/**
 * SVG renderer for OpenOrienteering Mapper symbol definitions.
 *
 * Output is organised in one <g> layer per map colour, stacked by colour priority, which is how
 * orienteering maps are printed (e.g. black above brown above yellow). All coordinates are in µm
 * of paper; callers set an SVG viewBox accordingly.
 */
import {
  type Bounds,
  Measured,
  type Mat,
  type PathPart,
  type Pt,
  apply,
  coordsToParts,
  emptyBounds,
  extend,
  matScale,
  mul,
  offsetPolyline,
  placement,
} from "./geometry";
import type {
  AreaSymbolDef,
  ColorDef,
  LineSymbolDef,
  LinePattern,
  PointPattern,
  PointSymbolDef,
  SymbolDef,
  SymbolSet,
  TextSymbolDef,
} from "./types";

import { REGISTRATION_COLOR } from "./colors";

/** True when a colour index refers to "no colour". */
const none = (c: number) => c < 0 && c !== REGISTRATION_COLOR;

const r = (v: number) => Math.round(v * 10) / 10;

function polyD(pts: Pt[], closed: boolean): string {
  if (pts.length === 0) return "";
  let d = `M${r(pts[0].x)} ${r(pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) d += `L${r(pts[i].x)} ${r(pts[i].y)}`;
  if (closed) d += "Z";
  return d;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Collects SVG elements per colour layer, plus shared <defs>. */
export class SvgLayers {
  readonly layers = new Map<number, string[]>();
  readonly defs = new Map<string, string>();
  readonly bounds: Bounds = emptyBounds();

  add(color: number, el: string): void {
    if (none(color)) return;
    let l = this.layers.get(color);
    if (!l) this.layers.set(color, (l = []));
    l.push(el);
  }

  /**
   * Renders the layers (bottom-most colour first). `layerStyle` may return extra CSS for a
   * colour's layer, e.g. "mix-blend-mode:multiply" to simulate overprinted purple.
   */
  body(colors: ColorDef[], opts: { layerIds?: boolean; layerStyle?: (c: ColorDef) => string | undefined } = {}): string {
    const byIndex = new Map(colors.map((c) => [c.index, c]));
    const order = [...this.layers.keys()].sort(
      (a, b) => (byIndex.get(b)?.priority ?? b) - (byIndex.get(a)?.priority ?? a),
    );
    let out = "";
    for (const ci of order) {
      const c = byIndex.get(ci);
      const fill = c?.rgb ?? "#000";
      const id = opts.layerIds && c ? ` data-color="${esc(c.name)}"` : "";
      const css = c && opts.layerStyle?.(c);
      const style = css ? ` style="${css}"` : "";
      out += `<g${id}${style} fill="${fill}" stroke="${fill}">${this.layers.get(ci)!.join("")}</g>`;
    }
    return out;
  }

  defsSvg(): string {
    return this.defs.size ? `<defs>${[...this.defs.values()].join("")}</defs>` : "";
  }
}

export interface RenderOptions {
  /** Symbol size factor, e.g. 1.5 to draw a 1:15000 set on a 1:10000 map. */
  scale?: number;
  /** Bézier flattening segment length in µm. */
  tolerance?: number;
  /** Prefix for generated <defs> ids (keeps ids unique when several SVGs are inlined in one page). */
  idPrefix?: string;
  /** Size factor for point symbols only (defaults to `scale`); lets maps enlarge point symbols a bit more than lines. */
  pointScale?: number;
}

export type SymbolRef = SymbolDef | string;

export class SymbolRenderer {
  readonly set: SymbolSet;
  readonly out: SvgLayers;
  readonly scale: number;
  readonly pointScale: number;
  readonly tol: number;
  readonly idPrefix: string;
  private readonly byCode = new Map<string, SymbolDef>();
  private readonly byId = new Map<number, SymbolDef>();
  private patternSeq = 0;
  private readonly patternIds = new WeakMap<object, Map<number, { id: string; color: number }>>();

  constructor(set: SymbolSet, opts: RenderOptions = {}, out = new SvgLayers()) {
    this.set = set;
    this.out = out;
    this.scale = opts.scale ?? 1;
    this.pointScale = opts.pointScale ?? this.scale;
    this.tol = opts.tolerance ?? 120;
    this.idPrefix = opts.idPrefix ?? "p";
    for (const s of set.symbols) {
      if (s.id !== undefined) this.byId.set(s.id, s);
      // Prefer visible symbols when several share a code.
      if (s.code && (!this.byCode.has(s.code) || this.byCode.get(s.code)!.hidden)) this.byCode.set(s.code, s);
    }
  }

  resolve(ref: SymbolRef): SymbolDef {
    if (typeof ref !== "string") return ref;
    const s = this.byCode.get(ref);
    if (!s) throw new Error(`Unknown symbol code ${ref} in ${this.set.id}`);
    return s;
  }

  has(code: string): boolean {
    return this.byCode.has(code);
  }

  /** Full standalone SVG document for everything drawn so far. */
  toSvg(viewBox: Bounds, size?: { width: string; height: string }, extra = ""): string {
    const w = viewBox.maxX - viewBox.minX;
    const h = viewBox.maxY - viewBox.minY;
    const dims = size ? ` width="${size.width}" height="${size.height}"` : "";
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r(viewBox.minX)} ${r(viewBox.minY)} ${r(w)} ${r(h)}"${dims}>` +
      this.out.defsSvg() +
      this.out.body(this.set.colors, { layerIds: true }) +
      extra +
      `</svg>`
    );
  }

  // ---------------------------------------------------------------- public drawing API

  /** Draws a point symbol (or text / combined) at (x, y). `rotation` is CCW radians, as in Mapper. */
  point(ref: SymbolRef, x: number, y: number, rotation = 0): void {
    const sym = this.resolve(ref);
    this.drawAtPoint(sym, placement(x, y, -rotation, this.pointScale));
  }

  /** Like point(), but `angle` is the screen angle (radians, y-down) of the symbol's x axis. */
  pointScreen(ref: SymbolRef, x: number, y: number, angle = 0): void {
    this.drawAtPoint(this.resolve(ref), placement(x, y, angle, this.pointScale));
  }

  /** Text with its baseline along the screen angle `angle`. */
  textScreen(ref: SymbolRef, x: number, y: number, text: string, angle = 0): void {
    const sym = this.resolve(ref);
    if (sym.type !== "text") throw new Error(`${sym.code} is not a text symbol`);
    this.drawText(sym, x, y, text, angle, this.scale);
  }

  /** Draws a line, area or combined symbol along/inside the given polylines. */
  path(ref: SymbolRef, polylines: Pt[][], closed: boolean): void {
    const parts: PathPart[] = polylines.filter((p) => p.length > 1).map((pts) => ({ pts, closed, dashIdx: [] }));
    if (parts.length) this.drawOnPath(this.resolve(ref), parts, this.scale);
  }

  /** Draws using raw parts (lets callers mix open/closed parts or mark dash points). */
  parts(ref: SymbolRef, parts: PathPart[]): void {
    if (parts.length) this.drawOnPath(this.resolve(ref), parts, this.scale);
  }

  text(ref: SymbolRef, x: number, y: number, text: string, rotation = 0): void {
    const sym = this.resolve(ref);
    if (sym.type !== "text") throw new Error(`${sym.code} is not a text symbol`);
    this.drawText(sym, x, y, text, -rotation, this.scale);
  }

  // ---------------------------------------------------------------- dispatch

  private drawAtPoint(sym: SymbolDef, m: Mat): void {
    switch (sym.type) {
      case "point":
        this.drawPoint(sym, m);
        break;
      case "text": {
        const p = apply(m, { x: 0, y: 0 });
        this.drawText(sym, p.x, p.y, sym.iconText, Math.atan2(m[1], m[0]), matScale(m));
        break;
      }
      case "combined":
        for (const part of sym.parts) {
          const s = "ref" in part ? this.byId.get(part.ref) : part.symbol;
          if (s) this.drawAtPoint(s, m);
        }
        break;
      default:
        break; // line/area symbols need a path
    }
  }

  private drawOnPath(sym: SymbolDef, parts: PathPart[], k: number): void {
    switch (sym.type) {
      case "line":
        for (const p of parts) this.drawLinePart(sym, p, k);
        break;
      case "area":
        this.drawArea(sym, parts, k);
        break;
      case "combined":
        for (const part of sym.parts) {
          const s = "ref" in part ? this.byId.get(part.ref) : part.symbol;
          if (s) this.drawOnPath(s, parts, k);
        }
        break;
      case "point": {
        // Point symbol given a path: place it at the first vertex.
        const p = parts[0].pts[0];
        this.drawPoint(sym, placement(p.x, p.y, 0, k));
        break;
      }
      case "text":
        break;
    }
  }

  // ---------------------------------------------------------------- primitives

  private circle(color: number, c: Pt, radius: number): void {
    if (none(color) || radius <= 0) return;
    this.out.add(color, `<circle cx="${r(c.x)}" cy="${r(c.y)}" r="${r(radius)}" stroke="none"/>`);
    extend(this.out.bounds, c.x, c.y, radius);
  }

  private ring(color: number, c: Pt, radius: number, width: number): void {
    if (none(color) || width <= 0) return;
    this.out.add(
      color,
      `<circle cx="${r(c.x)}" cy="${r(c.y)}" r="${r(radius)}" fill="none" stroke-width="${r(width)}"/>`,
    );
    extend(this.out.bounds, c.x, c.y, radius + width / 2);
  }

  private stroke(
    color: number,
    pts: Pt[],
    closed: boolean,
    width: number,
    cap: string,
    join: string,
    dash?: number[],
  ): void {
    if (none(color) || width <= 0 || pts.length < 2) return;
    let attrs = ` fill="none" stroke-width="${r(width)}"`;
    if (cap !== "butt") attrs += ` stroke-linecap="${cap}"`;
    if (join !== "miter") attrs += ` stroke-linejoin="${join}"`;
    else attrs += ` stroke-miterlimit="3"`;
    if (dash && dash.length) attrs += ` stroke-dasharray="${dash.map(r).join(" ")}"`;
    this.out.add(color, `<path d="${polyD(pts, closed)}"${attrs}/>`);
    for (const p of pts) extend(this.out.bounds, p.x, p.y, width / 2);
  }

  private fill(color: number, parts: PathPart[], paint?: string): void {
    if (none(color)) return;
    const d = parts.map((p) => polyD(p.pts, true)).join("");
    if (!d) return;
    const f = paint ? ` fill="${paint}"` : "";
    this.out.add(color, `<path d="${d}"${f} stroke="none" fill-rule="evenodd"/>`);
    for (const p of parts) for (const q of p.pts) extend(this.out.bounds, q.x, q.y);
  }

  // ---------------------------------------------------------------- point symbols

  private drawPoint(sym: PointSymbolDef, m: Mat): void {
    const s = matScale(m);
    const c = apply(m, { x: 0, y: 0 });
    if (!none(sym.innerColor) && sym.innerRadius > 0) this.circle(sym.innerColor, c, sym.innerRadius * s);
    if (!none(sym.outerColor) && sym.outerWidth > 0) {
      this.ring(sym.outerColor, c, (sym.innerRadius + sym.outerWidth / 2) * s, sym.outerWidth * s);
    }
    for (const el of sym.elements) {
      const obj = el.object;
      if (obj.kind === "point") {
        const [x, y] = obj.coords[0] ?? [0, 0, 0];
        this.drawAtPoint(el.symbol, mul(m, placement(x, y, -obj.rotation)));
      } else {
        const parts = coordsToParts(obj.coords, m, this.tol);
        if (parts.length) this.drawOnPath(el.symbol, parts, s);
      }
    }
  }

  // ---------------------------------------------------------------- text symbols

  private drawText(sym: TextSymbolDef, x: number, y: number, text: string, angle: number, k: number): void {
    const size = sym.fontSize * k;
    const rot = angle ? ` transform="rotate(${r((angle * 180) / Math.PI)} ${r(x)} ${r(y)})"` : "";
    const weight = sym.bold ? ` font-weight="bold"` : "";
    const style = sym.italic ? ` font-style="italic"` : "";
    const family = sym.fontFamily === "Sans Serif" ? "Arial, Helvetica, sans-serif" : `${sym.fontFamily}, sans-serif`;
    this.out.add(
      sym.color,
      `<text x="${r(x)}" y="${r(y)}" stroke="none" font-family="${esc(family)}" font-size="${r(size)}"${weight}${style} text-anchor="middle" dominant-baseline="central"${rot}>${esc(text)}</text>`,
    );
    const w = size * 0.6 * text.length;
    extend(this.out.bounds, x - w / 2, y - size / 2);
    extend(this.out.bounds, x + w / 2, y + size / 2);
  }

  // ---------------------------------------------------------------- line symbols

  private drawLinePart(sym: LineSymbolDef, part: PathPart, k: number): void {
    let line = new Measured(part.pts, part.closed);
    if (line.length <= 0) return;
    const closed = part.closed;

    if (!closed && (sym.startOffset > 0 || sym.endOffset > 0)) {
      const s0 = sym.startOffset * k;
      const s1 = line.length - sym.endOffset * k;
      if (s1 - s0 <= 0) return;
      line = new Measured(line.slice(s0, s1), false);
    }
    const pts = closed ? line.pts.slice(0, -1) : line.pts;
    const L = line.length;
    const cap = sym.cap === "round" ? "round" : sym.cap === "square" ? "square" : "butt";
    const join = sym.join === "round" ? "round" : sym.join === "bevel" ? "bevel" : "miter";

    // Borders (e.g. the black edges of roads).
    if (sym.borders) {
      for (const [b, side] of [
        [sym.borders.left, -1],
        [sym.borders.right, 1],
      ] as const) {
        if (none(b.color) || b.width <= 0) continue;
        const off = side * (sym.width / 2 + b.shift) * k;
        const opts = offsetPolyline(pts, closed, off);
        const dash = b.dashed ? [b.dashLength * k, b.breakLength * k] : undefined;
        this.stroke(b.color, opts, closed, b.width * k, "butt", "miter", dash);
      }
    }

    // Dash layout, also used to place mid symbols.
    let dashes: { start: number; end: number }[] | undefined;
    let groups: { start: number; end: number }[] | undefined;
    if (sym.dashed) {
      const layout = layoutDashes(sym, L, closed, k);
      if (layout) {
        dashes = layout.dashes;
        groups = layout.groups;
      }
    }

    if (!none(sym.color) && sym.width > 0) {
      if (dashes) {
        const dashArr: number[] = [];
        for (let i = 0; i < dashes.length; i++) {
          const d = dashes[i];
          const next = dashes[i + 1];
          dashArr.push(d.end - d.start, next ? next.start - d.end : L);
        }
        this.stroke(sym.color, pts, closed, sym.width * k, cap, join, dashArr);
      } else {
        this.stroke(sym.color, pts, closed, sym.width * k, cap, join);
      }
    }

    // Mid symbols.
    if (sym.midSymbol && sym.midSymbolPlacement !== 3 && sym.midSymbolsPerSpot > 0) {
      const spots: number[] = [];
      if (dashes && groups) {
        if (sym.midSymbolPlacement === 2) {
          for (let i = 0; i + 1 < groups.length; i++) spots.push((groups[i].end + groups[i + 1].start) / 2);
          if (closed && groups.length) spots.push((groups[groups.length - 1].end + L) / 2);
        } else if (sym.midSymbolPlacement === 1) {
          for (const g of groups) spots.push((g.start + g.end) / 2);
        } else {
          for (const d of dashes) spots.push((d.start + d.end) / 2);
        }
      } else {
        spots.push(...midSpots(sym, L, closed, k));
      }
      const n = sym.midSymbolsPerSpot;
      const gap = sym.midSymbolDistance * k;
      for (const s of spots) {
        for (let j = 0; j < n; j++) {
          const pos = s + (j - (n - 1) / 2) * gap;
          if (pos < 0 || pos > L) continue;
          const p = line.at(pos);
          this.drawPoint(sym.midSymbol, placement(p.x, p.y, p.angle, k));
        }
      }
    }

    if (!closed) {
      if (sym.startSymbol) {
        const p = line.at(0);
        this.drawPoint(sym.startSymbol, placement(p.x, p.y, p.angle, k));
      }
      if (sym.endSymbol) {
        const p = line.at(L);
        this.drawPoint(sym.endSymbol, placement(p.x, p.y, p.angle, k));
      }
    }

    if (sym.dashSymbol && part.dashIdx.length) {
      for (const idx of part.dashIdx) {
        if (sym.suppressDashSymbolAtEnds && !closed && (idx === 0 || idx === part.pts.length - 1)) continue;
        const s = line.lengthAt(idx);
        const before = line.at(Math.max(0, s - 1));
        const after = line.at(Math.min(L, s + 1));
        const angle = Math.atan2(after.y - before.y, after.x - before.x);
        const p = line.at(s);
        this.drawPoint(sym.dashSymbol, placement(p.x, p.y, angle, k));
      }
    }
  }

  // ---------------------------------------------------------------- area symbols

  private drawArea(sym: AreaSymbolDef, parts: PathPart[], k: number): void {
    if (!none(sym.color)) this.fill(sym.color, parts);
    for (const pat of sym.patterns) {
      const p = this.patternFor(pat, k);
      if (p) this.fill(p.color, parts, `url(#${p.id})`);
    }
  }

  private patternFor(pat: LinePattern | PointPattern, k: number): { id: string; color: number } | undefined {
    let perScale = this.patternIds.get(pat);
    if (!perScale) this.patternIds.set(pat, (perScale = new Map()));
    const cached = perScale.get(k);
    if (cached) return cached;

    const id = `${this.idPrefix}${this.patternSeq++}`;
    const deg = r((-pat.angle * 180) / Math.PI);
    const tr = deg ? ` patternTransform="rotate(${deg})"` : "";
    const H = pat.spacing * k;
    let result: { id: string; color: number } | undefined;

    if (pat.kind === "line") {
      if (none(pat.color) || pat.width <= 0 || H <= 0) return undefined;
      const W = H;
      const color = this.set.colors.find((c) => c.index === pat.color)?.rgb ?? "#000";
      const y0 = (((pat.offset * k) % H) + H) % H;
      let lines = "";
      for (const y of [y0 - H, y0, y0 + H]) {
        lines += `<path d="M0 ${r(y)}H${r(W)}"/>`;
      }
      this.out.defs.set(
        id,
        `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${r(W)}" height="${r(H)}"${tr}><g stroke="${color}" stroke-width="${r(pat.width * k)}" fill="none">${lines}</g></pattern>`,
      );
      result = { id, color: pat.color };
    } else {
      const W = pat.distance * k;
      if (W <= 0 || H <= 0) return undefined;
      const ox = pat.offsetAlong * k;
      const oy = pat.offset * k;
      // Measure one instance, then repeat it as often as needed to cover the tile [0,W]x[0,H].
      const probe = new SymbolRenderer(this.set, { scale: 1, tolerance: this.tol });
      probe.drawPoint(pat.symbol, placement(ox, oy, 0, k));
      const pb = probe.out.bounds;
      if (pb.maxX < pb.minX) return undefined;
      const sub = new SymbolRenderer(this.set, { scale: 1, tolerance: this.tol, idPrefix: `${id}_` });
      const ix0 = Math.floor(-pb.maxX / W);
      const ix1 = Math.ceil((W - pb.minX) / W);
      const iy0 = Math.floor(-pb.maxY / H);
      const iy1 = Math.ceil((H - pb.minY) / H);
      for (let dx = ix0; dx <= ix1; dx++) {
        for (let dy = iy0; dy <= iy1; dy++) {
          const bx0 = pb.minX + dx * W;
          const by0 = pb.minY + dy * H;
          if (bx0 > W || by0 > H || pb.maxX + dx * W < 0 || pb.maxY + dy * H < 0) continue;
          sub.drawPoint(pat.symbol, placement(ox + dx * W, oy + dy * H, 0, k));
        }
      }
      const colorsUsed = [...sub.out.layers.keys()];
      if (!colorsUsed.length) return undefined;
      // Put the pattern on the layer of its top-most colour.
      const prio = (ci: number) => this.set.colors.find((c) => c.index === ci)?.priority ?? ci;
      const color = colorsUsed.reduce((a, b) => (prio(a) <= prio(b) ? a : b));
      for (const [dk, dv] of sub.out.defs) this.out.defs.set(dk, dv);
      this.out.defs.set(
        id,
        `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${r(W)}" height="${r(H)}"${tr}>${sub.out.body(this.set.colors)}</pattern>`,
      );
      result = { id, color };
    }
    perScale.set(k, result);
    return result;
  }
}

// ------------------------------------------------------------------ line layout helpers

/**
 * Lays out dashes so that an open line starts and ends with a full dash (Mapper behaviour),
 * stretching or compressing the pattern slightly. Returns undefined for a solid line.
 */
export function layoutDashes(
  sym: Pick<LineSymbolDef, "dashLength" | "breakLength" | "dashesInGroup" | "inGroupBreakLength" | "halfOuterDashes">,
  L: number,
  closed: boolean,
  k: number,
): { dashes: { start: number; end: number }[]; groups: { start: number; end: number }[] } | undefined {
  const d = sym.dashLength * k;
  const b = sym.breakLength * k;
  const n = sym.dashesInGroup;
  const ib = sym.inGroupBreakLength * k;
  const G = n * d + (n - 1) * ib;
  const period = G + b;
  if (period <= 0 || d <= 0) return undefined;
  if (!closed && L < G) return undefined;

  let count: number;
  let f: number;
  if (closed) {
    count = Math.max(1, Math.round(L / period));
    f = L / (count * period);
  } else {
    count = Math.max(1, Math.round((L + b) / period));
    // count groups and count-1 breaks must exactly fill the line.
    f = L / (count * G + (count - 1) * b);
  }
  const dashes: { start: number; end: number }[] = [];
  const groups: { start: number; end: number }[] = [];
  for (let g = 0; g < count; g++) {
    const gs = g * period * f;
    groups.push({ start: gs, end: gs + G * f });
    for (let j = 0; j < n; j++) {
      const s = gs + j * (d + ib) * f;
      dashes.push({ start: s, end: s + d * f });
    }
  }
  return { dashes, groups };
}

/** Mid-symbol spots for a continuous (non-dashed) line. */
export function midSpots(
  sym: Pick<LineSymbolDef, "segmentLength" | "endLength" | "showAtLeastOneSymbol" | "minimumMidSymbolCount">,
  L: number,
  closed: boolean,
  k: number,
): number[] {
  const seg = sym.segmentLength * k;
  if (seg <= 0) return [];
  if (closed) {
    const n = Math.max(1, Math.round(L / seg));
    return Array.from({ length: n }, (_, i) => (i * L) / n);
  }
  const e = sym.endLength * k;
  const usable = L - 2 * e;
  if (usable < 0) return sym.showAtLeastOneSymbol ? [L / 2] : [];
  const n = Math.round(usable / seg);
  if (n === 0) return sym.showAtLeastOneSymbol || usable > 0 ? [L / 2] : [];
  return Array.from({ length: n + 1 }, (_, i) => e + (i * usable) / n);
}
