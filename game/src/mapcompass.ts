/**
 * Sport compass lying on the map (Q). Used the classic way to take a bearing:
 *   1. lay the long edge / direction-of-travel arrow along the leg (drag the plate, turn it by the knob);
 *   2. turn the housing until its orienting lines are parallel to the map's north lines (N up);
 *   3. the bezel now reads the bearing at the index mark — and the field compass (C) is set to it.
 *
 * Geometry is in paper millimetres; plate-local coordinates have −y = direction of travel and the
 * housing centre at the origin.
 */
const PLATE_W = 44;
const PLATE_FRONT = -66; // mm ahead of the housing centre
const PLATE_BACK = 30;
const HOUSING_R = 19;
const CAPSULE_R = 15;
const KNOB = { x: 0, y: -59, r: 4.5 };

export type CompassPart = "knob" | "housing" | "plate";

export class MapCompass {
  visible = false;
  /** Housing centre, paper mm. */
  x = 0;
  y = 0;
  /** Direction of travel of the baseplate on the map, rad clockwise from map north. */
  plate = 0;
  /** Bezel reading at the index mark, rad clockwise. */
  bearing = 0;

  private toLocal(px: number, py: number): [number, number] {
    const dx = px - this.x;
    const dy = py - this.y;
    const c = Math.cos(this.plate);
    const s = Math.sin(this.plate);
    return [dx * c + dy * s, -dx * s + dy * c];
  }

  hit(px: number, py: number): CompassPart | null {
    if (!this.visible) return null;
    const [lx, ly] = this.toLocal(px, py);
    if (Math.hypot(lx - KNOB.x, ly - KNOB.y) < KNOB.r + 1.5) return "knob";
    if (Math.hypot(lx, ly) < HOUSING_R) return "housing";
    if (Math.abs(lx) <= PLATE_W / 2 && ly >= PLATE_FRONT && ly <= PLATE_BACK) return "plate";
    return null;
  }

  /** Paper angle from the housing centre to a point (rad clockwise from up). */
  angleTo(px: number, py: number): number {
    return Math.atan2(px - this.x, -(py - this.y));
  }

  draw(ctx: CanvasRenderingContext2D, zoom: number): void {
    if (!this.visible) return;
    const px = 1 / zoom; // one screen pixel in mm
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.plate);

    // baseplate (transparent acrylic)
    ctx.beginPath();
    ctx.roundRect(-PLATE_W / 2, PLATE_FRONT, PLATE_W, PLATE_BACK - PLATE_FRONT, 5);
    ctx.fillStyle = "rgba(205,228,236,0.42)";
    ctx.fill();
    ctx.strokeStyle = "rgba(40,70,85,0.9)";
    ctx.lineWidth = Math.max(0.35, 1.2 * px);
    ctx.stroke();
    // ruler along both edges (every mm, longer every 5 and 10)
    ctx.strokeStyle = "rgba(10,20,25,0.85)";
    ctx.lineWidth = Math.max(0.12, 0.8 * px);
    ctx.beginPath();
    for (let y = PLATE_FRONT + 4; y <= PLATE_BACK - 4; y += 1) {
      const n = Math.round(y - PLATE_FRONT);
      const len = n % 10 === 0 ? 4 : n % 5 === 0 ? 2.6 : 1.4;
      if (zoom < 4 && n % 5) continue;
      ctx.moveTo(-PLATE_W / 2, y);
      ctx.lineTo(-PLATE_W / 2 + len, y);
      ctx.moveTo(PLATE_W / 2, y);
      ctx.lineTo(PLATE_W / 2 - len, y);
    }
    ctx.stroke();
    // centre line and direction-of-travel arrow
    ctx.setLineDash([2, 1.5]);
    ctx.beginPath();
    ctx.moveTo(0, -HOUSING_R);
    ctx.lineTo(0, PLATE_FRONT + 14);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(220,50,40,0.9)";
    ctx.beginPath();
    ctx.moveTo(0, PLATE_FRONT + 12);
    ctx.lineTo(-5, PLATE_FRONT + 24);
    ctx.lineTo(-1.6, PLATE_FRONT + 24);
    ctx.lineTo(-1.6, -HOUSING_R - 6);
    ctx.lineTo(1.6, -HOUSING_R - 6);
    ctx.lineTo(1.6, PLATE_FRONT + 24);
    ctx.lineTo(5, PLATE_FRONT + 24);
    ctx.closePath();
    ctx.fill();
    // rotation knob
    ctx.beginPath();
    ctx.arc(KNOB.x, KNOB.y, KNOB.r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(240,122,30,0.9)";
    ctx.fill();
    ctx.strokeStyle = "#5a2a05";
    ctx.lineWidth = Math.max(0.3, 1 * px);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(KNOB.x, KNOB.y, KNOB.r * 0.55, -2.4, 1.6);
    ctx.stroke();

    // housing: rotated so the bezel reads `bearing` at the index (plate-local up)
    ctx.save();
    ctx.rotate(-this.bearing);
    ctx.beginPath();
    ctx.arc(0, 0, HOUSING_R, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(55,60,68,0.75)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, CAPSULE_R, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(236,246,248,0.38)";
    ctx.fill();
    ctx.strokeStyle = "#151515";
    ctx.lineWidth = Math.max(0.25, 1 * px);
    ctx.stroke();
    // bezel ticks every 2°, labels every 30°
    ctx.strokeStyle = "#f2f2f2";
    ctx.beginPath();
    for (let a = 0; a < 360; a += zoom < 4 ? 10 : 2) {
      const r = (a * Math.PI) / 180;
      const len = a % 10 === 0 ? 2 : 1;
      const s = Math.sin(r);
      const c = Math.cos(r);
      ctx.moveTo(s * (HOUSING_R - 0.3), -c * (HOUSING_R - 0.3));
      ctx.lineTo(s * (HOUSING_R - 0.3 - len), -c * (HOUSING_R - 0.3 - len));
    }
    ctx.stroke();
    ctx.font = `bold 2.3px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let a = 0; a < 360; a += 30) {
      const r = (a * Math.PI) / 180;
      ctx.save();
      ctx.rotate(r);
      ctx.fillStyle = a === 0 ? "#ff5a50" : "#ffffff";
      ctx.fillText(a === 0 ? "N" : String(a), 0, -(HOUSING_R - 3.6));
      ctx.restore();
    }
    // orienting lines + arrow (point to bezel N)
    ctx.strokeStyle = "rgba(200,40,35,0.95)";
    ctx.lineWidth = Math.max(0.2, 1 * px);
    ctx.beginPath();
    for (const x of [-8, -4, 4, 8]) {
      const h = Math.sqrt(CAPSULE_R * CAPSULE_R - x * x) - 0.5;
      ctx.moveTo(x, -h);
      ctx.lineTo(x, h);
    }
    ctx.stroke();
    ctx.lineWidth = Math.max(0.35, 1.6 * px);
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(-3.4, -7);
    ctx.lineTo(-1.6, -7);
    ctx.lineTo(-1.6, 3);
    ctx.lineTo(1.6, 3);
    ctx.lineTo(1.6, -7);
    ctx.lineTo(3.4, -7);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // index mark
    ctx.fillStyle = "#101010";
    ctx.beginPath();
    ctx.moveTo(0, -HOUSING_R + 0.2);
    ctx.lineTo(-1.6, -HOUSING_R - 2.6);
    ctx.lineTo(1.6, -HOUSING_R - 2.6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // needle: the map is north-up, so on the map it points straight up
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.fillStyle = "rgba(225,45,40,0.95)";
    ctx.beginPath();
    ctx.moveTo(0, -12.5);
    ctx.lineTo(-1.5, 0);
    ctx.lineTo(1.5, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.moveTo(0, 12.5);
    ctx.lineTo(-1.5, 0);
    ctx.lineTo(1.5, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // bearing readout next to the compass (screen-sized text)
    const label = `${((Math.round((this.bearing * 180) / Math.PI) % 360) + 360) % 360}°`;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.font = `bold ${14 * px}px monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const lx = HOUSING_R + 26 * px;
    ctx.lineWidth = 3 * px;
    ctx.strokeStyle = "#fff";
    ctx.strokeText(label, lx, 0);
    ctx.fillStyle = "#97218b";
    ctx.fillText(label, lx, 0);
    ctx.restore();
  }
}
