import type { Learner } from "../core/learner.js";
import type { Dashboard } from "../net/api.js";
import { nextLesson, openHomework, when } from "../platform/school.js";
import type { KeyValue } from "../storage/idb.js";
import { el } from "../ui/dom.js";
import { streakOf, todaysShift, type ShiftPlan } from "./daily.js";
import { playEpisode, playWelcome } from "./player.js";
import { completeEpisode, hotelView, markPractice, markShift, markWelcomed, migrateState, openedUnits, studentCourse, type HotelView, type MoonbridgeState } from "./progress.js";
import { playShift, shiftFinale } from "./shift.js";
import { playReview, renderWords, reviewFinale } from "./words-view.js";
import { myWords, reviewQueue, WordDeck, type MyWord } from "./words.js";

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
  /** The student's name, for {name} in the welcome scene. */
  playerName?: string;
}

const KEY = "moonbridge";

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
  const deck = await WordDeck.load(d.kv);
  const words = myWords(d.learner.bundle, course, state, deck, d.learner.now());
  const wordsDeps = { navigate: d.navigate, now: () => d.learner.now() };

  // The first visit opens on the welcome scene instead of the map; /moonbridge/welcome replays it.
  if (content.welcome && (path === "/moonbridge/welcome" || (path === "/moonbridge" && !state.welcomed))) {
    await playWelcome(root, content.welcome, { content, learner: d.learner, mediaBase: d.mediaBase, name: d.playerName ?? "" });
    await d.kv.set(KEY, markWelcomed(migrateState(await d.kv.get(KEY))));
    root.replaceChildren(
      el(
        "div",
        { class: "card episode-end", "data-welcome-end": "" },
        el("h1", {}, "Добро пожаловать в Hotel Hello"),
        ...(view.next
          ? [
              el("p", {}, `Первый эпизод: ${view.next.title.ru}. Около пяти минут.`),
              el("button", { class: "primary", "data-start": view.next.episode_id, onclick: () => d.navigate(`/moonbridge/episode/${view.next!.episode_id}`) }, "Начать эпизод"),
            ]
          : []),
        el("button", { class: view.next ? "" : "primary", onclick: () => d.navigate("/moonbridge") }, "Осмотреть отель"),
      ),
    );
    return;
  }

  if (path === "/moonbridge/words") return renderWords(root, words, wordsDeps);
  if (path === "/moonbridge/words/review") {
    const queue = reviewQueue(words);
    if (!queue.length) return d.navigate("/moonbridge/words");
    const result = await playReview(root, queue, deck, wordsDeps);
    await d.kv.set(KEY, markPractice(migrateState(await d.kv.get(KEY)), d.learner.day()));
    root.replaceChildren(reviewFinale(result, wordsDeps));
    return;
  }

  if (path === "/moonbridge/shift") {
    if (!plan || !hasWork(plan) || state.shift_days.includes(today)) return d.navigate("/moonbridge");
    const result = await playShift(root, plan, { content, learner: d.learner, mediaBase: d.mediaBase });
    const next = markShift(migrateState(await d.kv.get(KEY)), plan.day);
    await d.kv.set(KEY, next);
    root.replaceChildren(shiftFinale(plan, result, streakOf(next.practice_days, plan.day).days, () => d.navigate("/moonbridge")));
    return;
  }

  if (episodeId) {
    // An episode the course has reached, or one of a unit the teacher gave as homework, even
    // if the student has not got that far in the hotel yet.
    const homework = d.board?.homework.filter((h) => h.module_id && content.episodes.some((e) => e.episode_id === episodeId && e.module_id === h.module_id)) ?? [];
    const reached = view.places.filter((p) => p.open).flatMap((p) => p.episodes).find((e) => e.episode.episode_id === episodeId && e.available)?.episode;
    const playable = reached ?? (homework.length ? content.episodes.find((e) => e.episode_id === episodeId) : undefined);
    if (!playable) return d.navigate("/moonbridge");
    const result = await playEpisode(root, playable, { content, learner: d.learner, mediaBase: d.mediaBase });
    // The result goes to the school before the student opens the homework again.
    if (homework.length) await d.learner.sync();
    const next: MoonbridgeState = markPractice(completeEpisode(state, result.episodeId), d.learner.day());
    await d.kv.set(KEY, next);
    const before = new Set(view.places.filter((p) => p.open).map((p) => p.place.place_id));
    const newPlaces = hotelView(content, course, next, opened).places.filter((p) => p.open && !before.has(p.place.place_id));
    const assigned = homework.find((h) => !h.submission?.review) ?? homework[0];
    root.replaceChildren(
      el(
        "div",
        { class: "card episode-end", "data-episode-end": result.episodeId },
        el("h1", {}, playable.title.ru),
        el("p", {}, `Эпизод пройден. С первого раза: ${result.firstTry.right} из ${result.firstTry.total}.`),
        ...newPlaces.map((p) => el("p", { class: "unlocked" }, `Открылось новое место: ${p.place.name.ru}`)),
        ...(assigned
          ? [el("button", { class: "primary", "data-to-homework": assigned.homework_id, onclick: () => d.navigate(`/homework/${assigned.homework_id}`) }, "К домашке")]
          : []),
        el("button", { class: assigned ? "" : "primary", onclick: () => d.navigate("/moonbridge") }, "В отель"),
      ),
    );
    return;
  }
  renderMap(root, view, plan, state, today, words, d);
}

/** «Мои слова» on the map: how many words, and how many wait for review. */
function wordsCard(words: MyWord[], d: SectionDeps): HTMLElement {
  const queue = reviewQueue(words).length;
  return el(
    "a",
    { class: "card words-card", href: "/moonbridge/words", "data-link": "", "data-words-card": String(queue) },
    el("h2", {}, "Мои слова"),
    el("p", {}, words.length ? (queue ? `Слов в блокноте: ${words.length}. Ждут повтора: ${queue}.` : `Слов в блокноте: ${words.length}. На сегодня всё повторено.`) : "Слова из эпизодов появятся здесь после первого эпизода."),
    el("span", { class: "card-action" }, queue ? "Повторить →" : "Открыть →"),
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

function renderMap(root: HTMLElement, view: HotelView, plan: ShiftPlan | undefined, state: MoonbridgeState, today: number, words: MyWord[], d: SectionDeps): void {
  const map = el("div", { class: "hotel-map" });
  for (const p of view.places) {
    const done = p.episodes.filter((e) => e.done).length;
    const room = el(
      "div",
      { class: `room ${p.open ? "open" : "locked"}`, "data-place": p.place.place_id },
      el("h2", {}, p.place.name.ru),
      el("p", { class: "muted" }, p.open ? `Эпизоды: ${done} из ${p.episodes.length}` : view.byTeacher ? "Закрыто: откроет преподаватель" : "Закрыто: откроется по ходу курса"),
    );
    if (p.open) {
      const list = el("ul", { class: "episodes" });
      for (const e of p.episodes.filter((x) => x.available)) {
        list.append(
          el(
            "li",
            {},
            el(
              "button",
              { class: e.done ? "episode done" : "episode", "data-episode": e.episode.episode_id, onclick: () => d.navigate(`/moonbridge/episode/${e.episode.episode_id}`) },
              `${e.done ? "✓ " : ""}${e.episode.title.ru}`,
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
  root.replaceChildren(
    el(
      "div",
      { class: "hotel" },
      el("header", { class: "section-head" }, el("a", { href: "/", "data-link": "", class: "back" }, "← Платформа"), el("h1", {}, "Hotel Hello")),
      ...[lobbyBoard(d.board, d), shiftCard(plan, state, today, d)].filter((x): x is HTMLElement => x !== undefined),
      play,
      wordsCard(words, d),
      map,
      ...(d.learner.bundle.moonbridge?.welcome ? [el("a", { href: "/moonbridge/welcome", "data-link": "", class: "link replay-welcome" }, "Как устроен отель")] : []),
      ...(d.feedback ? [d.feedback()] : []),
    ),
  );
}
