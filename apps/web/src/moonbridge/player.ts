import type { Character, Emotion, Episode, MoonbridgeContent, Place, Task, Welcome } from "@moonbridge/content";
import type { SubmitResult } from "@moonbridge/learning";
import type { Learner } from "../core/learner.js";
import { el } from "../ui/dom.js";
import { askTask, showFeedback } from "../ui/task-panel.js";
import { EpisodeRunner } from "./runner.js";

export interface PlayerDeps {
  content: MoonbridgeContent;
  learner: Learner;
  mediaBase: string;
}

export interface EpisodeResult {
  episodeId: string;
  /** Task answers: how many of the tasks shown were right on the first try. */
  firstTry: { right: number; total: number };
  path: string[];
  durationMs: number;
}

/** Someone who can speak in a scene: a resident, or a guest of the day. */
export interface Speaker {
  id: string;
  name: string;
  speciesRu: string;
  portraits: Partial<Record<Emotion, string>>;
}

export function residentSpeaker(c: Character): Speaker {
  return { id: c.character_id, name: c.name, speciesRu: c.species.ru, portraits: c.portraits };
}

/** A visual-novel stage: backdrop, portrait, speaker tag and the dialog box. Episodes and the daily shift both play on it. */
export class Stage {
  readonly scene: HTMLElement;
  readonly box: HTMLElement;
  private readonly portrait = el("div", { class: "portrait" });
  private readonly speaker = el("div", { class: "speaker" });

  constructor(root: HTMLElement, place: Place, title: string, attrs: Record<string, string>, private readonly d: PlayerDeps) {
    this.box = el("div", { class: "dialog", "aria-live": "polite" });
    this.scene = el(
      "section",
      { class: "scene", "data-place": place.place_id, ...attrs },
      background(place, d.mediaBase),
      el("div", { class: "scene-title" }, title),
      this.portrait,
      el("div", { class: "dialog-wrap" }, this.speaker, this.box),
    );
    root.replaceChildren(this.scene);
  }

  /** Who is on stage; undefined = the narrator. */
  show(who: Speaker | undefined, emotion: Emotion = "neutral"): void {
    this.speaker.textContent = who?.name ?? "";
    this.speaker.hidden = !who;
    this.scene.dataset.speaker = who?.id ?? "narrator";
    this.box.classList.toggle("narration", !who);
    this.portrait.replaceChildren(...(who ? [portraitOf(who, emotion, this.d.mediaBase)] : []));
  }

  /** A line; `showRu` puts the translation under it at once instead of behind «Перевод». */
  line(en: string, ru?: string, showRu = false): Promise<void> {
    return line(this.box, en, ru, showRu);
  }

  /** Asks a task in the dialog box and records the answer; feedback appears for anything but a clean right answer. */
  async task(task: Task, context: Record<string, unknown>): Promise<SubmitResult> {
    const answer = await askTask(this.box, task, { mediaBase: this.d.mediaBase });
    const result = await this.d.learner.answer(task.task_id, answer, context);
    if (!(result.outcome.correct && result.outcome.match === "accepted")) {
      const label = result.outcome.errorType ? this.d.learner.bundle.taxonomy.error_types.find((t) => t.id === result.outcome.errorType)?.label.ru : undefined;
      await showFeedback(this.box, result.outcome, label, task);
    }
    return result;
  }
}

/**
 * Plays one episode as a visual novel: the place behind, the speaker's portrait with an
 * emotion, a line or a task in the dialog box. Right and wrong answers lead wherever the
 * episode's JSON says; this file has no story in it.
 */
export async function playEpisode(root: HTMLElement, episode: Episode, d: PlayerDeps): Promise<EpisodeResult> {
  const place = d.content.places.find((p) => p.place_id === episode.place_id)!;
  const characters = new Map(d.content.characters.map((c) => [c.character_id, residentSpeaker(c)]));
  const runner = new EpisodeRunner(episode);
  const started = d.learner.now().getTime();
  const firstTry = new Map<string, boolean>();
  d.learner.resetAttempts();
  const stage = new Stage(root, place, episode.title.ru, { "data-episode": episode.episode_id }, d);

  while (!runner.finished) {
    const step = runner.current;
    stage.scene.dataset.step = step.id;
    if (step.kind === "line") {
      stage.show(step.speaker === "narrator" ? undefined : characters.get(step.speaker), step.emotion);
      await stage.line(step.text.en, step.text.ru);
      runner.next();
    } else if (step.kind === "task") {
      stage.show(step.speaker ? characters.get(step.speaker) : undefined, step.emotion);
      const result = await stage.task(d.learner.task(step.task_id), { mode: "moonbridge_episode", episode_id: episode.episode_id, step_id: step.id });
      if (!firstTry.has(step.id)) firstTry.set(step.id, result.outcome.correct);
      runner.answer(result.outcome.correct);
    }
  }
  const result = {
    episodeId: episode.episode_id,
    firstTry: { right: [...firstTry.values()].filter(Boolean).length, total: firstTry.size },
    path: runner.path,
    durationMs: Math.max(0, d.learner.now().getTime() - started),
  };
  await d.learner.episodeCompleted({ episodeId: episode.episode_id, moduleId: episode.module_id, firstTryRight: result.firstTry.right, tasks: result.firstTry.total, durationMs: result.durationMs });
  void d.learner.sync();
  return result;
}

/**
 * The welcome scene of the first visit: the same stage as an episode, lines only, the translation
 * always shown and {name} replaced with the student's name. "Пропустить" ends it at once; either
 * way the student has seen the hotel's rules once. Resolves with how it ended.
 */
export async function playWelcome(root: HTMLElement, welcome: Welcome, d: PlayerDeps & { name: string }): Promise<"seen" | "skipped"> {
  const place = d.content.places.find((p) => p.place_id === welcome.place_id) ?? d.content.places[0]!;
  const characters = new Map(d.content.characters.map((c) => [c.character_id, residentSpeaker(c)]));
  const stage = new Stage(root, place, welcome.title.ru, { "data-welcome": "" }, d);
  const name = d.name.trim() || "гость";
  const fill = (s: string) => s.replaceAll("{name}", name);
  let skipped = false;
  const skip = new Promise<void>((resolve) => {
    stage.scene.append(el("button", { class: "link skip", type: "button", "data-skip": "", onclick: () => ((skipped = true), resolve()) }, "Пропустить"));
  });
  const ids = new Map(welcome.steps.map((s, i) => [s.id, i]));
  for (let i = 0; i < welcome.steps.length && !skipped; ) {
    const step = welcome.steps[i]!;
    stage.scene.dataset.step = step.id;
    if (step.kind === "end") break;
    stage.show(step.speaker === "narrator" ? undefined : characters.get(step.speaker), step.emotion);
    await Promise.race([stage.line(fill(step.text.en), fill(step.text.ru), true), skip]);
    i = step.next !== undefined ? (ids.get(step.next) ?? welcome.steps.length) : i + 1;
  }
  return skipped ? "skipped" : "seen";
}

function line(box: HTMLElement, en: string, ru: string | undefined, showRu = false): Promise<void> {
  return new Promise((resolve) => {
    const text = el("p", { class: "line-text", lang: "en" }, en);
    const parts: HTMLElement[] = [text];
    if (ru && showRu) parts.push(el("p", { class: "line-ru", lang: "ru" }, ru));
    else if (ru) {
      const translation = el("p", { class: "line-ru", lang: "ru", hidden: "" }, ru);
      const toggle = el("button", { class: "link", type: "button", onclick: () => (translation.toggleAttribute("hidden"), toggle.remove()) }, "Перевод");
      parts.push(translation, toggle);
    }
    const next = el("button", { class: "primary next", onclick: () => resolve() }, "Дальше");
    box.replaceChildren(...parts, next);
    next.focus();
  });
}

/** The place's art, or a plain backdrop with its name until the illustrator's file is there. */
function background(place: Place, mediaBase: string): HTMLElement {
  const bg = el("div", { class: "backdrop", "data-place": place.place_id }, el("span", { class: "backdrop-name" }, place.name.en));
  const img = el("img", { src: `${mediaBase}/${place.background}`, alt: "" }) as HTMLImageElement;
  img.addEventListener("load", () => bg.classList.add("has-art"));
  img.addEventListener("error", () => img.remove());
  bg.prepend(img);
  return bg;
}

function portraitOf(who: Speaker, emotion: Emotion, mediaBase: string): HTMLElement {
  const path = who.portraits[emotion] ?? who.portraits.neutral;
  const frame = el("figure", { class: "portrait-frame", "data-character": who.id, "data-emotion": emotion });
  const stub = el("div", { class: "portrait-stub" }, el("span", { class: "initial" }, who.name.slice(0, 1)), el("span", { class: "species" }, who.speciesRu));
  frame.append(stub);
  if (path) {
    const img = el("img", { src: `${mediaBase}/${path}`, alt: who.name }) as HTMLImageElement;
    img.addEventListener("load", () => stub.remove());
    img.addEventListener("error", () => img.remove());
    frame.prepend(img);
  }
  return frame;
}
