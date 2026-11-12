import { wordKey, type ContentBundle, type Course, type Module, type MoonbridgeContent, type Word } from "@moonbridge/content";
import { ConceptScheduler, Rating, type StoredConceptCard } from "@moonbridge/learning";
import type { KeyValue } from "../storage/idb.js";
import type { MoonbridgeState } from "./progress.js";

// «Мои слова»: the student's own dictionary. Words come from the units' content (module.words);
// a unit's words enter it once the student has played one of the unit's episodes. Each word is
// an FSRS card of its own, kept apart from the concept cards of the learning engine: a word is
// recalled from its translation, not tested by tasks.

export const WORDS_KEY = "moonbridge-words";
/** Cards in one review: short enough for a tram stop. */
export const SESSION_SIZE = 10;
/** A word counts as learned once it is not due again for a week. */
const LEARNED_DAYS = 7;

export type WordStatus = "new" | "learning" | "learned";

export interface MyWord {
  id: string;
  word: Word;
  unit: Module;
  status: WordStatus;
  /** Waiting for review now; a new word is always waiting. */
  due: boolean;
}

export function wordId(moduleId: string, en: string): string {
  return `${moduleId}:${wordKey(en)}`;
}

/** Units whose words the student has met: any of their episodes is played. */
export function metUnits(content: MoonbridgeContent, state: MoonbridgeState): Set<string> {
  const done = new Set(state.completed_episodes);
  return new Set(content.episodes.filter((e) => done.has(e.episode_id)).map((e) => e.module_id));
}

/** The repetition schedule of the student's words, stored under its own key. */
export class WordDeck {
  private constructor(
    private readonly scheduler: ConceptScheduler,
    private readonly kv: KeyValue,
  ) {}

  static async load(kv: KeyValue): Promise<WordDeck> {
    const raw = await kv.get<StoredConceptCard[]>(WORDS_KEY);
    const stored = Array.isArray(raw) ? raw.filter((c) => typeof c?.concept_id === "string" && typeof c.card?.due === "string") : [];
    // No fuzz: the same answers give the same schedule, on every phone and in tests. No minute
    // steps: a word comes back on another day; within a review a forgotten word comes back once.
    return new WordDeck(new ConceptScheduler({ enableFuzz: false, shortTerm: false }, stored), kv);
  }

  status(id: string, now: Date): { status: WordStatus; due: boolean } {
    if (!this.scheduler.has(id)) return { status: "new", due: true };
    const card = this.scheduler.card(id, now);
    return { status: card.scheduled_days >= LEARNED_DAYS ? "learned" : "learning", due: card.due.getTime() <= now.getTime() };
  }

  async review(id: string, remembered: Recall, now: Date): Promise<void> {
    this.scheduler.review(id, GRADES[remembered], now);
    await this.kv.set(WORDS_KEY, this.scheduler.toJSON());
  }
}

export type Recall = "forgot" | "hard" | "remembered";
const GRADES = { forgot: Rating.Again, hard: Rating.Hard, remembered: Rating.Good } as const;

/** The student's words in course order, each with where it stands. */
export function myWords(bundle: ContentBundle, course: Course, state: MoonbridgeState, deck: WordDeck, now: Date): MyWord[] {
  const content = bundle.moonbridge;
  if (!content) return [];
  const met = metUnits(content, state);
  const order = [...course.units, ...bundle.modules.map((m) => m.module_id).filter((id) => !course.units.includes(id))];
  const out: MyWord[] = [];
  for (const id of order) {
    const unit = bundle.modules.find((m) => m.module_id === id);
    if (!unit || !met.has(id)) continue;
    for (const word of unit.words ?? []) {
      const wid = wordId(id, word.en);
      out.push({ id: wid, word, unit, ...deck.status(wid, now) });
    }
  }
  return out;
}

/**
 * What one review brings: words already learning and due again first (they are being forgotten),
 * then new ones, in course order, up to SESSION_SIZE.
 */
export function reviewQueue(words: MyWord[]): MyWord[] {
  const due = words.filter((w) => w.due && w.status !== "new");
  const fresh = words.filter((w) => w.status === "new");
  return [...due, ...fresh].slice(0, SESSION_SIZE);
}
