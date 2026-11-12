import { el } from "../ui/dom.js";
import { reviewQueue, type MyWord, type Recall, type WordDeck } from "./words.js";

// The screens of «Мои слова»: the list of the student's words and the review, one card at a time.

export interface WordsViewDeps {
  navigate: (path: string) => void;
  now: () => Date;
}

const STATUS_RU = { new: "новое", learning: "учу", learned: "выучено" } as const;

/** The dictionary: every word met so far, by unit, with how it stands and the review button. */
export function renderWords(root: HTMLElement, words: MyWord[], d: WordsViewDeps): void {
  const queue = reviewQueue(words);
  const learned = words.filter((w) => w.status === "learned").length;
  const units = [...new Map(words.map((w) => [w.unit.module_id, w.unit])).values()];
  root.replaceChildren(
    el(
      "div",
      { class: "words", "data-words": String(words.length) },
      el("header", { class: "section-head" }, el("a", { href: "/moonbridge", "data-link": "", class: "back" }, "← Отель"), el("h1", {}, "Мои слова")),
      words.length
        ? el(
            "div",
            { class: "card words-summary" },
            el("p", {}, `Слов: ${words.length}, выучено: ${learned}.`),
            queue.length
              ? el("button", { class: "primary", "data-review": String(queue.length), onclick: () => d.navigate("/moonbridge/words/review") }, `Повторить: ${queue.length}`)
              : el("p", { class: "muted", "data-review": "0" }, "На сегодня всё повторено. Слова вернутся, когда начнут забываться."),
          )
        : el("div", { class: "card", "data-words-empty": "" }, el("p", {}, "Здесь будут слова из эпизодов. Пройдите первый эпизод в отеле, и его слова появятся в блокноте.")),
      ...units.map((u) =>
        el(
          "section",
          { class: "card words-unit", "data-unit": u.module_id },
          el("h2", {}, u.title.ru),
          el(
            "ul",
            { class: "word-list" },
            ...words
              .filter((w) => w.unit.module_id === u.module_id)
              .map((w) =>
                el(
                  "li",
                  { class: `word ${w.status}`, "data-word": w.id, "data-status": w.status },
                  el("span", { class: "word-en", lang: "en" }, w.word.en),
                  el("span", { class: "word-ru" }, w.word.ru),
                  el("span", { class: "word-status" }, STATUS_RU[w.status]),
                ),
              ),
          ),
        ),
      ),
    ),
  );
}

export interface ReviewResult {
  /** Words shown in the review. */
  total: number;
  /** Remembered the first time they came up. */
  remembered: number;
}

/**
 * The review: the translation first, the student recalls the English, opens the answer and says
 * how it went. A forgotten word comes back once more at the end of the same review.
 */
export async function playReview(root: HTMLElement, queue: MyWord[], deck: WordDeck, d: WordsViewDeps): Promise<ReviewResult> {
  const pending = [...queue];
  const again = new Set<string>();
  let remembered = 0;
  let shown = 0;
  while (pending.length) {
    const w = pending.shift()!;
    const second = again.has(w.id);
    if (!second) shown += 1;
    const recall = await card(root, w, { at: shown, of: queue.length });
    await deck.review(w.id, recall, d.now());
    if (!second && recall !== "forgot") remembered += 1;
    if (recall === "forgot" && !second) {
      again.add(w.id);
      pending.push(w);
    }
  }
  return { total: queue.length, remembered };
}

function card(root: HTMLElement, w: MyWord, pos: { at: number; of: number }): Promise<Recall> {
  return new Promise((resolve) => {
    const answer = el(
      "div",
      { class: "word-answer", hidden: "" },
      el("p", { class: "word-en big", lang: "en" }, w.word.en, " ", el("button", { class: "play", type: "button", "aria-label": "Послушать", onclick: () => speak(w.word.en) }, "▶")),
      ...(w.word.example ? [el("p", { class: "word-example", lang: "en" }, w.word.example)] : []),
      el(
        "div",
        { class: "recall" },
        el("button", { class: "recall-forgot", "data-recall": "forgot", onclick: () => resolve("forgot") }, "Не помню"),
        el("button", { class: "recall-hard", "data-recall": "hard", onclick: () => resolve("hard") }, "С трудом"),
        el("button", { class: "primary recall-ok", "data-recall": "remembered", onclick: () => resolve("remembered") }, "Помню"),
      ),
    );
    const show = el(
      "button",
      {
        class: "primary show-answer",
        onclick: () => {
          answer.hidden = false;
          show.remove();
          speak(w.word.en);
        },
      },
      "Показать ответ",
    );
    root.replaceChildren(
      el(
        "div",
        { class: "word-review", "data-review-word": w.id },
        el("header", { class: "section-head" }, el("a", { href: "/moonbridge/words", "data-link": "", class: "back" }, "← Мои слова"), el("p", { class: "muted" }, `${Math.min(pos.at, pos.of)} из ${pos.of}`)),
        el(
          "div",
          { class: "card word-card" },
          el("p", { class: "muted" }, w.unit.title.ru),
          el("p", { class: "word-ru big" }, w.word.ru),
          el("p", { class: "muted" }, "Вспомните, как это по-английски, и откройте ответ."),
          show,
          answer,
        ),
      ),
    );
    show.focus();
  });
}

/** Until recordings exist, the phone reads the word aloud. */
function speak(text: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text.replace(/…/g, ""));
  u.lang = "en-GB";
  u.rate = 0.9;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

export function reviewFinale(result: ReviewResult, d: WordsViewDeps): HTMLElement {
  return el(
    "div",
    { class: "card episode-end", "data-review-end": "" },
    el("h1", {}, "Слова повторены"),
    el("p", {}, `Слов в повторе: ${result.total}. Вспомнили сразу: ${result.remembered}.`),
    el("p", { class: "muted" }, "Забытые слова вернутся скоро, а выученные — через несколько дней."),
    el("button", { class: "primary", onclick: () => d.navigate("/moonbridge") }, "В отель"),
    el("button", { onclick: () => d.navigate("/moonbridge/words") }, "К словам"),
  );
}
