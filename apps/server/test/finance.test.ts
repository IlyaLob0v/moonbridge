import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, type Sql } from "../src/db/sql.js";
import { DiskFileStore } from "../src/school/files.js";
import { SchoolStore } from "../src/school/store.js";
import { harness } from "./harness.js";

let pglite: PGlite;
let sql: Sql;
let store: SchoolStore;
let uploads: string;
let clock = new Date("2026-11-30T09:00:00Z");

beforeAll(async () => {
  pglite = new PGlite();
  sql = { query: (text, params) => pglite.query(text, params), exec: (text) => pglite.exec(text) } as Sql;
  await migrate(sql);
  store = new SchoolStore(sql);
  uploads = await mkdtemp(join(tmpdir(), "moonbridge-uploads-"));
});

afterAll(async () => {
  await pglite.close();
  await rm(uploads, { recursive: true, force: true });
});

beforeEach(async () => {
  clock = new Date("2026-11-30T09:00:00Z");
  await sql.exec("TRUNCATE accounts, school_groups, group_members, invites, payments, balance_entries, lesson_prices, lessons CASCADE");
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function app(): Promise<FastifyInstance> {
  return (await harness({ school: { store, files: new DiskFileStore(uploads), now: () => clock } })).app;
}

async function teacher(app: FastifyInstance, login = "ksenia"): Promise<string> {
  expect((await app.inject({ method: "POST", url: "/admin/teachers", headers: auth("admin-secret"), payload: { name: login, login, password: "teach-123" } })).statusCode).toBe(201);
  return (await app.inject({ method: "POST", url: "/auth/login", payload: { login, password: "teach-123" } })).json().token;
}

/** A group of the teacher with one student; returns the student's id and token. */
async function student(app: FastifyInstance, t: string, login = "anna", group = "A1 вечер") {
  const g = (await app.inject({ method: "POST", url: "/school/groups", headers: auth(t), payload: { name: group } })).json().group.group_id as string;
  const code = (await app.inject({ method: "POST", url: `/school/groups/${g}/invites`, headers: auth(t) })).json().code as string;
  const joined = (await app.inject({ method: "POST", url: `/invites/${code}/join`, payload: { name: login, login, password: "secret-1" } })).json();
  return { id: joined.account.id as string, token: joined.token as string, groupId: g };
}

const pay = (app: FastifyInstance, t: string, studentId: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/school/students/${studentId}/payments`, headers: auth(t), payload: body });
const price = (app: FastifyInstance, t: string, studentId: string, rub: number) =>
  app.inject({ method: "PUT", url: `/school/students/${studentId}/price`, headers: auth(t), payload: { price_rub: rub } });
const correct = (app: FastifyInstance, t: string, studentId: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/school/students/${studentId}/corrections`, headers: auth(t), payload: body });
const balanceOf = async (app: FastifyInstance, token: string, studentId: string) => (await app.inject({ url: `/school/students/${studentId}/balance`, headers: auth(token) })).json();

describe("the student's account", () => {
  it("counts held lessons at the price, once each, and sums up paid, held and left", async () => {
    const a = await app();
    const t = await teacher(a);
    const s = await student(a, t);
    expect((await price(a, t, s.id, 1500)).json()).toMatchObject({ price_rub: 1500, balance_rub: 0, lessons_left: 0 });

    const paid = await pay(a, t, s.id, { amount_rub: 12000, method: "transfer", paid_on: "2026-11-28", note: "абонемент на декабрь" });
    expect(paid.statusCode).toBe(201);
    expect(paid.json()).toMatchObject({ balance_rub: 12000, lessons_left: 8, payment: { amount_rub: 12000, method: "transfer", paid_on: "2026-11-28", status: "succeeded", voided: false } });

    // The lessons' attendance calls these; saving the same mark twice charges once.
    await store.finance.chargeLesson(s.id, "les_000000000001", new Date("2026-12-01T15:30:00Z"), null);
    await store.finance.chargeLesson(s.id, "les_000000000001", new Date("2026-12-01T15:30:00Z"), null);
    await store.finance.chargeLesson(s.id, "les_000000000002", new Date("2026-12-03T15:30:00Z"), null);
    await store.finance.chargeLesson(s.id, "les_000000000003", new Date("2026-12-05T15:30:00Z"), null);
    await store.finance.unchargeLesson(s.id, "les_000000000003");

    const mine = await a.inject({ url: `/school/students/${s.id}/balance`, headers: auth(s.token) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({ price_rub: 1500, paid_rub: 12000, lessons_held: 2, held_rub: 3000, balance_rub: 9000, lessons_left: 6, unpriced: 0, last_paid_on: "2026-11-28" });
    expect(mine.json().entries.map((e: { kind: string; amount_rub: number }) => [e.kind, e.amount_rub])).toEqual([
      ["lesson", -1500],
      ["lesson", -1500],
      ["payment", 12000],
    ]);
    expect(mine.json().entries[2]).toMatchObject({ note: "абонемент на декабрь", by: "ksenia", payment: { method: "transfer", voided: false } });
  });

  it("keeps the price a lesson was held at, and prices lessons held before there was a price", async () => {
    const a = await app();
    const t = await teacher(a);
    const s = await student(a, t);
    await store.finance.chargeLesson(s.id, "les_000000000001", new Date("2026-11-24T15:30:00Z"), null);
    expect(await balanceOf(a, t, s.id)).toMatchObject({ price_rub: null, lessons_held: 1, held_rub: 0, unpriced: 1, lessons_left: null });
    await price(a, t, s.id, 1500);
    await store.finance.chargeLesson(s.id, "les_000000000002", new Date("2026-11-26T15:30:00Z"), null);
    await price(a, t, s.id, 1600);
    await store.finance.chargeLesson(s.id, "les_000000000003", new Date("2026-11-28T15:30:00Z"), null);
    // Nothing paid: a debt of 4 600 ₽, i.e. 2 lessons and a part of one at the new price.
    expect(await balanceOf(a, t, s.id)).toMatchObject({ price_rub: 1600, lessons_held: 3, held_rub: 4600, unpriced: 0, balance_rub: -4600, lessons_left: -2 });
  });

  it("voids a payment entered by mistake once, keeping both lines", async () => {
    const a = await app();
    const t = await teacher(a);
    const s = await student(a, t);
    const p = (await pay(a, t, s.id, { amount_rub: 6000.5, method: "cash" })).json().payment;
    expect(p.paid_on).toBe("2026-11-30");
    const voided = await a.inject({ method: "POST", url: `/school/payments/${p.payment_id}/void`, headers: auth(t), payload: { reason: "ошиблась учеником" } });
    expect(voided.json()).toMatchObject({ balance_rub: 0, paid_rub: 0, payment: { voided: true } });
    expect((await a.inject({ method: "POST", url: `/school/payments/${p.payment_id}/void`, headers: auth(t), payload: {} })).statusCode).toBe(409);
    const entries = (await balanceOf(a, t, s.id)).entries;
    expect(entries.map((e: { kind: string; amount_rub: number }) => [e.kind, e.amount_rub])).toEqual([
      ["void", -6000.5],
      ["payment", 6000.5],
    ]);
    expect(entries[0].note).toBe("ошиблась учеником");
  });

  it("takes corrections in roubles or in lessons at the price, always with a reason", async () => {
    const a = await app();
    const t = await teacher(a);
    const s = await student(a, t);
    expect((await correct(a, t, s.id, { lessons: 1, note: "пробный" })).statusCode).toBe(409);
    await price(a, t, s.id, 1500);
    expect((await correct(a, t, s.id, { lessons: 0, note: "x" })).statusCode).toBe(400);
    expect((await correct(a, t, s.id, { lessons: 1, note: "  " })).statusCode).toBe(400);
    expect((await correct(a, t, s.id, { lessons: 1, amount_rub: 10, note: "x" })).statusCode).toBe(400);
    expect((await correct(a, t, s.id, { lessons: 1, note: "пробный урок бесплатно" })).json()).toMatchObject({ balance_rub: 1500, lessons_left: 1 });
    expect((await correct(a, t, s.id, { amount_rub: 500, note: "остаток с сентября" })).json()).toMatchObject({ balance_rub: 2000, lessons_left: 1 });
  });

  it("refuses odd amounts and prices, and dates in the future", async () => {
    const a = await app();
    const t = await teacher(a);
    const s = await student(a, t);
    expect((await pay(a, t, s.id, { amount_rub: 10.005, method: "cash" })).statusCode).toBe(400);
    expect((await pay(a, t, s.id, { amount_rub: 0, method: "cash" })).statusCode).toBe(400);
    expect((await pay(a, t, s.id, { amount_rub: 10, method: "cash", paid_on: "2026-12-01" })).statusCode).toBe(400);
    expect((await pay(a, t, s.id, { amount_rub: 10, method: "online" })).statusCode).toBe(400);
    expect((await price(a, t, s.id, 0)).statusCode).toBe(400);
    expect((await price(a, t, s.id, 1500.001)).statusCode).toBe(400);
  });
});

describe("held lessons", () => {
  it("are charged at the student's price when the teacher marks them present, and given back when the mark changes", async () => {
    const a = await app();
    const t = await teacher(a);
    const s = await student(a, t);
    await a.inject({ method: "PATCH", url: `/school/groups/${s.groupId}`, headers: auth(t), payload: { schedule: [{ weekday: 2, time: "18:30", minutes: 60 }] } });
    await price(a, t, s.id, 1500);
    await pay(a, t, s.id, { amount_rub: 6000, method: "transfer" });
    const [lesson] = (await a.inject({ url: `/school/groups/${s.groupId}/lessons`, headers: auth(t) })).json().lessons;
    clock = new Date("2026-12-01T16:40:00Z"); // Tuesday, after the lesson
    const mark = (status: string) => a.inject({ method: "PUT", url: `/school/lessons/${lesson.lesson_id}/attendance`, headers: auth(t), payload: { marks: [{ account_id: s.id, status }] } });
    expect((await mark("present")).statusCode).toBe(200);
    await mark("present");
    expect(await balanceOf(a, s.token, s.id)).toMatchObject({ lessons_held: 1, held_rub: 1500, balance_rub: 4500, lessons_left: 3 });
    await mark("absent");
    expect(await balanceOf(a, s.token, s.id)).toMatchObject({ lessons_held: 0, balance_rub: 6000, lessons_left: 4 });
  });
});

describe("who sees and changes the money", () => {
  it("keeps each teacher to their own students and each student to their own account", async () => {
    const a = await app();
    const ksenia = await teacher(a);
    const other = await teacher(a, "other");
    const anna = await student(a, ksenia);
    const boris = await student(a, other, "boris", "B1");
    const p = (await pay(a, ksenia, anna.id, { amount_rub: 6000, method: "card" })).json().payment;

    expect((await pay(a, other, anna.id, { amount_rub: 1, method: "cash" })).statusCode).toBe(404);
    expect((await price(a, other, anna.id, 1)).statusCode).toBe(404);
    expect((await a.inject({ url: `/school/students/${anna.id}/balance`, headers: auth(other) })).statusCode).toBe(404);
    expect((await a.inject({ method: "POST", url: `/school/payments/${p.payment_id}/void`, headers: auth(other), payload: {} })).statusCode).toBe(404);
    expect((await a.inject({ url: `/school/students/${anna.id}/balance`, headers: auth(boris.token) })).statusCode).toBe(404);
    // A student cannot record a payment or set a price, not even for themself.
    expect((await pay(a, anna.token, anna.id, { amount_rub: 1, method: "cash" })).statusCode).toBe(403);
    expect((await price(a, anna.token, anna.id, 1)).statusCode).toBe(403);
    expect((await a.inject({ url: "/school/finance", headers: auth(anna.token) })).statusCode).toBe(403);
    expect((await a.inject({ url: "/admin/finance" })).statusCode).toBe(401);
  });

  it("shows the teacher every student once, the month's money and the total debt", async () => {
    const a = await app();
    const t = await teacher(a);
    const anna = await student(a, t);
    const boris = await student(a, t, "boris", "B1");
    // Anna is in both groups.
    const code = (await a.inject({ method: "POST", url: `/school/groups/${boris.groupId}/invites`, headers: auth(t) })).json().code;
    await a.inject({ method: "POST", url: `/invites/${code}/join`, headers: auth(anna.token) });
    await price(a, t, anna.id, 1500);
    await price(a, t, boris.id, 2000);
    await pay(a, t, anna.id, { amount_rub: 12000, method: "transfer" });
    await pay(a, t, boris.id, { amount_rub: 2000, method: "cash", paid_on: "2026-10-31" });
    await store.finance.chargeLesson(anna.id, "les_a1", new Date("2026-11-24T15:30:00Z"), null);
    await store.finance.chargeLesson(boris.id, "les_b1", new Date("2026-10-30T15:30:00Z"), null);
    await store.finance.chargeLesson(boris.id, "les_b2", new Date("2026-11-25T15:30:00Z"), null);

    const f = (await a.inject({ url: "/school/finance", headers: auth(t) })).json();
    expect(f.month).toEqual({ from: "2026-11-01", received_rub: 12000, payments: 1, lessons_held: 2, held_rub: 3500 });
    expect(f.total).toEqual({ balance_rub: 8500, debt_rub: -2000 });
    expect(f.students).toEqual([
      { id: anna.id, name: "anna", groups: ["A1 вечер", "B1"], price_rub: 1500, balance_rub: 10500, lessons_left: 7, paid_rub: 12000, lessons_held: 1, held_rub: 1500, unpriced: 0, last_paid_on: "2026-11-30" },
      { id: boris.id, name: "boris", groups: ["B1"], price_rub: 2000, balance_rub: -2000, lessons_left: -1, paid_rub: 2000, lessons_held: 2, held_rub: 4000, unpriced: 0, last_paid_on: "2026-10-31" },
    ]);
  });

  it("lets the admin set a price, record a payment for any student and list everyone", async () => {
    const a = await app();
    const t = await teacher(a);
    const s = await student(a, t);
    expect((await a.inject({ method: "PUT", url: `/admin/students/${s.id}/price`, headers: auth("admin-secret"), payload: { price_rub: 1500 } })).statusCode).toBe(200);
    const res = await a.inject({ method: "POST", url: `/admin/students/${s.id}/payments`, headers: auth("admin-secret"), payload: { amount_rub: 3000, method: "cash" } });
    expect(res.statusCode).toBe(201);
    const all = (await a.inject({ url: "/admin/finance", headers: auth("admin-secret") })).json();
    expect(all.students).toEqual([{ id: s.id, name: "anna", login: "anna", price_rub: 1500, balance_rub: 3000, lessons_left: 2, paid_rub: 3000, lessons_held: 0, held_rub: 0, unpriced: 0, last_paid_on: "2026-11-30" }]);
    expect((await balanceOf(a, s.token, s.id)).entries[0].by).toBeNull();
  });
});
