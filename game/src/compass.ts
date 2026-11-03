/**
 * Hand-held sport (baseplate) compass: a damped spring needle. Opening it releases the needle at a random angle,
 * so it swings and takes a couple of seconds to settle; walking shakes it.
 */
import { gauss } from "./player";

const STIFFNESS = 22; // 1/s²
const DAMPING = 2 * 0.27 * Math.sqrt(STIFFNESS); // ζ ≈ 0.27 → settles in ~2–3 s
const RAISE_TIME = 0.35; // s

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class Compass {
  open = false;
  /** 0 = in the pocket, 1 = held up. */
  raise = 0;
  /** Needle screen angle (clockwise from up), rad. */
  angle = 0;
  vel = 0;
  /** Seconds the compass has been held. */
  usedTime = 0;

  toggle(): void {
    this.open = !this.open;
  }

  /** Becomes true when the needle has practically stopped. */
  get settled(): boolean {
    return this.raise >= 1 && Math.abs(this.vel) < 0.08;
  }

  update(dt: number, heading: number, moveFrac: number, step: boolean): void {
    const target = -heading; // north on screen, the view is heading-up
    const was = this.raise;
    this.raise = Math.max(0, Math.min(1, this.raise + ((this.open ? 1 : -1) * dt) / RAISE_TIME));
    if (was === 0 && this.raise > 0) {
      // freshly taken out: the needle is loose
      this.angle = target + (Math.random() < 0.5 ? -1 : 1) * (1.1 + Math.random() * 1.6);
      this.vel = (Math.random() - 0.5) * 6;
    }
    if (this.raise === 0) return;
    if (this.open) this.usedTime += dt;

    const err = wrap(this.angle - target);
    let acc = -STIFFNESS * err - DAMPING * this.vel;
    // hand tremor while walking + a kick on every footstep
    acc += gauss() * 9 * moveFrac;
    if (step) this.vel += (Math.random() - 0.5) * 2.2 * Math.max(0.3, moveFrac);
    // lifting the compass also disturbs it
    if (this.raise < 1) acc += gauss() * 6;
    this.vel += acc * dt;
    this.angle += this.vel * dt;
  }

  /**
   * Draws the sport compass in a 40×72 local frame (scale `ctx` for the size) into `ctx`: the baseplate points forward (up), the
   * housing is turned to `bearing`, the needle points to magnetic north. You face the bearing when
   * the red needle sits in the orienting arrow.
   */
  draw(ctx: CanvasRenderingContext2D, plate: HTMLImageElement, housing: HTMLImageElement, needle: HTMLImageElement, bearing: number): void {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(plate, 0, 0);
    ctx.save();
    ctx.translate(HOUSING_X, HOUSING_Y);
    ctx.save();
    ctx.rotate(-bearing);
    ctx.drawImage(housing, -18, -18);
    ctx.restore();
    ctx.rotate(this.angle);
    ctx.drawImage(needle, -2.5, -13.5);
    ctx.restore();
    ctx.fillStyle = "#202020";
    ctx.fillRect(HOUSING_X - 1, HOUSING_Y - 1, 2, 2);
  }
}

export const COMPASS_W = 40;
export const COMPASS_H = 72;
const HOUSING_X = 20;
const HOUSING_Y = 44;

/** Angle in [0, 360) degrees. */
export const deg = (rad: number) => ((Math.round((rad * 180) / Math.PI) % 360) + 360) % 360;
