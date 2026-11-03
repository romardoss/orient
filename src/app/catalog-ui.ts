/** Symbol catalogue: browse, search and download the generated asset library. */
import "./style.css";
import { assetUrl, loadJson } from "./data";

interface XmapEntry {
  code: string;
  name: string;
  type: string;
  shape: string;
  hidden: boolean;
  description: string;
  files: { svg: string; svgTrueSize: string; png: string; sprite: string };
}

interface DescEntry {
  kind: string;
  id: string;
  standard: string | null;
  wide: boolean;
  names: Record<string, string>;
  texts: Record<string, string>;
  files: { svg: string; png: string; sprite: string };
}

interface XmapManifest {
  set: string;
  title: string;
  scale: number;
  license: string;
  symbols: XmapEntry[];
}

interface DescManifest {
  set: string;
  languages: Record<string, string>;
  license: string;
  symbols: DescEntry[];
}

const SETS = [
  { slug: "isom-2017-2", label: "ISOM 2017-2" },
  { slug: "issprom-2019-2", label: "ISSprOM 2019-2" },
  { slug: "course-design", label: "Курсові символи" },
  { slug: "control-descriptions", label: "Легенди КП (IOF)" },
] as const;

const TYPE_UK: Record<string, string> = { point: "точковий", line: "лінійний", area: "площинний", text: "текст", combined: "комбінований" };
const COLUMN_UK: Record<string, string> = {
  A: "колонка A — старт",
  C: "колонка C — який із подібних",
  D: "колонка D — об'єкт",
  E: "колонка E — характеристика / другий об'єкт",
  F: "колонка F — розмір / комбінація",
  G: "колонка G — розташування КП",
  H: "колонка H — інше",
  V: "інструкції",
  W: "інструкції — маркований маршрут",
  X: "інструкції — обов'язковий прохід",
  Y: "інструкції — обмін карт",
  Z: "інструкції — до фінішу",
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const grid = $<HTMLDivElement>("grid");
const search = $<HTMLInputElement>("search");
const langSel = $<HTMLSelectElement>("lang");
const showHidden = $<HTMLInputElement>("showHidden");
const showHiddenLabel = showHidden.closest("label")!;
const dialog = $<HTMLDialogElement>("dialog");

let active: (typeof SETS)[number]["slug"] = (location.hash.slice(1) as typeof active) || "isom-2017-2";
const cache = new Map<string, Promise<XmapManifest | DescManifest>>();
const manifest = (slug: string) => {
  if (!cache.has(slug)) cache.set(slug, loadJson(`${slug}/manifest.json`));
  return cache.get(slug)!;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

function renderTabs() {
  $("tabs").replaceChildren(
    ...SETS.map((s) =>
      el("button", {
        type: "button",
        textContent: s.label,
        className: s.slug === active ? "active" : "",
        onclick: () => {
          active = s.slug;
          history.replaceState(null, "", `#${active}`);
          render();
        },
      }),
    ),
  );
}

function link(slug: string, path: string, label: string) {
  return el("a", { href: assetUrl(`${slug}/${path}`), download: path.split("/").pop()!, textContent: label });
}

function openXmap(slug: string, m: XmapManifest, s: XmapEntry) {
  dialog.replaceChildren(
    el(
      "div",
      { className: "detail" },
      el("div", { className: "preview" }, el("img", { src: assetUrl(`${slug}/${s.files.svg}`), alt: s.name })),
      el(
        "div",
        {},
        el("h2", { textContent: `${s.code} ${s.name}` }),
        el("div", { className: "meta", textContent: `${m.set} · ${TYPE_UK[s.type] ?? s.type}${s.hidden ? " · службовий" : ""}` }),
        el("div", { className: "description", textContent: s.description || "Опис відсутній." }),
        el(
          "div",
          { className: "downloads" },
          link(slug, s.files.svg, "SVG"),
          link(slug, s.files.svgTrueSize, "SVG (реальний розмір, мм)"),
          link(slug, s.files.png, "PNG 128 px"),
        ),
      ),
      el("button", { className: "close", type: "button", textContent: "×", onclick: () => dialog.close() }),
    ),
  );
  dialog.showModal();
}

function openDesc(slug: string, m: DescManifest, s: DescEntry) {
  const names = el("dl", { className: "names" });
  for (const [lang, name] of Object.entries(s.names)) {
    names.append(el("dt", { textContent: m.languages[lang] ?? lang }), el("dd", { textContent: name }));
  }
  dialog.replaceChildren(
    el(
      "div",
      { className: "detail" },
      el("div", { className: "preview" }, el("img", { src: assetUrl(`${slug}/${s.files.svg}`), alt: s.names.en ?? s.id })),
      el(
        "div",
        {},
        el("h2", { textContent: `${s.id} ${s.names.en ?? ""}` }),
        el("div", { className: "meta", textContent: `${COLUMN_UK[s.kind] ?? s.kind}${s.standard ? ` · стандарт ${s.standard}` : ""}` }),
        names,
        el("div", { className: "downloads" }, link(slug, s.files.svg, "SVG"), link(slug, s.files.png, "PNG 128 px")),
      ),
      el("button", { className: "close", type: "button", textContent: "×", onclick: () => dialog.close() }),
    ),
  );
  dialog.showModal();
}

async function render() {
  renderTabs();
  const slug = active;
  const m = await manifest(slug);
  if (slug !== active) return;
  const q = search.value.trim().toLowerCase();
  const cards: HTMLElement[] = [];
  showHiddenLabel.hidden = "languages" in m;
  if ("languages" in m) {
    langSel.hidden = false;
    if (!langSel.options.length) {
      for (const [code, name] of Object.entries(m.languages)) langSel.add(new Option(name, code));
      langSel.value = "en";
    }
    const lang = langSel.value;
    $("info").textContent = `${m.symbols.length} символів IOF-легенд КП (колонки C–H та інструкційні рядки), назви ${Object.keys(m.languages).length} мовами. Ліцензія: ${m.license}.`;
    for (const s of m.symbols) {
      const name = s.names[lang] ?? s.names.en ?? "";
      if (q && !`${s.kind} ${s.id} ${name} ${s.names.en ?? ""}`.toLowerCase().includes(q)) continue;
      cards.push(
        el(
          "div",
          { className: "card", onclick: () => openDesc(slug, m, s), title: name },
          el("img", { src: assetUrl(`${slug}/${s.files.svg}`), alt: name, loading: "lazy", className: s.wide ? "wide" : "" }),
          el("span", { className: "code", textContent: `${s.kind} ${s.id}` }),
          el("span", { className: "name", textContent: name }),
          ...(s.standard ? [el("span", { className: "hidden-tag", textContent: `IOF ${s.standard}` })] : []),
        ),
      );
    }
  } else {
    langSel.hidden = true;
    $("info").textContent = `${m.title}: ${m.symbols.length} символів, базовий масштаб 1:${m.scale.toLocaleString("uk")}. Ліцензія: ${m.license}.`;
    for (const s of m.symbols) {
      if (s.hidden && !showHidden.checked) continue;
      if (q && !`${s.code} ${s.name}`.toLowerCase().includes(q)) continue;
      cards.push(
        el(
          "div",
          { className: "card", onclick: () => openXmap(slug, m, s), title: s.name },
          el("img", { src: assetUrl(`${slug}/${s.files.svg}`), alt: s.name, loading: "lazy" }),
          el("span", { className: "code", textContent: s.code }),
          el("span", { className: "name", textContent: s.name }),
          ...(s.hidden ? [el("span", { className: "hidden-tag", textContent: "службовий" })] : []),
        ),
      );
    }
  }
  grid.replaceChildren(...cards);
}

search.addEventListener("input", render);
langSel.addEventListener("change", render);
showHidden.addEventListener("change", render);
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close();
});
render();
