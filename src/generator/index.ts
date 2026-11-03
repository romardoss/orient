/** Procedural orienteering map generator: parameters in, ISOM feature model out. */
import { setCourse } from "./course";
import { FeatureBuilder } from "./features";
import { computeLayout, rectToWorld } from "./layout";
import type { MapModel } from "./model";
import { type MapParams, metresPerMm } from "./params";
import { manMade } from "./manmade";
import { buildPaths, northLines } from "./paths";
import { Rng } from "./rng";
import { buildFields } from "./terrain";

export function generateMap(p: MapParams, onStage?: (stage: string) => void): MapModel {
  const l = computeLayout(p);
  const m = metresPerMm(p);
  const widthM = (l.frame.x1 - l.frame.x0) * m;
  const heightM = (l.frame.y1 - l.frame.y0) * m;
  const rng = new Rng(p.seed);
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const stage = <T>(name: string, fn: () => T): T => {
    onStage?.(name);
    const s = Date.now();
    const out = fn();
    timings[`ms_${name}`] = Date.now() - s;
    return out;
  };

  const fields = stage("terrain", () => buildFields(p, widthM, heightM, rng.fork("terrain")));
  const b = new FeatureBuilder(p, fields, rng.fork("features"));
  // Order matters: line features claim space before point symbols are scattered around them.
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

  return {
    widthM,
    heightM,
    features: b.features,
    sites: b.sites,
    course,
    stats: { ...b.stats, ...timings, ms_total: Date.now() - t0, sites: b.sites.length },
  };
}

export { DEFAULT_PARAMS, PRESETS } from "./params";
export type { MapParams } from "./params";
