import { describe, expect, it } from "vitest";
import { findCycles, normalizeAnswer, validateContent, type ContentSource } from "../src/index.js";
import { buildBundle, loadContentDir } from "../src/node.js";

const CONTENT_DIR = new URL("../../../content", import.meta.url).pathname;
/** A frozen copy of three A1 units with Moonbridge places and episodes: the tests do not depend on the live course. */
export const FIXTURE_DIR = new URL("./fixtures/content", import.meta.url).pathname;

async function load(dir: string): Promise<ContentSource> {
  const { source, parseErrors } = await loadContentDir(dir);
  expect(parseErrors).toEqual([]);
  return structuredClone(source);
}
const fixture = () => load(FIXTURE_DIR);

const codes = (src: ContentSource) => validateContent(src).issues.filter((i) => i.severity === "error").map((i) => i.code);
const episode = (src: ContentSource, id: string) => src.episodes!.find((e) => (e.data as any).episode_id === id)!.data as any;
const taskOfType = (src: ContentSource, type: string) =>
  src.taskSets.flatMap((f) => (f.data as any).tasks).find((t: any) => t.type === type) as any;

describe("the content in /content", () => {
  it("is valid", async () => {
    const result = validateContent(await load(CONTENT_DIR));
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("has a course, and Moonbridge for it", async () => {
    const bundle = buildBundle(validateContent(await load(CONTENT_DIR)).content!);
    expect(bundle.courses.length).toBeGreaterThan(0);
    expect(bundle.moonbridge?.episodes.length).toBeGreaterThan(0);
  });
});

describe("the fixture content", () => {
  it("has the four classic task types in every unit, and all eight in VerbToBe", async () => {
    const result = validateContent(await fixture());
    for (const set of result.content!.taskSets) {
      const types = new Set(set.tasks.map((t) => t.type));
      for (const t of ["choice", "gap_fill", "transform", "order_words"]) expect(types).toContain(t);
      if (set.module_id === "A1_VerbToBe_01") expect(types.size).toBe(8);
    }
  });

  it("builds a bundle whose hash depends on content only", async () => {
    const content = validateContent(await fixture()).content!;
    const a = buildBundle(content, new Date("2026-01-01"));
    const b = buildBundle(content, new Date("2026-06-01"));
    expect(a.content_hash).toBe(b.content_hash);
    expect(Object.keys(a.tasks).length).toBeGreaterThanOrEqual(36);
    expect(a.tasks["A1_PastSimple_01_q3"]?.module_id).toBe("A1_PastSimple_01");
    expect(a.moonbridge?.episodes.map((e) => e.episode_id)).toEqual(["articles_in_cafe", "to_be_at_reception"]);
  });

  it("works as a platform without Moonbridge", async () => {
    const src = await fixture();
    delete src.places;
    delete src.characters;
    delete src.episodes;
    delete src.daily;
    const result = validateContent(src);
    expect(result.ok).toBe(true);
    expect(buildBundle(result.content!).moonbridge).toBeUndefined();
  });

  it("works as Moonbridge without the daily shift", async () => {
    const src = await fixture();
    delete src.daily;
    const result = validateContent(src);
    expect(result.ok).toBe(true);
    expect(buildBundle(result.content!).moonbridge?.daily).toBeUndefined();
  });
});

describe("validator catches", () => {
  it("a task pointing at a concept its unit does not define", async () => {
    const src = await fixture();
    (src.taskSets[0]!.data as any).tasks[0].concept_id = "nope.missing";
    expect(codes(src)).toContain("ref.concept");
  });

  it("a prerequisite cycle", async () => {
    const src = await fixture();
    const verbToBe = src.modules.find((m) => (m.data as any).module_id === "A1_VerbToBe_01")!;
    (verbToBe.data as any).prerequisites = ["A1_PastSimple_01"];
    expect(codes(src)).toContain("cycle.prerequisites");
  });

  it("a duplicate task id", async () => {
    const src = await fixture();
    const tasks = (src.taskSets[0]!.data as any).tasks;
    tasks.push(structuredClone(tasks[0]));
    expect(codes(src)).toContain("duplicate.task_id");
  });

  it("a course that puts a unit before its prerequisite", async () => {
    const src = await fixture();
    (src.courses[0]!.data as any).units.reverse();
    expect(codes(src)).toContain("order.prerequisites");
  });

  it("a unit check larger than the task pool", async () => {
    const src = await fixture();
    (src.modules[0]!.data as any).mastery.check_task_count = 999;
    expect(codes(src)).toContain("mastery.pool");
  });

  it("an unknown error type in known_errors", async () => {
    const src = await fixture();
    const task = (src.taskSets[0]!.data as any).tasks.find((t: any) => t.answer.known_errors?.length);
    task.answer.known_errors[0].error_type = "grammar.made_up";
    expect(codes(src)).toContain("ref.error_type");
  });

  it("an answer that is both accepted and a known error", async () => {
    const src = await fixture();
    const task = (src.taskSets[0]!.data as any).tasks.find((t: any) => t.type === "gap_fill" && t.answer.known_errors?.length);
    task.answer.known_errors[0].match.push(task.answer.accepted[0].toUpperCase());
    expect(codes(src)).toContain("answer.conflict");
  });

  it("an order_words answer that cannot be built from its tokens", async () => {
    const src = await fixture();
    const task = (src.taskSets[0]!.data as any).tasks.find((t: any) => t.type === "order_words");
    task.answer.accepted = ["Something else entirely"];
    expect(codes(src)).toContain("answer.tokens");
  });

  it("a find_error answer that points past the last token", async () => {
    const src = await fixture();
    const task = taskOfType(src, "find_error");
    task.answer.accepted = ["9"];
    expect(codes(src)).toEqual(["answer.token_ref"]);
  });

  it("a translate_en_ru task without exactly three options, or with a missing option id", async () => {
    const src = await fixture();
    const task = taskOfType(src, "translate_en_ru");
    task.presentation.options.pop();
    expect(validateContent(src).issues.some((i) => i.code === "schema" && i.message.includes("options"))).toBe(true);
    const again = await fixture();
    taskOfType(again, "translate_en_ru").answer.accepted = ["z"];
    expect(codes(again)).toContain("answer.option_ref");
  });

  it("a listen_type task without a recording", async () => {
    const src = await fixture();
    delete taskOfType(src, "listen_type").presentation.audio;
    expect(validateContent(src).issues.some((i) => i.code === "schema" && i.message.includes("audio"))).toBe(true);
  });

  it("schema violations, with the offending field", async () => {
    const src = await fixture();
    (src.modules[0]!.data as any).cefr_level = "Z9";
    (src.modules[0]!.data as any).surprise = true;
    const issues = validateContent(src).issues;
    expect(issues.some((i) => i.code === "schema" && i.message.includes("cefr_level"))).toBe(true);
    expect(issues.some((i) => i.code === "schema" && i.message.includes("surprise"))).toBe(true);
  });
});

describe("Moonbridge checks", () => {
  it("a guest whose host is not a character, and a lost item defined twice", async () => {
    const src = await fixture();
    const daily = src.daily![0]!.data as any;
    daily.guests[0].host = "nobody";
    daily.lost_items.push({ ...daily.lost_items[0] });
    expect(codes(src).sort()).toEqual(["duplicate.item_id", "ref.character"]);
  });

  it("a course reordering that respects prerequisites is fine, and places follow it", async () => {
    const src = await fixture();
    // VerbToBe, PastSimple, Articles → VerbToBe, Articles, PastSimple: the café (opened by PastSimple)
    // now opens after the Articles episode that takes place there.
    const units = (src.courses[0]!.data as any).units;
    [units[1], units[2]] = [units[2], units[1]];
    expect(codes(src)).toEqual(["order.place"]);
    episode(src, "articles_in_cafe").place_id = "reception";
    episode(src, "articles_in_cafe").steps[0].speaker = "rocco";
    expect(codes(src)).toEqual([]);
  });

  it("an episode using a task of another unit, or one that does not exist", async () => {
    const src = await fixture();
    episode(src, "to_be_at_reception").steps[1].task_id = "A1_PastSimple_01_q1";
    episode(src, "articles_in_cafe").steps[0].task_id = "A1_Articles_01_nope";
    const issues = validateContent(src).issues.filter((i) => i.code === "ref.task");
    expect(issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("belongs to unit"), expect.stringContaining("does not exist")]),
    );
  });

  it("a branch to a missing step, an unreachable step and a loop without exit", async () => {
    const src = await fixture();
    const steps = episode(src, "to_be_at_reception").steps;
    steps[2].next = "nowhere";
    expect(codes(src)).toContain("ref.step");
    steps[2].next = "end";
    steps[1].on_wrong = "good"; // "oops" is now unreachable
    expect(codes(src)).toEqual(["step.unreachable"]);
    steps[1].on_wrong = "oops";
    steps[1].on_correct = "oops"; // ask ↔ oops, the end is never reached
    expect(codes(src)).toEqual(expect.arrayContaining(["step.unreachable", "step.no_end"]));
  });

  it("a last step that is not an end", async () => {
    const src = await fixture();
    episode(src, "articles_in_cafe").steps[1] = { id: "bye", kind: "line", speaker: "pip", text: { en: "Bye!" } };
    expect(codes(src)).toContain("step.dangling");
  });

  it("an emotion the character has no portrait for, and an unknown speaker", async () => {
    const src = await fixture();
    episode(src, "articles_in_cafe").steps[0].emotion = "happy";
    episode(src, "to_be_at_reception").steps[0].speaker = "nobody";
    expect(codes(src)).toEqual(expect.arrayContaining(["ref.emotion", "ref.character"]));
  });

  it("a speaker who lives elsewhere is only a warning", async () => {
    const src = await fixture();
    const hello = episode(src, "to_be_at_reception").steps[0];
    hello.speaker = "pip";
    delete hello.emotion; // Pip has no "happy" portrait
    const result = validateContent(src);
    expect(result.ok).toBe(true);
    expect(result.issues.map((i) => i.code)).toContain("speaker.elsewhere");
  });

  it("one unit opening two places", async () => {
    const src = await fixture();
    (src.places![0]!.data as any).places[0].unlocked_by = "A1_PastSimple_01";
    expect(codes(src)).toContain("duplicate.unlock");
  });

  it("places without characters", async () => {
    const src = await fixture();
    delete src.characters;
    expect(codes(src)).toContain("moonbridge.files");
  });
});

describe("findCycles", () => {
  it("finds a three-node cycle and ignores acyclic parts", () => {
    const graph = new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]], ["d", ["a"]]]);
    expect(findCycles(graph)).toEqual([["a", "b", "c"]]);
  });
});

describe("normalizeAnswer", () => {
  it("unifies apostrophes, case, spaces and trailing punctuation", () => {
    expect(normalizeAnswer("  We  AREN’T afraid. ")).toBe("we aren't afraid");
    expect(normalizeAnswer("Are you a friend ?")).toBe("are you a friend");
    expect(normalizeAnswer("Went", true)).toBe("Went");
  });
});

describe("the welcome scene and the units' words", () => {
  const live = () => load(CONTENT_DIR);
  const welcome = (src: ContentSource) => src.welcome![0]!.data as any;

  it("ships the live welcome and words into the bundle", async () => {
    const result = validateContent(await live());
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    const bundle = buildBundle(result.content!);
    expect(bundle.moonbridge!.welcome!.steps.at(-1)!.kind).toBe("end");
    expect(bundle.modules.every((m) => (m.words?.length ?? 0) > 0)).toBe(true);
  });

  it("checks the welcome like an episode: places, speakers, steps", async () => {
    const src = await live();
    welcome(src).place_id = "nowhere";
    welcome(src).steps[1].speaker = "dracula";
    welcome(src).steps[2].next = "missing";
    expect(codes(src)).toEqual(expect.arrayContaining(["ref.place", "ref.character", "ref.step"]));
  });

  it("refuses tasks in the welcome and a second welcome file", async () => {
    const src = await live();
    welcome(src).steps.splice(1, 0, { id: "quiz", kind: "task", task_id: "A1_NiceToMeetYou_01_hello" });
    expect(codes(src)).toContain("schema");
    const two = await live();
    two.welcome!.push(structuredClone(two.welcome![0]!));
    expect(codes(two)).toContain("moonbridge.files");
  });

  it("warns when the welcome happens somewhere still closed on the first visit", async () => {
    const src = await live();
    welcome(src).place_id = "cafe";
    const result = validateContent(src);
    expect(result.ok).toBe(true);
    expect(result.issues.map((i) => i.code)).toContain("welcome.place");
  });

  it("refuses the same word twice in a unit, whatever the case and spaces", async () => {
    const src = await live();
    const m = src.modules[0]!.data as any;
    m.words.push({ en: `  ${m.words[0].en.toUpperCase()} `, ru: "ещё раз" });
    expect(codes(src)).toContain("duplicate.word");
  });
});
