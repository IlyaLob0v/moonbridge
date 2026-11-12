import type { Character, Emotion, Episode, MoonbridgeContent, Place, Say, SceneTransition, Task, TimeOfDay, Welcome } from "@moonbridge/content";
import type { SubmitResult } from "@moonbridge/learning";
import type { Learner } from "../core/learner.js";
import { el } from "../ui/dom.js";
import { askTask, showFeedback } from "../ui/task-panel.js";
import { EpisodeRunner } from "./runner.js";
import type { Sound } from "./sound.js";

export interface PlayerDeps {
  content: MoonbridgeContent;
  learner: Learner;
  mediaBase: string;
  /** The student's name: lines say it where the author wrote {name}. */
  playerName?: string;
  sound?: Sound;
}

export interface EpisodeResult {
  episodeId: string;
  /** Task answers: how many of the tasks shown were right on the first try. */
  firstTry: { right: number; total: number };
  path: string[];
  durationMs: number;
  /** Where the episode ended: the end screen stays on that place. */
  placeId: string;
}

/** Someone who can speak in a scene: a resident, or a guest of the day. */
export interface Speaker {
  id: string;
  name: string;
  speciesRu: string;
  portraits: Partial<Record<Emotion, string>>;
  reactions?: Character["reactions"];
}

/** A resident as they are at that time of day: Rocco is a werewolf at night and a man by day. */
export function residentSpeaker(c: Character, time: TimeOfDay = "night"): Speaker {
  const form = time === "day" && c.day ? c.day : c;
  return { id: c.character_id, name: c.name, speciesRu: form.species.ru, portraits: form.portraits, ...(c.reactions ? { reactions: c.reactions } : {}) };
}

/** The art of a place at that time of day. */
export function placeArt(place: Place, time: TimeOfDay): string {
  return time === "day" ? (place.background_day ?? place.background) : place.background;
}

export function withName(text: string, name: string | undefined, lang: "en" | "ru"): string {
  return text.replaceAll("{name}", name?.trim() || (lang === "en" ? "friend" : "друг"));
}

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pick = <T>(xs: T[] | undefined): T | undefined => (xs?.length ? xs[Math.floor(Math.random() * xs.length)] : undefined);

/** Runs a Web Animation and resolves when it ends; at once when the student asked for less motion. */
function animate(node: Element, frames: Keyframe[], options: KeyframeAnimationOptions): Promise<void> {
  if (reducedMotion() || typeof node.animate !== "function") return Promise.resolve();
  return node.animate(frames, options).finished.then(
    () => undefined,
    () => undefined,
  );
}

const TYPE_MS = 28;

/**
 * A visual-novel stage: backdrop, portrait, speaker tag and the dialog box. Episodes and the daily
 * shift both play on it. Lines type out letter by letter (a tap shows the whole line, the next tap
 * goes on), residents step in and out and show their mood by moving, an answer gets a reaction
 * from whoever asked, and the stage can travel to another place through a fade or the lift.
 */
export class Stage {
  readonly scene: HTMLElement;
  readonly box: HTMLElement;
  private backdrop: HTMLElement;
  private readonly portrait = el("div", { class: "portrait" });
  private readonly speaker = el("div", { class: "speaker" });
  private readonly fx = el("div", { class: "fx", "aria-hidden": "true" });
  private current: { who: Speaker; frame: HTMLElement } | undefined;
  /** A tap on the scene: first finishes the typing, then moves on. */
  private skip: (() => void) | undefined;
  private advance: (() => void) | undefined;

  constructor(
    root: HTMLElement,
    place: Place,
    title: string,
    attrs: Record<string, string>,
    private readonly d: PlayerDeps,
    readonly time: TimeOfDay = "night",
  ) {
    this.box = el("div", { class: "dialog", "aria-live": "polite" });
    this.backdrop = background(place, d.mediaBase, time);
    const sound = d.sound;
    const soundButton = sound
      ? el("button", {
          class: "sound-toggle",
          type: "button",
          "aria-label": "Звук",
          "aria-pressed": String(sound.on),
          onclick: () => {
            const on = sound.toggle();
            soundButton!.textContent = on ? "🔊" : "🔇";
            soundButton!.setAttribute("aria-pressed", String(on));
            if (on) sound.unlock();
          },
        }, sound.on ? "🔊" : "🔇")
      : undefined;
    this.scene = el(
      "section",
      { class: "scene", "data-place": place.place_id, "data-time": time, ...attrs },
      this.backdrop,
      el("div", { class: "atmosphere", "aria-hidden": "true" }),
      el("div", { class: "scene-title" }, title),
      ...(soundButton ? [soundButton] : []),
      this.portrait,
      el("div", { class: "dialog-wrap" }, this.speaker, this.box),
      this.fx,
    );
    this.scene.addEventListener("pointerdown", () => sound?.unlock());
    this.scene.addEventListener("click", (e) => {
      if ((e.target as Element).closest("button, a, input, textarea, select, label, form, .task")) return;
      if (this.skip) this.skip();
      else this.advance?.();
    });
    root.replaceChildren(this.scene);
    sound?.setAmbience(time === "night" ? "rain" : "hum");
  }

  /** Who is on stage; undefined = the narrator. The same resident stays and changes face; a new one steps in. */
  show(who: Speaker | undefined, emotion: Emotion = "neutral"): void {
    this.speaker.textContent = who?.name ?? "";
    this.speaker.hidden = !who;
    this.scene.dataset.speaker = who?.id ?? "narrator";
    this.box.classList.toggle("narration", !who);
    if (who && this.current?.who.id === who.id) {
      if (this.current.frame.dataset.emotion === emotion) return;
      const frame = portraitOf(who, emotion, this.d.mediaBase);
      this.current.frame.replaceWith(frame);
      this.current.frame = frame;
      void this.emote(emotion);
      return;
    }
    const leaving = this.current?.frame;
    if (leaving) {
      // Out of the way of the selectors that find who is on stage, then gone.
      leaving.className = "portrait-leaving";
      leaving.removeAttribute("data-character");
      leaving.removeAttribute("data-emotion");
      void animate(leaving, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(28px)" }], { duration: 200, easing: "ease-in", fill: "forwards" }).then(() => leaving.remove());
    }
    this.current = undefined;
    if (!who) return;
    const frame = portraitOf(who, emotion, this.d.mediaBase);
    this.portrait.append(frame);
    this.current = { who, frame };
    void animate(
      frame,
      [
        { opacity: 0, transform: "translateY(48px) scale(0.96)" },
        { opacity: 1, transform: "translateY(-8px) scale(1)", offset: 0.7 },
        { opacity: 1, transform: "none" },
      ],
      { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
  }

  /** Whoever is on stage takes a face and moves (once, even when the face changes too). */
  private react(who: Speaker, mood: Emotion, motion: Emotion | "typo"): void {
    const before = this.current?.frame.dataset.emotion;
    this.show(who, mood);
    if (before === mood || motion !== mood) void this.emote(motion);
  }

  /** A mood shown by moving: a hop of joy, a shudder of annoyance. */
  private emote(emotion: Emotion | "typo"): Promise<void> {
    const frame = this.current?.frame;
    if (!frame) return Promise.resolve();
    if (emotion === "happy")
      return animate(frame, [{ transform: "none" }, { transform: "translateY(-18px)" }, { transform: "none" }, { transform: "translateY(-7px)" }, { transform: "none" }], { duration: 520, easing: "ease-out" });
    if (emotion === "upset")
      return animate(frame, [{ transform: "none" }, { transform: "translateX(-9px) rotate(-2deg)" }, { transform: "translateX(8px) rotate(1.5deg)" }, { transform: "translateX(-5px)" }, { transform: "none" }], { duration: 420 });
    if (emotion === "typo") return animate(frame, [{ transform: "none" }, { transform: "rotate(-3deg)" }, { transform: "rotate(3deg)" }, { transform: "none" }], { duration: 380 });
    return Promise.resolve();
  }

  /** A line typed out letter by letter. A tap shows all of it, "Дальше" (or a second tap) goes on. `showRu` puts the translation under it at once. */
  line(en: string, ru?: string, showRu = false): Promise<void> {
    const name = this.d.playerName;
    const textEn = withName(en, name, "en");
    const textRu = ru === undefined ? undefined : withName(ru, name, "ru");
    return new Promise((resolve) => {
      const typed = el("span", { class: "typed" });
      const rest = el("span", { class: "rest", "aria-hidden": "true" }, textEn);
      const text = el("p", { class: "line-text", lang: "en" }, typed, rest);
      const parts: HTMLElement[] = [text];
      if (textRu && showRu) parts.push(el("p", { class: "line-ru", lang: "ru" }, textRu));
      else if (textRu) {
        const translation = el("p", { class: "line-ru", lang: "ru", hidden: "" }, textRu);
        const toggle = el("button", { class: "link", type: "button", onclick: () => (translation.toggleAttribute("hidden"), toggle.remove()) }, "Перевод");
        parts.push(translation, toggle);
      }
      const chars = [...textEn];
      let shown = 0;
      let timer: ReturnType<typeof setInterval> | undefined;
      const finishTyping = () => {
        if (timer) clearInterval(timer);
        timer = undefined;
        typed.textContent = textEn;
        rest.textContent = "";
        this.skip = undefined;
      };
      const done = () => {
        finishTyping();
        this.advance = undefined;
        this.d.sound?.play("tap");
        resolve();
      };
      const next = el("button", { class: "primary next", onclick: done }, "Дальше");
      this.box.replaceChildren(...parts, next);
      next.focus();
      this.advance = done;
      if (reducedMotion()) return finishTyping();
      this.skip = finishTyping;
      timer = setInterval(() => {
        shown = Math.min(chars.length, shown + 1);
        typed.textContent = chars.slice(0, shown).join("");
        rest.textContent = chars.slice(shown).join("");
        if (shown >= chars.length) finishTyping();
      }, TYPE_MS);
    });
  }

  /**
   * Asks a task in the dialog box and records the answer. Whoever asked reacts: a clean right
   * answer gets a hop, a spark and a short word; anything else a shudder and the correction in
   * their voice.
   */
  async task(task: Task, context: Record<string, unknown>): Promise<SubmitResult> {
    this.skip = this.advance = undefined;
    const answer = await askTask(this.box, task, { mediaBase: this.d.mediaBase });
    const result = await this.d.learner.answer(task.task_id, answer, context);
    const o = result.outcome;
    const who = this.current?.who;
    if (o.correct && o.match === "accepted") {
      this.d.sound?.play("right");
      this.sparkle();
      if (who) {
        this.react(who, who.portraits.happy ? "happy" : "neutral", "happy");
        const say = pick(who.reactions?.right);
        if (say) this.quip(withName(say.en, this.d.playerName, "en"));
      }
      return result;
    }
    const kind = o.match === "typo" ? "typo" : o.correct ? "right" : "wrong";
    this.d.sound?.play(kind === "wrong" ? "wrong" : "typo");
    if (who) {
      if (kind === "wrong") this.react(who, who.portraits.upset ? "upset" : "neutral", "upset");
      else void this.emote("typo");
    }
    void animate(this.box, [{ transform: "none" }, { transform: "translateX(-6px)" }, { transform: "translateX(5px)" }, { transform: "none" }], { duration: 300 });
    const label = o.errorType ? this.d.learner.bundle.taxonomy.error_types.find((t) => t.id === o.errorType)?.label.ru : undefined;
    const say: Say | undefined = who ? pick(who.reactions?.[kind]) : undefined;
    await showFeedback(this.box, o, label, task, say ? { en: withName(say.en, this.d.playerName, "en"), ...(say.ru ? { ru: withName(say.ru, this.d.playerName, "ru") } : {}) } : undefined);
    return result;
  }

  /** The stage travels: through black, through the lift's doors, or at once. */
  async moveTo(place: Place, transition: SceneTransition = "fade"): Promise<void> {
    this.skip = this.advance = undefined;
    const swap = () => {
      const bg = background(place, this.d.mediaBase, this.time);
      this.backdrop.replaceWith(bg);
      this.backdrop = bg;
      this.scene.dataset.place = place.place_id;
      this.show(undefined);
      this.box.replaceChildren();
    };
    if (transition === "cut" || reducedMotion()) return swap();
    if (transition === "lift") {
      const left = el("div", { class: "door left" });
      const right = el("div", { class: "door right" });
      const needle = el("span", { class: "needle" });
      const doors = el("div", { class: "lift-doors", "aria-hidden": "true" }, left, right, el("div", { class: "floor-dial" }, needle));
      this.scene.append(doors);
      this.d.sound?.play("lift");
      const shut = { duration: 480, easing: "cubic-bezier(.5,0,.5,1)", fill: "forwards" } as const;
      await Promise.all([animate(left, [{ transform: "translateX(-101%)" }, { transform: "none" }], shut), animate(right, [{ transform: "translateX(101%)" }, { transform: "none" }], shut)]);
      swap();
      await animate(needle, [{ transform: "rotate(-70deg)" }, { transform: "rotate(70deg)" }], { duration: 800, easing: "ease-in-out", fill: "forwards" });
      const open = { duration: 520, easing: "cubic-bezier(.5,0,.5,1)", fill: "forwards" } as const;
      await Promise.all([animate(left, [{ transform: "none" }, { transform: "translateX(-101%)" }], open), animate(right, [{ transform: "none" }, { transform: "translateX(101%)" }], open)]);
      doors.remove();
      return;
    }
    const curtain = el("div", { class: "curtain", "aria-hidden": "true" });
    this.scene.append(curtain);
    this.d.sound?.play("whoosh");
    await animate(curtain, [{ opacity: 0 }, { opacity: 1 }], { duration: 380, fill: "forwards" });
    swap();
    await wait(140);
    await animate(curtain, [{ opacity: 1 }, { opacity: 0 }], { duration: 480, fill: "forwards" });
    curtain.remove();
  }

  /** The title card of a chapter: it goes by itself after a moment, or on a tap. */
  chapter(kicker: string, title: string, sub?: string): Promise<void> {
    const card = el(
      "div",
      { class: "chapter-card", "data-chapter": "" },
      el("p", { class: "chapter-kicker" }, kicker),
      el("h1", {}, title),
      ...(sub ? [el("p", { class: "chapter-sub", lang: "en" }, sub)] : []),
    );
    this.scene.append(card);
    this.d.sound?.play("chapter");
    return new Promise((resolve) => {
      let over = false;
      const done = () => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        this.advance = undefined;
        card.style.pointerEvents = "none";
        void animate(card, [{ opacity: 1 }, { opacity: 0 }], { duration: 320, fill: "forwards" }).then(() => card.remove());
        resolve();
      };
      const timer = setTimeout(done, reducedMotion() ? 1200 : 2400);
      this.advance = done;
    });
  }

  /** Sparks over the dialog box. */
  private sparkle(): void {
    if (reducedMotion()) return;
    const rect = this.box.getBoundingClientRect();
    const host = this.scene.getBoundingClientRect();
    const cx = rect.left - host.left + rect.width / 2;
    const cy = rect.top - host.top + 20;
    for (let i = 0; i < 16; i++) {
      const spark = el("span", { class: "spark" });
      spark.style.left = `${cx}px`;
      spark.style.top = `${cy}px`;
      this.fx.append(spark);
      const angle = (Math.PI * 2 * i) / 16 + Math.random() * 0.4;
      const dist = 50 + Math.random() * 70;
      void animate(
        spark,
        [
          { transform: "translate(-50%, -50%) scale(1)", opacity: 1 },
          { transform: `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist - 30}px)) scale(0.2)`, opacity: 0 },
        ],
        { duration: 650 + Math.random() * 250, easing: "cubic-bezier(.1,.7,.3,1)", fill: "forwards" },
      ).then(() => spark.remove());
    }
  }

  /** A short word from whoever is on stage, in a bubble that fades by itself. */
  private quip(text: string): void {
    const bubble = el("div", { class: "quip", lang: "en", "aria-hidden": "true" }, text);
    this.portrait.append(bubble);
    void animate(
      bubble,
      [
        { opacity: 0, transform: "translateY(8px) scale(.9)" },
        { opacity: 1, transform: "none", offset: 0.15 },
        { opacity: 1, transform: "none", offset: 0.8 },
        { opacity: 0, transform: "translateY(-6px)" },
      ],
      { duration: 1600, fill: "forwards" },
    ).then(() => bubble.remove());
    if (reducedMotion()) setTimeout(() => bubble.remove(), 1600);
  }
}

export interface ChapterInfo {
  /** The unit's number in the course, for "Глава 2". */
  number?: number;
}

/**
 * Plays one episode as a visual novel: the place behind, the speaker's portrait with an
 * emotion, a line or a task in the dialog box, a move to another place. Right and wrong answers
 * lead wherever the episode's JSON says; this file has no story in it.
 */
export async function playEpisode(root: HTMLElement, episode: Episode, d: PlayerDeps, chapter: ChapterInfo = {}): Promise<EpisodeResult> {
  const time = episode.time_of_day ?? "night";
  const placeOf = (id: string) => d.content.places.find((p) => p.place_id === id)!;
  let place = placeOf(episode.place_id);
  const characters = new Map(d.content.characters.map((c) => [c.character_id, residentSpeaker(c, time)]));
  const runner = new EpisodeRunner(episode);
  const started = d.learner.now().getTime();
  const firstTry = new Map<string, boolean>();
  d.learner.resetAttempts();
  const stage = new Stage(root, place, episode.title.ru, { "data-episode": episode.episode_id }, d, time);
  // The scene names its first step at once, while the title card is still up.
  if (runner.current.kind !== "scene") stage.scene.dataset.step = runner.current.id;
  const kicker = [chapter.number ? `Глава ${chapter.number}` : "", time === "day" ? "☀ День" : "☾ Ночь", place.name.ru].filter(Boolean).join(" · ");
  await stage.chapter(kicker, episode.title.ru, episode.title.en);

  while (!runner.finished) {
    const step = runner.current;
    if (step.kind === "scene") {
      place = placeOf(step.place_id);
      await stage.moveTo(place, step.transition);
      runner.next();
    } else if (step.kind === "line") {
      stage.scene.dataset.step = step.id;
      stage.show(step.speaker === "narrator" ? undefined : characters.get(step.speaker), step.emotion);
      await stage.line(step.text.en, step.text.ru);
      runner.next();
    } else if (step.kind === "task") {
      stage.scene.dataset.step = step.id;
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
    placeId: place.place_id,
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
export async function playWelcome(root: HTMLElement, welcome: Welcome, d: PlayerDeps & { name: string }, time: TimeOfDay = "night"): Promise<"seen" | "skipped"> {
  const place = d.content.places.find((p) => p.place_id === welcome.place_id) ?? d.content.places[0]!;
  const characters = new Map(d.content.characters.map((c) => [c.character_id, residentSpeaker(c, time)]));
  const stage = new Stage(root, place, welcome.title.ru, { "data-welcome": "" }, d, time);
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

/** The place's art at that time of day, or a plain backdrop with its name until the illustrator's file is there. */
export function background(place: Place, mediaBase: string, time: TimeOfDay = "night"): HTMLElement {
  const bg = el("div", { class: "backdrop", "data-place": place.place_id, "data-time": time }, el("span", { class: "backdrop-name" }, place.name.en));
  const art = placeArt(place, time);
  const img = el("img", { src: `${mediaBase}/${art}`, alt: "" }) as HTMLImageElement;
  img.addEventListener("load", () => bg.classList.add("has-art"));
  img.addEventListener("error", () => {
    // No day picture yet: the night one, lit up by the day theme, is better than none.
    if (art !== place.background && !img.dataset.fallback) {
      img.dataset.fallback = "1";
      img.src = `${mediaBase}/${place.background}`;
    } else img.remove();
  });
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
