import type { ContentBundle, Episode } from "@moonbridge/content";
import { beforeAll, describe, expect, it } from "vitest";
import { EpisodeRunner } from "../src/moonbridge/runner.js";
import { loadBundle } from "./fixtures.js";

let bundle: ContentBundle;
beforeAll(async () => {
  bundle = await loadBundle();
});
const episode = (id: string) => bundle.moonbridge!.episodes.find((e) => e.episode_id === id)!;

describe("EpisodeRunner", () => {
  it("plays the right-answer path to the end", () => {
    const r = new EpisodeRunner(episode("to_be_at_reception"));
    expect(r.current.id).toBe("hello");
    r.next();
    r.answer(true);
    expect(r.current.id).toBe("good");
    r.next();
    expect(r.finished).toBe(true);
    expect(r.path).toEqual(["hello", "ask", "good", "end"]);
  });

  it("sends a wrong answer into its branch and back to the task", () => {
    const r = new EpisodeRunner(episode("to_be_at_reception"));
    r.next();
    r.answer(false);
    expect(r.current.id).toBe("oops");
    r.next();
    expect(r.current.id).toBe("ask");
    r.answer(true);
    r.next();
    expect(r.path).toEqual(["hello", "ask", "oops", "ask", "good", "end"]);
    expect(r.results.get("ask")).toBe(true);
  });

  it("moves on from a scene step like from a line", () => {
    const base = episode("to_be_at_reception");
    const steps = [...base.steps];
    steps.splice(1, 0, { id: "walk", kind: "scene", place_id: "reception", transition: "fade" });
    const r = new EpisodeRunner({ ...base, steps });
    r.next();
    expect(r.current.id).toBe("walk");
    r.next();
    expect(r.current.id).toBe("ask");
    expect(() => r.next()).toThrow(/not a line or a scene/);
  });

  it("follows a branch added in the content alone", () => {
    const base = episode("to_be_at_reception");
    const edited: Episode = {
      ...base,
      steps: [
        ...base.steps.slice(0, 3),
        { id: "oops", kind: "line", speaker: "rocco", emotion: "upset", text: { en: "A key for room 0? We have no room 0." }, next: "joke" },
        { id: "joke", kind: "line", speaker: "narrator", text: { en: "The lift laughs." }, next: "ask" },
        { id: "end", kind: "end" },
      ],
    };
    const r = new EpisodeRunner(edited);
    r.next();
    r.answer(false);
    r.next();
    expect(r.current.id).toBe("joke");
  });

  it("refuses an action that does not fit the step", () => {
    const r = new EpisodeRunner(episode("to_be_at_reception"));
    expect(() => r.answer(true)).toThrow(/not a task/);
    r.next();
    expect(() => r.next()).toThrow(/not a line/);
  });
});
