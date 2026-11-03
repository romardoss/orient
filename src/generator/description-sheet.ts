/**
 * IOF control description sheet (pictorial), drawn with the Purple Pen symbol definitions.
 * Units: one cell = 200 (Purple Pen's symbol box), so the sheet is 1600 wide.
 */
import { type DescSymbol, type DescSymbolSet, descSymbolBody } from "../symbols/control-descriptions";
import type { ControlDesc, Course } from "./model";

const CELL = 200;
const COLS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Column F holds either a combination symbol (crossing, junction, bend) or a dimension text. */
export function isFSymbol(v: string): boolean {
  return /^(10\.|11\.7)/.test(v);
}

export class DescLookup {
  private byKey = new Map<string, DescSymbol>();

  constructor(readonly set: DescSymbolSet) {
    for (const s of set.symbols) {
      // Prefer the 2018 drawing, then the standard-independent one; 2004-only drawings last.
      const key = s.id;
      const cur = this.byKey.get(key);
      const rank = (x: DescSymbol) => (x.standard === "2018" ? 3 : x.standard === undefined ? 2 : 1);
      if (!cur || rank(s) > rank(cur)) this.byKey.set(key, s);
    }
  }

  get(id: string): DescSymbol | undefined {
    return this.byKey.get(id);
  }

  name(id: string, lang = "en"): string {
    const s = this.get(id);
    return s?.names[lang] ?? s?.names.en ?? id;
  }
}

function symbolAt(sym: DescSymbol | undefined, col: number, row: number): string {
  if (!sym) return "";
  const cx = col * CELL + CELL / 2;
  const cy = row * CELL + CELL / 2;
  return `<g transform="translate(${cx} ${cy}) scale(0.92)">${descSymbolBody(sym, "#000")}</g>`;
}

function textAt(text: string, x: number, row: number, size = 120, weight = "bold", anchor = "middle"): string {
  return `<text x="${x}" y="${row * CELL + CELL / 2}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" dominant-baseline="central" fill="#000">${esc(text)}</text>`;
}

function descCells(desc: ControlDesc | undefined, row: number, lookup: DescLookup): string {
  if (!desc) return "";
  let out = "";
  for (const col of ["C", "D", "E", "F", "G", "H"] as const) {
    const v = desc[col];
    if (!v) continue;
    const ci = COLS.indexOf(col);
    const sym = col === "F" && !isFSymbol(v) ? undefined : lookup.get(v);
    if (sym) out += symbolAt(sym, ci, row);
    else out += textAt(v, ci * CELL + CELL / 2, row, 110, "normal");
  }
  return out;
}

export interface SheetOptions {
  title: string;
}

export function descriptionSheet(course: Course, lookup: DescLookup, opts: SheetOptions): { svg: string; body: string; width: number; height: number } {
  const rows = 4 + course.controls.length;
  const W = 8 * CELL;
  const H = rows * CELL;
  let body = `<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`;

  // Header rows.
  body += textAt(opts.title, W / 2, 0, 110);
  body += textAt(course.name, 1.5 * CELL, 1, 110);
  body += textAt(`${(course.length / 1000).toFixed(1)} km`, 4 * CELL, 1, 110);
  body += textAt(`${course.climb} m`, 6.5 * CELL, 1, 110);

  // Start row.
  body += symbolAt(lookup.get("start"), 0, 2);
  body += descCells(course.startDesc, 2, lookup);

  course.controls.forEach((c, i) => {
    const row = 3 + i;
    body += textAt(String(i + 1), CELL / 2, row, 120);
    body += textAt(String(c.code), 1.5 * CELL, row, 120);
    body += descCells(c.desc, row, lookup);
  });

  // Finish instruction (navigate to finish), with the distance in the middle.
  const finRow = rows - 1;
  const fin = lookup.get("14.3");
  if (fin) body += `<g transform="translate(${W / 2} ${finRow * CELL + CELL / 2}) scale(0.92 0.92)">${descSymbolBody(fin, "#000")}</g>`;
  body += `<rect x="${W / 2 - 230}" y="${finRow * CELL + 50}" width="460" height="100" fill="#fff"/>`;
  body += textAt(`${course.finishDistance} m`, W / 2, finRow, 100, "bold");

  // Grid lines: thin between cells, thick under the header and every third control.
  let grid = "";
  for (let r = 1; r < rows; r++) {
    const thick = r === 2 || r === 3 || (r > 3 && (r - 3) % 3 === 0) || r === rows - 1;
    grid += `<path d="M0 ${r * CELL}H${W}" stroke-width="${thick ? 12 : 5}"/>`;
  }
  for (let c = 1; c < 8; c++) {
    // Columns only within control rows (start row included).
    grid += `<path d="M${c * CELL} ${2 * CELL}V${(rows - 1) * CELL}" stroke-width="5"/>`;
  }
  grid += `<path d="M${3 * CELL} ${CELL}V${2 * CELL}M${5 * CELL} ${CELL}V${2 * CELL}" stroke-width="5"/>`;
  grid += `<rect x="6" y="6" width="${W - 12}" height="${H - 12}" fill="none" stroke-width="12"/>`;
  body += `<g stroke="#000" fill="none">${grid}</g>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${(W / CELL) * 7}mm" height="${(H / CELL) * 7}mm">${body}</svg>`;
  return { svg, body, width: W, height: H };
}

/** Plain-text description lines (IOF-style English), e.g. "1  31  north foot of cliff, 3 m". */
export function textDescriptions(course: Course, lookup: DescLookup, lang = "en"): string[] {
  return course.controls.map((c, i) => {
    const parts: string[] = [];
    if (c.desc.G) parts.push(lookup.name(c.desc.G, lang));
    parts.push(lookup.name(c.desc.D, lang));
    if (c.desc.E) parts.push(lookup.name(c.desc.E, lang));
    if (c.desc.F) parts.push(isFSymbol(c.desc.F) ? lookup.name(c.desc.F, lang) : `${c.desc.F} m`);
    return `${i + 1}. [${c.code}] ${parts.join(", ")}`;
  });
}
