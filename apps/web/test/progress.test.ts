import type { ContentBundle, Course } from "@moonbridge/content";
import { beforeAll, describe, expect, it } from "vitest";
import { completeEpisode, emptyState, hotelTime, hotelView, migrateState, openedUnits } from "../src/moonbridge/progress.js";
import { loadBundle } from "./fixtures.js";

let bundle: ContentBundle;
let course: Course;
beforeAll(async () => {
  bundle = await loadBundle();
  course = bundle.courses[0]!;
});
const open = (v: ReturnType<typeof hotelView>) => v.places.filter((p) => p.open).map((p) => p.place.place_id);

describe("hotelView", () => {
  it("starts at the reception with its first episode", () => {
    const v = hotelView(bundle.moonbridge!, course, emptyState());
    expect(open(v)).toEqual(["reception"]);
    expect(v.currentUnit).toBe("A1_VerbToBe_01");
    expect(v.next?.episode_id).toBe("to_be_at_reception");
  });

  it("opens the Night Café once the units before it are behind the student", () => {
    const v = hotelView(bundle.moonbridge!, course, completeEpisode(emptyState(), "to_be_at_reception"));
    expect(open(v)).toEqual(["reception", "cafe"]);
    expect(v.next?.episode_id).toBe("articles_in_cafe");
    expect(v.places[0]!.episodes[0]!.done).toBe(true);
  });

  it("follows the course order in the content", () => {
    const reordered = { ...course, units: ["A1_VerbToBe_01", "A1_Articles_01", "A1_PastSimple_01"] };
    const v = hotelView(bundle.moonbridge!, reordered, completeEpisode(emptyState(), "to_be_at_reception"));
    expect(v.currentUnit).toBe("A1_Articles_01");
    expect(open(v)).toEqual(["reception"]);
  });

  it("has nothing next when every episode is played", () => {
    const state = ["to_be_at_reception", "articles_in_cafe"].reduce(completeEpisode, emptyState());
    const v = hotelView(bundle.moonbridge!, course, state);
    expect(v.next).toBeUndefined();
    expect(v.currentUnit).toBeUndefined();
    expect(open(v)).toEqual(["reception", "cafe"]);
  });
});

describe("hotelView when the teacher opens the units", () => {
  it("opens nothing but what the teacher has given", () => {
    const v = hotelView(bundle.moonbridge!, course, emptyState(), new Set());
    expect(v.byTeacher).toBe(true);
    expect(v.next).toBeUndefined();
    expect(v.places.flatMap((p) => p.episodes).some((e) => e.available)).toBe(false);
  });

  it("opens a given unit and its place, even ahead of the course, and keeps a played unit open", () => {
    const v = hotelView(bundle.moonbridge!, course, emptyState(), new Set(["A1_Articles_01"]));
    expect(open(v)).toContain("cafe");
    expect(v.next?.episode_id).toBe("articles_in_cafe");
    expect(v.currentUnit).toBe("A1_Articles_01");
    const played = hotelView(bundle.moonbridge!, course, completeEpisode(emptyState(), "articles_in_cafe"), new Set());
    expect(played.places.flatMap((p) => p.episodes).find((e) => e.episode.episode_id === "articles_in_cafe")!.available).toBe(true);
    expect(played.studiedUnits).toEqual(["A1_Articles_01"]);
  });

  it("follows the teacher only when every group of the student asks for it", () => {
    const hw = [{ module_id: "A1_VerbToBe_01" }, { module_id: null }];
    expect(openedUnits({ groups: [{ unit_access: "assigned" }], homework: hw })).toEqual(new Set(["A1_VerbToBe_01"]));
    expect(openedUnits({ groups: [{ unit_access: "assigned" }, { unit_access: "course" }], homework: hw })).toBeUndefined();
    expect(openedUnits({ groups: [], homework: [] })).toBeUndefined();
    expect(openedUnits(undefined)).toBeUndefined();
  });
});

describe("side quests and the time of day", () => {
  it("lists a side quest in its place, but the unit and the Play button do not wait for it", () => {
    const side = { ...bundle.moonbridge!.episodes.find((e) => e.episode_id === "to_be_at_reception")!, episode_id: "morning_side", side: true, time_of_day: "day" as const };
    const content = { ...bundle.moonbridge!, episodes: [...bundle.moonbridge!.episodes, side] };
    const v = hotelView(content, course, completeEpisode(emptyState(), "to_be_at_reception"));
    expect(v.places[0]!.episodes.map((e) => e.episode.episode_id)).toEqual(["to_be_at_reception", "morning_side"]);
    expect(open(v)).toEqual(["reception", "cafe"]);
    expect(v.next?.episode_id).toBe("articles_in_cafe");
  });

  it("follows the clock unless the student chose a time on the map", () => {
    const at = (h: number) => new Date(2026, 10, 12, h, 30);
    expect(hotelTime(emptyState(), at(6))).toBe("night");
    expect(hotelTime(emptyState(), at(7))).toBe("day");
    expect(hotelTime(emptyState(), at(18))).toBe("day");
    expect(hotelTime(emptyState(), at(19))).toBe("night");
    expect(hotelTime({ ...emptyState(), time: "night" }, at(12))).toBe("night");
  });

  it("keeps the chosen time and the places seen open, and drops anything else there", () => {
    const s = migrateState({ ...emptyState(), time: "day", seen_places: ["reception", 7] });
    expect(s.time).toBe("day");
    expect(s.seen_places).toEqual(["reception"]);
    expect(migrateState({ ...emptyState(), time: "noon" }).time).toBeUndefined();
  });
});

describe("MoonbridgeState", () => {
  it("survives unknown shapes and does not duplicate episodes", () => {
    expect(migrateState(undefined)).toEqual(emptyState());
    expect(migrateState({ version: 9 })).toEqual(emptyState());
    const s = completeEpisode(completeEpisode(emptyState(), "a"), "a");
    expect(migrateState(JSON.parse(JSON.stringify(s)))).toEqual({ version: 1, completed_episodes: ["a"], practice_days: [], shift_days: [], welcomed: true });
    expect(migrateState({ version: 1, completed_episodes: [] }).practice_days).toEqual([]);
  });
});
