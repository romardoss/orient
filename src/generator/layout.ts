/** Paper layout: map frame, title box and the control description sheet, in paper millimetres. */
import type { Rect } from "./course";
import { type MapParams, metresPerMm } from "./params";

export const MARGIN_MM = 6;
export const SHEET_CELL_MM = 6;

export interface Layout {
  paperW: number;
  paperH: number;
  /** Map frame (mm, paper coordinates). */
  frame: Rect;
  title: Rect;
  /** Control description sheet; empty when the course is disabled. */
  sheet?: Rect;
}

export function sheetRows(controls: number): number {
  // title, course, start, controls…, finish
  return 4 + controls;
}

export function computeLayout(p: MapParams): Layout {
  const frame = { x0: MARGIN_MM, y0: MARGIN_MM, x1: p.widthMm - MARGIN_MM, y1: p.heightMm - MARGIN_MM };
  const tw = 74;
  const th = 30;
  const title = { x0: frame.x1 - tw - 3, y0: frame.y0 + 3, x1: frame.x1 - 3, y1: frame.y0 + 3 + th };
  let sheet: Rect | undefined;
  if (p.course.enabled) {
    const w = 8 * SHEET_CELL_MM;
    const h = sheetRows(p.course.controls) * SHEET_CELL_MM;
    sheet = { x0: frame.x0 + 3, y0: frame.y0 + 3, x1: frame.x0 + 3 + w, y1: frame.y0 + 3 + h };
  }
  return { paperW: p.widthMm, paperH: p.heightMm, frame, title, sheet };
}

/** Converts a paper rectangle (mm) into world metres relative to the map frame. */
export function rectToWorld(p: MapParams, l: Layout, r: Rect): Rect {
  const m = metresPerMm(p);
  return {
    x0: (r.x0 - l.frame.x0) * m,
    y0: (r.y0 - l.frame.y0) * m,
    x1: (r.x1 - l.frame.x0) * m,
    y1: (r.y1 - l.frame.y0) * m,
  };
}
