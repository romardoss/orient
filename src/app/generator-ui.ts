/** Generator page: parameter form ↔ URL, worker-driven generation, pan/zoom viewer, exports. */
import "./style.css";
import { DEFAULT_PARAMS, type MapParams, PRESETS, type PresetId, TERRAIN_KEYS, randomTerrain } from "../generator/params";
import { assetRoot } from "./data";
import { type PdfImagePage, buildPdf } from "./pdf";
import type { WorkerRequest, WorkerResponse } from "./worker";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("params");
const field = <T extends HTMLInputElement | HTMLSelectElement>(name: string) => form.elements.namedItem(name) as T;

interface UiState {
  preset: PresetId;
  params: MapParams;
  palette: "print" | "mapper";
  overprint: boolean;
  showSheet: boolean;
  showTitle: boolean;
}

const SLIDERS = TERRAIN_KEYS;

// ------------------------------------------------------------------ state <-> form <-> URL

function defaults(): UiState {
  return { preset: "mixed", params: structuredClone(DEFAULT_PARAMS), palette: "print", overprint: true, showSheet: true, showTitle: true };
}

function fromHash(): UiState {
  const s = defaults();
  const q = new URLSearchParams(location.hash.slice(1));
  const num = (k: string) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : undefined);
  const preset = q.get("preset") as PresetId | null;
  if (preset && PRESETS[preset]) {
    s.preset = preset;
    Object.assign(s.params, PRESETS[preset].params);
  }
  const p = s.params;
  p.seed = num("seed") ?? p.seed;
  for (const k of SLIDERS) p[k] = num(k) ?? p[k];
  const scale = num("scale");
  if (scale === 10000 || scale === 15000) p.scale = scale;
  const ci = num("ci");
  if (ci === 2.5 || ci === 5) p.contourInterval = ci;
  p.widthMm = num("w") ?? p.widthMm;
  p.heightMm = num("h") ?? p.heightMm;
  p.title = q.get("title") ?? p.title;
  p.symbolSize = num("sym") ?? p.symbolSize;
  p.course.enabled = q.get("course") !== "0";
  p.course.controls = num("controls") ?? p.course.controls;
  p.course.lengthKm = num("len") ?? p.course.lengthKm;
  p.course.name = q.get("cname") ?? p.course.name;
  p.course.legs = q.get("legs") !== "0";
  if (q.get("palette") === "mapper") s.palette = "mapper";
  s.overprint = q.get("overprint") !== "0";
  s.showSheet = q.get("sheet") !== "0";
  s.showTitle = q.get("tbox") !== "0";
  return s;
}

function toHash(s: UiState) {
  const p = s.params;
  const q = new URLSearchParams({
    preset: s.preset,
    seed: String(p.seed),
    ...Object.fromEntries(SLIDERS.map((k) => [k, String(p[k])])),
    scale: String(p.scale),
    ci: String(p.contourInterval),
    w: String(p.widthMm),
    h: String(p.heightMm),
    title: p.title,
    sym: String(p.symbolSize ?? 1),
    course: p.course.enabled ? "1" : "0",
    controls: String(p.course.controls),
    len: String(p.course.lengthKm),
    cname: p.course.name,
    legs: p.course.legs === false ? "0" : "1",
    palette: s.palette,
    overprint: s.overprint ? "1" : "0",
    sheet: s.showSheet ? "1" : "0",
    tbox: s.showTitle ? "1" : "0",
  });
  history.replaceState(null, "", `#${q}`);
}

function writeForm(s: UiState) {
  const p = s.params;
  field<HTMLSelectElement>("preset").value = s.preset;
  field<HTMLInputElement>("seed").value = String(p.seed);
  for (const k of SLIDERS) field<HTMLInputElement>(k).value = String(p[k]);
  field<HTMLInputElement>("title").value = p.title;
  field<HTMLInputElement>("symbolSize").value = String(p.symbolSize ?? 1);
  field<HTMLSelectElement>("scale").value = String(p.scale);
  field<HTMLSelectElement>("paper").value = `${p.widthMm}x${p.heightMm}`;
  field<HTMLSelectElement>("contourInterval").value = String(p.contourInterval);
  field<HTMLInputElement>("courseEnabled").checked = p.course.enabled;
  field<HTMLInputElement>("courseName").value = p.course.name;
  field<HTMLInputElement>("courseLegs").checked = p.course.legs !== false;
  field<HTMLInputElement>("controls").value = String(p.course.controls);
  field<HTMLInputElement>("lengthKm").value = String(p.course.lengthKm);
  field<HTMLSelectElement>("palette").value = s.palette;
  field<HTMLInputElement>("overprint").checked = s.overprint;
  field<HTMLInputElement>("showSheet").checked = s.showSheet;
  field<HTMLInputElement>("showTitle").checked = s.showTitle;
  updateOutputs();
}

function readForm(): UiState {
  const s = defaults();
  const p = s.params;
  s.preset = field<HTMLSelectElement>("preset").value as PresetId;
  p.seed = Math.floor(Number(field<HTMLInputElement>("seed").value) || 1);
  for (const k of SLIDERS) p[k] = Number(field<HTMLInputElement>(k).value);
  p.title = field<HTMLInputElement>("title").value || "Orienteering map";
  p.symbolSize = Number(field<HTMLInputElement>("symbolSize").value) || 1;
  p.scale = Number(field<HTMLSelectElement>("scale").value) as MapParams["scale"];
  const [w, h] = field<HTMLSelectElement>("paper").value.split("x").map(Number);
  p.widthMm = w;
  p.heightMm = h;
  p.contourInterval = Number(field<HTMLSelectElement>("contourInterval").value) as MapParams["contourInterval"];
  p.course = {
    enabled: field<HTMLInputElement>("courseEnabled").checked,
    name: field<HTMLInputElement>("courseName").value || "Course",
    controls: Number(field<HTMLInputElement>("controls").value),
    lengthKm: Number(field<HTMLInputElement>("lengthKm").value),
    legs: field<HTMLInputElement>("courseLegs").checked,
  };
  s.palette = field<HTMLSelectElement>("palette").value as UiState["palette"];
  s.overprint = field<HTMLInputElement>("overprint").checked;
  s.showSheet = field<HTMLInputElement>("showSheet").checked;
  s.showTitle = field<HTMLInputElement>("showTitle").checked;
  return s;
}

function updateOutputs() {
  for (const out of form.querySelectorAll<HTMLOutputElement>("output[data-for]")) {
    const input = field<HTMLInputElement>(out.dataset.for!);
    const v = Number(input.value);
    out.value = input.step === "1" || Number.isInteger(v) ? String(v) : v.toFixed(input.step === "0.1" ? 1 : 2);
  }
}

// ------------------------------------------------------------------ viewer (pan / zoom)

const viewer = $<HTMLElement>("viewer");
const img = $<HTMLImageElement>("map");
const view = { x: 0, y: 0, z: 1, baseW: 1, baseH: 1 };
const MAX_PX = 16000;

function applyView() {
  img.style.width = `${view.baseW * view.z}px`;
  img.style.height = `${view.baseH * view.z}px`;
  img.style.left = `${view.x}px`;
  img.style.top = `${view.y}px`;
}

function fit() {
  const r = viewer.getBoundingClientRect();
  const z = Math.min((r.width - 40) / view.baseW, (r.height - 40) / view.baseH);
  view.z = z;
  view.x = (r.width - view.baseW * z) / 2;
  view.y = (r.height - view.baseH * z) / 2;
  applyView();
}

function zoomAt(factor: number, cx: number, cy: number) {
  const maxZ = MAX_PX / Math.max(view.baseW, view.baseH);
  const nz = Math.min(maxZ, Math.max(0.05, view.z * factor));
  const f = nz / view.z;
  view.x = cx - (cx - view.x) * f;
  view.y = cy - (cy - view.y) * f;
  view.z = nz;
  applyView();
}

viewer.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const r = viewer.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  },
  { passive: false },
);
let drag: { x: number; y: number; vx: number; vy: number } | undefined;
viewer.addEventListener("pointerdown", (e) => {
  if ((e.target as HTMLElement).closest("button")) return;
  drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  viewer.setPointerCapture(e.pointerId);
  viewer.classList.add("dragging");
});
viewer.addEventListener("pointermove", (e) => {
  if (!drag) return;
  view.x = drag.vx + e.clientX - drag.x;
  view.y = drag.vy + e.clientY - drag.y;
  applyView();
});
const endDrag = () => {
  drag = undefined;
  viewer.classList.remove("dragging");
};
viewer.addEventListener("pointerup", endDrag);
viewer.addEventListener("pointercancel", endDrag);
const centre = () => {
  const r = viewer.getBoundingClientRect();
  return [r.width / 2, r.height / 2] as const;
};
$("zoomIn").onclick = () => zoomAt(1.5, ...centre());
$("zoomOut").onclick = () => zoomAt(1 / 1.5, ...centre());
$("zoomFit").onclick = fit;

// ------------------------------------------------------------------ generation

const STAGES: Record<string, string> = {
  terrain: "Рельєф і стік води…",
  water: "Озера, болота, струмки…",
  paths: "Дороги та стежки…",
  vegetation: "Рослинність…",
  contours: "Горизонталі…",
  rocks: "Скелі та каміння…",
  earth: "Земляні форми…",
  manmade: "Штучні об'єкти…",
  details: "Дрібні деталі…",
  course: "Постановка дистанції…",
  render: "Рендеринг символів ISOM…",
};

const status = $<HTMLElement>("status");
const button = $<HTMLButtonElement>("generate");
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
let reqId = 0;
let current: { svg: string; sheetSvg?: string; params: MapParams } | undefined;
let mapUrl: string | undefined;
let sheetUrl: string | undefined;
let firstRender = true;

function setStatus(text: string | undefined) {
  status.hidden = !text;
  if (text) status.textContent = text;
}

function generate() {
  const s = readForm();
  toHash(s);
  button.disabled = true;
  const req: WorkerRequest = {
    id: ++reqId,
    assetRoot: assetRoot(),
    params: s.params,
    draw: { palette: s.palette, overprint: s.overprint, showSheet: s.showSheet, showTitle: s.showTitle },
  };
  worker.postMessage(req);
  setStatus("Генерація…");
}

worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
  const m = ev.data;
  if (m.id !== reqId) return;
  if (m.type === "stage") {
    setStatus(STAGES[m.stage] ?? m.stage);
    return;
  }
  button.disabled = false;
  if (m.type === "error") {
    setStatus(undefined);
    console.error(m.message);
    alert(`Помилка генерації:\n${m.message}`);
    return;
  }
  const params = readForm().params;
  current = { svg: m.svg, sheetSvg: m.sheetSvg, params };
  if (mapUrl) URL.revokeObjectURL(mapUrl);
  mapUrl = URL.createObjectURL(new Blob([m.svg], { type: "image/svg+xml" }));
  const pxPerMm = 3.78;
  const sizeChanged = view.baseW !== params.widthMm * pxPerMm || view.baseH !== params.heightMm * pxPerMm;
  view.baseW = params.widthMm * pxPerMm;
  view.baseH = params.heightMm * pxPerMm;
  img.onload = () => {
    if (firstRender || sizeChanged) fit();
    else applyView();
    firstRender = false;
    setStatus(undefined);
  };
  img.src = mapUrl;

  if (sheetUrl) URL.revokeObjectURL(sheetUrl);
  const sheetImg = $<HTMLImageElement>("sheet");
  if (m.sheetSvg) {
    sheetUrl = URL.createObjectURL(new Blob([m.sheetSvg], { type: "image/svg+xml" }));
    sheetImg.src = sheetUrl;
    sheetImg.hidden = false;
  } else {
    sheetImg.hidden = true;
  }
  const list = $<HTMLOListElement>("descList");
  list.replaceChildren(...m.descriptions.map((d) => Object.assign(document.createElement("li"), { textContent: d })));

  const st = m.stats;
  const featureCount = Object.entries(st)
    .filter(([k]) => /^\d/.test(k))
    .reduce((a, [, v]) => a + v, 0);
  const rows: [string, string][] = [
    ["Об'єктів на карті", String(featureCount)],
    ["Можливих місць для КП", String(st.sites ?? 0)],
    ["Генерація", `${st.ms_total} мс`],
    ["Рендеринг", `${st.ms_draw} мс`],
    ["Розмір SVG", `${(m.svg.length / 1e6).toFixed(1)} МБ`],
  ];
  if (m.course) rows.push(["Дистанція", `${(m.course.length / 1000).toFixed(2)} км, ↑${m.course.climb} м`]);
  $("stats").replaceChildren(
    ...rows.flatMap(([k, v]) => [Object.assign(document.createElement("span"), { textContent: k }), Object.assign(document.createElement("b"), { textContent: v })]),
  );
};

// ------------------------------------------------------------------ exports

function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const baseName = () => (current ? `orienteering-${current.params.seed}` : "orienteering");

$("dlSvg").onclick = () => current && download(`${baseName()}.svg`, new Blob([current.svg], { type: "image/svg+xml" }));
$("dlSheet").onclick = () => current?.sheetSvg && download(`${baseName()}-descriptions.svg`, new Blob([current.sheetSvg], { type: "image/svg+xml" }));
$("dlPng").onclick = async () => {
  if (!current || !mapUrl) return;
  setStatus("Растеризація 300 dpi…");
  const dpi = 300;
  const w = Math.round((current.params.widthMm / 25.4) * dpi);
  const h = Math.round((current.params.heightMm / 25.4) * dpi);
  const im = new Image(w, h);
  im.src = mapUrl;
  await im.decode();
  const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(im, 0, 0, w, h);
  canvas.toBlob((b) => {
    setStatus(undefined);
    if (b) download(`${baseName()}.png`, b);
  }, "image/png");
};
$("print").onclick = () => {
  if (!current) return;
  const { widthMm: w, heightMm: h } = current.params;
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(
    `<!doctype html><title>${baseName()}</title><style>@page{size:${w}mm ${h}mm;margin:0}html,body{margin:0}svg{display:block;width:${w}mm;height:${h}mm}</style>${current.svg}`,
  );
  win.document.close();
  setTimeout(() => win.print(), 400);
};

// ------------------------------------------------------------------ batch PDF

/** Rasterises an SVG string to JPEG at the given resolution. */
async function svgToJpeg(svg: string, widthMm: number, heightMm: number, dpi: number): Promise<PdfImagePage> {
  const w = Math.round((widthMm / 25.4) * dpi);
  const h = Math.round((heightMm / 25.4) * dpi);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const im = new Image(w, h);
    im.src = url;
    await im.decode();
    const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(im, 0, 0, w, h);
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/jpeg", 0.9));
    canvas.width = canvas.height = 0;
    return { jpeg: new Uint8Array(await blob.arrayBuffer()), widthPx: w, heightPx: h, widthMm, heightMm };
  } finally {
    URL.revokeObjectURL(url);
  }
}

let batchCancelled = false;

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

async function batchPdf() {
  const count = Math.max(1, Math.min(100, Math.floor(Number($<HTMLInputElement>("batchCount").value) || 1)));
  const dpi = Number($<HTMLSelectElement>("batchDpi").value) || 200;
  const base = readForm();
  const startBtn = $<HTMLButtonElement>("batchPdf");
  const cancelBtn = $<HTMLButtonElement>("batchCancel");
  const progress = $<HTMLProgressElement>("batchProgress");
  const info = $<HTMLElement>("batchInfo");
  const infoText = info.textContent;

  // Each map: random seed + random terrain; sheet, scale and course come from the form.
  const jobs = Array.from({ length: count }, (_, i) => {
    const params: MapParams = structuredClone(base.params);
    Object.assign(params, randomTerrain());
    params.title = count > 1 ? `${base.params.title} · ${i + 1}` : base.params.title;
    return params;
  });
  const draw = { palette: base.palette, overprint: base.overprint, showSheet: base.showSheet, showTitle: base.showTitle };

  batchCancelled = false;
  startBtn.disabled = true;
  cancelBtn.hidden = false;
  progress.hidden = false;
  progress.max = count;
  progress.value = 0;

  const nWorkers = Math.max(1, Math.min(count, Math.min(3, Math.floor((navigator.hardwareConcurrency || 2) / 2))));
  const workers = Array.from({ length: nWorkers }, () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }));
  const pages: (PdfImagePage | undefined)[] = new Array(count);
  const failed: number[] = [];
  let done = 0;
  let next = 0;
  // Rasterising on the main thread one map at a time keeps memory bounded.
  let raster = Promise.resolve();

  const runOn = (w: Worker) =>
    new Promise<void>((resolve) => {
      const take = () => {
        if (batchCancelled || next >= count) return resolve();
        const i = next++;
        info.textContent = `Генерація карти ${Math.min(done + 1, count)} з ${count}…`;
        w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
          const m = ev.data;
          if (m.id !== i || m.type === "stage") return;
          if (m.type === "error") {
            console.error(`Карта ${i + 1}:`, m.message);
            failed.push(i + 1);
            done++;
            progress.value = done;
            take();
            return;
          }
          const p = jobs[i];
          raster = raster.then(async () => {
            if (batchCancelled) return;
            try {
              pages[i] = await svgToJpeg(m.svg, p.widthMm, p.heightMm, dpi);
            } catch (e) {
              console.error(e);
              failed.push(i + 1);
            }
            done++;
            progress.value = done;
          });
          take();
        };
        w.postMessage({ id: i, assetRoot: assetRoot(), params: jobs[i], draw } satisfies WorkerRequest);
      };
      take();
    });

  try {
    await Promise.all(workers.map(runOn));
    await raster;
    if (batchCancelled) {
      info.textContent = "Скасовано.";
      return;
    }
    const ok = pages.filter((p): p is PdfImagePage => !!p);
    if (!ok.length) {
      info.textContent = "Не вдалося згенерувати жодної карти.";
      return;
    }
    info.textContent = "Збирання PDF…";
    const pdf = buildPdf(ok, base.params.title);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    download(`orienteering-batch-${ok.length}-${stamp}.pdf`, pdf);
    const seeds = jobs.map((j, i) => (pages[i] ? j.seed : undefined)).filter((x) => x !== undefined);
    console.info("Batch seeds:", seeds);
    info.textContent =
      `Готово: ${ok.length} ${plural(ok.length, "карта", "карти", "карт")}, ${(pdf.size / 1e6).toFixed(1)} МБ.` + (failed.length ? ` Не вдалося: ${failed.join(", ")}.` : "");
  } finally {
    for (const w of workers) w.terminate();
    startBtn.disabled = false;
    cancelBtn.hidden = true;
    progress.hidden = true;
    if (!info.textContent || info.textContent.startsWith("Генерація")) info.textContent = infoText;
  }
}

$("batchPdf").onclick = () => void batchPdf();
$("batchCancel").onclick = () => {
  batchCancelled = true;
  $<HTMLElement>("batchInfo").textContent = "Скасування…";
};

// ------------------------------------------------------------------ wiring

const presetSelect = field<HTMLSelectElement>("preset");
for (const [id, pr] of Object.entries(PRESETS)) presetSelect.add(new Option(pr.label, id));
// Moving a terrain slider by hand means the map no longer matches the preset.
for (const k of SLIDERS) field(k).addEventListener("input", () => (presetSelect.value = "custom"));
$("randomMap").onclick = () => {
  const s = readForm();
  Object.assign(s.params, randomTerrain());
  s.preset = "custom";
  writeForm(s);
  generate();
};
presetSelect.addEventListener("change", () => {
  const s = readForm();
  Object.assign(s.params, PRESETS[s.preset].params);
  writeForm(s);
});
form.addEventListener("input", updateOutputs);
form.addEventListener("submit", (e) => {
  e.preventDefault();
  generate();
});
$("dice").onclick = () => {
  field<HTMLInputElement>("seed").value = String(Math.floor(Math.random() * 1e8));
  generate();
};
// Display-only options regenerate immediately.
for (const name of ["palette", "overprint", "showSheet", "showTitle", "courseLegs"]) field(name).addEventListener("change", generate);
window.addEventListener("resize", () => current && fit());

writeForm(fromHash());
generate();
