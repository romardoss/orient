/** Loads the prebuilt symbol data served from the asset library. */
import type { DescSymbolSet } from "../symbols/control-descriptions";
import type { SymbolSet } from "../symbols/types";

const base = import.meta.env.BASE_URL;

/**
 * Fetches a file from the asset library. `root` must be an absolute URL when called from a
 * worker, because relative URLs there resolve against the worker script, not the page.
 */
export async function loadJson<T>(path: string, root = base): Promise<T> {
  const res = await fetch(`${root}${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} — run "npm run assets" first`);
  return (await res.json()) as T;
}

export const loadIsom = (root?: string) => loadJson<SymbolSet>("isom-2017-2/symbols.json", root);
export const loadDescriptions = (root?: string) => loadJson<DescSymbolSet>("control-descriptions/symbols.json", root);
/** Absolute URL of the asset library root, for passing to workers. */
export const assetRoot = () => new URL(base, location.href).href;
export const assetUrl = (path: string) => `${base}${path}`;
