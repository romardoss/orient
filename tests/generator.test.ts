import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { drawMap } from "../src/generator/draw";
import { Grid } from "../src/generator/grid";
import { generateMap } from "../src/generator/index";
import { isolines, ringArea } from "../src/generator/iso";
import { DEFAULT_PARAMS, type MapParams, PRESETS, RELIEF_MAX, clampRelief, randomTerrain } from "../src/generator/params";
import { Rng } from "../src/generator/rng";
import type { DescSymbolSet } from "../src/symbols/control-descriptions";
import type { SymbolSet } from "../src/symbols/types";
import { ROOT } from "../tools/load-sets";

const iso = JSON.parse(readFileSync(join(ROOT, "assets/isom-2017-2/symbols.json"), "utf8")) as SymbolSet;
const desc = JSON.parse(readFileSync(join(ROOT, "assets/control-descriptions/symbols.json"), "utf8")) as DescSymbolSet;

/** Small, fast map for tests. */
function params(over: Partial<MapParams> = {}): MapParams {
  return { ...DEFAULT_PARAMS, scale: 15000, widthMm: 180, heightMm: 130, ...over, course: { ...DEFAULT_PARAMS.course, controls: 6, lengthKm: 3, ...over.course } };
}

describe("iso-lines", () => {
  it("orients rings: knolls have negative area, depressions positive", () => {
    const peak = new Grid(40, 40, 10).fill((x, y) => 100 - Math.hypot(x - 200, y - 200) / 5);
    const pit = new Grid(40, 40, 10).fill((x, y) => Math.hypot(x - 200, y - 200) / 5);
    const [a] = isolines(peak, 80);
    const [b] = isolines(pit, 20);
    expect(a.closed && b.closed).toBe(true);
    expect(ringArea(a.pts)).toBeLessThan(0);
    expect(ringArea(b.pts)).toBeGreaterThan(0);
  });

  it("closes lines at the border when asked", () => {
    const slope = new Grid(30, 20, 10).fill((x) => x);
    expect(isolines(slope, 150)[0].closed).toBe(false);
    expect(isolines(slope, 150, true).every((l) => l.closed)).toBe(true);
  });
});

describe("rng", () => {
  it("is deterministic and forks independently", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    expect([a.next(), a.next()]).toEqual([b.next(), b.next()]);
    expect(new Rng(42).fork("x").next()).not.toBe(new Rng(42).fork("y").next());
  });
});

describe("map generator", () => {
  const p = params({ seed: 123 });
  const model = generateMap(p);

  it("is reproducible from the seed", () => {
    const again = generateMap(p);
    expect(drawMap(again, p, iso, desc)).toBe(drawMap(model, p, iso, desc));
    expect(drawMap(generateMap(params({ seed: 124 })), p, iso, desc)).not.toBe(drawMap(model, p, iso, desc));
  });

  it("produces the main ISOM feature classes", () => {
    const codes = new Set(model.features.map((f) => f.code));
    for (const c of ["101", "102", "601.1"]) expect(codes.has(c), c).toBe(true);
    expect(model.features.length).toBeGreaterThan(100);
  });

  it("uses only symbols that exist in the ISOM set", () => {
    const known = new Set(iso.symbols.map((s) => s.code));
    for (const f of model.features) expect(known.has(f.code), f.code).toBe(true);
  });

  it("sets a valid course", () => {
    const c = model.course!;
    expect(c).toBeTruthy();
    expect(c.controls).toHaveLength(6);
    const codes = c.controls.map((x) => x.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const x of c.controls) {
      expect(x.code).toBeGreaterThanOrEqual(31);
      expect(x.x).toBeGreaterThan(0);
      expect(x.x).toBeLessThan(model.widthM);
      expect(x.y).toBeGreaterThan(0);
      expect(x.y).toBeLessThan(model.heightM);
    }
    // IOF: controls closer than 60 m are not used on the same course.
    for (let i = 0; i < c.controls.length; i++) {
      for (let j = i + 1; j < c.controls.length; j++) {
        expect(Math.hypot(c.controls[i].x - c.controls[j].x, c.controls[i].y - c.controls[j].y)).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it("renders a complete SVG sheet", () => {
    const svg = drawMap(model, p, iso, desc);
    expect(svg).toMatch(/^<svg[^>]+width="180mm" height="130mm"/);
    expect(svg).toContain('id="course"');
    expect(svg).toContain("mix-blend-mode:multiply");
  });

  it.each(Object.keys(PRESETS))("generates the %s preset", (preset) => {
    const pp = params({ ...PRESETS[preset as keyof typeof PRESETS].params, seed: 7 });
    const m = generateMap(pp);
    expect(m.features.length).toBeGreaterThan(50);
  });
});

describe("relief limit", () => {
  it("keeps every preset, the default and random terrain within RELIEF_MAX", () => {
    expect(RELIEF_MAX).toBe(30);
    expect(DEFAULT_PARAMS.relief).toBeLessThanOrEqual(RELIEF_MAX);
    for (const pr of Object.values(PRESETS)) expect(pr.params.relief ?? 0).toBeLessThanOrEqual(RELIEF_MAX);
    const rng = new Rng(7);
    for (let i = 0; i < 500; i++) expect(randomTerrain(() => rng.next()).relief).toBeLessThanOrEqual(RELIEF_MAX);
    expect(clampRelief(180)).toBe(RELIEF_MAX);
  });
});
