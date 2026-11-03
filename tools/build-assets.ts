/**
 * Builds the symbol asset library from the vendored upstream sources:
 *
 *   assets/<set>/svg/<code>.svg            square icon, fitted to the symbol
 *   assets/<set>/svg-true-size/<code>.svg  same drawing, width/height in mm at the set's base scale
 *   assets/<set>/png/<code>.png            128 px raster icon
 *   assets/<set>/sprite.svg                all icons as <symbol id="<set>-<code>">
 *   assets/<set>/manifest.json             code, name, type, description, file names
 *   assets/<set>/symbols.json              normalized definitions consumed by the renderer
 *   assets/<set>/preview.png               contact sheet
 *
 * Usage: npm run assets
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { descSymbolBody, descSymbolSvg, isWide } from "../src/symbols/control-descriptions";
import { renderIcon } from "../src/symbols/icons";
import type { SymbolDef, SymbolSet } from "../src/symbols/types";
import { ROOT, XMAP_SETS, loadControlDescriptions, loadXmap } from "./load-sets";

const OUT = join(ROOT, "assets");
const PNG_SIZE = 128;
/** Symbols that are application artwork rather than map symbols. */
const EXCLUDED_CODES = new Set(["999"]);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fileSafe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_");
}

/** Removes descriptions (kept in the manifest) to keep the renderer data compact. */
function stripDescriptions(sym: SymbolDef): SymbolDef {
  return JSON.parse(JSON.stringify(sym, (k, v) => (k === "description" ? undefined : v)));
}

async function contactSheet(items: { label: string; svg: string; wide?: boolean }[], file: string, cols = 10) {
  const cell = 120;
  const comps: sharp.OverlayOptions[] = [];
  let i = 0;
  let maxY = 0;
  for (const it of items) {
    if (it.wide && i % cols) i += cols - (i % cols);
    const x = (i % cols) * cell;
    const y = Math.floor(i / cols) * (cell + 16);
    const w = it.wide ? Math.min(cols, 6) * cell - 20 : 100;
    const png = await sharp(Buffer.from(it.svg)).resize(w, 100, { fit: "contain", background: "#fff" }).flatten({ background: "#fff" }).png().toBuffer();
    comps.push({ input: png, left: x + 10, top: y + 4 });
    const lw = it.wide ? w + 20 : cell;
    comps.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${lw}" height="14"><text x="3" y="11" font-size="10" font-family="sans-serif">${esc(it.label.slice(0, it.wide ? 80 : 21))}</text></svg>`,
      ),
      left: x,
      top: y + 106,
    });
    maxY = y + cell + 16;
    i += it.wide ? Math.min(cols, 6) : 1;
  }
  await sharp({ create: { width: cols * cell, height: maxY, channels: 3, background: "#e6e6e6" } })
    .composite(comps)
    .png()
    .toFile(file);
}

async function buildXmapSet(slug: string, title: string, set: SymbolSet) {
  const dir = join(OUT, slug);
  rmSync(dir, { recursive: true, force: true });
  for (const sub of ["svg", "svg-true-size", "png"]) mkdirSync(join(dir, sub), { recursive: true });

  const manifest: unknown[] = [];
  const sprite: string[] = [];
  const sheet: { label: string; svg: string }[] = [];
  const used = new Set<string>();

  for (const sym of set.symbols) {
    if (!sym.code || EXCLUDED_CODES.has(sym.code)) continue;
    let base = fileSafe(sym.code);
    if (used.has(base)) base = `${base}-${sym.id}`;
    used.add(base);

    const prefix = `${slug.replace(/[^a-z0-9]/g, "")}${sym.id}_`;
    const icon = renderIcon(set, sym, { size: "64", idPrefix: prefix });
    const trueSize = renderIcon(set, sym, { trueSize: true, idPrefix: prefix });
    writeFileSync(join(dir, "svg", `${base}.svg`), icon.svg);
    writeFileSync(join(dir, "svg-true-size", `${base}.svg`), trueSize.svg);
    const png = renderIcon(set, sym, { size: String(PNG_SIZE), idPrefix: prefix });
    await sharp(Buffer.from(png.svg)).png().toFile(join(dir, "png", `${base}.png`));

    const vb = icon.svg.match(/viewBox="([^"]+)"/)![1];
    const inner = icon.svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
    sprite.push(`<symbol id="${slug}-${base}" viewBox="${vb}">${inner}</symbol>`);
    sheet.push({ label: `${sym.code} ${sym.name ?? ""}`, svg: renderIcon(set, sym, { size: "100", background: "#fff", idPrefix: prefix }).svg });

    manifest.push({
      code: sym.code,
      id: sym.id,
      name: sym.name ?? "",
      type: sym.type,
      shape: icon.shape,
      hidden: sym.hidden ?? false,
      description: sym.description ?? "",
      files: {
        svg: `svg/${base}.svg`,
        svgTrueSize: `svg-true-size/${base}.svg`,
        png: `png/${base}.png`,
        sprite: `sprite.svg#${slug}-${base}`,
      },
    });
  }

  writeFileSync(join(dir, "sprite.svg"), `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${sprite.join("")}</svg>`);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ set: set.id, title, scale: set.scale, source: set.source, license: set.license, colors: set.colors, symbols: manifest }, null, 1),
  );
  writeFileSync(join(dir, "symbols.json"), JSON.stringify({ ...set, symbols: set.symbols.map(stripDescriptions) }));
  await contactSheet(sheet, join(dir, "preview.png"));
  console.log(`${slug}: ${manifest.length} symbols`);
  return manifest.length;
}

async function buildControlDescriptions() {
  const slug = "control-descriptions";
  const set = loadControlDescriptions();
  const dir = join(OUT, slug);
  rmSync(dir, { recursive: true, force: true });
  for (const sub of ["svg", "png"]) mkdirSync(join(dir, sub), { recursive: true });

  const manifest: unknown[] = [];
  const sprite: string[] = [];
  const sheet: { label: string; svg: string; wide?: boolean }[] = [];
  const used = new Set<string>();
  for (const sym of set.symbols) {
    if (!sym.ops.length) continue; // textual-only entries such as "All controls"
    let base = fileSafe(`${sym.kind}-${sym.id}`);
    if (sym.standard) base += `-${sym.standard}`;
    if (used.has(base)) base += "-b";
    used.add(base);
    const wide = isWide(sym);
    const svg = descSymbolSvg(sym, { size: "64" });
    writeFileSync(join(dir, "svg", `${base}.svg`), svg);
    await sharp(Buffer.from(descSymbolSvg(sym, { size: String(PNG_SIZE) })))
      .png()
      .toFile(join(dir, "png", `${base}.png`));
    sprite.push(`<symbol id="cd-${base}" viewBox="${wide ? "-800 -100 1600 200" : "-100 -100 200 200"}">${descSymbolBody(sym, "currentColor")}</symbol>`);
    sheet.push({ label: `${sym.kind} ${sym.id} ${sym.names.en ?? ""}`, svg: descSymbolSvg(sym, { size: "100", box: true }), wide });
    manifest.push({
      kind: sym.kind,
      id: sym.id,
      standard: sym.standard ?? null,
      replacementId: sym.replacementId ?? null,
      wide,
      names: sym.names,
      texts: sym.texts,
      files: { svg: `svg/${base}.svg`, png: `png/${base}.png`, sprite: `sprite.svg#cd-${base}` },
    });
  }
  writeFileSync(join(dir, "sprite.svg"), `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${sprite.join("")}</svg>`);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ set: set.id, languages: set.languages, source: set.source, license: set.license, symbols: manifest }, null, 1),
  );
  writeFileSync(join(dir, "symbols.json"), JSON.stringify(set));
  await contactSheet(sheet, join(dir, "preview.png"), 12);
  console.log(`${slug}: ${manifest.length} symbols`);
  return manifest.length;
}

const counts: Record<string, number> = {};
for (const spec of XMAP_SETS) counts[spec.slug] = await buildXmapSet(spec.slug, spec.title, loadXmap(spec));
counts["control-descriptions"] = await buildControlDescriptions();
console.log("total", Object.values(counts).reduce((a, b) => a + b, 0));
