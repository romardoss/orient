#!/usr/bin/env node
/**
 * Generates the game's pixel-art assets into game/assets/ (no dependencies: PNG via node:zlib).
 *
 *   node game/tools/make-sprites.mjs
 *
 * tiles.png  — 8×8 ground tiles, one row per ground type (order = GROUND in game/src/world.ts),
 *              4 variants per row.
 * other PNGs — single sprites (hand-drawn ASCII or procedural).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- PNG writer
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePng(name, img) {
  const { w, h, px } = img;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(join(OUT, name), png);
}

// ---------------------------------------------------------------- tiny canvas
const image = (w, h) => ({ w, h, px: Buffer.alloc(w * h * 4) });
function hex(c) {
  if (!c) return [0, 0, 0, 0];
  const v = c.replace("#", "");
  const a = v.length === 8 ? parseInt(v.slice(6, 8), 16) : 255;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16), a];
}
function put(img, x, y, c) {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h || !c) return;
  const [r, g, b, a] = hex(c);
  const i = (y * img.w + x) * 4;
  img.px[i] = r;
  img.px[i + 1] = g;
  img.px[i + 2] = b;
  img.px[i + 3] = a;
}
function blit(dst, src, ox, oy) {
  for (let y = 0; y < src.h; y++)
    for (let x = 0; x < src.w; x++) {
      const i = (y * src.w + x) * 4;
      if (src.px[i + 3] === 0) continue;
      const j = ((oy + y) * dst.w + ox + x) * 4;
      src.px.copy(dst.px, j, i, i + 4);
    }
}
/** ASCII art → image. `.` = transparent. */
function ascii(rows, pal) {
  const img = image(rows[0].length, rows.length);
  rows.forEach((r, y) => [...r].forEach((ch, x) => ch !== "." && put(img, x, y, pal[ch])));
  return img;
}

let seed = 1234567;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

// ---------------------------------------------------------------- ground tiles
// Order MUST match GROUND in game/src/world.ts.
const T = 8;
const VARIANTS = 4;
const tiles = {
  forest: { base: "#45632f", specks: [["#3a5628", 0.22], ["#527239", 0.18], ["#6b5a36", 0.06]] },
  open: { base: "#8db449", specks: [["#9fc556", 0.2], ["#7da23f", 0.18], ["#d8d36a", 0.025]] },
  rough: { base: "#a5a24e", specks: [["#bab45d", 0.2], ["#8e8b41", 0.2], ["#c4b36a", 0.05]] },
  marsh: { base: "#56744a", specks: [["#4c7f8c", 0.18], ["#6b8f9e", 0.08], ["#8b9b4a", 0.14]], pattern: "marsh" },
  shallow: { base: "#5a9cc5", specks: [["#6fb0d6", 0.12]], pattern: "wave", wave: "#86c2e2" },
  deep: { base: "#2f679b", specks: [["#2a5d8d", 0.15]], pattern: "wave", wave: "#4a86b9" },
  stream: { base: "#4a8dc0", specks: [["#5e9fcf", 0.2]], pattern: "wave", wave: "#86c2e2" },
  path: { base: "#b8996a", specks: [["#a6875a", 0.22], ["#c9ac7d", 0.18]] },
  track: { base: "#a3865b", specks: [["#8f744d", 0.25], ["#b7996b", 0.15]] },
  road: { base: "#86847e", specks: [["#93918b", 0.25], ["#77756f", 0.2]] },
  ride: { base: "#76a043", specks: [["#87b14f", 0.2], ["#678f3a", 0.2]] },
  paved: { base: "#9c9a94", specks: [["#aaa8a2", 0.15]], pattern: "slabs", line: "#85837d" },
  stony: { base: "#6f6c5c", specks: [["#97948a", 0.16], ["#5b594c", 0.18], ["#b0ada2", 0.05]] },
  sand: { base: "#d7c389", specks: [["#e3d29e", 0.2], ["#c4af76", 0.18]] },
  barerock: { base: "#8a8a80", specks: [["#9a9a90", 0.2], ["#76766d", 0.12]], pattern: "cracks", line: "#5e5e57" },
  broken: { base: "#45632f", specks: [["#33461f", 0.2], ["#5a4a2c", 0.12], ["#527239", 0.12]] },
  cultivated: { base: "#b49b57", specks: [["#c3aa64", 0.12]], pattern: "rows", line: "#957f43" },
  earthbank: { base: "#5c5233", specks: [["#4a4228", 0.3], ["#6d6240", 0.2]] },
  gully: { base: "#4c452e", specks: [["#3b3523", 0.3], ["#5d553a", 0.15]] },
  wall: { base: "#8c8b83", pattern: "bricks", line: "#5f5e58" },
  fence: { base: "#4f6a35", specks: [["#45602f", 0.2]], pattern: "fence", line: "#7a5530", line2: "#5c3e22" },
  ruin: { base: "#6c6a5e", specks: [["#8f8d81", 0.25], ["#4e4c43", 0.25]] },
  rail: { base: "#776b61", specks: [["#8a7e74", 0.2]], pattern: "rail", line: "#b9b9b9", line2: "#5a3e2a" },
  bridge: { base: "#9a6b3a", pattern: "planks", line: "#6e4826" },
  building: { base: "#8b3a2c", pattern: "roof", line: "#6e2a20", line2: "#a54a3a" },
  cliff: { base: "#4b4a47", specks: [["#5f5e5a", 0.25], ["#33322f", 0.3], ["#77766f", 0.08]] },
  restricted: { base: "#7d8f4a", specks: [["#8f9f55", 0.15]], pattern: "hatch", line: "#b0484e" },
  bigrock: { base: "#7a7a72", specks: [["#8e8e86", 0.25], ["#66665f", 0.2]], pattern: "cracks", line: "#55554f" },
  deepmarsh: { base: "#3f5d52", specks: [["#355347", 0.25], ["#4f7e8a", 0.2], ["#6d7f3d", 0.12]], pattern: "marsh" },
};
const names = Object.keys(tiles);
const sheet = image(T * VARIANTS, T * names.length);
names.forEach((name, row) => {
  const s = tiles[name];
  for (let v = 0; v < VARIANTS; v++) {
    const t = image(T, T);
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        let c = s.base;
        for (const [col, d] of s.specks ?? []) if (rnd() < d) c = col;
        put(t, x, y, c);
      }
    switch (s.pattern) {
      case "wave":
        for (let k = 0; k < 2; k++) {
          const y = (v * 3 + k * 4 + 1) % T;
          const x0 = Math.floor(rnd() * 5);
          for (let x = x0; x < x0 + 3; x++) put(t, x % T, y, s.wave);
        }
        break;
      case "marsh":
        for (let k = 0; k < 2; k++) {
          const y = Math.floor(rnd() * T);
          for (let x = 0; x < T; x += 2) put(t, x, y, "#4c7f8c");
        }
        break;
      case "slabs":
        for (let i = 0; i < T; i++) {
          put(t, i, 0, s.line);
          put(t, 0, i, s.line);
        }
        break;
      case "cracks": {
        let x = Math.floor(rnd() * T);
        for (let y = 0; y < T; y++) {
          put(t, x, y, s.line);
          x = (x + pick([-1, 0, 1]) + T) % T;
        }
        break;
      }
      case "rows":
        for (let x = 0; x < T; x++) {
          put(t, x, 1, s.line);
          put(t, x, 5, s.line);
        }
        break;
      case "bricks":
        for (let y = 0; y < T; y++)
          for (let x = 0; x < T; x++) {
            const off = (y >> 1) % 2 ? 2 : 0;
            if (y % 2 === 1 || (x + off) % 4 === 0) put(t, x, y, s.line);
            else if (rnd() < 0.2) put(t, x, y, "#a2a198");
          }
        break;
      case "fence":
        for (let x = 0; x < T; x++) put(t, x, 3, s.line);
        for (let x = 0; x < T; x++) put(t, x, 5, s.line);
        put(t, 1, 2, s.line2);
        put(t, 1, 3, s.line2);
        put(t, 1, 4, s.line2);
        put(t, 1, 5, s.line2);
        put(t, 1, 6, s.line2);
        put(t, 5, 2, s.line2);
        put(t, 5, 6, s.line2);
        break;
      case "rail":
        for (let y = 0; y < T; y += 3) for (let x = 0; x < T; x++) put(t, x, y, s.line2);
        for (let y = 0; y < T; y++) {
          put(t, 2, y, s.line);
          put(t, 5, y, s.line);
        }
        break;
      case "planks":
        for (let x = 0; x < T; x++) put(t, x, 3, s.line), put(t, x, 7, s.line);
        put(t, (v * 3) % T, 1, s.line);
        put(t, (v * 3 + 4) % T, 5, s.line);
        break;
      case "roof":
        for (let y = 0; y < T; y++)
          for (let x = 0; x < T; x++) {
            if (y % 3 === 2) put(t, x, y, s.line);
            else if ((x + (y > 2 ? 2 : 0)) % 4 === 0) put(t, x, y, s.line);
            else if (y % 3 === 0 && rnd() < 0.4) put(t, x, y, s.line2);
          }
        break;
      case "hatch":
        for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) if ((x + y) % 4 === 0) put(t, x, y, s.line);
        break;
    }
    blit(sheet, t, v * T, row * T);
  }
});
writePng("tiles.png", sheet);
writeFileSync(join(OUT, "tiles.json"), JSON.stringify({ tile: T, variants: VARIANTS, names }, null, 1));

// ---------------------------------------------------------------- objects
/** Round canopy, dithered, lit from the north-west. */
function canopy(r, dark, mid, light, hi) {
  const s = r * 2 + 2;
  const img = image(s, s);
  const c = s / 2 - 0.5;
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      const dx = x - c;
      const dy = y - c;
      const wob = 0.9 * Math.sin(Math.atan2(dy, dx) * 7 + r);
      const d = Math.hypot(dx, dy);
      if (d > r + wob) continue;
      const lit = -(dx + dy) / (r * 1.4) + (rnd() - 0.5) * 0.6;
      let col = mid;
      if (d > r + wob - 1.2) col = dark;
      else if (lit > 0.55) col = hi;
      else if (lit > 0.15) col = light;
      else if (lit < -0.45) col = dark;
      put(img, x, y, col);
    }
  return img;
}
writePng("tree1.png", canopy(11, "#1f3d1c", "#2f5a26", "#3f7330", "#5a9140"));
writePng("tree2.png", canopy(10, "#1c3a26", "#285533", "#346d3d", "#4c8a4e"));
writePng("tree3.png", canopy(9, "#2a4418", "#3d6424", "#527e2e", "#76a03c"));

const P = {
  k: "#1b1b1b",
  K: "#333333",
  g: "#2b4f22",
  G: "#3e6e2e",
  L: "#5c9a40",
  y: "#8fc25a",
  s: "#5d5d58",
  S: "#86857d",
  W: "#b4b3aa",
  w: "#ffffff",
  o: "#f07a1e",
  O: "#c95c10",
  b: "#6b4a2a",
  B: "#8c6538",
  r: "#c8322d",
  R: "#e8504a",
  c: "#f2c9a0",
  h: "#4a3020",
  u: "#2c5d9c",
  U: "#4b7fc4",
  n: "#3a7cc0",
  p: "#97218b",
  m: "#d06bc8",
  t: "#c7c36b",
};

writePng(
  "bush.png",
  ascii(
    [
      "..gGG...",
      ".gGLLGg.",
      "gGLyLGGg",
      "gGLLGGLg",
      "gGGGGLGg",
      ".gGLGGg.",
      "..gggg..",
      "........",
    ],
    P,
  ),
);
writePng(
  "fern.png",
  ascii(
    [
      "........",
      "...L....",
      ".L.G.L..",
      "..GGG...",
      ".L.G..L.",
      "...G.G..",
      "........",
      "........",
    ],
    P,
  ),
);
writePng(
  "reeds.png",
  ascii(
    [
      "..t.....",
      "..t..t..",
      ".tG..t..",
      ".G...G.t",
      ".G..GG.G",
      "..G.G..G",
      "........",
      "........",
    ],
    P,
  ),
);
writePng(
  "boulder.png",
  ascii(
    [
      "........",
      "..sSSs..",
      ".sSWWSs.",
      ".sSWSSs.",
      "ksSSSSsk",
      ".kssssk.",
      "..kkkk..",
      "........",
    ],
    P,
  ),
);
writePng(
  "stones.png",
  ascii(
    [
      "........",
      ".S......",
      "......W.",
      "...s....",
      "........",
      ".W...S..",
      "........",
      "....s...",
    ],
    P,
  ),
);
writePng(
  "pit.png",
  ascii(
    [
      "........",
      "..bbbb..",
      ".bhhhhb.",
      ".bhkkhb.",
      ".bhkkhb.",
      ".bhhhhB.",
      "..BBBB..",
      "........",
    ],
    P,
  ),
);
writePng(
  "well.png",
  ascii(
    [
      "..SSSS..",
      ".SWWWWS.",
      "SWuuuuWS",
      "SWuUUuWS",
      "SWuUuuWS",
      "SWuuuuWS",
      ".SWWWWS.",
      "..SSSS..",
    ],
    P,
  ),
);
writePng(
  "cairn.png",
  ascii(
    [
      "...SS...",
      "..sWSs..",
      "..SSsS..",
      ".sWSSWs.",
      ".SsSsSS.",
      "sWSSWSsk",
      ".kssssk.",
      "........",
    ],
    P,
  ),
);
writePng(
  "rack.png",
  ascii(
    [
      "b......b",
      "BBBBBBBB",
      "b.t.t..b",
      "BBBBBBBB",
      "b..t.t.b",
      "BBBBBBBB",
      "b......b",
      "........",
    ],
    P,
  ),
);
writePng(
  "spring.png",
  ascii(
    [
      "........",
      "...nn...",
      "..nUUn..",
      ".nU..Un.",
      ".nU..Un.",
      "..nUUn..",
      "...nn...",
      "........",
    ],
    P,
  ),
);

// Large boulder 16×16 and knoll 16×16 (procedural).
{
  const img = image(16, 16);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const d = Math.hypot(x - 7.5, (y - 7.5) * 1.1);
      if (d > 7) continue;
      const lit = -(x - 7.5 + (y - 7.5)) / 10 + (rnd() - 0.5) * 0.3;
      put(img, x, y, d > 6.2 ? "#2e2e2b" : lit > 0.35 ? "#b4b3aa" : lit > -0.1 ? "#86857d" : "#5d5d58");
    }
  writePng("boulder_big.png", img);
}
{
  const img = image(16, 16);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d > 7.5 || rnd() < (d / 7.5) ** 3) continue;
      const lit = -(x - 7.5 + (y - 7.5)) / 10;
      put(img, x, y, lit > 0.2 ? "#ffffff30" : lit < -0.2 ? "#00000030" : null);
    }
  writePng("knoll.png", img);
}
// Tower 16×16: lattice from above.
writePng(
  "tower.png",
  ascii(
    [
      "kk..........kk..",
      "kBk........kBk..",
      ".kBk......kBk...",
      "..kBBBBBBBBk....",
      "...BbbbbbbB.....",
      "...BbBBBBbB.....",
      "...BbBwwBbB.....",
      "...BbBwwBbB.....",
      "...BbBBBBbB.....",
      "...BbbbbbbB.....",
      "..kBBBBBBBBk....",
      ".kBk......kBk...",
      "kBk........kBk..",
      "kk..........kk..",
      "................",
      "................",
    ],
    P,
  ),
);

// Control flag (orienteering kite, white/orange diagonal), 8×12, pole at x=0.
writePng(
  "flag.png",
  ascii(
    [
      "kwwwwwwk",
      "kwwwwwok",
      "kwwwwook",
      "kwwwoook",
      "kwwooook",
      "kwoooook",
      "koooOOOk",
      "kkkkkkkk",
      "k.......",
      "k.......",
      "k.......",
      "K.......",
    ],
    P,
  ),
);
// Finish flag (checkered).
writePng(
  "finish.png",
  ascii(
    [
      "kkkkkkkk",
      "kwwkkwwk",
      "kwwkkwwk",
      "kkkwwkkk",
      "kkkwwkkk",
      "kwwkkwwk",
      "kwwkkwwk",
      "kkkkkkkk",
      "k.......",
      "k.......",
      "k.......",
      "K.......",
    ],
    P,
  ),
);
// Start marker: purple triangle on the ground.
writePng(
  "start.png",
  ascii(
    [
      "......pp......",
      ".....pmmp.....",
      ".....pmmp.....",
      "....pm..mp....",
      "....pm..mp....",
      "...pm....mp...",
      "...pm....mp...",
      "..pm......mp..",
      "..pm......mp..",
      ".pmppppppppmp.",
      "pmmmmmmmmmmmmp",
      "pppppppppppppp",
    ],
    P,
  ),
);

// Player seen from above, facing up: 3 frames (stand, left step, right step), 12×12 each.
const playerFrames = [
  [
    "............",
    "....hhhh....",
    "...hcchhh...",
    "...hcchhh...",
    "..RrrrrrrR..",
    ".RRrrrrrrRR.",
    ".cRrrrrrrRc.",
    ".cRrrrrrrRc.",
    "..RrrrrrrR..",
    "...uu..uu...",
    "...UU..UU...",
    "............",
  ],
  [
    "...uu.......",
    "...UU.hh....",
    "...hcchhh...",
    "...hcchhh...",
    "..RrrrrrrR..",
    ".RRrrrrrrRRc",
    ".cRrrrrrrRc.",
    "c.RrrrrrrR..",
    "..RrrrrrrR..",
    ".......uu...",
    ".......UU...",
    "............",
  ],
  [
    ".......uu...",
    "....hhUU....",
    "...hcchhh...",
    "...hcchhh...",
    "..RrrrrrrR..",
    "cRRrrrrrrRR.",
    ".cRrrrrrrRc.",
    "..RrrrrrrR.c",
    "..RrrrrrrR..",
    "...uu.......",
    "...UU.......",
    "............",
  ],
];
{
  const img = image(36, 12);
  playerFrames.forEach((f, i) => blit(img, ascii(f, P), i * 12, 0));
  writePng("player.png", img);
}

// ---------------------------------------------------------------- sport (baseplate) compass
// plate.png 40×72: transparent baseplate, direction-of-travel arrow, ruler, index mark.
// The housing (36×36) sits on it centred at (20, 44); housing.png rotates with the bearing.
{
  const W = 40;
  const H = 72;
  const img = image(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      // rounded corners
      const cx = x < 3 ? 3 - x : x > W - 4 ? x - (W - 4) : 0;
      const cy = y < 3 ? 3 - y : y > H - 4 ? y - (H - 4) : 0;
      if (cx * cx + cy * cy > 9) continue;
      const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 || cx * cx + cy * cy > 4;
      put(img, x, y, edge ? "#5f7f8c" : (x + y) % 9 === 0 ? "#e4f1f5c0" : "#c9dfe6b0");
    }
  // ruler on both long edges
  for (let y = 4; y < H - 4; y += 2) {
    put(img, 1, y, "#20282c");
    put(img, W - 2, y, "#20282c");
    if (y % 10 === 4) {
      put(img, 2, y, "#20282c");
      put(img, W - 3, y, "#20282c");
    }
  }
  // direction-of-travel arrow
  for (let y = 3; y <= 20; y++) {
    const half = y < 9 ? Math.floor((y - 3) / 1.3) : 1;
    for (let x = 20 - half - 1; x <= 19 + half + 1; x++) put(img, x, y, y < 9 ? (x === 20 - half - 1 || x === 19 + half + 1 ? "#8e1c18" : "#e8504a") : x === 18 || x === 21 ? "#8e1c18" : "#e8504a");
  }
  // index mark just above the housing
  put(img, 19, 24, "#101010");
  put(img, 20, 24, "#101010");
  put(img, 19, 25, "#101010");
  put(img, 20, 25, "#101010");
  // lanyard hole
  put(img, 19, 67, "#5f7f8c");
  put(img, 20, 67, "#5f7f8c");
  writePng("plate.png", img);
}
// housing.png 36×36: bezel with 10° ticks, red N, liquid capsule with orienting arrow and lines.
{
  const S = 36;
  const img = image(S, S);
  const c = S / 2 - 0.5;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d > 17.6) continue;
      let col;
      if (d > 16.8) col = "#151515";
      else if (d > 13.6) col = x + y < S ? "#4a4f57" : "#373b42";
      else if (d > 13) col = "#151515";
      else col = "#eaf4f6d8";
      put(img, x, y, col);
    }
  // ticks every 10° on the bezel, longer every 30°, red at N
  for (let a = 0; a < 360; a += 10) {
    const rad = (a * Math.PI) / 180;
    const r0 = a % 30 === 0 ? 14 : 15.3;
    for (let r = r0; r <= 16.5; r += 0.5) put(img, Math.round(c + Math.sin(rad) * r), Math.round(c - Math.cos(rad) * r), a === 0 ? "#ff4a40" : "#e0e0e0");
  }
  // orienting lines (parallel to the orienting arrow)
  for (let y = 7; y <= 28; y++) {
    if (Math.hypot(10 - c, y - c) < 12.6) put(img, 10, y, "#c8322d");
    if (Math.hypot(25 - c, y - c) < 12.6) put(img, 25, y, "#c8322d");
    if (y % 2 === 0 && Math.hypot(6 - c, y - c) < 12.6) put(img, 6, y, "#30303080");
    if (y % 2 === 0 && Math.hypot(29 - c, y - c) < 12.6) put(img, 29, y, "#30303080");
  }
  // orienting arrow (outline "shed" the needle sits in), pointing to N
  const arrow = [
    "....rr....",
    "...rRRr...",
    "..rRffRr..",
    ".rRffffRr.",
    "rrrffffrrr",
    "..rffffr..",
    "..rffffr..",
    "..rffffr..",
    "..rffffr..",
    "..rffffr..",
    "..rffffr..",
    "..rffffr..",
    "..rrrrrr..",
  ];
  arrow.forEach((row, j) => [...row].forEach((ch, i) => ch !== "." && put(img, 13 + i, 5 + j, ch === "R" ? "#e8504a" : ch === "f" ? "#ff8a8070" : "#c8322d")));
  writePng("housing.png", img);
}
// needle.png 5×27: red half points to magnetic north.
{
  const L = 27;
  const img = image(5, L);
  const mid = (L - 1) / 2;
  for (let y = 0; y < L; y++) {
    const half = y < mid ? y / mid : (L - 1 - y) / mid;
    const wdt = Math.round(half * 2);
    for (let x = 2 - wdt; x <= 2 + wdt; x++) {
      const edge = x === 2 - wdt || x === 2 + wdt;
      if (y < mid) put(img, x, y, edge ? "#8e1c18" : x < 2 ? "#ff5a50" : "#d8322d");
      else if (y > mid) put(img, x, y, edge ? "#555555" : x < 2 ? "#ffffff" : "#cfcfcf");
      else put(img, x, y, "#202020");
    }
  }
  writePng("needle.png", img);
}

console.log(`Wrote ${names.length} tiles and sprites to ${OUT}`);
