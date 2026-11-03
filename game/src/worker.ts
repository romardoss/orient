/// <reference lib="webworker" />
/**
 * Off-thread map generation for the game: the same pipeline as generateMap() (src/generator/index.ts),
 * but it keeps the terrain height field, renders the ISOM SVG map and rasterises the playable world.
 */
import { loadDescriptions, loadIsom } from "../../src/app/data";
import { setCourse } from "../../src/generator/course";
import { drawMap } from "../../src/generator/draw";
import { FeatureBuilder } from "../../src/generator/features";
import { computeLayout, rectToWorld } from "../../src/generator/layout";
import type { MapModel } from "../../src/generator/model";
import { type MapParams, metresPerMm } from "../../src/generator/params";
import { manMade } from "../../src/generator/manmade";
import { buildPaths, northLines } from "../../src/generator/paths";
import { Rng } from "../../src/generator/rng";
import { buildFields } from "../../src/generator/terrain";
import { buildWorld, type World } from "./world";

export type GenRequest = { assetRoot: string; params: MapParams };
export type GenResponse =
  | { type: "stage"; stage: string }
  | { type: "done"; svg: string; world: World }
  | { type: "error"; message: string };

const post = (m: GenResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (ev: MessageEvent<GenRequest>) => {
  const { params: p, assetRoot } = ev.data;
  const stage = <T>(name: string, fn: () => T): T => {
    post({ type: "stage", stage: name });
    return fn();
  };
  try {
    const symbols = Promise.all([loadIsom(assetRoot), loadDescriptions(assetRoot)]);
    const l = computeLayout(p);
    const m = metresPerMm(p);
    const widthM = (l.frame.x1 - l.frame.x0) * m;
    const heightM = (l.frame.y1 - l.frame.y0) * m;
    const rng = new Rng(p.seed);
    const fields = stage("terrain", () => buildFields(p, widthM, heightM, rng.fork("terrain")));
    const b = new FeatureBuilder(p, fields, rng.fork("features"));
    stage("water", () => b.water());
    const paths = stage("paths", () => buildPaths(b));
    stage("vegetation", () => b.vegetation());
    stage("contours", () => b.contours());
    stage("rocks", () => b.rocks());
    stage("earth", () => b.earthFeatures());
    stage("manmade", () => manMade(b, paths));
    stage("details", () => {
      b.smallLandforms();
      b.spotHeights();
      b.vegetationPoints();
      northLines(b);
    });
    const avoid = [l.title, ...(l.sheet ? [l.sheet] : [])].map((r) => rectToWorld(p, l, r));
    const course = stage("course", () => setCourse(b, avoid));
    if (!course) throw new Error("Не вдалося поставити дистанцію");
    const model: MapModel = { widthM, heightM, features: b.features, sites: b.sites, course, stats: b.stats };

    post({ type: "stage", stage: "render" });
    const [iso, desc] = await symbols;
    const svg = drawMap(model, p, iso, desc, {});

    post({ type: "stage", stage: "world" });
    const hg = fields.height;
    const world = buildWorld(model, { nx: hg.nx, ny: hg.ny, cell: hg.cell, data: hg.data });
    post({ type: "done", svg, world }, [world.ground.buffer, world.veg.buffer, world.obj.buffer, world.solid.buffer, world.shade.buffer]);
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  }
};
