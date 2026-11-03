/** Generated map content, in world metres (x east, y south). */
import type { Pt } from "../symbols/geometry";

export type Feature =
  /** `angle` is the screen angle (radians, y-down) of the symbol's local x axis. */
  | { kind: "point"; code: string; x: number; y: number; angle?: number }
  | { kind: "line"; code: string; pts: Pt[]; closed?: boolean }
  /** Rings combined with the even-odd rule (holes, bands). */
  | { kind: "area"; code: string; rings: Pt[][] }
  | { kind: "text"; code: string; x: number; y: number; text: string; angle?: number };

/** IOF control description of a site; values are Purple Pen symbol ids (e.g. D "1.10", G "11.14N"). */
export interface ControlDesc {
  C?: string;
  D: string;
  E?: string;
  /** Symbol id ("10.2") or a dimension text ("2", "1.5"). */
  F?: string;
  G?: string;
  H?: string;
}

export interface ControlSite {
  x: number;
  y: number;
  desc: ControlDesc;
  /** Preference weight for course setting. */
  weight: number;
  /** Short human readable label, e.g. "boulder". */
  label: string;
}

export interface CourseControl {
  x: number;
  y: number;
  code: number;
  desc: ControlDesc;
  label: string;
}

export interface Course {
  name: string;
  start: { x: number; y: number };
  /** Feature at the start, for the start row of the description sheet. */
  startDesc?: ControlDesc;
  controls: CourseControl[];
  finish: { x: number; y: number };
  /** Straight-line length in metres. */
  length: number;
  /** Sum of climbs along the straight legs, in metres. */
  climb: number;
  /** Distance from the last control to the finish, metres. */
  finishDistance: number;
  /** Extra course overprint (ISOM 702, 707–713). */
  extras?: CourseExtras;
}

export interface CourseExtras {
  /** Map issue point (702) and the marked route (707) from it to the start. */
  issue?: Pt;
  marked?: Pt[];
  /** Out-of-bounds areas (709), boundaries (708) and forbidden routes (711). */
  oobAreas: Pt[][];
  oobLines: Pt[][];
  oobRoutes: Pt[][];
  /** Crossing points (710); angle = screen angle of the crossed line. */
  crossings: { x: number; y: number; angle: number }[];
  firstAid?: Pt;
  refreshments: Pt[];
}

export interface MapModel {
  widthM: number;
  heightM: number;
  features: Feature[];
  sites: ControlSite[];
  course?: Course;
  stats: Record<string, number>;
}
