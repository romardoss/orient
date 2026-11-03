/** Renders a single symbol on a representative sample geometry, as a standalone SVG icon. */
import { type Bounds, type Pt, isEmpty } from "./geometry";
import { SymbolRenderer } from "./render";
import type { SymbolDef, SymbolSet } from "./types";

export interface IconOptions {
  /** Output width/height attributes, e.g. "64" or "12mm". Omit for a size-less SVG. */
  size?: string;
  /** When true, width/height are the true printed size in mm at the set's base scale. */
  trueSize?: boolean;
  /** Smallest viewBox side (µm) so that tiny dots don't fill the whole icon. */
  minExtent?: number;
  background?: string;
  /** Prefix for <defs> ids; must be unique when several icons share one document. */
  idPrefix?: string;
}

type Shape = "point" | "line" | "area" | "text";

function resolveShape(set: SymbolSet, sym: SymbolDef, depth = 0): Shape {
  switch (sym.type) {
    case "point":
      return "point";
    case "line":
      return "line";
    case "area":
      return "area";
    case "text":
      return "text";
    case "combined": {
      if (depth > 4) return "line";
      let shape: Shape = "line";
      for (const part of sym.parts) {
        const s = "ref" in part ? set.symbols.find((x) => x.id === part.ref) : part.symbol;
        if (!s) continue;
        const sh = resolveShape(set, s, depth + 1);
        if (sh === "area") return "area";
        if (sh === "point") shape = "point";
      }
      return shape;
    }
  }
}

/** Longest repeat length along a line symbol, so the sample shows at least a couple of repeats. */
function lineRepeat(sym: SymbolDef): number {
  if (sym.type !== "line") return 0;
  let rep = 0;
  if (sym.dashed) rep = sym.dashesInGroup * sym.dashLength + (sym.dashesInGroup - 1) * sym.inGroupBreakLength + sym.breakLength;
  if (sym.midSymbol) rep = Math.max(rep, sym.segmentLength + 2 * sym.endLength);
  return rep;
}

function areaRepeat(set: SymbolSet, sym: SymbolDef, depth = 0): number {
  if (depth > 4) return 0;
  if (sym.type === "area") {
    let rep = 0;
    for (const p of sym.patterns) rep = Math.max(rep, p.spacing, p.kind === "point" ? p.distance : 0);
    return rep;
  }
  if (sym.type === "combined") {
    let rep = 0;
    for (const part of sym.parts) {
      const s = "ref" in part ? set.symbols.find((x) => x.id === part.ref) : part.symbol;
      if (s) rep = Math.max(rep, areaRepeat(set, s, depth + 1), lineRepeat(s));
    }
    return rep;
  }
  return lineRepeat(sym);
}

/** Gentle S-shaped sample line from -len/2 to +len/2. */
export function sampleLine(len: number): Pt[] {
  const pts: Pt[] = [];
  const n = 48;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: (t - 0.5) * len, y: Math.sin(t * Math.PI * 2) * len * 0.08 });
  }
  return pts;
}

/** Soft blob used as sample area. */
export function sampleArea(size: number): Pt[] {
  const pts: Pt[] = [];
  const n = 64;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = (size / 2) * (1 + 0.06 * Math.sin(3 * a) + 0.04 * Math.cos(5 * a));
    pts.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr });
  }
  return pts;
}

export interface RenderedIcon {
  svg: string;
  bounds: Bounds;
  shape: Shape;
}

export function renderIcon(set: SymbolSet, sym: SymbolDef, opts: IconOptions = {}): RenderedIcon {
  const ren = new SymbolRenderer(set, { idPrefix: opts.idPrefix ?? `i${sym.id ?? "x"}_` });
  const shape = resolveShape(set, sym);
  if (shape === "point") {
    ren.point(sym, 0, 0);
  } else if (shape === "text") {
    ren.text(sym, 0, 0, sym.type === "text" ? sym.iconText : "A");
  } else if (shape === "line") {
    const len = Math.min(30000, Math.max(8000, lineRepeat(sym) * 2.2));
    ren.path(sym, [sampleLine(len)], false);
  } else {
    const size = Math.min(24000, Math.max(6000, areaRepeat(set, sym) * 2.5));
    ren.path(sym, [sampleArea(size)], true);
  }

  const b = ren.out.bounds;
  if (isEmpty(b)) {
    b.minX = b.minY = -500;
    b.maxX = b.maxY = 500;
  }
  // Square viewBox centred on the content, with a margin.
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const half = Math.max(b.maxX - b.minX, b.maxY - b.minY, opts.minExtent ?? 1200) * 0.56;
  const vb: Bounds = { minX: cx - half, minY: cy - half, maxX: cx + half, maxY: cy + half };
  let size: { width: string; height: string } | undefined;
  if (opts.trueSize) {
    const mm = `${Math.round((half * 2) / 10) / 100}mm`;
    size = { width: mm, height: mm };
  } else if (opts.size) {
    size = { width: opts.size, height: opts.size };
  }
  const bg = opts.background
    ? `<rect x="${vb.minX}" y="${vb.minY}" width="${half * 2}" height="${half * 2}" fill="${opts.background}"/>`
    : "";
  let svg = ren.toSvg(vb, size);
  if (bg) svg = svg.replace(/(<svg[^>]*>)/, `$1${bg}`);
  return { svg, bounds: vb, shape };
}
