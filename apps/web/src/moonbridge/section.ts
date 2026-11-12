import type { Learner } from "../core/learner.js";
import type { Dashboard } from "../net/api.js";
import { nextLesson, openHomework, when } from "../platform/school.js";
import type { KeyValue } from "../storage/idb.js";
import { el } from "../ui/dom.js";
import { streakOf, todaysShift, type ShiftPlan } from "./daily.js";
import type { Place, TimeOfDay } from "@moonbridge/content";
import { background, playEpisode, residentSpeaker } from "./player.js";
import { completeEpisode, hotelTime, hotelView, markPractice, markShift, migrateState, openedUnits, studentCourse, type HotelView, type MoonbridgeState } from "./progress.js";
import { playShift, shiftFinale } from "./shift.js";
import { Sound } from "./sound.js";

// The Moonbridge section. It is loaded only when the student opens /moonbridge, so the
// platform works, and stays light, without it. It keeps nothing but its own game state;
// answers go to the shared learner.

export interface SectionDeps {
  learner: Learner;
  kv: KeyValue;
  mediaBase: string;
  navigate: (path: string) => void;
  /** The student's school, for the board in the lobby. */
  board?: Dashboard;
  /** "Сообщить о проблеме" under the hotel map, for signed-in testers. */
  feedback?: () => HTMLElement;
  /** The student's name, for the lines that say {player}. */
  playerName?: string;
}

const KEY = "moonbridge";

/** One for the whole visit: the student's sound choice and the ambience carry from scene to scene. */
const sound = new Sound();

/** The platform calls this when the student leaves the hotel: the rain stays behind. */
export function stopSound(): void {
  sound.stopAmbience();
}

/** The first name is enough for Rocco. */
const firstName = (name: string | undefined) => name?.trim().split(/\s+/)[0];

export async function mountMoonbridge(root: HTMLElement, path: string, d: SectionDeps): Promise<void> {
  const content = d.learner.bundle.moonbridge;
  const course = studentCourse(d.learner.bundle);
  if (!content || !course) {
    root.replaceChildren(el("div", { class: "card" }, el("h1", {}, "Moonbridge"), el("p", {}, "Раздел пока закрыт: в курсе нет эпизодов.")));
    return;
  }
  const state = migrateState(await d.kv.get(KEY));
  const episodeId = /^\/moonbridge\/episode\/([A-Za-z0-9_]+)$/.exec(path)?.[1];
  const opened = openedUnits(d.board);
  const view = hotelView(content, course, state, opened);
  const today = d.learner.day();
  const plan = await todaysShift(d.learner, state, opened);
  const time = hotelTime(state, d.learner.now());
  document.body.dataset.time = time;
  const name = firstName(d.playerName);
  const playerDeps = { content, learner: d.learner, mediaBase: d.mediaBase, sound, ...(name ? { playerName: name } : {}) };

  if (path === "/moonbridge/shift") {
    if (!plan || !hasWork(plan) || state.shift_days.includes(today)) return d.navigate("/moonbridge");
    const result = await playShift(root, plan, { ...playerDeps, time });
    const next = markShift(migrateState(await d.kv.get(KEY)), plan.day);
    await d.kv.set(KEY, next);
    overStage(root, shiftFinale(plan, result, streakOf(next.practice_days, plan.day).days, () => d.navigate("/moonbridge")));
    return;
  }

  if (episodeId) {
    // An episode the course has reached, or one of a unit the teacher gave as homework, even
    // if the student has not got that far in the hotel yet.
    const homework = d.board?.homework.filter((h) => h.module_id && content.episodes.some((e) => e.episode_id === episodeId && e.module_id === h.module_id)) ?? [];
    const reached = view.places.filter((p) => p.open).flatMap((p) => p.episodes).find((e) => e.episode.episode_id === episodeId && e.available)?.episode;
    const playable = reached ?? (homework.length ? content.episodes.find((e) => e.episode_id === episodeId) : undefined);
    if (!playable) return d.navigate("/moonbridge");
    const unitNo = course.units.indexOf(playable.module_id) + 1;
    const result = await playEpisode(root, playable, playerDeps, unitNo > 0 ? { number: unitNo } : {});
    // The result goes to the school before the student opens the homework again.
    if (homework.length) await d.learner.sync();
    const next: MoonbridgeState = markPractice(completeEpisode(state, result.episodeId), d.learner.day());
    await d.kv.set(KEY, next);
    const before = new Set(view.places.filter((p) => p.open).map((p) => p.place.place_id));
    const newPlaces = hotelView(content, course, next, opened).places.filter((p) => p.open && !before.has(p.place.place_id));
    const assigned = homework.find((h) => !h.submission?.review) ?? homework[0];
    const { right, total } = result.firstTry;
    const stars = !total || right === total ? 3 : right * 2 >= total ? 2 : 1;
    const end = el(
      "div",
      { class: "card episode-end", "data-episode-end": result.episodeId },
      el("p", { class: "end-kicker" }, "Эпизод пройден"),
      el("h1", {}, playable.title.ru),
      el("div", { class: "stars", role: "img", "aria-label": `${stars} из 3` }, ...[1, 2, 3].map((i) => el("span", { class: i <= stars ? "star on" : "star" }, "★"))),
      el("p", {}, `С первого раза: ${right} из ${total}.`),
      ...newPlaces.map((p) => unlockedPlace(p.place, time, d.mediaBase)),
      ...(assigned
        ? [el("button", { class: "primary", "data-to-homework": assigned.homework_id, onclick: () => d.navigate(`/homework/${assigned.homework_id}`) }, "К домашке")]
        : []),
      el("button", { class: assigned ? "" : "primary", onclick: () => d.navigate("/moonbridge") }, "В отель"),
    );
    overStage(root, end);
    sound.play(newPlaces.length ? "unlock" : "right");
    return;
  }
  // Places the student has not seen open yet get their moment on the map. The first visit after
  // this feature arrived counts every open place as seen, so nobody gets a flood of old news.
  const openNow = view.places.filter((p) => p.open).map((p) => p.place.place_id);
  const seen = state.seen_places ?? openNow;
  const fresh = new Set(openNow.filter((id) => !seen.includes(id)));
  if (!state.seen_places || fresh.size) await d.kv.set(KEY, { ...state, seen_places: [...new Set([...seen, ...openNow])] });
  if (fresh.size) sound.play("unlock");
  renderMap(root, view, plan, state, today, time, fresh, d);
}

/**
 * The end of an episode or a shift as a card over the last scene: the place stays behind,
 * the dialog steps aside. Without a scene (nothing was played), the card alone.
 */
function overStage(root: HTMLElement, card: HTMLElement): void {
  const scene = root.querySelector<HTMLElement>(".scene");
  if (!scene) return root.replaceChildren(card);
  scene.classList.add("ended");
  scene.querySelector(".dialog-wrap")?.remove();
  scene.querySelector(".portrait")?.replaceChildren();
  scene.append(el("div", { class: "end-overlay" }, card));
}

/** The news of a new place: its picture in a frame, with a burst of light. */
function unlockedPlace(place: Place, time: TimeOfDay, mediaBase: string): HTMLElement {
  return el(
    "div",
    { class: "unlocked", "data-unlocked": place.place_id },
    el("div", { class: "unlocked-art" }, background(place, mediaBase, time)),
    el("p", { class: "unlocked-kicker" }, "Открылось новое место"),
    el("p", { class: "unlocked-name" }, place.name.ru),
  );
}

function hasWork(plan: ShiftPlan): boolean {
  return plan.lostAndFound.length > 0 || plan.guest !== undefined;
}

/**
 * The board in the lobby: the same next lesson and homework as on the platform's Today,
 * so a student who opens the hotel first still sees what is due. Homework opens on the platform.
 */
function lobbyBoard(board: Dashboard | undefined, d: SectionDeps): HTMLElement | undefined {
  if (!board?.groups.length) return undefined;
  const now = new Date(d.learner.now());
  const lesson = nextLesson(board.groups, now);
  const open = openHomework(board);
  return el(
    "div",
    { class: "card lobby-board", "data-board": "" },
    el("h2", {}, "Доска в лобби"),
    el("p", { "data-board-lesson": "" }, lesson ? (lesson.start <= now ? `Урок идёт сейчас: ${lesson.group.name}` : `Урок ${when(lesson.start, now)}`) : "Уроков в расписании нет"),
    ...(open.length
      ? open.map((h) =>
          el(
            "a",
            { href: `/homework/${h.homework_id}`, "data-link": "", class: "board-note", "data-board-homework": h.homework_id },
            `${h.title}${h.due_at ? `, до ${when(new Date(h.due_at), now)}` : ""}`,
          ),
        )
      : [el("p", { class: "muted" }, "Вся домашка сдана.")]),
  );
}

/** The daily shift card on top of the map: what is waiting today, or who comes tomorrow. */
function shiftCard(plan: ShiftPlan | undefined, state: MoonbridgeState, today: number, d: SectionDeps): HTMLElement | undefined {
  if (!plan) return undefined;
  const streak = streakOf(state.practice_days, today);
  const streakLine = el("p", { class: "muted streak", "data-streak": String(streak.days) }, streak.days ? `Дней практики подряд: ${streak.days}` : "Серия начнётся с сегодняшней смены");
  if (state.shift_days.includes(today)) {
    return el(
      "div",
      { class: "card shift-card done", "data-shift-card": "done" },
      el("h2", {}, "Смена на сегодня закрыта"),
      ...(plan.teaser ? [el("p", {}, `Завтра: ${plan.teaser.teaser.ru ?? plan.teaser.teaser.en}`)] : []),
      streakLine,
    );
  }
  if (!hasWork(plan)) {
    return el("div", { class: "card shift-card", "data-shift-card": "empty" }, el("h2", {}, "Смена в отеле"), el("p", {}, "Сегодня бюро находок пусто, а гости придут, когда вы пройдёте первый юнит."), streakLine);
  }
  const parts = [
    plan.lostAndFound.length ? `в бюро находок ${plan.lostAndFound.length} шт.` : "",
    plan.guest ? `гость дня: ${plan.guest.template.name}` : "",
  ].filter(Boolean);
  return el(
    "div",
    { class: "card shift-card", "data-shift-card": "ready" },
    el("h2", {}, "Смена в отеле"),
    el("p", {}, `Сегодня ${parts.join(", ")}. Около ${Math.max(1, Math.round(plan.estimatedMs / 60_000))} мин.`),
    streakLine,
    el("button", { class: "primary start-shift", onclick: () => d.navigate("/moonbridge/shift") }, plan.returning ? "Вернуться к работе" : "Начать смену"),
  );
}

function renderMap(
  root: HTMLElement,
  view: HotelView,
  plan: ShiftPlan | undefined,
  state: MoonbridgeState,
  today: number,
  time: TimeOfDay,
  fresh: Set<string>,
  d: SectionDeps,
): void {
  const content = d.learner.bundle.moonbridge!;
  const map = el("div", { class: "hotel-map" });
  const other = time === "day" ? "ночью" : "днём";
  for (const p of view.places) {
    const done = p.episodes.filter((e) => e.done && !e.episode.side).length;
    const main = p.episodes.filter((e) => !e.episode.side).length;
    const residents = p.place.characters
      .map((id) => content.characters.find((c) => c.character_id === id))
      .filter((c) => c !== undefined)
      .map((c) => residentSpeaker(c, time))
      .map((s) => `${s.name}, ${s.speciesRu}`);
    const room = el(
      "div",
      { class: `room ${p.open ? "open" : "locked"}${fresh.has(p.place.place_id) ? " just-opened" : ""}`, "data-place": p.place.place_id },
      ...(p.open ? [el("div", { class: "room-art", "aria-hidden": "true" }, background(p.place, d.mediaBase, time))] : []),
      el("h2", {}, p.place.name.ru),
      ...(p.open && residents.length ? [el("p", { class: "room-residents" }, residents.join(" · "))] : []),
      el("p", { class: "muted" }, p.open ? `Эпизоды: ${done} из ${main}` : view.byTeacher ? "Закрыто: откроет преподаватель" : "Закрыто: откроется по ходу курса"),
    );
    if (p.open) {
      const list = el("ul", { class: "episodes" });
      for (const e of p.episodes.filter((x) => x.available)) {
        const when = e.episode.time_of_day ?? "night";
        const elsewhen = when !== time;
        const note = [e.episode.side ? "доп. эпизод" : "", elsewhen ? other : ""].filter(Boolean).join(", ");
        list.append(
          el(
            "li",
            {},
            el(
              "button",
              {
                class: `episode${e.done ? " done" : ""}${elsewhen ? " other-time" : ""}${e.episode.side ? " side" : ""}`,
                "data-episode": e.episode.episode_id,
                "data-time": when,
                onclick: () => d.navigate(`/moonbridge/episode/${e.episode.episode_id}`),
              },
              el("span", { class: "episode-time", "aria-hidden": "true" }, when === "day" ? "☀" : "☾"),
              `${e.done ? "✓ " : ""}${e.episode.title.ru}`,
              ...(note ? [el("span", { class: "episode-note" }, note)] : []),
            ),
          ),
        );
      }
      room.append(list);
    }
    map.append(room);
  }
  const play = view.next
    ? el("button", { class: "primary play-next", onclick: () => d.navigate(`/moonbridge/episode/${view.next!.episode_id}`) }, `Играть: ${view.next.title.ru}`)
    : el("p", { class: "muted", "data-no-next": "" }, view.byTeacher ? "Новые эпизоды откроются, когда преподаватель задаст следующий юнит." : "Все эпизоды пройдены. Новые появятся со следующим юнитом.");
  const switchTime = el(
    "button",
    {
      class: "time-toggle",
      type: "button",
      "data-time-toggle": time,
      "aria-label": time === "day" ? "Сейчас день. Дождаться ночи" : "Сейчас ночь. Дождаться утра",
      onclick: async () => {
        sound.unlock();
        sound.play("whoosh");
        await d.kv.set(KEY, { ...migrateState(await d.kv.get(KEY)), time: time === "day" ? "night" : "day" });
        d.navigate("/moonbridge");
      },
    },
    time === "day" ? "☀ День" : "☾ Ночь",
  );
  sound.setAmbience(undefined);
  root.replaceChildren(
    el(
      "div",
      { class: "hotel", "data-time": time },
      el("header", { class: "section-head" }, el("a", { href: "/", "data-link": "", class: "back" }, "← Платформа"), el("h1", {}, "Hotel Hello"), switchTime),
      ...[lobbyBoard(d.board, d), shiftCard(plan, state, today, d)].filter((x): x is HTMLElement => x !== undefined),
      play,
      map,
      ...(d.feedback ? [d.feedback()] : []),
    ),
  );
}
