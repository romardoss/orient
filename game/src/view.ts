/**
 * Top-down game view. The scene is rendered heading-up into a small pixel buffer and scaled ×2
 * with nearest-neighbour, so everything (even rotated terrain) keeps the chunky pixel-art look.
 * Ground + low objects are baked into cached 32×32 m chunks; tree canopies are drawn per frame.
 */
import type { Compass } from "./compass";
import type { Player } from "./player";
import type { Sprites } from "./sprites";
import { Obj, isTree, type World } from "./world";

/** Visibility radius, metres: open land vs. the densest thicket. */
const VIS_OPEN = 58;
const VIS_MIN = 7;
const VIS_SAMPLE_R = 9;
const FOG_LEVELS = 6;
const FOG_MAX = 0.93;
/** Relief shading steps on each side (light / shadow). */
const SHADE_LEVELS = 3;
/** 4×4 Bayer matrix, for pixel-art dithered fog edges. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

export const PX = 8; // buffer pixels per metre (= tile size)
export const BUF_W = 320;
export const BUF_H = 360;
/** Player position in the buffer: below the centre, so you see more ahead. */
const EYE_X = BUF_W / 2;
const EYE_Y = 245;
const VIEW_R = Math.hypot(EYE_X, EYE_Y) / PX + 2;
const CS = 32; // chunk size, cells
const MARGIN = 3; // objects from neighbouring cells that overlap into a chunk
const MAX_CHUNKS = 90;

type Chunk = { canvas: HTMLCanvasElement; trees: number[] };

const BAKED: Partial<Record<Obj, keyof Sprites>> = {
  [Obj.Bush]: "bush",
  [Obj.Fern]: "fern",
  [Obj.Reeds]: "reeds",
  [Obj.Boulder]: "boulder",
  [Obj.BoulderBig]: "boulder_big",
  [Obj.Stones]: "stones",
  [Obj.Pit]: "pit",
  [Obj.Well]: "well",
  [Obj.Cairn]: "cairn",
  [Obj.Rack]: "rack",
  [Obj.Spring]: "spring",
  [Obj.Knoll]: "knoll",
  [Obj.Tower]: "tower",
};
const TREE_SPRITE = ["tree1", "tree2", "tree3"] as const;

const vhash = (i: number, j: number) => {
  let h = Math.imul(i, 73856093) ^ Math.imul(j, 19349663);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
};

export class GameView {
  readonly buf = document.createElement("canvas");
  private readonly b: CanvasRenderingContext2D;
  private readonly chunks = new Map<number, Chunk>();
  /** Current (smoothed) visibility radius, metres. */
  vis = VIS_OPEN;
  private readonly fog = document.createElement("canvas");
  private readonly fogData: ImageData;
  private fogVis = -1;
  private readonly shadeCanvas = document.createElement("canvas");
  private readonly shadeImg = new ImageData((CS + 1) * PX, (CS + 1) * PX);

  constructor(
    private readonly world: World,
    private readonly sp: Sprites,
  ) {
    this.buf.width = BUF_W;
    this.buf.height = BUF_H;
    this.b = this.buf.getContext("2d")!;
    this.fog.width = BUF_W;
    this.fog.height = BUF_H;
    this.fogData = new ImageData(BUF_W, BUF_H);
    this.shadeCanvas.width = this.shadeCanvas.height = (CS + 1) * PX;
  }

  /**
   * How far you can see from here: trees, bushes and green undergrowth around the runner
   * (within VIS_SAMPLE_R) shrink the radius; open land gives a clear view.
   */
  visibilityAt(x: number, y: number): number {
    const w = this.world;
    let n = 0;
    let trees = 0;
    let bushes = 0;
    let veg = 0;
    const r = VIS_SAMPLE_R;
    for (let j = Math.floor(y - r); j <= Math.floor(y + r); j++) {
      for (let i = Math.floor(x - r); i <= Math.floor(x + r); i++) {
        if (i < 0 || j < 0 || i >= w.w || j >= w.h || (i + 0.5 - x) ** 2 + (j + 0.5 - y) ** 2 > r * r) continue;
        const k = j * w.w + i;
        const o = w.obj[k];
        n++;
        if (isTree(o)) trees++;
        else if (o === Obj.Bush) bushes++;
        veg += w.veg[k];
      }
    }
    if (!n) return VIS_OPEN;
    const density = (trees / n) * 6 + (bushes / n) * 4 + (veg / n) * 0.25;
    return VIS_MIN + (VIS_OPEN - VIS_MIN) / (1 + density * 15);
  }

  /** Eases the visibility radius towards the local value (eyes adapt, no popping). */
  updateVisibility(p: Player, dt: number): void {
    const target = this.visibilityAt(p.x, p.y);
    this.vis += (target - this.vis) * Math.min(1, dt * 1.5);
  }

  /** Dithered darkness beyond the visibility radius, centred on the runner. */
  private drawFog(): void {
    const v = this.vis;
    const inner = v * 0.6 * PX;
    const outer = v * 1.2 * PX;
    if (inner > Math.hypot(BUF_W, BUF_H)) return;
    if (Math.abs(v - this.fogVis) > 0.05) {
      this.fogVis = v;
      const d = this.fogData.data;
      for (let y = 0; y < BUF_H; y++) {
        for (let x = 0; x < BUF_W; x++) {
          const r = Math.hypot(x + 0.5 - EYE_X, y + 0.5 - EYE_Y);
          let a = r <= inner ? 0 : r >= outer ? 1 : (r - inner) / (outer - inner);
          a = a * a * (3 - 2 * a) * FOG_LEVELS;
          const lvl = Math.floor(a) + (a - Math.floor(a) > BAYER[(y & 3) * 4 + (x & 3)] ? 1 : 0);
          const i = (y * BUF_W + x) * 4;
          d[i] = 8;
          d[i + 1] = 14;
          d[i + 2] = 9;
          d[i + 3] = Math.round((Math.min(FOG_LEVELS, lvl) / FOG_LEVELS) * FOG_MAX * 255);
        }
      }
      this.fog.getContext("2d")!.putImageData(this.fogData, 0, 0);
    }
    this.b.drawImage(this.fog, 0, 0);
  }

  /** Bakes the chunks around a point ahead of time (start of the race). */
  prebuild(x: number, y: number): void {
    this.forVisibleChunks(x, y, (cx, cy) => this.chunk(cx, cy));
  }

  private forVisibleChunks(x: number, y: number, fn: (cx: number, cy: number) => void) {
    const nx = Math.ceil(this.world.w / CS);
    const ny = Math.ceil(this.world.h / CS);
    for (let cy = Math.max(0, Math.floor((y - VIEW_R) / CS)); cy <= Math.min(ny - 1, Math.floor((y + VIEW_R) / CS)); cy++)
      for (let cx = Math.max(0, Math.floor((x - VIEW_R) / CS)); cx <= Math.min(nx - 1, Math.floor((x + VIEW_R) / CS)); cx++) fn(cx, cy);
  }

  private chunk(cx: number, cy: number): Chunk {
    const key = cy * 4096 + cx;
    let c = this.chunks.get(key);
    if (c) {
      // LRU: re-insert as most recent
      this.chunks.delete(key);
      this.chunks.set(key, c);
      return c;
    }
    c = this.bake(cx, cy);
    this.chunks.set(key, c);
    if (this.chunks.size > MAX_CHUNKS) this.chunks.delete(this.chunks.keys().next().value!);
    return c;
  }

  private bake(cx: number, cy: number): Chunk {
    const { world: w, sp } = this;
    const canvas = document.createElement("canvas");
    // one extra cell of overlap hides seams between rotated chunks
    canvas.width = canvas.height = (CS + 1) * PX;
    const g = canvas.getContext("2d")!;
    g.imageSmoothingEnabled = false;
    const i0 = cx * CS;
    const j0 = cy * CS;
    const trees: number[] = [];
    const inside = (i: number, j: number) => i >= 0 && j >= 0 && i < w.w && j < w.h;

    for (let j = j0; j < j0 + CS + 1; j++) {
      for (let i = i0; i < i0 + CS + 1; i++) {
        const px = (i - i0) * PX;
        const py = (j - j0) * PX;
        if (!inside(i, j)) {
          g.fillStyle = "#1a1a1a";
          g.fillRect(px, py, PX, PX);
          continue;
        }
        const k = j * w.w + i;
        const h = vhash(i, j);
        g.drawImage(sp.tiles, (h & 3) * PX, w.ground[k] * PX, PX, PX, px, py, PX, PX);
        const v = w.veg[k];
        if (v) {
          g.fillStyle = `rgba(20,70,10,${0.1 + 0.08 * v})`;
          g.fillRect(px, py, PX, PX);
        }
      }
    }
    this.bakeShade(g, i0, j0);
    // tree shadows first, then low objects
    for (let pass = 0; pass < 2; pass++) {
      for (let j = j0 - MARGIN; j < j0 + CS + 1 + MARGIN; j++) {
        for (let i = i0 - MARGIN; i < i0 + CS + 1 + MARGIN; i++) {
          if (!inside(i, j)) continue;
          const o = w.obj[j * w.w + i];
          if (!o) continue;
          const px = (i - i0 + 0.5) * PX;
          const py = (j - j0 + 0.5) * PX;
          if (isTree(o)) {
            if (pass === 0) {
              g.fillStyle = "rgba(0,10,0,0.28)";
              g.beginPath();
              g.ellipse(px + 5, py + 5, 11, 9, 0.6, 0, Math.PI * 2);
              g.fill();
              // trunk
              g.fillStyle = "#4a3020";
              g.fillRect(Math.round(px) - 2, Math.round(py) - 2, 4, 4);
            } else if (i >= i0 && j >= j0 && i < i0 + CS && j < j0 + CS) trees.push(i, j, o);
            continue;
          }
          if (pass === 0) continue;
          const name = BAKED[o as Obj];
          if (!name) continue;
          const img = sp[name];
          g.drawImage(img, Math.round(px - img.width / 2), Math.round(py - img.height / 2));
        }
      }
    }
    return { canvas, trees };
  }

  /**
   * Relief light & shadow as stepped terraces: the cell shade is interpolated per pixel, then
   * quantised to SHADE_LEVELS steps each way with a world-anchored Bayer dither, so slopes read as
   * crisp pixel-art bands with dithered edges (seamless across chunks).
   */
  private bakeShade(g: CanvasRenderingContext2D, i0: number, j0: number): void {
    const w = this.world;
    const S = (CS + 1) * PX;
    const img = this.shadeImg;
    const d = img.data;
    const cell = (i: number, j: number) => w.shade[Math.max(0, Math.min(w.h - 1, j)) * w.w + Math.max(0, Math.min(w.w - 1, i))];
    for (let py = 0; py < S; py++) {
      const v = j0 + (py + 0.5) / PX - 0.5;
      const j = Math.floor(v);
      const ty = v - j;
      const gy = j0 * PX + py;
      for (let px = 0; px < S; px++) {
        const u = i0 + (px + 0.5) / PX - 0.5;
        const i = Math.floor(u);
        const tx = u - i;
        const a = cell(i, j);
        const b = cell(i + 1, j);
        const c = cell(i, j + 1);
        const e = cell(i + 1, j + 1);
        const s = (a + (b - a) * tx + (c - a) * ty + (a - b - c + e) * tx * ty) / 100;
        const t = s * SHADE_LEVELS;
        const fl = Math.floor(t);
        const lvl = Math.max(-SHADE_LEVELS, Math.min(SHADE_LEVELS, fl + (t - fl > BAYER[(gy & 3) * 4 + ((i0 * PX + px) & 3)] ? 1 : 0)));
        const o = (py * S + px) * 4;
        if (lvl > 0) {
          d[o] = 255;
          d[o + 1] = 248;
          d[o + 2] = 210;
          d[o + 3] = Math.round((lvl / SHADE_LEVELS) * 0.24 * 255);
        } else if (lvl < 0) {
          d[o] = 12;
          d[o + 1] = 16;
          d[o + 2] = 42;
          d[o + 3] = Math.round((-lvl / SHADE_LEVELS) * 0.5 * 255);
        } else d[o + 3] = 0;
      }
    }
    const sc = this.shadeCanvas.getContext("2d")!;
    sc.putImageData(img, 0, 0);
    g.drawImage(this.shadeCanvas, 0, 0);
  }

  /** World → buffer coordinates for the current camera. */
  toScreen(p: Player, x: number, y: number): [number, number] {
    const rx = x - p.x;
    const ry = y - p.y;
    const c = Math.cos(p.heading);
    const s = Math.sin(p.heading);
    return [EYE_X + (rx * c + ry * s) * PX, EYE_Y + (-rx * s + ry * c) * PX];
  }

  /** Draws the hand-held compass at `scale`; rotation is sampled at screen resolution, so it stays clean. */
  drawCompass(g: CanvasRenderingContext2D, compass: Compass, bearing: number, x: number, y: number, scale: number): void {
    g.save();
    g.translate(x, y);
    g.scale(scale, scale);
    compass.draw(g, this.sp.plate, this.sp.housing, this.sp.needle, bearing);
    g.restore();
  }

  render(p: Player, showCodes: boolean): void {
    const { b, world: w, sp } = this;
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.imageSmoothingEnabled = false;
    b.fillStyle = "#1a1a1a";
    b.fillRect(0, 0, BUF_W, BUF_H);

    const visible: Chunk[] = [];
    b.save();
    b.translate(EYE_X, EYE_Y);
    b.rotate(-p.heading);
    b.scale(PX, PX);
    b.translate(-p.x, -p.y);
    this.forVisibleChunks(p.x, p.y, (cx, cy) => {
      const c = this.chunk(cx, cy);
      visible.push(c);
      b.drawImage(c.canvas, cx * CS, cy * CS, CS + 1, CS + 1);
    });
    b.restore();

    // course markers (upright on screen)
    const course = w.course;
    const marker = (img: HTMLImageElement, x: number, y: number, ax: number, ay: number) => {
      const [sx, sy] = this.toScreen(p, x, y);
      if (sx < -20 || sy < -20 || sx > BUF_W + 20 || sy > BUF_H + 20) return null;
      b.drawImage(img, Math.round(sx - ax), Math.round(sy - ay));
      return [sx, sy] as const;
    };
    marker(sp.start, course.start.x, course.start.y, 7, 7);
    const labels: [number, number, string][] = [];
    for (const c of course.controls) {
      const at = marker(sp.flag, c.x, c.y, 0, 11);
      if (at && showCodes && Math.hypot(c.x - p.x, c.y - p.y) < this.vis * 0.8) labels.push([at[0] + 4, at[1] - 14, String(c.code)]);
    }
    marker(sp.finish, course.finish.x, course.finish.y, 0, 11);

    // player
    const moving = Math.abs(p.speed) > 0.1;
    const frame = moving ? 1 + (Math.floor(p.stepPhase * 2) % 2) : 0;
    const hop = p.hopHeight;
    if (hop > 0) {
      // in the air: shadow stays on the ground, the runner gets "closer" to the camera
      b.fillStyle = "rgba(0,0,0,0.3)";
      b.fillRect(EYE_X - 4, EYE_Y + 3, 8, 3);
    }
    const ps = Math.round(12 + hop * 4);
    b.drawImage(sp.player, frame * 12, 0, 12, 12, Math.round(EYE_X - ps / 2), Math.round(EYE_Y - ps / 2 - hop * 2), ps, ps);

    // canopies above the player
    b.save();
    b.translate(EYE_X, EYE_Y);
    b.rotate(-p.heading);
    b.scale(PX, PX);
    b.translate(-p.x, -p.y);
    for (const c of visible) {
      const t = c.trees;
      for (let n = 0; n < t.length; n += 3) {
        const x = t[n] + 0.5;
        const y = t[n + 1] + 0.5;
        const dx = x - p.x;
        const dy = y - p.y;
        if (dx * dx + dy * dy > VIEW_R * VIEW_R) continue;
        const img = sp[TREE_SPRITE[t[n + 2] - Obj.Tree1]];
        b.globalAlpha = dx * dx + dy * dy < 2.6 ? 0.45 : 1;
        b.drawImage(img, x - img.width / PX / 2, y - img.height / PX / 2, img.width / PX, img.height / PX);
      }
    }
    b.globalAlpha = 1;
    b.restore();

    this.drawFog();

    // control code plates (only when close enough to read)
    b.font = "8px monospace";
    b.textBaseline = "top";
    for (const [x, y, s] of labels) {
      const tw = Math.ceil(b.measureText(s).width) + 2;
      b.fillStyle = "#ffffff";
      b.fillRect(Math.round(x), Math.round(y), tw, 8);
      b.fillStyle = "#000000";
      b.fillText(s, Math.round(x) + 1, Math.round(y));
    }
  }
}
