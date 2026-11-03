/// <reference lib="webworker" />
/** Runs map generation + SVG rendering off the main thread. */
import { DescLookup, descriptionSheet, textDescriptions } from "../generator/description-sheet";
import { type DrawOptions, drawMap } from "../generator/draw";
import { generateMap } from "../generator/index";
import type { MapModel } from "../generator/model";
import type { MapParams } from "../generator/params";
import type { DescSymbolSet } from "../symbols/control-descriptions";
import type { SymbolSet } from "../symbols/types";
import { loadDescriptions, loadIsom } from "./data";

export type WorkerRequest = { id: number; assetRoot: string; params: MapParams; draw: Omit<DrawOptions, "hidden"> & { hidden?: string[] } };
export type WorkerResponse =
  | { id: number; type: "stage"; stage: string }
  | { id: number; type: "done"; svg: string; sheetSvg?: string; descriptions: string[]; stats: Record<string, number>; course?: MapModel["course"] }
  | { id: number; type: "error"; message: string };

let data: Promise<[SymbolSet, DescSymbolSet]> | undefined;

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const { id, params, draw, assetRoot } = ev.data;
  const post = (m: WorkerResponse) => (self as unknown as Worker).postMessage(m);
  try {
    data ??= Promise.all([loadIsom(assetRoot), loadDescriptions(assetRoot)]);
    const [iso, desc] = await data;
    const model = generateMap(params, (stage) => post({ id, type: "stage", stage }));
    post({ id, type: "stage", stage: "render" });
    const t = performance.now();
    const svg = drawMap(model, params, iso, desc, { ...draw, hidden: new Set(draw.hidden ?? []) });
    model.stats.ms_draw = Math.round(performance.now() - t);
    const lookup = new DescLookup(desc);
    post({
      id,
      type: "done",
      svg,
      sheetSvg: model.course ? descriptionSheet(model.course, lookup, { title: params.title }).svg : undefined,
      descriptions: model.course ? textDescriptions(model.course, lookup) : [],
      stats: model.stats,
      course: model.course,
    });
  } catch (e) {
    post({ id, type: "error", message: e instanceof Error ? e.stack ?? e.message : String(e) });
  }
};
