import type { ContentBundle, Course } from "@moonbridge/content";
import { beforeAll, describe, expect, it } from "vitest";
import { completeEpisode, emptyState, markWelcomed, migrateState } from "../src/moonbridge/progress.js";
import { metUnits, myWords, reviewQueue, SESSION_SIZE, WordDeck, WORDS_KEY, wordId } from "../src/moonbridge/words.js";
import { BACKED_UP_KEYS } from "../src/net/backup.js";
import { MemoryKeyValue } from "../src/storage/idb.js";
import { loadBundle } from "./fixtures.js";

const CONTENT_DIR = new URL("../../../content", import.meta.url).pathname;
let bundle: ContentBundle;
let course: Course;
beforeAll(async () => {
  bundle = await loadBundle(CONTENT_DIR);
  course = bundle.courses[0]!;
});

const day = (n: number) => new Date(Date.UTC(2027, 0, 11 + n, 9));
const unitWords = (id: string) => bundle.modules.find((m) => m.module_id === id)!.words!;
const played = (...units: string[]) =>
  units.reduce((s, u) => completeEpisode(s, bundle.moonbridge!.episodes.find((e) => e.module_id === u)!.episode_id), emptyState());

describe("Мои слова", () => {
  it("is empty until an episode of a unit is played, then holds that unit's words as new", async () => {
    const deck = await WordDeck.load(new MemoryKeyValue());
    expect(myWords(bundle, course, emptyState(), deck, day(0))).toEqual([]);
    const state = played("A1_NiceToMeetYou_01");
    expect([...metUnits(bundle.moonbridge!, state)]).toEqual(["A1_NiceToMeetYou_01"]);
    const words = myWords(bundle, course, state, deck, day(0));
    expect(words.map((w) => w.word.en)).toEqual(unitWords("A1_NiceToMeetYou_01").map((w) => w.en));
    expect(words.every((w) => w.status === "new" && w.due)).toBe(true);
  });

  it("lists units in course order, not in the order they were played", async () => {
    const deck = await WordDeck.load(new MemoryKeyValue());
    const words = myWords(bundle, course, played("A1_NightCafe_04", "A1_NiceToMeetYou_01"), deck, day(0));
    expect([...new Set(words.map((w) => w.unit.module_id))]).toEqual(["A1_NiceToMeetYou_01", "A1_NightCafe_04"]);
  });

  it("brings words being forgotten before new ones, at most a session at a time", async () => {
    const kv = new MemoryKeyValue();
    const deck = await WordDeck.load(kv);
    const state = played("A1_NiceToMeetYou_01", "A1_WhereAreYouFrom_02");
    const first = reviewQueue(myWords(bundle, course, state, deck, day(0)));
    expect(first).toHaveLength(SESSION_SIZE);
    const forgotten = first[3]!.id;
    for (const w of first) await deck.review(w.id, w.id === forgotten ? "forgot" : "remembered", day(0));
    // Later the same day only new words are left; the next day the forgotten one comes first.
    const later = reviewQueue(myWords(bundle, course, state, deck, new Date(day(0).getTime() + 3600_000)));
    expect(later.every((w) => w.status === "new")).toBe(true);
    const tomorrow = reviewQueue(myWords(bundle, course, state, deck, day(1)));
    expect(tomorrow[0]!.id).toBe(forgotten);
    expect(tomorrow.filter((w) => w.status !== "new").map((w) => w.id)).toEqual([forgotten]);
  });

  it("keeps the schedule across visits and counts a word learned once it is a week away", async () => {
    const kv = new MemoryKeyValue();
    const id = wordId("A1_NiceToMeetYou_01", unitWords("A1_NiceToMeetYou_01")[0]!.en);
    let at = day(0);
    for (let i = 0; i < 6; i++) {
      const deck = await WordDeck.load(kv);
      const s = deck.status(id, at);
      if (s.status === "learned") break;
      await deck.review(id, "remembered", at);
      at = (await WordDeck.load(kv)).status(id, at).due ? at : new Date(at.getTime() + 30 * 86400_000);
    }
    const deck = await WordDeck.load(kv);
    expect(deck.status(id, at).status).toBe("learned");
    expect(deck.status(id, day(0)).due).toBe(false);
    expect(Array.isArray(await kv.get(WORDS_KEY))).toBe(true);
  });

  it("is backed up with the rest of the game", () => {
    expect(BACKED_UP_KEYS).toContain(WORDS_KEY);
  });

  it("ignores a broken stored deck instead of failing the hotel", async () => {
    const kv = new MemoryKeyValue();
    await kv.set(WORDS_KEY, [{ nonsense: true }, "x"]);
    const deck = await WordDeck.load(kv);
    expect(deck.status("A1_NiceToMeetYou_01:welcome", day(0))).toEqual({ status: "new", due: true });
  });
});

describe("the welcome flag", () => {
  it("is off for a new student, on once seen, and on for students who played before it existed", () => {
    expect(emptyState().welcomed).toBe(false);
    expect(migrateState(markWelcomed(emptyState())).welcomed).toBe(true);
    expect(migrateState({ version: 1, completed_episodes: ["x"], practice_days: [], shift_days: [] }).welcomed).toBe(true);
    expect(migrateState({ version: 1, completed_episodes: [] }).welcomed).toBe(false);
  });
});
