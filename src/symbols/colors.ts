/**
 * Display colours for map inks.
 *
 * Mapper stores a naive CMYK→RGB conversion (e.g. 100% cyan → #00ffff), which looks neon on screen.
 * Here each process ink is modelled by its typical printed sRGB appearance (ISO coated stock)
 * and the inks are combined subtractively, which is much closer to what a printed map looks like.
 */

/** Approximate sRGB of 100% process inks on coated paper. */
const INKS: [number, number, number][] = [
  [0, 160, 227], // cyan
  [229, 0, 125], // magenta
  [255, 237, 0], // yellow
  [35, 31, 32], // black
];

export function inkRgb(cmyk: [number, number, number, number]): string {
  const out = [1, 1, 1];
  cmyk.forEach((amount, i) => {
    const ink = INKS[i];
    for (let ch = 0; ch < 3; ch++) out[ch] *= 1 - amount * (1 - ink[ch] / 255);
  });
  return "#" + out.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}

/** Mapper's special colour index for registration marks (printed in all inks). */
export const REGISTRATION_COLOR = -900;
