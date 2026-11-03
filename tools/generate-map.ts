/**
 * Command-line map generator.
 *
 *   npm run map -- --seed 42 --preset hilly --scale 10000 --out out/map
 *   npm run map -- --random --out out/random          (random seed and terrain)
 *   npm run map -- --no-legs --out out/controls        (controls and numbers only, no leg lines)
 *   npm run map -- --preset river --rock 0.8 --manmade 0.9  (any terrain slider can be overridden)
 *
 * Writes <out>.svg, <out>.png (unless --no-png), <out>-descriptions.svg and <out>.json (stats + course).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import type { DescSymbolSet } from "../src/symbols/control-descriptions";
import type { SymbolSet } from "../src/symbols/types";
import { DescLookup, descriptionSheet, textDescriptions } from "../src/generator/description-sheet";
import { drawMap } from "../src/generator/draw";
import { DEFAULT_PARAMS, type MapParams, PRESETS, generateMap } from "../src/generator/index";
import { type PresetId, TERRAIN_KEYS, randomTerrain } from "../src/generator/params";
import { ROOT } from "./load-sets";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const preset = (arg("preset") ?? "mixed") as PresetId;
if (!PRESETS[preset]) throw new Error(`Unknown preset ${preset}; use one of ${Object.keys(PRESETS).join(", ")}`);
const p: MapParams = {
  ...DEFAULT_PARAMS,
  ...PRESETS[preset].params,
  seed: Number(arg("seed") ?? DEFAULT_PARAMS.seed),
  scale: Number(arg("scale") ?? DEFAULT_PARAMS.scale) as MapParams["scale"],
  widthMm: Number(arg("width") ?? DEFAULT_PARAMS.widthMm),
  heightMm: Number(arg("height") ?? DEFAULT_PARAMS.heightMm),
  title: arg("title") ?? DEFAULT_PARAMS.title,
  course: { ...DEFAULT_PARAMS.course, controls: Number(arg("controls") ?? DEFAULT_PARAMS.course.controls), lengthKm: Number(arg("length") ?? DEFAULT_PARAMS.course.lengthKm), legs: !process.argv.includes("--no-legs") },
};
if (process.argv.includes("--random")) Object.assign(p, randomTerrain());
if (arg("symbols")) p.symbolSize = Number(arg("symbols"));
for (const k of TERRAIN_KEYS) if (arg(k) !== undefined) p[k] = Number(arg(k));
const out = resolve(arg("out") ?? join(ROOT, "out", `map-${preset}-${p.seed}`));
mkdirSync(dirname(out), { recursive: true });

const iso = JSON.parse(readFileSync(join(ROOT, "assets/isom-2017-2/symbols.json"), "utf8")) as SymbolSet;
const desc = JSON.parse(readFileSync(join(ROOT, "assets/control-descriptions/symbols.json"), "utf8")) as DescSymbolSet;

const model = generateMap(p);
const t = Date.now();
const svg = drawMap(model, p, iso, desc, {});
model.stats.ms_draw = Date.now() - t;
writeFileSync(`${out}.svg`, svg);
const lookup = new DescLookup(desc);
if (model.course) writeFileSync(`${out}-descriptions.svg`, descriptionSheet(model.course, lookup, { title: p.title }).svg);
writeFileSync(
  `${out}.json`,
  JSON.stringify({ params: p, stats: model.stats, course: model.course, descriptions: model.course ? textDescriptions(model.course, lookup) : [] }, null, 1),
);
if (!process.argv.includes("--no-png")) {
  const dpi = Number(arg("dpi") ?? 150);
  await sharp(Buffer.from(svg), { density: dpi, limitInputPixels: false }).png().toFile(`${out}.png`);
}
console.log(`${out}.svg  (${(svg.length / 1e6).toFixed(1)} MB)`, JSON.stringify(model.stats));
if (model.course) console.log(textDescriptions(model.course, lookup).join("\n"));
