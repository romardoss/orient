import { describe, expect, it } from "vitest";
import { descSymbolSvg } from "../src/symbols/control-descriptions";
import { coordsToParts } from "../src/symbols/geometry";
import { renderIcon } from "../src/symbols/icons";
import { SymbolRenderer, layoutDashes, midSpots } from "../src/symbols/render";
import { CoordFlag, type LineSymbolDef } from "../src/symbols/types";
import { XMAP_SETS, loadControlDescriptions, loadXmap } from "../tools/load-sets";

const isom = loadXmap(XMAP_SETS[0]);
const sets = XMAP_SETS.map(loadXmap);
const desc = loadControlDescriptions();

describe("xmap parser", () => {
  it("reads the ISOM 2017-2 set", () => {
    expect(isom.id).toBe("ISOM 2017-2");
    expect(isom.scale).toBe(15000);
    expect(isom.symbols).toHaveLength(191);
    expect(isom.colors.find((c) => c.name === "Brown 100%")).toBeTruthy();
  });

  it("parses line, point, area and combined symbols", () => {
    const contour = isom.symbols.find((s) => s.code === "101") as LineSymbolDef;
    expect(contour.type).toBe("line");
    expect(contour.width).toBe(140);
    expect(isom.colors.find((c) => c.index === contour.color)?.name).toBe("Brown 100%");

    const bank = isom.symbols.find((s) => s.code === "104") as LineSymbolDef;
    expect(bank.midSymbol?.type).toBe("point");
    expect(bank.startSymbol && bank.endSymbol).toBeTruthy();

    const marsh = isom.symbols.find((s) => s.code === "308");
    expect(marsh?.type === "area" && marsh.patterns[0].kind).toBe("line");

    const lake = isom.symbols.find((s) => s.code === "301");
    expect(lake?.type).toBe("combined");
  });

  it("parses all three Mapper sets", () => {
    expect(sets.map((s) => s.symbols.length)).toEqual([191, 185, 209]);
  });
});

describe("geometry", () => {
  it("flattens Bézier curves and keeps end points", () => {
    const [part] = coordsToParts([
      [0, 0, CoordFlag.CurveStart],
      [100, 0, 0],
      [200, 100, 0],
      [200, 200, 0],
    ]);
    expect(part.pts[0]).toEqual({ x: 0, y: 0 });
    expect(part.pts[part.pts.length - 1]).toEqual({ x: 200, y: 200 });
    expect(part.pts.length).toBeGreaterThan(3);
  });

  it("splits parts at hole points and detects closed rings", () => {
    const parts = coordsToParts([
      [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 0, CoordFlag.ClosePoint | CoordFlag.HolePoint],
      [2, 2, 0], [4, 2, 0], [2, 4, 0], [2, 2, CoordFlag.ClosePoint],
    ]);
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => p.closed && p.pts.length === 3)).toBe(true);
  });

  it("lays out dashes so open lines start and end with a dash", () => {
    const sym = { dashLength: 2000, breakLength: 250, dashesInGroup: 1, inGroupBreakLength: 0, halfOuterDashes: false };
    for (const L of [2500, 7300, 19999]) {
      const d = layoutDashes(sym, L, false, 1)!;
      expect(d.dashes[0].start).toBe(0);
      expect(d.dashes[d.dashes.length - 1].end).toBeCloseTo(L, 6);
    }
    expect(layoutDashes(sym, 1000, false, 1)).toBeUndefined();
  });

  it("spaces mid symbols evenly between the end lengths", () => {
    const spots = midSpots({ segmentLength: 500, endLength: 570, showAtLeastOneSymbol: true, minimumMidSymbolCount: 0 }, 5140, false, 1);
    expect(spots[0]).toBe(570);
    expect(spots[spots.length - 1]).toBeCloseTo(5140 - 570, 6);
  });
});

describe("renderer", () => {
  it("draws a boulder as a black dot of the specified size", () => {
    const r = new SymbolRenderer(isom);
    r.point("204", 1000, 1000);
    const black = isom.colors.find((c) => c.name === "Black 100%")!;
    expect(r.out.layers.get(black.index)?.[0]).toContain('r="200"');
  });

  it("scales symbols for enlarged map scales", () => {
    const r = new SymbolRenderer(isom, { scale: 1.5 });
    r.point("204", 0, 0);
    const black = isom.colors.find((c) => c.name === "Black 100%")!;
    expect(r.out.layers.get(black.index)?.[0]).toContain('r="300"');
  });

  it("creates <pattern> defs for patterned areas", () => {
    const r = new SymbolRenderer(isom);
    r.path("308", [[{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 5000 }]], true);
    expect([...r.out.defs.values()].join("")).toContain("<pattern");
  });

  it("stacks colour layers by priority (yellow below black)", () => {
    const r = new SymbolRenderer(isom);
    r.path("401", [[{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 5000 }]], true);
    r.point("204", 100, 100);
    const body = r.out.body(isom.colors, { layerIds: true });
    expect(body.indexOf("Yellow")).toBeLessThan(body.indexOf("Black 100%"));
  });

  it("renders an icon for every symbol of every set", () => {
    for (const set of sets) {
      for (const sym of set.symbols) {
        const icon = renderIcon(set, sym);
        expect(icon.svg.startsWith("<svg"), `${set.id} ${sym.code}`).toBe(true);
        expect(icon.bounds.maxX).toBeGreaterThan(icon.bounds.minX);
      }
    }
  });
});

describe("control descriptions", () => {
  it("parses Purple Pen symbols with multilingual names", () => {
    expect(desc.symbols).toHaveLength(201);
    expect(Object.keys(desc.languages).length).toBeGreaterThanOrEqual(20);
    expect(desc.symbols.find((s) => s.id === "2.4")?.names.de).toBe("Stein");
  });

  it("puts the north-side marker at the top (y flipped)", () => {
    const north = desc.symbols.find((s) => s.id === "11.1N")!;
    const dot = north.ops.find((o) => o.t === "filled-circle")!;
    expect(dot.pts[1]).toBeGreaterThan(0); // y-up in the source
    expect(descSymbolSvg(north)).toMatch(/cy="-\d/); // y-down in SVG
  });
});
