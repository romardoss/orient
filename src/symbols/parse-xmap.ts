/**
 * Parser for OpenOrienteering Mapper symbol sets in the uncompressed XML format (.xmap, v9).
 *
 * Works with any W3C DOM implementation (browser DOMParser or @xmldom/xmldom in Node),
 * so it takes an already-parsed Document.
 */
import { REGISTRATION_COLOR, inkRgb } from "./colors";
import type {
  AreaSymbolDef,
  CapStyle,
  ColorDef,
  CombinedSymbolDef,
  Coord,
  ElementObject,
  JoinStyle,
  LineBorder,
  LineSymbolDef,
  PointSymbolDef,
  SymbolDef,
  SymbolElement,
  SymbolSet,
  TextSymbolDef,
} from "./types";

type El = Element;

function kids(el: El, name?: string): El[] {
  const out: El[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!name || localName(n as El) === name)) out.push(n as El);
  }
  return out;
}

function kid(el: El, name: string): El | undefined {
  return kids(el, name)[0];
}

function localName(el: El): string {
  return el.localName || el.nodeName.replace(/^.*:/, "");
}

function num(el: El, attr: string, fallback = 0): number {
  const v = el.getAttribute(attr);
  if (v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(el: El, attr: string, fallback = false): boolean {
  const v = el.getAttribute(attr);
  if (v === null) return fallback;
  return v === "true" || v === "1";
}

function str(el: El, attr: string): string | undefined {
  const v = el.getAttribute(attr);
  return v === null ? undefined : v;
}

function hex(v: number): string {
  return Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, "0");
}

function parseColor(el: El): ColorDef {
  const rgbEl = kid(el, "rgb");
  const r = rgbEl ? num(rgbEl, "r") : 0;
  const g = rgbEl ? num(rgbEl, "g") : 0;
  const b = rgbEl ? num(rgbEl, "b") : 0;
  const priority = num(el, "priority");
  const cmyk: ColorDef["cmyk"] = [num(el, "c"), num(el, "m"), num(el, "y"), num(el, "k")];
  return {
    index: priority,
    priority,
    name: str(el, "name") ?? `Color ${priority}`,
    rgb: inkRgb(cmyk),
    mapperRgb: `#${hex(r)}${hex(g)}${hex(b)}`,
    cmyk,
    opacity: num(el, "opacity", 1),
  };
}

function parseCoords(coordsEl: El | undefined): Coord[] {
  if (!coordsEl) return [];
  const coordEls = kids(coordsEl, "coord");
  if (coordEls.length > 0) {
    return coordEls.map((c) => [num(c, "x"), num(c, "y"), num(c, "flags")] as Coord);
  }
  // Compact text form: "x y flags;x y;..."
  const text = coordsEl.textContent ?? "";
  return text
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [x, y, f] = s.split(/\s+/).map(Number);
      return [x, y, f || 0] as Coord;
    });
}

function parseObject(el: El): ElementObject {
  const type = num(el, "type");
  return {
    kind: type === 0 ? "point" : "path",
    coords: parseCoords(kid(el, "coords")),
    rotation: num(el, "rotation"),
  };
}

const CAPS: CapStyle[] = ["flat", "round", "square", "pointed"];
const JOINS: JoinStyle[] = ["bevel", "miter", "round"];

function parseBorder(el: El): LineBorder {
  return {
    color: num(el, "color", -1),
    width: num(el, "width"),
    shift: num(el, "shift"),
    dashed: bool(el, "dashed"),
    dashLength: num(el, "dash_length", 2000),
    breakLength: num(el, "break_length", 1000),
  };
}

function nestedPoint(container: El | undefined): PointSymbolDef | undefined {
  if (!container) return undefined;
  const symEl = kid(container, "symbol");
  if (!symEl) return undefined;
  const s = parseSymbol(symEl);
  return s.type === "point" ? s : undefined;
}

function parsePoint(base: Partial<SymbolDef>, el: El): PointSymbolDef {
  const elements: SymbolElement[] = [];
  for (const e of kids(el, "element")) {
    const symEl = kid(e, "symbol");
    const objEl = kid(e, "object");
    if (!symEl || !objEl) continue;
    // Text objects (type 4) inside point symbols are only used by layout helpers; skip them.
    if (num(objEl, "type") === 4) continue;
    elements.push({ symbol: parseSymbol(symEl), object: parseObject(objEl) });
  }
  return {
    ...base,
    type: "point",
    rotatable: bool(el, "rotatable"),
    innerRadius: num(el, "inner_radius"),
    innerColor: num(el, "inner_color", -1),
    outerWidth: num(el, "outer_width"),
    outerColor: num(el, "outer_color", -1),
    elements,
  };
}

function parseLine(base: Partial<SymbolDef>, el: El): LineSymbolDef {
  let borders: LineSymbolDef["borders"];
  const bordersEl = kid(el, "borders");
  if (bordersEl) {
    const bs = kids(bordersEl, "border").map(parseBorder);
    if (bs.length >= 1) borders = { left: bs[0], right: bs[1] ?? bs[0] };
  }
  return {
    ...base,
    type: "line",
    color: num(el, "color", -1),
    width: num(el, "line_width"),
    minimumLength: num(el, "minimum_length"),
    cap: CAPS[num(el, "cap_style")] ?? "flat",
    join: JOINS[num(el, "join_style", 1)] ?? "miter",
    pointedCapLength: num(el, "pointed_cap_length"),
    startOffset: num(el, "start_offset"),
    endOffset: num(el, "end_offset"),
    dashed: bool(el, "dashed"),
    dashLength: num(el, "dash_length", 4000),
    breakLength: num(el, "break_length", 1000),
    dashesInGroup: Math.max(1, num(el, "dashes_in_group", 1)),
    inGroupBreakLength: num(el, "in_group_break_length", 500),
    halfOuterDashes: bool(el, "half_outer_dashes"),
    segmentLength: num(el, "segment_length", 4000),
    endLength: num(el, "end_length"),
    showAtLeastOneSymbol: bool(el, "show_at_least_one_symbol"),
    minimumMidSymbolCount: num(el, "minimum_mid_symbol_count"),
    midSymbolsPerSpot: num(el, "mid_symbols_per_spot", 1),
    midSymbolDistance: num(el, "mid_symbol_distance"),
    midSymbolPlacement: num(el, "mid_symbol_placement"),
    suppressDashSymbolAtEnds: bool(el, "suppress_dash_symbol_at_ends"),
    startSymbol: nestedPoint(kid(el, "start_symbol")),
    midSymbol: nestedPoint(kid(el, "mid_symbol")),
    endSymbol: nestedPoint(kid(el, "end_symbol")),
    dashSymbol: nestedPoint(kid(el, "dash_symbol")),
    borders,
  };
}

function parseArea(base: Partial<SymbolDef>, el: El): AreaSymbolDef {
  const patterns: AreaSymbolDef["patterns"] = [];
  for (const p of kids(el, "pattern")) {
    const type = num(p, "type");
    const common = {
      angle: num(p, "angle"),
      rotatable: bool(p, "rotatable"),
      spacing: num(p, "line_spacing", 1000),
      offset: num(p, "line_offset"),
    };
    if (type === 1) {
      patterns.push({ kind: "line", ...common, color: num(p, "color", -1), width: num(p, "line_width") });
    } else if (type === 2) {
      const symEl = kid(p, "symbol");
      const sym = symEl ? parseSymbol(symEl) : undefined;
      if (sym && sym.type === "point") {
        patterns.push({
          kind: "point",
          ...common,
          distance: num(p, "point_distance", 1000),
          offsetAlong: num(p, "offset_along_line"),
          clipping: num(p, "no_clipping"),
          symbol: sym,
        });
      }
    }
  }
  return {
    ...base,
    type: "area",
    color: num(el, "inner_color", -1),
    minArea: num(el, "min_area"),
    rotatable: bool(el, "rotatable"),
    patterns,
  };
}

function parseText(base: Partial<SymbolDef>, el: El): TextSymbolDef {
  const font = kid(el, "font");
  const text = kid(el, "text");
  return {
    ...base,
    type: "text",
    fontFamily: (font && str(font, "family")) || "sans-serif",
    fontSize: font ? num(font, "size", 4000) : 4000,
    bold: font ? bool(font, "bold") : false,
    italic: font ? bool(font, "italic") : false,
    color: text ? num(text, "color", -1) : -1,
    iconText: str(el, "icon_text") ?? "A",
  };
}

function parseCombined(base: Partial<SymbolDef>, el: El): CombinedSymbolDef {
  const parts: CombinedSymbolDef["parts"] = [];
  for (const p of kids(el, "part")) {
    if (bool(p, "private")) {
      const symEl = kid(p, "symbol");
      if (symEl) parts.push({ symbol: parseSymbol(symEl) });
    } else {
      parts.push({ ref: num(p, "symbol", -1) });
    }
  }
  return { ...base, type: "combined", parts };
}

export function parseSymbol(el: El): SymbolDef {
  const type = num(el, "type");
  const base: Partial<SymbolDef> = {};
  const id = str(el, "id");
  if (id !== undefined) base.id = Number(id);
  const code = str(el, "code");
  if (code) base.code = code;
  const name = str(el, "name");
  if (name) base.name = name;
  if (bool(el, "is_hidden")) base.hidden = true;
  const desc = kid(el, "description");
  if (desc && desc.textContent) base.description = desc.textContent.trim();

  switch (type) {
    case 1:
      return parsePoint(base, kid(el, "point_symbol")!);
    case 2:
      return parseLine(base, kid(el, "line_symbol")!);
    case 4:
      return parseArea(base, kid(el, "area_symbol")!);
    case 8:
      return parseText(base, kid(el, "text_symbol")!);
    case 16:
      return parseCombined(base, kid(el, "combined_symbol")!);
    default:
      throw new Error(`Unsupported symbol type ${type} (${code} ${name})`);
  }
}

export function parseXmap(doc: Document, meta: { source: string; license: string }): SymbolSet {
  const root = doc.documentElement;
  const geo = kid(root, "georeferencing");
  const colorsEl = kid(root, "colors");
  const colors = colorsEl ? kids(colorsEl, "color").map(parseColor) : [];
  // Registration colour: printed in all inks, drawn above everything else.
  colors.push({
    index: REGISTRATION_COLOR,
    priority: -1,
    name: "Registration black",
    rgb: "#000000",
    mapperRgb: "#000000",
    cmyk: [1, 1, 1, 1],
    opacity: 1,
  });

  // Symbols live either directly in <map><symbols> or inside a <barrier> wrapper.
  let symbolsEl = kid(root, "symbols");
  if (!symbolsEl) {
    for (const b of kids(root, "barrier")) {
      symbolsEl = kid(b, "symbols");
      if (symbolsEl) break;
    }
  }
  if (!symbolsEl) throw new Error("No <symbols> element found");

  return {
    id: str(symbolsEl, "id") ?? "symbols",
    scale: geo ? num(geo, "scale", 15000) : 15000,
    colors,
    symbols: kids(symbolsEl, "symbol").map(parseSymbol),
    source: meta.source,
    license: meta.license,
  };
}
