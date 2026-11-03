/** Player movement: tank controls, heading drift, terrain speed and collision. */
import { GROUND_NAMES, GROUND_SPEED, VEG_SPEED, heightAt, type World } from "./world";

export const RUN_SPEED = 9; // m/s on open land (running pace, game-fast)
export const TURN_SPEED = 1.05; // rad/s, keyboard (~60°/s)
/** Keyboard turning eases in/out instead of snapping to full rate. */
const TURN_ACCEL = 5; // rad/s²
export const RADIUS = 0.32; // m
const ACCEL = 13.5;
const BACK = 0.45;
/** Heading drift (Ornstein–Uhlenbeck): angular velocity, rad/s. */
const DRIFT_TAU = 3.5;
const DRIFT_STD = 0.015;
/** Sideways slip of the walking direction relative to the facing, rad. */
const SLIP_TAU = 6;
const SLIP_STD = 0.022;

/** Side hop (A/D): a short jump sideways to get around an obstacle. */
const HOP_DIST = 1.3; // m
const HOP_TIME = 0.28; // s in the air
const HOP_COOLDOWN = 0.55; // s from take-off to the next possible hop

export interface Input {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  /** Extra heading change this frame (mouse drag), rad. */
  turn?: number;
}

export const gauss = () => {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
};

export class Player {
  /** Heading: 0 = north, clockwise, radians. */
  heading = 0;
  speed = 0;
  /** Current keyboard turning rate, rad/s. */
  turnRate = 0;
  drift = 0;
  slip = 0;
  /** Walking cycle, advances with distance; a step happens every 0.5 of a cycle. */
  stepPhase = 0;
  distance = 0;
  bumped = 0;
  /** Side hop progress 0..1 (≥1 = on the ground), direction −1 left / +1 right. */
  private hopU = 1;
  private hopDir = 0;
  private hopCooldown = 0;
  constructor(
    public x: number,
    public y: number,
  ) {}

  /** Starts a side hop; ignored while in the air or right after a hop (no holding/spamming). */
  hop(dir: -1 | 1): boolean {
    if (this.hopCooldown > 0) return false;
    this.hopU = 0;
    this.hopDir = dir;
    this.hopCooldown = HOP_COOLDOWN;
    return true;
  }

  /** Jump height 0..1 for drawing. */
  get hopHeight(): number {
    return this.hopU < 1 ? Math.sin(Math.PI * this.hopU) : 0;
  }

  /** Returns true when a footstep (or a hop landing) happened this frame. */
  update(dt: number, inp: Input, w: World, slowFactor: number): boolean {
    const turnTarget = ((inp.right ? 1 : 0) - (inp.left ? 1 : 0)) * TURN_SPEED;
    const dt2 = turnTarget - this.turnRate;
    this.turnRate += Math.sign(dt2) * Math.min(Math.abs(dt2), TURN_ACCEL * dt);
    this.heading += this.turnRate * dt + (inp.turn ?? 0);

    const dir = (inp.forward ? 1 : 0) - (inp.back ? BACK : 0);
    const terrain = this.terrainFactor(w, dir);
    const target = dir * RUN_SPEED * terrain * slowFactor;
    const dv = target - this.speed;
    this.speed += Math.sign(dv) * Math.min(Math.abs(dv), ACCEL * dt);

    const frac = Math.min(1, Math.abs(this.speed) / RUN_SPEED);
    if (frac > 0.02) {
      // Nobody walks perfectly straight: the heading wanders and the body slips sideways.
      const sq = Math.sqrt(dt);
      this.drift += (-this.drift / DRIFT_TAU) * dt + DRIFT_STD * Math.sqrt(2 / DRIFT_TAU) * sq * gauss();
      this.slip += (-this.slip / SLIP_TAU) * dt + SLIP_STD * Math.sqrt(2 / SLIP_TAU) * sq * gauss();
      this.heading += this.drift * frac * dt;
    }
    const moveDir = this.heading + this.slip * frac;
    const step = this.speed * dt;
    const dx = Math.sin(moveDir) * step;
    const dy = -Math.cos(moveDir) * step;
    const n = Math.max(1, Math.ceil(Math.abs(step) / 0.15));
    let moved = 0;
    for (let k = 0; k < n; k++) moved += this.move(w, dx / n, dy / n);
    this.distance += moved;
    if (moved < Math.abs(step) * 0.3 && Math.abs(step) > 0.001) {
      this.bumped = 0.25;
      this.speed *= 0.5;
    }
    this.bumped = Math.max(0, this.bumped - dt);

    // side hop: eased sideways displacement perpendicular to the facing
    let landed = false;
    this.hopCooldown = Math.max(0, this.hopCooldown - dt);
    if (this.hopU < 1) {
      const u0 = this.hopU;
      const u1 = Math.min(1, u0 + dt / HOP_TIME);
      const ease = (u: number) => (1 - Math.cos(Math.PI * u)) / 2;
      const d = HOP_DIST * (ease(u1) - ease(u0)) * this.hopDir;
      const sx = Math.cos(this.heading) * d;
      const sy = Math.sin(this.heading) * d;
      const m = Math.max(1, Math.ceil(Math.abs(d) / 0.15));
      for (let k = 0; k < m; k++) this.distance += this.move(w, sx / m, sy / m);
      this.hopU = u1;
      landed = u1 >= 1;
    }

    const before = this.stepPhase;
    this.stepPhase += moved / 2.6; // running stride ≈ 1.3 m
    return landed || Math.floor(before * 2) !== Math.floor(this.stepPhase * 2);
  }

  /** Speed multiplier from ground, vegetation and slope. */
  terrainFactor(w: World, dir: number): number {
    const i = Math.floor(this.x);
    const j = Math.floor(this.y);
    if (i < 0 || j < 0 || i >= w.w || j >= w.h) return 1;
    const k = j * w.w + i;
    const g = GROUND_SPEED[GROUND_NAMES[w.ground[k]]] || 0.5;
    const v = VEG_SPEED[w.veg[k]];
    let slope = 1;
    if (dir !== 0) {
      const fx = Math.sin(this.heading) * Math.sign(dir);
      const fy = -Math.cos(this.heading) * Math.sign(dir);
      const grade = heightAt(w.height, this.x + fx, this.y + fy) - heightAt(w.height, this.x - fx, this.y - fy);
      slope = grade > 0 ? Math.max(0.45, 1 - grade * 1.4) : Math.min(1.12, 1 - grade * 0.4);
    }
    return g * v * slope;
  }

  private move(w: World, dx: number, dy: number): number {
    if (!blocked(w, this.x + dx, this.y + dy)) {
      this.x += dx;
      this.y += dy;
      return Math.hypot(dx, dy);
    }
    // slide along the obstacle
    if (dx && !blocked(w, this.x + dx, this.y)) {
      this.x += dx;
      return Math.abs(dx);
    }
    if (dy && !blocked(w, this.x, this.y + dy)) {
      this.y += dy;
      return Math.abs(dy);
    }
    return 0;
  }
}

/** Circle (player) against solid 1 m cells and the map edge. */
export function blocked(w: World, x: number, y: number, r = RADIUS): boolean {
  if (x < r || y < r || x > w.w - r || y > w.h - r) return true;
  for (let j = Math.floor(y - r); j <= Math.floor(y + r); j++) {
    for (let i = Math.floor(x - r); i <= Math.floor(x + r); i++) {
      if (!w.solid[j * w.w + i]) continue;
      const cx = Math.max(i, Math.min(x, i + 1));
      const cy = Math.max(j, Math.min(y, j + 1));
      if ((cx - x) ** 2 + (cy - y) ** 2 < r * r) return true;
    }
  }
  return false;
}
