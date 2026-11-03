/**
 * Normalized symbol model, derived from the OpenOrienteering Mapper XML format (.xmap).
 *
 * Units: all lengths are in micrometres of *paper* (1/1000 mm) at the symbol set's base scale,
 * exactly as in the .xmap files. Angles are radians, counter-clockwise on screen.
 * Coordinates use a y-down screen system.
 */

export interface ColorDef {
  /** Index used by symbols to reference this colour. */
  index: number;
  /** 0 = top-most colour. Higher numbers are drawn first (below). */
  priority: number;
  name: string;
  /** CSS colour used for display, e.g. "#00a0e3" (printed-ink approximation). */
  rgb: string;
  /** Mapper's own RGB value (naive CMYK conversion). */
  mapperRgb: string;
  cmyk: [number, number, number, number];
  opacity: number;
}

/** Coordinate flag bits, as defined by Mapper's MapCoord. */
export const CoordFlag = {
  CurveStart: 1,
  ClosePoint: 2,
  GapPoint: 4,
  HolePoint: 16,
  DashPoint: 32,
} as const;

/** [x, y, flags] */
export type Coord = [number, number, number];

export interface ElementObject {
  kind: "point" | "path";
  coords: Coord[];
  rotation: number;
}

export interface SymbolElement {
  symbol: SymbolDef;
  object: ElementObject;
}

interface SymbolBase {
  /** Index in the set (Mapper's `id`). Undefined for inline/private sub-symbols. */
  id?: number;
  code?: string;
  name?: string;
  description?: string;
  hidden?: boolean;
}

export interface PointSymbolDef extends SymbolBase {
  type: "point";
  rotatable: boolean;
  innerRadius: number;
  innerColor: number;
  outerWidth: number;
  outerColor: number;
  elements: SymbolElement[];
}

export interface LineBorder {
  color: number;
  width: number;
  shift: number;
  dashed: boolean;
  dashLength: number;
  breakLength: number;
}

export type CapStyle = "flat" | "round" | "square" | "pointed";
export type JoinStyle = "bevel" | "miter" | "round";

export interface LineSymbolDef extends SymbolBase {
  type: "line";
  color: number;
  width: number;
  minimumLength: number;
  cap: CapStyle;
  join: JoinStyle;
  pointedCapLength: number;
  startOffset: number;
  endOffset: number;
  dashed: boolean;
  dashLength: number;
  breakLength: number;
  dashesInGroup: number;
  inGroupBreakLength: number;
  halfOuterDashes: boolean;
  segmentLength: number;
  endLength: number;
  showAtLeastOneSymbol: boolean;
  minimumMidSymbolCount: number;
  midSymbolsPerSpot: number;
  midSymbolDistance: number;
  /** 0 = centre of dashes, 1 = centre of dash groups, 2 = centre of gaps, 3 = none */
  midSymbolPlacement: number;
  suppressDashSymbolAtEnds: boolean;
  startSymbol?: PointSymbolDef;
  midSymbol?: PointSymbolDef;
  endSymbol?: PointSymbolDef;
  dashSymbol?: PointSymbolDef;
  borders?: { left: LineBorder; right: LineBorder };
}

export interface LinePattern {
  kind: "line";
  angle: number;
  rotatable: boolean;
  spacing: number;
  offset: number;
  color: number;
  width: number;
}

export interface PointPattern {
  kind: "point";
  angle: number;
  rotatable: boolean;
  spacing: number;
  offset: number;
  distance: number;
  offsetAlong: number;
  /** 0 = clip, 1 = keep symbols whose bbox is inside, 2 = keep symbols whose centre is inside */
  clipping: number;
  symbol: PointSymbolDef;
}

export interface AreaSymbolDef extends SymbolBase {
  type: "area";
  color: number;
  minArea: number;
  rotatable: boolean;
  patterns: (LinePattern | PointPattern)[];
}

export interface TextSymbolDef extends SymbolBase {
  type: "text";
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: number;
  iconText: string;
}

export interface CombinedSymbolDef extends SymbolBase {
  type: "combined";
  /** Either a reference to a top-level symbol id, or a private inline symbol. */
  parts: ({ ref: number } | { symbol: SymbolDef })[];
}

export type SymbolDef = PointSymbolDef | LineSymbolDef | AreaSymbolDef | TextSymbolDef | CombinedSymbolDef;

export interface SymbolSet {
  /** e.g. "ISOM 2017-2" */
  id: string;
  /** Base scale denominator, e.g. 15000. */
  scale: number;
  colors: ColorDef[];
  symbols: SymbolDef[];
  source: string;
  license: string;
}
