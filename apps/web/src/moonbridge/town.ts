import type { ContentBundle, Place, TimeOfDay } from "@moonbridge/content";
import { el } from "../ui/dom.js";
import type { EpisodeView, HotelView } from "./progress.js";

// The town map: one building per unit of the course, along a path in course order. A building's
// quests are the unit's episodes; its windows are the unit's tasks, lit as the student answers
// them right. Nothing here is content: buildings, names and quests all come from the course.

export type BuildingState = "locked" | "open" | "current" | "done";

export interface TaskMark {
  task_id: string;
  /** right: the latest answer was right; wrong: it was not; new: never answered. */
  mark: "right" | "wrong" | "new";
}

export interface Building {
  unit: string;
  /** 1-based position in the course. */
  number: number;
  title: string;
  /** The place the unit opens (the first unit: the place open from the start). */
  place?: Place;
  state: BuildingState;
  quests: EpisodeView[];
  tasks: TaskMark[];
}

export function buildings(view: HotelView, bundle: ContentBundle, results: Map<string, boolean>): Building[] {
  const places = bundle.moonbridge?.places ?? [];
  const firstPlace = places.find((p) => p.unlocked_by === null);
  const placeViews = new Map(view.places.map((p) => [p.place.place_id, p]));
  const episodesOf = (unit: string) => view.places.flatMap((p) => p.episodes).filter((e) => e.episode.module_id === unit);
  return view.course.units.map((unit, i) => {
    const module = bundle.modules.find((m) => m.module_id === unit);
    const place = places.find((p) => p.unlocked_by === unit) ?? (i === 0 ? firstPlace : undefined);
    const quests = episodesOf(unit);
    const main = quests.filter((q) => !q.episode.side);
    const reached = quests.some((q) => q.available) || (!!place && !!placeViews.get(place.place_id)?.open && quests.length > 0);
    const done = main.length > 0 && main.every((q) => q.done);
    const state: BuildingState = !reached ? "locked" : done ? "done" : unit === view.currentUnit ? "current" : "open";
    const tasks = (module?.tasks ?? []).map((task_id): TaskMark => ({ task_id, mark: results.has(task_id) ? (results.get(task_id) ? "right" : "wrong") : "new" }));
    return { unit, number: i + 1, title: module?.title.ru ?? unit, ...(place ? { place } : {}), state, quests, tasks };
  });
}

export interface TownDeps {
  time: TimeOfDay;
  mediaBase: string;
  byTeacher: boolean;
  /** Units whose place the student sees open for the first time. */
  fresh: Set<string>;
  /** The quest list of the chosen building. */
  panel: (b: Building) => HTMLElement;
}

const ROW = 168;

/** The map: buildings zigzag down a path; the chosen one's quests open under the map. */
export function townMap(list: Building[], d: TownDeps): HTMLElement {
  const panelSlot = el("div", { class: "building-panel-slot" });
  const height = list.length * ROW + 40;
  const xOf = (i: number) => (i % 2 === 0 ? 28 : 72);
  const yOf = (i: number) => i * ROW + ROW / 2 + 10;
  const reachedUpTo = list.reduce((n, b, i) => (b.state !== "locked" ? i : n), 0);
  const points = list.map((_, i) => `${xOf(i)},${yOf(i)}`);
  const path = (from: number, to: number) => (to > from ? `M ${points.slice(from, to + 1).join(" L ")}` : "");
  const svg = `<svg class="town-path" viewBox="0 0 100 ${height}" preserveAspectRatio="none" aria-hidden="true">
    <path class="road" d="${path(0, list.length - 1)}" vector-effect="non-scaling-stroke"/>
    <path class="road-walked" d="${path(0, reachedUpTo)}" vector-effect="non-scaling-stroke"/>
  </svg>`;
  const town = el("div", { class: "town", style: `height:${height}px` });
  town.innerHTML = svg;

  let chosen: HTMLElement | undefined;
  const choose = (b: Building, node: HTMLElement, scroll: boolean) => {
    chosen?.classList.remove("chosen");
    chosen = node;
    node.classList.add("chosen");
    node.setAttribute("aria-expanded", "true");
    panelSlot.replaceChildren(d.panel(b));
    if (scroll) panelSlot.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const nodes = list.map((b, i) => {
    const lit = b.tasks.length ? b.tasks.filter((t) => t.mark === "right").length / b.tasks.length : 0;
    const node = el(
      "button",
      {
        type: "button",
        class: `building ${b.state === "locked" ? "locked" : "open"} state-${b.state}${d.fresh.has(b.unit) ? " just-opened" : ""}`,
        "data-unit": b.unit,
        ...(b.place ? { "data-place": b.place.place_id } : {}),
        style: `left:${xOf(i)}%;top:${yOf(i)}px`,
        "aria-label": `${b.number}. ${b.place?.name.ru ?? b.title}: ${stateLabel(b, d.byTeacher)}`,
      },
      buildingArt(b, lit, d),
      el("span", { class: "building-name" }, el("b", {}, `${b.number} · ${b.place?.name.ru ?? b.title}`), el("span", { class: "building-sub" }, b.title)),
      ...(b.state === "current" ? [el("span", { class: "you-are-here" }, "Вы здесь")] : []),
      ...(b.state === "done" ? [el("span", { class: "building-flag", "aria-hidden": "true" }, "★")] : []),
    );
    node.addEventListener("click", () => choose(b, node, true));
    town.append(node);
    return node;
  });

  // Open with the building the student is working on, else the last one reached.
  const start = list.findIndex((b) => b.state === "current");
  const first = start >= 0 ? start : reachedUpTo;
  if (list[first]) choose(list[first]!, nodes[first]!, false);
  return el("div", { class: "hotel-map town-map", "data-time": d.time }, town, panelSlot);
}

function stateLabel(b: Building, byTeacher: boolean): string {
  if (b.state === "locked") return byTeacher ? "откроет преподаватель" : "откроется по ходу курса";
  if (b.state === "done") return "пройдено";
  if (b.state === "current") return "вы здесь";
  return "открыто";
}

/** The building: the place's own picture when the content has one, a drawn house otherwise, its windows lit by tasks. */
function buildingArt(b: Building, lit: number, d: TownDeps): HTMLElement {
  const art = el("span", { class: "building-art", "aria-hidden": "true" });
  const windows = 6;
  const on = Math.round(lit * windows);
  const win = Array.from({ length: windows }, (_, k) => {
    const x = 22 + (k % 3) * 20;
    const y = 46 + Math.floor(k / 3) * 18;
    return `<rect class="win${k < on ? " lit" : ""}" x="${x}" y="${y}" width="12" height="11" rx="2"/>`;
  }).join("");
  art.innerHTML = `<svg viewBox="0 0 100 100"><path class="roof" d="M8 42 L50 10 L92 42 Z"/><rect class="wall" x="14" y="40" width="72" height="52" rx="3"/>${win}<path class="door" d="M44 92 V78 a6 6 0 0 1 12 0 V92 Z"/>${
    b.state === "locked" ? '<g class="lock"><rect x="40" y="60" width="20" height="16" rx="3"/><path d="M44 60 v-5 a6 6 0 0 1 12 0 v5" fill="none"/></g>' : ""
  }</svg>`;
  const picture = b.place?.building;
  if (picture) {
    const img = el("img", { src: `${d.mediaBase}/${picture}`, alt: "" }) as HTMLImageElement;
    img.addEventListener("load", () => art.classList.add("has-art"));
    img.addEventListener("error", () => img.remove());
    art.prepend(img);
  }
  return art;
}

/** The task windows of a building: one mark per task of the unit. */
export function taskWindows(tasks: TaskMark[]): HTMLElement {
  const right = tasks.filter((t) => t.mark === "right").length;
  return el(
    "div",
    { class: "task-windows", "data-tasks-right": String(right) },
    el("p", { class: "muted" }, `Задания: ${right} из ${tasks.length}`),
    el(
      "div",
      { class: "windows", role: "img", "aria-label": `Верно: ${right}, с ошибкой: ${tasks.filter((t) => t.mark === "wrong").length}, ещё не было: ${tasks.filter((t) => t.mark === "new").length}` },
      ...tasks.map((t) => el("span", { class: `window ${t.mark}`, "data-task": t.task_id })),
    ),
  );
}
