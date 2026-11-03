/** Node-side loading of the vendored symbol sets. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { parseXmap } from "../src/symbols/parse-xmap";
import { type DescSymbolSet, parseControlDescriptions } from "../src/symbols/control-descriptions";
import type { SymbolSet } from "../src/symbols/types";

export const ROOT = resolve(import.meta.dirname, "..");

const OOM_LICENSE = "GPL-3.0-or-later (derived from OpenOrienteering Mapper symbol sets)";
const OOM_SOURCE = "https://github.com/OpenOrienteering/mapper/tree/master/symbol%20sets/src";

export interface SetSpec {
  slug: string;
  file: string;
  title: string;
}

export const XMAP_SETS: SetSpec[] = [
  { slug: "isom-2017-2", file: "vendor/openorienteering/ISOM 2017-2_15000.xmap", title: "ISOM 2017-2 (forest, 1:15 000)" },
  { slug: "issprom-2019-2", file: "vendor/openorienteering/ISSprOM 2019_4000.xmap", title: "ISSprOM 2019-2 (sprint, 1:4 000)" },
  { slug: "course-design", file: "vendor/openorienteering/Course_Design_10000.xmap", title: "Course design & control description cells" },
];

export function loadXmap(spec: SetSpec): SymbolSet {
  const xml = readFileSync(resolve(ROOT, spec.file), "utf8").replace(/^\uFEFF/, "");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  return parseXmap(doc as unknown as Document, { source: OOM_SOURCE, license: OOM_LICENSE });
}

export function loadControlDescriptions(): DescSymbolSet {
  const xml = readFileSync(resolve(ROOT, "vendor/purplepen/symbols.xml"), "utf8").replace(/^\uFEFF/, "");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  return parseControlDescriptions(doc as unknown as Document, {
    source: "https://github.com/petergolde/PurplePen/blob/master/src/PurplePenCore/symbols.xml",
    license: "BSD-3-Clause-style, © Peter Golde (Purple Pen)",
  });
}
