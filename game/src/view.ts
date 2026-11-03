/**
 * Top-down game view. The scene is rendered heading-up into a small pixel buffer and scaled ×2
 * with nearest-neighbour, so everything (even rotated terrain) keeps the chunky pixel-art look.
 * Ground + low objects are baked into cached 32×32 m chunks; tree canopies are drawn per frame.
 */
import type { Compass } from "./compass";
import type { Player } from "./player";
import type { Sprites } from "./sprites";
import { GROUND, Obj, heightAt, isTree, type World } from "./world";

/** Visibility radius, metres: open land vs. the densest thicket. */
const VIS_OPEN = 58;
const VIS_MIN = 10;
const VIS_SAMPLE_R = 9;
const FOG_LEVELS = 6;
const FOG_MAX = 0.62;
/**
 * Perspective from a camera CAM_H metres above the runner: a point h metres above the runner's eye
 * level is drawn CAM_H / (CAM_H − h) times further from the runner and that much bigger. Covers both
 * the terrain (uphill = closer) and the object's own height (tree tops lean outwards = parallax).
 */
const CAM_H = 80;
const PERSP_MIN = 0.7;
const PERSP_MAX = 1.6;
/** Max crown / flag enlargement (smaller than PERSP_MAX, so the lean stays visible uphill). */
const SIZE_MAX = 1.3;
/** Height of the drawn top of things, metres: canopies per tree sprite, control flags. */
const CANOPY_H = [1, 0.7, 0.5];
const FLAG_H = 0.9;
/**
 * World isolines are denser than the map: CONTOUR_SPLIT lines per map contour interval. Lines on
 * the map's own contours are normal, the in-between ones fainter, every 5th map contour is an
 * index contour (thicker, darker), as on the map.
 */
const CONTOUR_SPLIT = 2;
const INDEX_EVERY = 5 * CONTOUR_SPLIT;
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
  private readonly lineCanvas = document.createElement("canvas");
  private readonly lineImg = new ImageData((CS + 1) * PX, (CS + 1) * PX);

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
    this.lineCanvas.width = this.lineCanvas.height = (CS + 1) * PX;
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
    const inner = v * 0.75 * PX;
    const outer = v * 1.6 * PX;
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
        const s = w.shade[k];
        if (s > 4) {
          g.fillStyle = `rgba(255,250,215,${(s / 100) * 0.26})`;
          g.fillRect(px, py, PX, PX);
        } else if (s < -4) {
          g.fillStyle = `rgba(10,15,40,${(-s / 100) * 0.48})`;
          g.fillRect(px, py, PX, PX);
        }
      }
    }
    this.bakeContours(g, i0, j0);
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
              g.fillStyle = "rgba(0,10,0,0.38)";
              g.beginPath();
              g.ellipse(px + 6, py + 6, 12, 9.5, 0.7, 0, Math.PI * 2);
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
   * Thin contour lines like on the printed map (same interval): a pixel is on a contour where the
   * height crosses a multiple of the interval between it and its right / lower neighbour.
   */
  private bakeContours(g: CanvasRenderingContext2D, i0: number, j0: number): void {
    const w = this.world;
    const S = (CS + 1) * PX;
    const N = S + 1;
    const ci = w.contourInterval / CONTOUR_SPLIT;
    const lv = new Int32Array(N * N);
    for (let py = 0; py < N; py++)
      for (let px = 0; px < N; px++) lv[py * N + px] = Math.floor(heightAt(w.height, i0 + (px + 0.5) / PX, j0 + (py + 0.5) / PX) / ci);
    const d = this.lineImg.data;
    d.fill(0);
    for (let py = 0; py < S; py++) {
      const cj = j0 + Math.floor(py / PX);
      for (let px = 0; px < S; px++) {
        const ci2 = i0 + Math.floor(px / PX);
        if (ci2 >= w.w || cj >= w.h) continue;
        const gr = w.ground[cj * w.w + ci2];
        if (gr === GROUND.deep || gr === GROUND.shallow) continue;
        const a = lv[py * N + px];
        const r = lv[py * N + px + 1];
        const b = lv[(py + 1) * N + px];
        if (a === r && a === b) continue;
        // the level being crossed
        const level = Math.max(a, r, b);
        const index = level % INDEX_EVERY === 0;
        const onMap = level % CONTOUR_SPLIT === 0;
        const o = (py * S + px) * 4;
        d[o] = 120;
        d[o + 1] = 62;
        d[o + 2] = 18;
        d[o + 3] = index ? 175 : onMap ? 115 : 70;
        if (index && px + 1 < S) {
          // index contours are two pixels wide
          d[o + 4] = 120;
          d[o + 5] = 62;
          d[o + 6] = 18;
          d[o + 7] = 175;
        }
      }
    }
    this.lineCanvas.getContext("2d")!.putImageData(this.lineImg, 0, 0);
    g.drawImage(this.lineCanvas, 0, 0);
  }

  /** Perspective factor for a point h metres above the ground at (x, y): higher = closer = bigger and further out. */
  private persp(x: number, y: number, eyeH: number, h: number): { lean: number; size: number } {
    // terrain height of the base relative to the runner's eye level
    const dh = Math.max(-CAM_H * 0.6, Math.min(CAM_H * 0.4, heightAt(this.world.height, x, y) - eyeH));
    const top = CAM_H - dh - h;
    // full perspective of the top (strong uphill) vs. the lean over its own base (never < 1, so
    // downhill the crowns still lean outwards instead of being pulled towards the runner)
    const full = CAM_H / top;
    const own = (CAM_H - dh) / top;
    return {
      lean: Math.min(PERSP_MAX, Math.max(full, own)),
      // size: higher terrain = closer = bigger, but capped lower so a crown never hides its lean
      size: Math.max(PERSP_MIN, Math.min(SIZE_MAX, full)),
    };
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
    const eyeH = heightAt(w.height, p.x, p.y);
    const marker = (img: HTMLImageElement, x: number, y: number, ax: number, ay: number) => {
      const { lean, size: z } = this.persp(x, y, eyeH, FLAG_H);
      const [sx, sy] = this.toScreen(p, p.x + (x - p.x) * lean, p.y + (y - p.y) * lean);
      if (sx < -20 || sy < -20 || sx > BUF_W + 20 || sy > BUF_H + 20) return null;
      b.drawImage(img, Math.round(sx - ax * z), Math.round(sy - ay * z), Math.round(img.width * z), Math.round(img.height * z));
      return [sx, sy - (z - 1) * ay] as const;
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
    // parallax: each crown sits above its trunk and leans away from the camera axis
    type Crown = { tx: number; ty: number; x: number; y: number; z: number; img: HTMLImageElement };
    const crowns: Crown[] = [];
    for (const c of visible) {
      const t = c.trees;
      for (let n = 0; n < t.length; n += 3) {
        const tx = t[n] + 0.5;
        const ty = t[n + 1] + 0.5;
        if ((tx - p.x) ** 2 + (ty - p.y) ** 2 > VIEW_R * VIEW_R) continue;
        const kind = t[n + 2] - Obj.Tree1;
        const { lean, size } = this.persp(tx, ty, eyeH, CANOPY_H[kind]);
        crowns.push({ tx, ty, x: p.x + (tx - p.x) * lean, y: p.y + (ty - p.y) * lean, z: size, img: sp[TREE_SPRITE[kind]] });
      }
    }
    // trunks first (seen at an angle they run from the base to the crown), then all crowns on top
    b.strokeStyle = "#2b1d12";
    b.lineWidth = 0.35;
    b.beginPath();
    for (const c of crowns) {
      if ((c.x - c.tx) ** 2 + (c.y - c.ty) ** 2 < 0.01) continue;
      b.moveTo(c.tx, c.ty);
      b.lineTo(c.x, c.y);
    }
    b.stroke();
    for (const c of crowns) {
      b.globalAlpha = (c.x - p.x) ** 2 + (c.y - p.y) ** 2 < 2.6 ? 0.45 : 1;
      const sw = (c.img.width / PX) * c.z;
      const sh = (c.img.height / PX) * c.z;
      b.drawImage(c.img, c.x - sw / 2, c.y - sh / 2, sw, sh);
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
