/** Loads the pixel-art PNGs from game/assets (built by game/tools/make-sprites.mjs). */
const NAMES = [
  "tiles",
  "tree1",
  "tree2",
  "tree3",
  "bush",
  "fern",
  "reeds",
  "boulder",
  "boulder_big",
  "stones",
  "pit",
  "well",
  "cairn",
  "rack",
  "spring",
  "knoll",
  "tower",
  "flag",
  "finish",
  "start",
  "player",
  "plate",
  "housing",
  "needle",
] as const;

export type SpriteName = (typeof NAMES)[number];
export type Sprites = Record<SpriteName, HTMLImageElement>;

export async function loadSprites(): Promise<Sprites> {
  const entries = await Promise.all(
    NAMES.map(async (n) => {
      const img = new Image();
      img.src = new URL(`../assets/${n}.png`, import.meta.url).href;
      await img.decode();
      return [n, img] as const;
    }),
  );
  return Object.fromEntries(entries) as Sprites;
}
