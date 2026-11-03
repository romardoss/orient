/**
 * Right panel: the real generated ISOM map (SVG rasterised once), pannable and zoomable.
 * The runner's position is NOT shown during the race — only when peeking (M) and after the finish.
 */
import { computeLayout } from "../../src/generator/layout";
import { type MapParams, metresPerMm } from "../../src/generator/params";
import { type CompassPart, MapCompass } from "./mapcompass";

const RASTER_PX_PER_MM = 14;

export async function rasteriseSvg(svg: string, p: MapParams): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = Math.round(p.widthMm * RASTER_PX_PER_MM);
    c.height = Math.round(p.heightMm * RASTER_PX_PER_MM);
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface MapOverlay {
  /** Runner position + heading, world metres. */
  runner?: { x: number; y: number; heading: number };
  track?: { x: number; y: number }[];
}

export class MapView {
  private readonly ctx: CanvasRenderingContext2D;
  /** Screen px per paper mm. */
  private zoom = 1;
  /** Paper mm at the panel centre. */
  private cx = 0;
  private cy = 0;
  private readonly frame;
  private readonly mpm: number;
  private drag?: { x: number; y: number; cx: number; cy: number };
  /** Dragging a part of the map compass: offsets / start angles in paper mm / rad. */
  private cdrag?: { part: CompassPart; dx: number; dy: number; a0: number; v0: number };
  readonly compass = new MapCompass();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly raster: HTMLCanvasElement,
    private readonly p: MapParams,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.frame = computeLayout(p).frame;
    this.mpm = metresPerMm(p);
    this.resize();
    this.fit();
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const [px, py] = this.screenToPaper(sx, sy);
      const part = this.compass.hit(px, py);
      const stepDeg = e.deltaY < 0 ? -1 : 1;
      if (part === "housing") this.compass.bearing += (stepDeg * (e.shiftKey ? 5 : 1) * Math.PI) / 180;
      else if (part) this.compass.plate += (stepDeg * (e.shiftKey ? 5 : 1) * Math.PI) / 180;
      else this.zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, sx, sy);
      this.updateCursor(part);
    });
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      const r = canvas.getBoundingClientRect();
      const [px, py] = this.screenToPaper(e.clientX - r.left, e.clientY - r.top);
      const part = this.compass.hit(px, py);
      const c = this.compass;
      if (part) {
        const a0 = c.angleTo(px, py);
        this.cdrag = { part, dx: c.x - px, dy: c.y - py, a0, v0: part === "housing" ? c.bearing : c.plate };
        return;
      }
      this.drag = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy };
    });
    canvas.addEventListener("pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      const [px, py] = this.screenToPaper(e.clientX - r.left, e.clientY - r.top);
      const c = this.compass;
      if (this.cdrag) {
        const d = this.cdrag;
        if (d.part === "plate") {
          c.x = px + d.dx;
          c.y = py + d.dy;
        } else {
          // turning around the housing centre; the housing turns the other way to the bezel reading
          const da = c.angleTo(px, py) - d.a0;
          if (d.part === "knob") c.plate = d.v0 + da;
          else c.bearing = d.v0 - da;
        }
        return;
      }
      if (!this.drag) {
        this.updateCursor(c.hit(px, py));
        return;
      }
      this.cx = this.drag.cx - (e.clientX - this.drag.x) / this.zoom;
      this.cy = this.drag.cy - (e.clientY - this.drag.y) / this.zoom;
    });
    const end = () => {
      this.drag = undefined;
      this.cdrag = undefined;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
  }

  private get cssW() {
    return this.canvas.width / (window.devicePixelRatio || 1);
  }
  private get cssH() {
    return this.canvas.height / (window.devicePixelRatio || 1);
  }

  fit(): void {
    this.zoom = Math.min(this.cssW / this.p.widthMm, this.cssH / this.p.heightMm);
    this.cx = this.p.widthMm / 2;
    this.cy = this.p.heightMm / 2;
  }

  /** Zooms around a screen point (CSS px); without one, around the panel centre. */
  zoomAt(f: number, sx = this.cssW / 2, sy = this.cssH / 2): void {
    const min = Math.min(this.cssW / this.p.widthMm, this.cssH / this.p.heightMm) * 0.8;
    const nz = Math.max(min, Math.min(40, this.zoom * f));
    const mx = this.cx + (sx - this.cssW / 2) / this.zoom;
    const my = this.cy + (sy - this.cssH / 2) / this.zoom;
    this.zoom = nz;
    this.cx = mx - (sx - this.cssW / 2) / nz;
    this.cy = my - (sy - this.cssH / 2) / nz;
  }

  /** Centres the view on a world point (metres) at a readable zoom. */
  focus(x: number, y: number, zoom = 8): void {
    this.zoom = zoom;
    this.cx = this.frame.x0 + x / this.mpm;
    this.cy = this.frame.y0 + y / this.mpm;
  }

  private updateCursor(part: CompassPart | null): void {
    this.canvas.style.cursor = part === "plate" ? "move" : part ? "alias" : "";
  }

  private screenToPaper(sx: number, sy: number): [number, number] {
    return [this.cx + (sx - this.cssW / 2) / this.zoom, this.cy + (sy - this.cssH / 2) / this.zoom];
  }

  /** Shows / hides the compass on the map; a newly shown compass appears at the panel centre. */
  toggleCompass(): void {
    const c = this.compass;
    c.visible = !c.visible;
    if (c.visible) {
      c.x = this.cx;
      c.y = this.cy;
    }
  }

  private worldToPaper(x: number, y: number): [number, number] {
    return [this.frame.x0 + x / this.mpm, this.frame.y0 + y / this.mpm];
  }

  draw(o: MapOverlay = {}): void {
    const { ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#3b3f46";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    // paper mm → device px
    const k = this.zoom * dpr;
    ctx.setTransform(k, 0, 0, k, (this.cssW / 2 - this.cx * this.zoom) * dpr, (this.cssH / 2 - this.cy * this.zoom) * dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 12;
    ctx.drawImage(this.raster, 0, 0, this.p.widthMm, this.p.heightMm);
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";

    if (o.track && o.track.length > 1) {
      ctx.strokeStyle = "rgba(230,30,30,0.85)";
      ctx.lineWidth = 0.45;
      ctx.lineJoin = ctx.lineCap = "round";
      ctx.beginPath();
      o.track.forEach((q, i) => {
        const [x, y] = this.worldToPaper(q.x, q.y);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
    this.compass.draw(ctx, this.zoom);
    if (o.runner) {
      const [x, y] = this.worldToPaper(o.runner.x, o.runner.y);
      const r = Math.max(0.8, 6 / this.zoom);
      ctx.strokeStyle = "#e01e1e";
      ctx.lineWidth = r * 0.35;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.sin(o.runner.heading) * r * 2.6, y - Math.cos(o.runner.heading) * r * 2.6);
      ctx.stroke();
      ctx.fillStyle = "#e01e1e";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = r * 0.3;
      ctx.stroke();
    }
  }
}
