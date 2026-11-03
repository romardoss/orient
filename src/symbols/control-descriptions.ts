/**
 * IOF control description symbols, from Purple Pen's symbols.xml (BSD-style license).
 *
 * Each symbol is drawn in a 200×200 box centred on (0,0) with y pointing up; instructional
 * (special) symbols in columns W–Z span 1600×200.
 */

export type DescOp =
  | { t: "lines" | "polygon" | "beziers"; pts: number[]; thickness: number; ends?: "round" | "flat"; corners?: "round" | "sharp" }
  | { t: "filled-polygon" | "filled-beziers"; pts: number[] }
  | { t: "circle"; pts: number[]; thickness: number; radius: number }
  | { t: "filled-circle"; pts: number[]; radius: number };

export interface DescSymbol {
  /** Column the symbol is normally used in: C, D, E, F, G, H, or W–Z for instructional lines. */
  kind: string;
  /** IOF 2004 id, e.g. "1.10"; suffixes like "N"/"NE" encode direction variants. */
  id: string;
  /** "2004" / "2018" when the drawing is specific to one standard version. */
  standard?: string;
  replacementId?: string;
  names: Record<string, string>;
  /** Singular textual description per language (may contain {0} placeholders). */
  texts: Record<string, string>;
  ops: DescOp[];
}

export interface DescSymbolSet {
  id: string;
  languages: Record<string, string>;
  symbols: DescSymbol[];
  source: string;
  license: string;
}

function kids(el: Element, name?: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!name || (n as Element).nodeName === name)) out.push(n as Element);
  }
  return out;
}

export function parseControlDescriptions(doc: Document, meta: { source: string; license: string }): DescSymbolSet {
  const root = doc.documentElement;
  const languages: Record<string, string> = {};
  for (const l of kids(root, "language")) {
    const code = l.getAttribute("lang");
    if (code) languages[code] = (l.textContent ?? code).trim();
  }
  const symbols: DescSymbol[] = [];
  for (const s of kids(root, "symbol")) {
    const sym: DescSymbol = {
      kind: s.getAttribute("kind") ?? "?",
      id: s.getAttribute("id") ?? "?",
      names: {},
      texts: {},
      ops: [],
    };
    const std = s.getAttribute("standard");
    if (std) sym.standard = std;
    const rep = s.getAttribute("replacement-id");
    if (rep) sym.replacementId = rep;
    for (const c of kids(s)) {
      const lang = c.getAttribute("lang") ?? "en";
      const pts = kids(c, "point").flatMap((p) => [Number(p.getAttribute("x")), Number(p.getAttribute("y"))]);
      const thickness = Number(c.getAttribute("thickness") ?? 0);
      switch (c.nodeName) {
        case "name":
          sym.names[lang] = (c.textContent ?? "").trim();
          break;
        case "text":
          // Keep the default (singular, no case/gender variant) text only.
          if (!c.getAttribute("plural") && !c.getAttribute("case") && !(lang in sym.texts)) {
            sym.texts[lang] = (c.textContent ?? "").trim();
          }
          break;
        case "lines":
        case "polygon":
        case "beziers": {
          const op: DescOp = { t: c.nodeName, pts, thickness };
          const ends = c.getAttribute("ends");
          const corners = c.getAttribute("corners");
          if (ends === "flat" || ends === "round") op.ends = ends;
          if (corners === "sharp" || corners === "round") op.corners = corners;
          sym.ops.push(op);
          break;
        }
        case "filled-polygon":
        case "filled-beziers":
          sym.ops.push({ t: c.nodeName, pts });
          break;
        case "circle":
          sym.ops.push({ t: "circle", pts, thickness, radius: Number(c.getAttribute("radius") ?? 0) });
          break;
        case "filled-circle":
          sym.ops.push({ t: "filled-circle", pts, radius: Number(c.getAttribute("radius") ?? 0) });
          break;
      }
    }
    symbols.push(sym);
  }
  return { id: "IOF Control Descriptions", languages, symbols, ...meta };
}

const f = (v: number) => Math.round(v * 100) / 100;

function pathD(op: DescOp, closed: boolean): string {
  const p = op.pts;
  if (op.t === "beziers" || op.t === "filled-beziers") {
    let d = `M${f(p[0])} ${f(-p[1])}`;
    for (let i = 2; i + 5 < p.length + 0; i += 6) {
      d += `C${f(p[i])} ${f(-p[i + 1])} ${f(p[i + 2])} ${f(-p[i + 3])} ${f(p[i + 4])} ${f(-p[i + 5])}`;
    }
    return closed ? d + "Z" : d;
  }
  let d = "";
  for (let i = 0; i + 1 < p.length; i += 2) d += `${i ? "L" : "M"}${f(p[i])} ${f(-p[i + 1])}`;
  return closed ? d + "Z" : d;
}

/** SVG elements (no <svg> wrapper) in the symbol's own coordinates, y flipped to point down. */
export function descSymbolBody(sym: DescSymbol, color = "currentColor"): string {
  let out = "";
  for (const op of sym.ops) {
    switch (op.t) {
      case "lines":
      case "beziers":
      case "polygon": {
        const cap = op.ends === "flat" ? "butt" : "round";
        const join = op.corners === "sharp" ? "miter" : "round";
        out += `<path d="${pathD(op, op.t === "polygon")}" fill="none" stroke="${color}" stroke-width="${f(op.thickness)}" stroke-linecap="${cap}" stroke-linejoin="${join}"/>`;
        break;
      }
      case "filled-polygon":
      case "filled-beziers":
        out += `<path d="${pathD(op, true)}" fill="${color}"/>`;
        break;
      case "circle":
        out += `<circle cx="${f(op.pts[0])}" cy="${f(-op.pts[1])}" r="${f(op.radius)}" fill="none" stroke="${color}" stroke-width="${f(op.thickness)}"/>`;
        break;
      case "filled-circle":
        out += `<circle cx="${f(op.pts[0])}" cy="${f(-op.pts[1])}" r="${f(op.radius)}" fill="${color}"/>`;
        break;
    }
  }
  return out;
}

export function isWide(sym: DescSymbol): boolean {
  return /^[V-Z]$/.test(sym.kind);
}

/** Standalone SVG for one control description symbol. */
export function descSymbolSvg(sym: DescSymbol, opts: { size?: string; color?: string; box?: boolean } = {}): string {
  const wide = isWide(sym);
  const vb = wide ? "-800 -100 1600 200" : "-100 -100 200 200";
  const color = opts.color ?? "#000";
  const dims = opts.size ? (wide ? ` width="${Number(opts.size) * 8 || opts.size}" height="${opts.size}"` : ` width="${opts.size}" height="${opts.size}"`) : "";
  const box = opts.box
    ? `<rect x="${wide ? -800 : -100}" y="-100" width="${wide ? 1600 : 200}" height="200" fill="#fff" stroke="${color}" stroke-width="6"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"${dims}>${box}${descSymbolBody(sym, color)}</svg>`;
}
