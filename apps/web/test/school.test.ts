import { describe, expect, it } from "vitest";
import type { Dashboard, GroupView } from "../src/net/api.js";
import { nextLesson, openHomework, scheduleText, when } from "../src/platform/school.js";
import { addDays } from "../src/platform/report.js";
import { moscowInputToIso } from "../src/platform/teacher.js";

const group = (schedule: GroupView["schedule"], name = "A1 вечер"): GroupView => ({ group_id: name, name, teacher_name: "Ксения", call_url: null, schedule });
const TUE_THU = [
  { weekday: 2, time: "18:30", minutes: 60 },
  { weekday: 4, time: "18:30", minutes: 60 },
];

describe("the schedule", () => {
  // Monday 30 November 2026, 12:00 in Moscow.
  const monday = new Date("2026-11-30T09:00:00Z");

  it("finds the next lesson in Moscow time", () => {
    const l = nextLesson([group(TUE_THU)], monday)!;
    expect(l.start.toISOString()).toBe("2026-12-01T15:30:00.000Z");
    expect(when(l.start, monday)).toBe("завтра в 18:30");
  });

  it("counts a lesson that has started as the current one until it ends", () => {
    const during = new Date("2026-12-01T16:00:00Z");
    expect(nextLesson([group(TUE_THU)], during)!.start.toISOString()).toBe("2026-12-01T15:30:00.000Z");
    const after = new Date("2026-12-01T16:31:00Z");
    expect(nextLesson([group(TUE_THU)], after)!.start.toISOString()).toBe("2026-12-03T15:30:00.000Z");
  });

  it("wraps over the week and picks the earliest of several groups", () => {
    const sunday = new Date("2026-12-06T18:00:00Z"); // 21:00 Sunday in Moscow
    const l = nextLesson([group(TUE_THU), group([{ weekday: 1, time: "10:00", minutes: 45 }], "Утро")], sunday)!;
    expect(l.group.name).toBe("Утро");
    expect(when(l.start, sunday)).toBe("завтра в 10:00");
    expect(nextLesson([group([])], sunday)).toBeUndefined();
  });

  it("says a later day by weekday and date", () => {
    expect(when(new Date("2026-12-03T15:00:00Z"), monday)).toBe("чт, 3 декабря, 18:00");
    expect(when(new Date("2026-11-30T15:00:00Z"), monday)).toBe("сегодня в 18:00");
  });

  it("describes a group's week", () => {
    expect(scheduleText(TUE_THU)).toBe("вт и чт в 18:30");
    expect(scheduleText([{ weekday: 5, time: "17:00", minutes: 60 }, ...TUE_THU])).toBe("вт и чт в 18:30; пт в 17:00");
    expect(scheduleText([])).toBe("Расписание пока не задано");
  });

  it("reads the teacher's deadline as Moscow time", () => {
    expect(moscowInputToIso("2026-12-03T18:00")).toBe("2026-12-03T15:00:00.000Z");
    expect(moscowInputToIso("")).toBeNull();
  });
});

describe("homework", () => {
  it("lists the file homework not handed in and the units not played through", () => {
    const hw = (id: string, needs_file: boolean, submitted: boolean, unit = false) => ({
      homework_id: id,
      group_id: "g",
      title: id,
      description: "",
      due_at: null,
      needs_file,
      module_id: unit ? "A1_Unit_01" : null,
      account_id: null,
      assignee_name: null,
      auto_grade: false,
      created_at: "2026-11-30T09:00:00Z",
      submission: submitted
        ? { submission_id: "s", account_id: "a", student_name: "Анна", file_name: "x.m4a", mime: "audio/mp4", size: 1, score: null, submitted_at: "2026-11-30T10:00:00Z", review: null }
        : null,
    });
    const d: Dashboard = {
      account: { id: "a", name: "Анна", role: "student", login: "anna" },
      groups: [],
      homework: [hw("open", true, false), hw("done", true, true), hw("in-class", false, false), hw("unit", false, false, true), hw("unit-played", false, true, true)],
    };
    expect(openHomework(d).map((h) => h.homework_id)).toEqual(["open", "unit"]);
  });
});

describe("the weekly report", () => {
  it("steps through Moscow dates by day and by week", () => {
    expect(addDays("2026-11-30", 6)).toBe("2026-12-06");
    expect(addDays("2026-12-07", -7)).toBe("2026-11-30");
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
  });
});
