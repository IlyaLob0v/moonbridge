import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, type Sql } from "../src/db/sql.js";
import { DiskFileStore } from "../src/school/files.js";
import { slotTimes } from "../src/school/lesson-store.js";
import type { LessonBilling } from "../src/school/lessons.js";
import { SchoolStore } from "../src/school/store.js";
import { harness } from "./harness.js";

let pglite: PGlite;
let sql: Sql;
let uploads: string;
// Monday 30 November 2026, 12:00 in Moscow.
let clock = new Date("2026-11-30T09:00:00Z");
let ledger: string[] = [];

const billing: LessonBilling = {
  charge: async (accountId, lessonId) => void ledger.push(`charge ${accountId} ${lessonId}`),
  uncharge: async (accountId, lessonId) => void ledger.push(`uncharge ${accountId} ${lessonId}`),
};

beforeAll(async () => {
  pglite = new PGlite();
  sql = { query: (text, params) => pglite.query(text, params), exec: (text) => pglite.exec(text) } as Sql;
  await migrate(sql);
  uploads = await mkdtemp(join(tmpdir(), "moonbridge-lessons-"));
});

afterAll(async () => {
  await pglite.close();
  await rm(uploads, { recursive: true, force: true });
});

beforeEach(async () => {
  clock = new Date("2026-11-30T09:00:00Z");
  ledger = [];
  await sql.exec("TRUNCATE accounts, school_groups, group_members, invites, lessons, lesson_plans, lesson_attendance CASCADE");
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const TUE_THU = [
  { weekday: 2, time: "18:30", minutes: 60 },
  { weekday: 4, time: "18:30", minutes: 60 },
];

async function teacherToken(app: FastifyInstance, login = "ksenia"): Promise<string> {
  await app.inject({ method: "POST", url: "/admin/teachers", headers: auth("admin-secret"), payload: { name: login === "ksenia" ? "Ксения" : "Другой", login, password: "teach-123" } });
  return (await app.inject({ method: "POST", url: "/auth/login", payload: { login, password: "teach-123" } })).json().token;
}

/** Ksenia's group "A1 вечер" on Tuesdays and Thursdays at 18:30 with Anna and Boris. */
async function setup() {
  const app = (await harness({ school: { store: new SchoolStore(sql), files: new DiskFileStore(uploads), now: () => clock, billing } })).app;
  const t = await teacherToken(app);
  const g = await app.inject({ method: "POST", url: "/school/groups", headers: auth(t), payload: { name: "A1 вечер", call_url: "https://telemost.yandex.ru/j/123", schedule: TUE_THU } });
  const groupId = g.json().group.group_id as string;
  const code = (await app.inject({ method: "POST", url: `/school/groups/${groupId}/invites`, headers: auth(t) })).json().code as string;
  const join = async (name: string, login: string) => (await app.inject({ method: "POST", url: `/invites/${code}/join`, payload: { name, login, password: "secret-1" } })).json();
  const anna = await join("Анна", "anna");
  const boris = await join("Борис", "boris");
  return { app, t, groupId, anna: { id: anna.account.id as string, token: anna.token as string }, boris: { id: boris.account.id as string, token: boris.token as string } };
}

const groupLessons = async (app: FastifyInstance, t: string, groupId: string) => (await app.inject({ url: `/school/groups/${groupId}/lessons`, headers: auth(t) })).json().lessons as any[];

describe("lessons from the weekly schedule", () => {
  it("finds every slot in Moscow time across weeks", () => {
    const slots = slotTimes(TUE_THU, new Date("2026-11-30T09:00:00Z"), new Date("2026-12-08T00:00:00Z"));
    expect(slots.map((s) => s.at.toISOString())).toEqual(["2026-12-01T15:30:00.000Z", "2026-12-03T15:30:00.000Z"]);
    // Sunday late evening and Monday early morning in Moscow belong to different weeks.
    const edge = slotTimes([{ weekday: 7, time: "23:30", minutes: 30 }, { weekday: 1, time: "00:30", minutes: 30 }], new Date("2026-12-06T00:00:00Z"), new Date("2026-12-08T00:00:00Z"));
    expect(edge.map((s) => s.at.toISOString())).toEqual(["2026-12-06T20:30:00.000Z", "2026-12-06T21:30:00.000Z"]);
  });

  it("generates four weeks of lessons with the group's call link, the same ones every time", async () => {
    const { app, t, groupId, anna } = await setup();
    const lessons = await groupLessons(app, t, groupId);
    expect(lessons.map((l) => l.starts_at.slice(0, 10))).toEqual(["2026-12-01", "2026-12-03", "2026-12-08", "2026-12-10", "2026-12-15", "2026-12-17", "2026-12-22", "2026-12-24"]);
    expect(lessons[0]).toMatchObject({ status: "planned", minutes: 60, ends_at: "2026-12-01T16:30:00.000Z", call_url: "https://telemost.yandex.ru/j/123", group_name: "A1 вечер" });
    expect(lessons[0].attendance.map((a: any) => [a.name, a.status])).toEqual([["Анна", null], ["Борис", null]]);
    expect((await groupLessons(app, t, groupId)).map((l) => l.lesson_id)).toEqual(lessons.map((l) => l.lesson_id));

    // Two weeks on, the horizon has moved with the clock.
    clock = new Date("2026-12-14T09:00:00Z");
    const later = await groupLessons(app, t, groupId);
    expect(later.at(-1).starts_at.slice(0, 10)).toBe("2027-01-07");

    const dash = (await app.inject({ url: "/school/dashboard", headers: auth(anna.token) })).json();
    expect(dash.lessons[0]).toMatchObject({ status: "planned", attendance: null });
  });

  it("replaces the coming lessons when the schedule changes, but keeps the ones the teacher prepared", async () => {
    const { app, t, groupId } = await setup();
    const before = await groupLessons(app, t, groupId);
    const prepared = before.find((l) => l.starts_at.startsWith("2026-12-08"))!;
    await app.inject({ method: "PATCH", url: `/school/lessons/${prepared.lesson_id}`, headers: auth(t), payload: { topic: "Past Simple" } });
    await app.inject({ method: "PATCH", url: `/school/groups/${groupId}`, headers: auth(t), payload: { schedule: [{ weekday: 3, time: "19:00", minutes: 90 }] } });
    const after = await groupLessons(app, t, groupId);
    expect(after.map((l) => `${l.starts_at.slice(0, 10)} ${l.minutes}`)).toEqual(["2026-12-02 90", "2026-12-08 60", "2026-12-09 90", "2026-12-16 90", "2026-12-23 90"]);
    expect(after.find((l) => l.lesson_id === prepared.lesson_id)?.topic).toBe("Past Simple");
  });
});

describe("the teacher's lessons", () => {
  it("adds materials and the recording, moves or cancels a lesson; the student sees it", async () => {
    const { app, t, groupId, anna } = await setup();
    const [first, second] = await groupLessons(app, t, groupId);
    const edit = await app.inject({
      method: "PATCH",
      url: `/school/lessons/${first.lesson_id}`,
      headers: auth(t),
      payload: { topic: "To be", materials: [{ title: "Рабочий лист", url: "https://disk.yandex.ru/d/abc" }], recording_url: "https://disk.yandex.ru/i/rec", call_url: "https://zoom.us/j/9" },
    });
    expect(edit.statusCode).toBe(200);
    await app.inject({ method: "PATCH", url: `/school/lessons/${second.lesson_id}`, headers: auth(t), payload: { status: "cancelled", note: "Преподаватель заболел" } });
    const bad = await app.inject({ method: "PATCH", url: `/school/lessons/${first.lesson_id}`, headers: auth(t), payload: { materials: [{ title: "x", url: "javascript:alert(1)" }] } });
    expect(bad.statusCode).toBe(400);

    const mine = (await app.inject({ url: "/school/lessons", headers: auth(anna.token) })).json().lessons;
    expect(mine[0]).toMatchObject({ topic: "To be", materials: [{ title: "Рабочий лист", url: "https://disk.yandex.ru/d/abc" }], recording_url: "https://disk.yandex.ru/i/rec", call_url: "https://zoom.us/j/9" });
    expect(mine[1]).toMatchObject({ status: "cancelled", note: "Преподаватель заболел" });
    expect(mine[0].attendance).toBeNull();

    const extra = await app.inject({ method: "POST", url: `/school/groups/${groupId}/lessons`, headers: auth(t), payload: { starts_at: "2026-12-05T08:00:00.000Z", minutes: 45, topic: "Отработка" } });
    expect(extra.statusCode).toBe(201);
    expect((await groupLessons(app, t, groupId)).map((l) => l.topic)).toContain("Отработка");
  });

  it("keeps lessons to their own teacher", async () => {
    const { app, groupId, anna } = await setup();
    const other = await teacherToken(app, "other");
    expect((await app.inject({ url: `/school/groups/${groupId}/lessons`, headers: auth(other) })).statusCode).toBe(404);
    const [first] = (await app.inject({ url: "/school/lessons", headers: auth(anna.token) })).json().lessons;
    expect((await app.inject({ method: "PATCH", url: `/school/lessons/${first.lesson_id}`, headers: auth(other), payload: { topic: "x" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/school/lessons/${first.lesson_id}`, headers: auth(anna.token), payload: { topic: "x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: `/school/lessons/${first.lesson_id}/attendance`, headers: auth(other), payload: { marks: [] } })).statusCode).toBe(404);
  });
});

describe("attendance", () => {
  it("marks who came, charges those present, and shows it to the student and in the reports", async () => {
    const { app, t, groupId, anna, boris } = await setup();
    const [first] = await groupLessons(app, t, groupId);
    const mark = (marks: { account_id: string; status: string }[]) => app.inject({ method: "PUT", url: `/school/lessons/${first.lesson_id}/attendance`, headers: auth(t), payload: { marks } });

    expect((await mark([{ account_id: anna.id, status: "present" }])).statusCode).toBe(409);
    clock = new Date("2026-12-01T16:40:00Z"); // Tuesday, ten minutes after the lesson
    const teacherDash = (await app.inject({ url: "/school/dashboard", headers: auth(t) })).json();
    expect(teacherDash.lessons.filter((l: any) => l.status === "planned" && Date.parse(l.ends_at) <= clock.getTime()).map((l: any) => l.lesson_id)).toEqual([first.lesson_id]);

    expect((await mark([{ account_id: "acc_stranger", status: "present" }])).statusCode).toBe(400);
    const held = await mark([{ account_id: anna.id, status: "present" }, { account_id: boris.id, status: "absent" }]);
    expect(held.statusCode).toBe(200);
    expect(held.json().lesson.status).toBe("held");
    expect(held.json().lesson.attendance.map((a: any) => [a.name, a.status])).toEqual([["Анна", "present"], ["Борис", "absent"]]);
    expect(ledger).toEqual([`charge ${anna.id} ${first.lesson_id}`, `uncharge ${boris.id} ${first.lesson_id}`]);

    const annaLessons = (await app.inject({ url: "/school/lessons", headers: auth(anna.token) })).json().lessons;
    expect(annaLessons[0]).toMatchObject({ status: "held", attendance: "present" });
    const borisReport = (await app.inject({ url: `/school/students/${boris.id}/report`, headers: auth(t) })).json();
    expect(borisReport.lessons).toMatchObject({ held: 1, present: 0, absent: 1 });
    expect(borisReport.lessons.lessons.map((l: any) => l.attendance)).toEqual(["absent"]);
    const progress = (await app.inject({ url: `/school/groups/${groupId}/progress`, headers: auth(t) })).json();
    expect(progress.students.map((s: any) => [s.name, s.lessons])).toEqual([
      ["Анна", { held: 1, present: 1, absent: 0 }],
      ["Борис", { held: 1, present: 0, absent: 1 }],
    ]);

    // Boris came after all; then the lesson turns out not to have happened.
    ledger = [];
    await mark([{ account_id: boris.id, status: "present" }]);
    expect(ledger).toEqual([`charge ${boris.id} ${first.lesson_id}`]);
    ledger = [];
    const cancelled = await app.inject({ method: "PATCH", url: `/school/lessons/${first.lesson_id}`, headers: auth(t), payload: { status: "cancelled" } });
    expect(cancelled.json().lesson.attendance.every((a: any) => a.status === null)).toBe(true);
    expect(ledger.sort()).toEqual([`uncharge ${anna.id} ${first.lesson_id}`, `uncharge ${boris.id} ${first.lesson_id}`].sort());
    expect((await app.inject({ url: `/school/students/${anna.id}/report`, headers: auth(anna.token) })).json().lessons).toMatchObject({ held: 0, present: 0 });
  });
});
