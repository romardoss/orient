/** User-facing generator parameters and terrain presets. */

export interface MapParams {
  seed: number;
  /** Map scale denominator. ISOM symbols are enlarged ×1.5 at 1:10 000. */
  scale: 15000 | 10000;
  /** Printed map size in millimetres. */
  widthMm: number;
  heightMm: number;
  /** Contour interval in metres. */
  contourInterval: 2.5 | 5;
  /**
   * Approximate height range of the terrain in metres, clamped to RELIEF_MIN..RELIEF_MAX.
   * Capped at 30 m for now: the contour generator misbehaves on steeper terrain (to be fixed later).
   */
  relief: number;
  /** 0..1 amount of small landforms (knolls, depressions, gullies). */
  detail: number;
  /** 0..1 rocks: cliffs, boulders, stony ground. */
  rock: number;
  /** 0..1 lakes, streams and marshes. */
  water: number;
  /** 0..1 rivers: 0 none, small = crossable river, larger = wide uncrossable river (+ tributary). */
  river: number;
  /** 0..1 buildings, farmsteads, fences, walls, rides and other man-made features. */
  manmade: number;
  /** 0..1 share of open land. */
  open: number;
  /** 0..1 share of green (runnability-reducing) vegetation. */
  vegetation: number;
  /** 0..1 density of tracks and paths. */
  paths: number;
  course: CourseParams;
  title: string;
  /** Extra enlargement of map symbols for legibility (1 = ISOM size). Default 1.25. */
  symbolSize?: number;
}

export interface CourseParams {
  enabled: boolean;
  controls: number;
  /** Target length in km (straight line, start → controls → finish). */
  lengthKm: number;
  name: string;
  /** Draw the leg lines between controls (false = controls and numbers only). Default true. */
  legs?: boolean;
}

export type PresetId = "mixed" | "river" | "rolling" | "hilly" | "lakes" | "flat" | "farmland" | "custom";

export const PRESETS: Record<PresetId, { label: string; params: Partial<MapParams> }> = {
  mixed: { label: "Змішаний ліс", params: { relief: 25, detail: 0.6, rock: 0.35, water: 0.45, river: 0.3, open: 0.35, vegetation: 0.45, paths: 0.55, manmade: 0.45 } },
  river: { label: "Річкова долина", params: { relief: 28, detail: 0.6, rock: 0.45, water: 0.6, river: 0.85, open: 0.35, vegetation: 0.45, paths: 0.55, manmade: 0.5 } },
  rolling: { label: "Пологі пагорби", params: { relief: 18, detail: 0.7, rock: 0.1, water: 0.35, river: 0.2, open: 0.3, vegetation: 0.5, paths: 0.6, manmade: 0.5 } },
  hilly: { label: "Гірський", params: { relief: 30, detail: 0.5, rock: 0.45, water: 0.25, river: 0.55, open: 0.2, vegetation: 0.35, paths: 0.45, manmade: 0.25 } },
  lakes: { label: "Озерний край", params: { relief: 20, detail: 0.6, rock: 0.3, water: 0.9, river: 0.6, open: 0.25, vegetation: 0.55, paths: 0.5, manmade: 0.35 } },
  flat: { label: "Рівнина з болотами", params: { relief: 10, detail: 0.5, rock: 0.05, water: 0.85, river: 0.5, open: 0.45, vegetation: 0.6, paths: 0.7, manmade: 0.55 } },
  farmland: { label: "Хутори й поля", params: { relief: 15, detail: 0.5, rock: 0.15, water: 0.45, river: 0.4, open: 0.65, vegetation: 0.45, paths: 0.75, manmade: 0.9 } },
  /** Keeps whatever the sliders say (used by the "random map" button and manual edits). */
  custom: { label: "Власні налаштування", params: {} },
};

/**
 * Height range limits in metres. The upper limit is temporary: the current contour generator
 * produces wrong isolines on steeper terrain, so relief is capped at 30 m until that is fixed.
 */
export const RELIEF_MIN = 8;
export const RELIEF_MAX = 30;

export function clampRelief(v: number): number {
  return Math.max(RELIEF_MIN, Math.min(RELIEF_MAX, Number.isFinite(v) ? v : RELIEF_MAX));
}

/** Terrain sliders that randomMapParams() rolls. */
export const TERRAIN_KEYS = ["relief", "detail", "rock", "water", "river", "open", "vegetation", "paths", "manmade"] as const;

/**
 * Fully random terrain: a new seed and random values for every terrain slider.
 * `random` is injectable for tests; the UI passes Math.random.
 */
export function randomTerrain(random: () => number = Math.random): Pick<MapParams, "seed" | (typeof TERRAIN_KEYS)[number]> {
  const r = (a: number, b: number) => a + (b - a) * random();
  const round = (v: number) => Math.round(v * 20) / 20;
  // Skewed towards the middle but every corner of the parameter space is reachable.
  const tri = (a: number, b: number) => r(a, b) * 0.5 + r(a, b) * 0.5;
  return {
    seed: Math.floor(random() * 1e8),
    relief: Math.round(Math.exp(r(Math.log(RELIEF_MIN), Math.log(RELIEF_MAX)))),
    detail: round(tri(0.15, 1)),
    rock: round(random() < 0.25 ? r(0, 0.15) : tri(0.1, 1)),
    water: round(tri(0.1, 1)),
    river: round(random() < 0.2 ? 0 : r(0.15, 1)),
    open: round(tri(0.05, 0.75)),
    vegetation: round(tri(0.1, 0.9)),
    paths: round(tri(0.15, 0.95)),
    manmade: round(tri(0.05, 1)),
  };
}

export const DEFAULT_PARAMS: MapParams = {
  seed: 20261027,
  scale: 10000,
  widthMm: 297,
  heightMm: 210,
  contourInterval: 5,
  relief: 25,
  detail: 0.6,
  rock: 0.35,
  water: 0.45,
  river: 0.3,
  open: 0.35,
  vegetation: 0.45,
  paths: 0.55,
  manmade: 0.45,
  course: { enabled: true, controls: 12, lengthKm: 4.5, name: "Траса A", legs: true },
  title: "Generated Forest",
  symbolSize: 1.25,
};

/** Symbol enlargement relative to the ISOM base scale 1:15 000 (course overprint uses this). */
export function symbolScale(p: MapParams): number {
  return 15000 / p.scale;
}

/** Map symbol enlargement: ISOM scale factor times the user's legibility factor. */
export function mapSymbolScale(p: MapParams): number {
  return symbolScale(p) * Math.max(0.5, Math.min(3, p.symbolSize ?? 1));
}

/** Point symbols (boulders, knolls, trees, towers…) are drawn this much larger than lines and areas. */
export const POINT_BOOST = 1.3;

/** Point symbol enlargement on the map. */
export function mapPointScale(p: MapParams): number {
  return mapSymbolScale(p) * POINT_BOOST;
}

/** Metres in the terrain per millimetre of paper. */
export function metresPerMm(p: MapParams): number {
  return p.scale / 1000;
}
