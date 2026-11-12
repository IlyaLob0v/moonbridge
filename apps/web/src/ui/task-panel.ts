import type { Task } from "@moonbridge/content";
import { displayResponse, type CheckOutcome, type Response } from "@moonbridge/learning";
import { el } from "./dom.js";

export interface Answer {
  response: Response;
  hintUsed: boolean;
  durationMs: number;
}

const TYPE_LABEL: Record<Task["type"], string> = {
  choice: "Выберите вариант",
  gap_fill: "Заполните пропуск",
  transform: "Перестройте предложение",
  order_words: "Соберите предложение",
  listen_type: "Послушайте и напечатайте",
  translate_ru_en: "Переведите на английский",
  translate_en_ru: "Выберите перевод",
  find_error: "Найдите ошибку",
};

export interface AskOptions {
  /** Base URL of content media (recordings). */
  mediaBase?: string;
  now?: () => number;
}

/**
 * Renders a task by its type and resolves with the student's answer. Everything the
 * student reads comes from the task itself: this file holds no task text.
 */
export function askTask(root: HTMLElement, task: Task, o: AskOptions = {}): Promise<Answer> {
  const now = o.now ?? performance.now.bind(performance);
  return new Promise((resolve) => {
    const started = now();
    let hintUsed = false;
    const p = task.presentation;

    const panel = el("div", { class: "task", "data-task": task.task_id, "data-type": task.type });
    panel.append(el("div", { class: "task-type" }, p.instruction_ru ?? TYPE_LABEL[task.type]));
    if (p.source) panel.append(el("blockquote", { class: "task-source", lang: task.type === "translate_ru_en" ? "ru" : "en" }, p.source));
    if (!(task.type === "translate_en_ru" && p.source === p.prompt)) panel.append(el("div", { class: "task-prompt", lang: "en" }, p.prompt));

    const timer = el("div", { class: "task-timer" });
    const limit = task.time_limit_s;
    let tick: ReturnType<typeof setInterval> | undefined;
    if (limit) {
      const bar = el("span");
      timer.append(bar);
      tick = setInterval(() => {
        const left = Math.max(0, 1 - (now() - started) / (limit * 1000));
        bar.style.width = `${left * 100}%`;
        timer.classList.toggle("late", left < 0.25);
      }, 200);
    }

    const finish = (response: Response) => {
      if (tick) clearInterval(tick);
      root.replaceChildren();
      resolve({ response, hintUsed, durationMs: Math.round(now() - started) });
    };

    const body = el("div", { class: "task-body" });
    let focus: HTMLElement | undefined;
    if (task.type === "choice" || task.type === "translate_en_ru") {
      const lang = task.type === "translate_en_ru" ? "ru" : "en";
      for (const option of p.options ?? []) {
        body.append(el("button", { class: "option", lang, onclick: () => finish(option.id) }, option.text));
      }
    } else if (task.type === "find_error") {
      const line = el("div", { class: "find-line", lang: "en" });
      (p.tokens ?? []).forEach((token, i) => {
        line.append(/^[.,!?;]$/.test(token) ? el("span", { class: "punct" }, token) : el("button", { class: "token", onclick: () => finish(String(i)) }, token));
      });
      body.append(line);
    } else if (task.type === "order_words") {
      const built: string[] = [];
      const line = el("div", { class: "order-line", lang: "en" });
      const bank = el("div", { class: "order-bank", lang: "en" });
      const submit = el("button", { class: "primary", onclick: () => finish([...built]) }, "Ответить") as HTMLButtonElement;
      const render = () => {
        line.replaceChildren(...built.map((w, i) => el("button", { class: "token placed", onclick: () => (built.splice(i, 1), render()) }, w)));
        const left = [...(p.tokens ?? [])];
        for (const w of built) left.splice(left.indexOf(w), 1);
        bank.replaceChildren(...left.map((w) => el("button", { class: "token", onclick: () => (built.push(w), render()) }, w)));
        submit.disabled = left.length > 0;
      };
      body.append(line, bank, submit);
      render();
    } else {
      if (task.type === "listen_type" && p.audio) {
        const audio = el("audio", { src: `${o.mediaBase ?? ""}/${p.audio}`, preload: "auto" }) as HTMLAudioElement;
        // Until the recording is in content/media, the phone reads the first accepted answer aloud.
        let missing = false;
        audio.addEventListener("error", () => (missing = true));
        const speak = () => {
          if (!("speechSynthesis" in window)) return;
          const u = new SpeechSynthesisUtterance(task.answer.accepted[0] ?? "");
          u.lang = "en-GB";
          u.rate = 0.9;
          speechSynthesis.cancel();
          speechSynthesis.speak(u);
        };
        const play = el(
          "button",
          { class: "play", type: "button", onclick: () => (missing ? speak() : ((audio.currentTime = 0), void audio.play().catch(speak))) },
          "▶ Слушать",
        );
        body.append(audio, play);
      }
      const input = el("input", {
        type: "text",
        class: "answer",
        lang: "en",
        autocomplete: "off",
        autocapitalize: "off",
        spellcheck: "false",
        "aria-label": "Ответ",
      }) as HTMLInputElement;
      const submit = el("button", { class: "primary", type: "submit" }, "Ответить");
      const form = el("form", { class: "answer-form", onsubmit: (e: Event) => (e.preventDefault(), input.value.trim() && finish(input.value)) }, input, submit);
      body.append(form);
      focus = input;
    }
    panel.append(body);

    if (p.hint) {
      const hint = el("div", { class: "task-hint", hidden: "" }, p.hint);
      const btn = el("button", { class: "link", onclick: () => ((hintUsed = true), hint.removeAttribute("hidden"), btn.remove()) }, "Подсказка");
      panel.append(btn, hint);
    }
    panel.append(timer);
    root.replaceChildren(panel);
    focus?.focus();
  });
}

/**
 * What happened, with the author's feedback; resolves when the student continues. With `voice`,
 * the character who asked says it: their words lead, the verdict becomes a small tag.
 */
export function showFeedback(root: HTMLElement, outcome: CheckOutcome, errorLabel?: string, task?: Task, voice?: { en: string; ru?: string }): Promise<void> {
  return new Promise((resolve) => {
    const kind = outcome.match === "typo" ? "typo" : outcome.correct ? "right" : "wrong";
    const verdict = kind === "right" ? "Верно!" : kind === "typo" ? "Почти: опечатка" : "Не совсем";
    const box = el("div", { class: `feedback ${kind}${voice ? " voiced" : ""}`, "data-outcome": kind });
    if (voice) {
      box.append(
        el("div", { class: "feedback-verdict" }, verdict),
        el("div", { class: "feedback-title feedback-voice", lang: "en" }, voice.en),
        ...(voice.ru ? [el("div", { class: "feedback-voice-ru muted", lang: "ru" }, voice.ru)] : []),
      );
    } else box.append(el("div", { class: "feedback-title" }, verdict));
    if (kind !== "right") {
      box.append(
        el("div", {}, "Ваш ответ: ", el("span", { class: kind === "typo" ? "typo" : "wrong", lang: "en" }, (task ? displayResponse(task, outcome.response) : outcome.response) || "—")),
        el("div", {}, "Верно: ", el("span", { class: "right", lang: "en" }, outcome.correctForm)),
      );
      if (outcome.feedback) box.append(el("div", { class: "feedback-note" }, outcome.feedback));
      else if (errorLabel && outcome.match !== "unclassified") box.append(el("div", { class: "feedback-note" }, errorLabel));
    }
    const next = el("button", { class: "primary", onclick: () => (root.replaceChildren(), resolve()) }, "Дальше");
    box.append(next);
    root.replaceChildren(box);
    next.focus();
  });
}
