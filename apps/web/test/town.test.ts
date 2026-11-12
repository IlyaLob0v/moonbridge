import type { ContentBundle, Course } from "@moonbridge/content";
import { beforeAll, describe, expect, it } from "vitest";
import { completeEpisode, emptyState, hotelView } from "../src/moonbridge/progress.js";
import { buildings } from "../src/moonbridge/town.js";
import { loadBundle } from "./fixtures.js";

let bundle: ContentBundle;
let course: Course;
beforeAll(async () => {
  bundle = await loadBundle();
  course = bundle.courses[0]!;
});

describe("the town map", () => {
  it("has a building per unit in course order, with the unit's episodes as quests and its tasks as windows", () => {
    const list = buildings(hotelView(bundle.moonbridge!, course, emptyState()), bundle, new Map());
    expect(list.map((b) => b.unit)).toEqual(course.units);
    expect(list.map((b) => b.state)).toEqual(["current", "locked", "locked"]);
    expect(list[0]!.place?.place_id).toBe("reception");
    expect(list[0]!.quests.map((q) => q.episode.episode_id)).toEqual(["to_be_at_reception"]);
    const module = bundle.modules.find((m) => m.module_id === course.units[0])!;
    expect(list[0]!.tasks.map((t) => t.task_id)).toEqual(module.tasks);
    expect(list[0]!.tasks.every((t) => t.mark === "new")).toBe(true);
  });

  it("marks a played unit done, moves the student on, and lights the windows by the latest answers", () => {
    const module = bundle.modules.find((m) => m.module_id === course.units[0])!;
    const [a, b] = module.tasks;
    const view = hotelView(bundle.moonbridge!, course, completeEpisode(emptyState(), "to_be_at_reception"));
    const list = buildings(view, bundle, new Map([[a!, true], [b!, false]]));
    expect(list[0]!.state).toBe("done");
    expect(list[0]!.tasks.slice(0, 3).map((t) => t.mark)).toEqual(["right", "wrong", "new"]);
    expect(list.find((x) => x.state === "current")?.unit).toBe(view.currentUnit);
  });
});
