import { describe, expect, it } from "vitest";
import type { LessonView } from "../src/net/api.js";
import { isoToMoscowInput, lessonDate, nextScheduled, parseMaterials, toMark } from "../src/platform/lessons.js";
import { moscowInputToIso } from "../src/platform/teacher.js";

const lesson = (id: string, starts_at: string, status: LessonView["status"] = "planned", minutes = 60): LessonView => ({
  lesson_id: id,
  group_id: "g",
  group_name: "A1 вечер",
  starts_at,
  ends_at: new Date(Date.parse(starts_at) + minutes * 60_000).toISOString(),
  minutes,
  status,
  topic: "",
  call_url: null,
  materials: [],
  recording_url: null,
  note: "",
});

describe("lessons", () => {
  const tue = lesson("tue", "2026-12-01T15:30:00.000Z");
  const thu = lesson("thu", "2026-12-03T15:30:00.000Z", "cancelled");
  const tue2 = lesson("tue2", "2026-12-08T15:30:00.000Z");

  it("finds the lesson going on or the next one, skipping cancelled lessons", () => {
    expect(nextScheduled([tue2, thu, tue], new Date("2026-12-01T16:00:00Z"))?.lesson_id).toBe("tue");
    expect(nextScheduled([tue2, thu, tue], new Date("2026-12-01T16:31:00Z"))?.lesson_id).toBe("tue2");
  });

  it("lists the ended lessons that still need attendance", () => {
    const now = new Date("2026-12-04T09:00:00Z");
    expect(toMark([tue, thu, tue2, lesson("held", "2026-11-26T15:30:00.000Z", "held")], now).map((l) => l.lesson_id)).toEqual(["tue"]);
  });

  it("reads materials typed one per line", () => {
    expect(parseMaterials("Рабочий лист https://disk.yandex.ru/d/1\nhttps://quizlet.com/x — слова\n\nбез ссылки\nhttps://a.ru/b")).toEqual([
      { title: "Рабочий лист", url: "https://disk.yandex.ru/d/1" },
      { title: "слова", url: "https://quizlet.com/x" },
      { title: "Материал 3", url: "https://a.ru/b" },
    ]);
  });

  it("shows and edits times in Moscow", () => {
    expect(isoToMoscowInput("2026-12-01T15:30:00.000Z")).toBe("2026-12-01T18:30");
    expect(moscowInputToIso(isoToMoscowInput("2026-12-01T15:30:00.000Z"))).toBe("2026-12-01T15:30:00.000Z");
    expect(lessonDate(tue)).toMatch(/1 декабря.*18:30/);
  });
});
