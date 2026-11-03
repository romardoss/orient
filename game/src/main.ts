/** Orient — top-down orienteering game on a procedurally generated ISOM map. */
import { DEFAULT_PARAMS, type MapParams, PRESETS } from "../../src/generator/index";
import { type PresetId, randomTerrain } from "../../src/generator/params";
import { COMPASS_H, COMPASS_W, Compass, deg } from "./compass";
import { MapView, rasteriseSvg } from "./mapview";
import { Player, RUN_SPEED } from "./player";
import { loadSprites } from "./sprites";
import { BUF_H, BUF_W, GameView } from "./view";
import type { GenRequest, GenResponse } from "./worker";
import type { World } from "./world";

const PUNCH_RADIUS = 2.5;
const FINISH_RADIUS = 3;
const PEEK_PENALTY = 30;

const STAGES: Record<string, string> = {
  terrain: "рельєф",
  water: "вода",
  paths: "дороги й стежки",
  vegetation: "рослинність",
  contours: "горизонталі",
  rocks: "скелі й каміння",
  earth: "форми рельєфу",
  manmade: "будівлі й огорожі",
  details: "дрібні об'єкти",
  course: "постановка дистанції",
  render: "друк карти",
  world: "будування світу",
};

// ---------------------------------------------------------------- params
const q = new URLSearchParams(location.search);
const seed = Number(q.get("seed")) || Math.floor(Math.random() * 1e8);
/** Everything (terrain sliders included) derives from the seed, so ?seed=N always gives the same map. */
const seeded = (s: number) => () => {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const preset = q.get("preset") as PresetId | null;
const params: MapParams = {
  ...DEFAULT_PARAMS,
  ...(preset && PRESETS[preset] ? PRESETS[preset].params : randomTerrain(seeded(seed))),
  seed,
  scale: 10000,
  widthMm: 200,
  heightMm: 200,
  title: "Orient",
  course: { enabled: true, controls: 6, lengthKm: 1.8, name: "Гра", legs: true },
};
// Fewer dense thickets and marshes than a real map: the game should be about navigation, not wading.
params.vegetation = Math.round(params.vegetation * 0.6 * 20) / 20;
params.water = Math.round(params.water * 0.7 * 20) / 20;

// ---------------------------------------------------------------- DOM
const gameCanvas = document.getElementById("game") as HTMLCanvasElement;
const mapCanvas = document.getElementById("map") as HTMLCanvasElement;
const loading = document.getElementById("loading")!;
const loadingStage = document.getElementById("loading-stage")!;
const seedLabel = document.getElementById("seed")!;
seedLabel.textContent = `seed ${params.seed}`;
const g = gameCanvas.getContext("2d")!;
gameCanvas.width = BUF_W * 2;
gameCanvas.height = BUF_H * 2;

// ---------------------------------------------------------------- generation
function generate(): Promise<{ svg: string; world: World }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent<GenResponse>) => {
      const m = ev.data;
      if (m.type === "stage") loadingStage.textContent = `${STAGES[m.stage] ?? m.stage}…`;
      else if (m.type === "error") reject(new Error(m.message));
      else {
        worker.terminate();
        resolve(m);
      }
    };
    worker.onerror = (e) => reject(new Error(e.message));
    // The symbol library is served from the site root, next to index.html.
    const req: GenRequest = { params, assetRoot: new URL("./", location.href).href };
    worker.postMessage(req);
  });
}

// ---------------------------------------------------------------- audio
let audio: AudioContext | undefined;
function beep(freq: number, dur: number, delay = 0) {
  audio ??= new AudioContext();
  const t = audio.currentTime + delay;
  const o = audio.createOscillator();
  const v = audio.createGain();
  o.type = "square";
  o.frequency.value = freq;
  v.gain.setValueAtTime(0.06, t);
  v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(v).connect(audio.destination);
  o.start(t);
  o.stop(t + dur);
}

// ---------------------------------------------------------------- game state
type State = "ready" | "running" | "finished";

async function main() {
  const [{ svg, world }, sprites] = await Promise.all([generate(), loadSprites()]);
  loadingStage.textContent = "друк карти…";
  const raster = await rasteriseSvg(svg, params);
  const mapView = new MapView(mapCanvas, raster, params);
  const view = new GameView(world, sprites);
  const course = world.course;

  let state: State = "ready";
  let player!: Player;
  let compass!: Compass;
  let next = 0;
  let time = 0;
  let peeks = 0;
  let peeking = false;
  let msg = "";
  let msgTime = 0;
  let nearWrong = -1;
  let splits: number[] = [];
  let track: { x: number; y: number }[] = [];

  const reset = () => {
    player = new Player(course.start.x, course.start.y);
    player.heading = Math.random() * Math.PI * 2;
    compass = new Compass();
    compass.open = true; // in the hand from the start; C puts it away / takes it out
    next = 0;
    time = 0;
    peeks = 0;
    splits = [];
    track = [{ x: player.x, y: player.y }];
    state = "ready";
    say("");
    view.prebuild(player.x, player.y);
    view.vis = view.visibilityAt(player.x, player.y);
    mapView.fit();
  };
  const say = (s: string, t = 3) => {
    msg = s;
    msgTime = t;
  };
  reset();
  loading.style.display = "none";

  // ---------------------------------------------------------------- input
  const keys = new Set<string>();
  window.addEventListener("keydown", (e) => {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    switch (e.code) {
      case "Enter":
      case "Space":
      case "KeyW":
      case "ArrowUp":
        if (state === "ready") {
          state = "running";
          say("Старт! Знайдіть КП 1.");
          beep(880, 0.15);
        }
        break;
      case "KeyA":
      case "KeyD":
        // one press = one hop; holding does nothing (key repeat is ignored above)
        if (state === "running") player.hop(e.code === "KeyA" ? -1 : 1);
        break;
      case "KeyQ":
        mapView.toggleCompass();
        say(mapView.compass.visible ? "Компас на карті: тягни основу, крути ручку й лімб" : `Азимут на компасі: ${deg(mapView.compass.bearing)}°`);
        break;
      case "KeyC":
        if (state !== "finished") compass.toggle();
        break;
      case "KeyM":
        if (state === "running") {
          peeks++;
          say(`Підглядання: +${PEEK_PENALTY} с штрафу`);
        }
        break;
      case "KeyR":
        reset();
        break;
      case "KeyN": {
        const u = new URL(location.href);
        u.searchParams.set("seed", String(Math.floor(Math.random() * 1e8)));
        location.href = u.href;
        break;
      }
      case "Equal":
      case "NumpadAdd":
        mapView.zoomAt(1.25);
        break;
      case "Minus":
      case "NumpadSubtract":
        mapView.zoomAt(0.8);
        break;
      case "KeyF":
        mapView.fit();
        break;
    }
  });
  window.addEventListener("keyup", (e) => keys.delete(e.code));
  window.addEventListener("blur", () => keys.clear());

  // Second control scheme: Space runs, dragging the mouse over the game view turns.
  const MOUSE_TURN = 0.0045; // rad per CSS px
  let mouseTurn = 0;
  let dragging = false;
  gameCanvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    gameCanvas.setPointerCapture(e.pointerId);
  });
  gameCanvas.addEventListener("pointermove", (e) => {
    if (dragging && state !== "finished") mouseTurn += e.movementX * MOUSE_TURN;
  });
  const endDrag = () => (dragging = false);
  gameCanvas.addEventListener("pointerup", endDrag);
  gameCanvas.addEventListener("pointercancel", endDrag);
  gameCanvas.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("resize", () => mapView.resize());

  // ---------------------------------------------------------------- loop
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    draw();
    requestAnimationFrame(frame);
  };

  function update(dt: number) {
    msgTime = Math.max(0, msgTime - dt);
    peeking = state === "running" && keys.has("KeyM");
    const canMove = state === "running";
    const inp = {
      forward: canMove && (keys.has("KeyW") || keys.has("ArrowUp") || keys.has("Space")),
      back: canMove && (keys.has("KeyS") || keys.has("ArrowDown")),
      left: state !== "finished" && keys.has("ArrowLeft"),
      right: state !== "finished" && keys.has("ArrowRight"),
      turn: mouseTurn,
    };
    mouseTurn = 0;
    const step = player.update(dt, inp, world, 1);
    view.updateVisibility(player, dt);
    compass.update(dt, player.heading, Math.min(1, Math.abs(player.speed) / RUN_SPEED), step);
    if (step && state === "running") beep(90 + Math.random() * 30, 0.03);
    if (state !== "running") return;

    time += dt;
    const lastPt = track[track.length - 1];
    if (Math.hypot(player.x - lastPt.x, player.y - lastPt.y) > 3) track.push({ x: player.x, y: player.y });

    // punching
    if (next < course.controls.length) {
      const c = course.controls[next];
      if (Math.hypot(player.x - c.x, player.y - c.y) < PUNCH_RADIUS) {
        splits.push(time);
        next++;
        beep(1320, 0.08);
        beep(1760, 0.12, 0.09);
        say(next < course.controls.length ? `КП ${next} (код ${c.code}) відмічено! Далі — КП ${next + 1}.` : `КП ${next} (код ${c.code}) відмічено! Тепер — на фініш.`);
      }
    } else if (Math.hypot(player.x - course.finish.x, player.y - course.finish.y) < FINISH_RADIUS) {
      splits.push(time);
      state = "finished";
      compass.open = false;
      beep(660, 0.15);
      beep(880, 0.15, 0.16);
      beep(1320, 0.3, 0.32);
      mapView.fit();
    }
    // a control that is not the next one
    let wrong = -1;
    course.controls.forEach((c, i) => {
      if (i !== next && Math.hypot(player.x - c.x, player.y - c.y) < PUNCH_RADIUS) wrong = i;
    });
    if (wrong >= 0 && wrong !== nearWrong) {
      const c = course.controls[wrong];
      say(wrong < next ? `Код ${c.code} — це КП ${wrong + 1}, ви його вже відмітили.` : `Код ${c.code} — не той КП! Потрібен КП ${next + 1}.`);
      beep(220, 0.2);
    }
    nearWrong = wrong;
  }

  const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

  function draw() {
    view.render(player, true);
    g.imageSmoothingEnabled = false;
    g.drawImage(view.buf, 0, 0, gameCanvas.width, gameCanvas.height);

    const showRunner = peeking || state === "finished";
    mapView.draw({
      runner: showRunner ? { x: player.x, y: player.y, heading: player.heading } : undefined,
      track: state === "finished" ? track : undefined,
    });

    // HUD
    g.font = "bold 18px monospace";
    g.textBaseline = "top";
    const total = course.controls.length;
    const target = next < total ? `КП ${next + 1}/${total}` : "ФІНІШ";
    panel(10, 10, [`Час ${fmt(time)}`, `Ціль: ${target}`, ...(peeks ? [`Підгл. ${peeks}×${PEEK_PENALTY}с`] : [])]);
    if (compass.raise > 0) {
      // compass held in the hand, bottom-left, ×3 pixels, set to the bearing taken on the map
      const ease = 1 - (1 - compass.raise) ** 3;
      const cw = COMPASS_W * 3;
      const size = COMPASS_H * 3;
      const y = Math.round(gameCanvas.height - (size + 12) * ease);
      g.fillStyle = "rgba(0,0,0,0.3)";
      g.fillRect(22, y + 8, cw, size);
      view.drawCompass(g, compass, mapView.compass.bearing, 16, y, 3);
      g.font = "bold 14px monospace";
      shadowText(`азимут ${deg(mapView.compass.bearing)}°`, 16 + cw + 10, y + size - 40);
      shadowText(compass.settled ? "стрілка стала" : "стрілка гуляє…", 16 + cw + 10, y + size - 18);
    }
    if (msgTime > 0 && msg) {
      g.font = "bold 16px monospace";
      const w = g.measureText(msg).width + 20;
      g.fillStyle = "rgba(0,0,0,0.6)";
      g.fillRect((gameCanvas.width - w) / 2, 64, w, 28);
      g.fillStyle = "#ffe08a";
      g.textAlign = "center";
      g.fillText(msg, gameCanvas.width / 2, 70);
      g.textAlign = "left";
    }
    if (state === "ready") {
      dialog([
        "СТАРТ",
        "",
        `Дистанція: ${total} КП, ${(course.length / 1000).toFixed(1)} км по прямій`,
        "Відмічайте КП по порядку, потім — на фініш.",
        "Ваше положення на карті не показується!",
        "",
        "W/S або ↑/↓ — вперед / назад",
        "←/→ — поворот",
        "A/D — стрибок убік (обійти перешкоду)",
        "або: Пробіл — біг, тягни мишею по виду — поворот",
        "Q — компас на карту: зняти азимут",
        "   (тягни основу, оранжева ручка — поворот,",
        "    лімб — тягни/колесо; лінії лімба ∥ лініям N)",
        "C — компас у руку: стрілка в «будиночок» = азимут",
        "   (на бігу стрілка сильно гуляє — зупиніться, щоб звірити)",
        `M — підглянути на карту (+${PEEK_PENALTY} с)`,
        "Карта: колесо — масштаб, тягни — зсув, F — уся",
        "",
        "Enter / Пробіл / W — почати",
      ]);
    } else if (state === "finished") {
      const penalty = peeks * PEEK_PENALTY;
      const lines = ["ФІНІШ!", "", `Час: ${fmt(time)}${penalty ? `  + штраф ${penalty} с = ${fmt(time + penalty)}` : ""}`, `Пробіг: ${(player.distance / 1000).toFixed(2)} км (по прямій ${(course.length / 1000).toFixed(2)})`, `Компас у руці: ${fmt(compass.usedTime)}`, ""];
      splits.forEach((s, i) => lines.push(`${i < total ? `КП ${i + 1}` : "Фініш"}: ${fmt(s)}  (+${fmt(s - (splits[i - 1] ?? 0))})`));
      lines.push("", "Ваш маршрут — червоним на карті", "R — ще раз   N — нова карта");
      dialog(lines);
    }
    g.font = "12px monospace";
    g.fillStyle = "rgba(255,255,255,0.55)";
    g.textAlign = "right";
    g.fillText("A/D стрибок · Q азимут · C компас · M карта · R · N", gameCanvas.width - 8, gameCanvas.height - 16);
    g.textAlign = "left";
  }

  function panel(x: number, y: number, lines: string[]) {
    const w = Math.max(...lines.map((l) => g.measureText(l).width)) + 16;
    g.fillStyle = "rgba(0,0,0,0.55)";
    g.fillRect(x, y, w, lines.length * 22 + 10);
    g.fillStyle = "#fff";
    lines.forEach((l, i) => g.fillText(l, x + 8, y + 6 + i * 22));
  }
  function shadowText(s: string, x: number, y: number) {
    g.fillStyle = "#000";
    g.fillText(s, x + 1, y + 1);
    g.fillStyle = "#fff";
    g.fillText(s, x, y);
  }
  function dialog(lines: string[]) {
    g.font = "bold 16px monospace";
    const w = Math.min(gameCanvas.width - 40, Math.max(...lines.map((l) => g.measureText(l).width)) + 40);
    const h = lines.length * 22 + 30;
    const x = (gameCanvas.width - w) / 2;
    const y = (gameCanvas.height - h) / 2;
    g.fillStyle = "rgba(10,14,20,0.85)";
    g.fillRect(x, y, w, h);
    g.strokeStyle = "#f07a1e";
    g.lineWidth = 3;
    g.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
    lines.forEach((l, i) => {
      g.fillStyle = i === 0 ? "#f07a1e" : "#e8e8e8";
      g.fillText(l, x + 20, y + 16 + i * 22);
    });
  }

  requestAnimationFrame(frame);
}

main().catch((e) => {
  loadingStage.textContent = `Помилка: ${e instanceof Error ? e.message : String(e)}`;
  console.error(e);
});
