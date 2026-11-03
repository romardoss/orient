/** Regular scalar grid over the map, in world metres (x east, y south). */
export class Grid {
  readonly data: Float32Array;

  constructor(
    readonly nx: number,
    readonly ny: number,
    readonly cell: number,
  ) {
    this.data = new Float32Array(nx * ny);
  }

  static like(g: Grid): Grid {
    return new Grid(g.nx, g.ny, g.cell);
  }

  idx(i: number, j: number): number {
    return j * this.nx + i;
  }

  get(i: number, j: number): number {
    i = i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i;
    j = j < 0 ? 0 : j >= this.ny ? this.ny - 1 : j;
    return this.data[j * this.nx + i];
  }

  set(i: number, j: number, v: number): void {
    this.data[j * this.nx + i] = v;
  }

  fill(fn: (x: number, y: number, i: number, j: number) => number): this {
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) this.data[j * this.nx + i] = fn(i * this.cell, j * this.cell, i, j);
    }
    return this;
  }

  /** Bilinear sample at world coordinates. */
  sample(x: number, y: number): number {
    const fx = x / this.cell;
    const fy = y / this.cell;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const a = this.get(i, j);
    const b = this.get(i + 1, j);
    const c = this.get(i, j + 1);
    const d = this.get(i + 1, j + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  }

  /** Gradient (per metre) at world coordinates, by central differences. */
  grad(x: number, y: number): { x: number; y: number } {
    const h = this.cell;
    return {
      x: (this.sample(x + h, y) - this.sample(x - h, y)) / (2 * h),
      y: (this.sample(x, y + h) - this.sample(x, y - h)) / (2 * h),
    };
  }

  /** Box blur, `passes` times (approximates a Gaussian). */
  blur(radius: number, passes = 2): Grid {
    const { nx, ny } = this;
    const w = 2 * radius + 1;
    let src = this.data;
    const tmp = new Float32Array(src.length);
    for (let p = 0; p < passes; p++) {
      for (let j = 0; j < ny; j++) {
        const row = j * nx;
        let acc = 0;
        for (let i = -radius; i <= radius; i++) acc += src[row + Math.min(nx - 1, Math.max(0, i))];
        for (let i = 0; i < nx; i++) {
          tmp[row + i] = acc / w;
          acc += src[row + Math.min(nx - 1, i + radius + 1)] - src[row + Math.max(0, i - radius)];
        }
      }
      const out = new Float32Array(src.length);
      for (let i = 0; i < nx; i++) {
        let acc = 0;
        for (let j = -radius; j <= radius; j++) acc += tmp[Math.min(ny - 1, Math.max(0, j)) * nx + i];
        for (let j = 0; j < ny; j++) {
          out[j * nx + i] = acc / w;
          acc += tmp[Math.min(ny - 1, j + radius + 1) * nx + i] - tmp[Math.max(0, j - radius) * nx + i];
        }
      }
      src = out;
    }
    const g = Grid.like(this);
    g.data.set(src);
    return g;
  }

  quantile(q: number): number {
    const sorted = Float32Array.from(this.data).sort();
    return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(q * sorted.length)))];
  }
}
