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
  await sql.exec("TRUNCATE accounts, school_groups, group_members, invites, payments, balance_entries CASCADE");
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

describe("lesson balance", () => {
  it("adds paid lessons, takes one per held lesson once, and gives it back when the mark changes", async () => {
    const a = await app();
    const t = await teacher(a);
    const s = await student(a, t);

    const paid = await pay(a, t, s.id, { lessons: 8, amount_rub: 12000, method: "transfer", paid_on: "2026-11-28", note: "абонемент на декабрь" });
    expect(paid.statusCode).toBe(201);
    expect(paid.json()).toMatchObject({ balance: 8, payment: { lessons: 8, amount_rub: 12000, method: "transfer", paid_on: "2026-11-28", status: "succeeded", voided: false } });

    // The lessons' attendance calls these; saving the same mark twice charges once.
    await store.finance.chargeLesson(s.id, "les_000000000001", new Date("2026-12-01T15:30:00Z"), null);
    await store.finance.chargeLesson(s.id, "les_000000000001", new Date("2026-12-01T15:30:00Z"), null);
    await store.finance.chargeLesson(s.id, "les_000000000002", new Date("2026-12-03T15:30:00Z"), null);
    expect(await store.finance.balance(s.id)).toBe(6);
    await store.finance.unchargeLesson(s.id, "les_000000000002");
    expect(await store.finance.balance(s.id)).toBe(7);

    const mine = await a.inject({ url: `/school/students/${s.id}/balance`, headers: auth(s.token) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({ balance: 7, lessons_held: 1, last_paid_on: "2026-11-28" });
    expect(mine.json().entries.map((e: { kind: string; delta: number }) => [e.kind, e.delta])).toEqual([
      ["lesson", -1],
      ["payment", 8],
    ]);
    expect(mine.json().entries[1]).toMatchObject({ note: "абонемент на декабрь", by: "ksenia", payment: { amount_rub: 12000, method: "transfer", voided: false } });
  });

  it("lets the balance go below zero: a lesson held before the payment is a debt", async () => {
    const a = await app();
    const t = await teacher(a);
    const s = await student(a, t);
    await store.finance.chargeLesson(s.id, "les_000000000001", clock, null);
    expect((await a.inject({ url: `/school/students/${s.id}/balance`, headers: auth(t) })).json().balance).toBe(-1);
  });

  it("voids a payment entered by mistake once, keeping both lines", async () => {
    const a = await app();
    const t = await teacher(a);
    const s = await student(a, t);
    const p = (await pay(a, t, s.id, { lessons: 4, amount_rub: 6000.5, method: "cash" })).json().payment;
    expect(p.paid_on).toBe("2026-11-30");
    const voided = await a.inject({ method: "POST", url: `/school/payments/${p.payment_id}/void`, headers: auth(t), payload: { reason: "ошиблась учеником" } });
    expect(voided.json()).toMatchObject({ balance: 0, payment: { voided: true } });
    expect((await a.inject({ method: "POST", url: `/school/payments/${p.payment_id}/void`, headers: auth(t), payload: {} })).statusCode).toBe(409);
    const entries = (await a.inject({ url: `/school/students/${s.id}/balance`, headers: auth(t) })).json().entries;
    expect(entries.map((e: { kind: string; delta: number }) => [e.kind, e.delta])).toEqual([
      ["void", -4],
      ["payment", 4],
    ]);
    expect(entries[0].note).toBe("ошиблась учеником");
  });

  it("takes corrections with a reason only", async () => {
    const a = await app();
    const t = await teacher(a);
    const s = await student(a, t);
    expect((await a.inject({ method: "POST", url: `/school/students/${s.id}/corrections`, headers: auth(t), payload: { delta: 0, note: "x" } })).statusCode).toBe(400);
    expect((await a.inject({ method: "POST", url: `/school/students/${s.id}/corrections`, headers: auth(t), payload: { delta: 1, note: "  " } })).statusCode).toBe(400);
    const ok = await a.inject({ method: "POST", url: `/school/students/${s.id}/corrections`, headers: auth(t), payload: { delta: 1, note: "пробный урок бесплатно" } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().balance).toBe(1);
  });

  it("refuses amounts with fractions of a kopeck and dates in the future", async () => {
    const a = await app();
    const t = await teacher(a);
    const s = await student(a, t);
    expect((await pay(a, t, s.id, { lessons: 1, amount_rub: 10.005, method: "cash" })).statusCode).toBe(400);
    expect((await pay(a, t, s.id, { lessons: 1, amount_rub: 10, method: "cash", paid_on: "2026-12-01" })).statusCode).toBe(400);
    expect((await pay(a, t, s.id, { lessons: 1, amount_rub: 10, method: "online" })).statusCode).toBe(400);
    expect((await pay(a, t, s.id, { lessons: 0, amount_rub: 10, method: "cash" })).statusCode).toBe(400);
  });
});

describe("who sees and changes the money", () => {
  it("keeps each teacher to their own students and each student to their own balance", async () => {
    const a = await app();
    const ksenia = await teacher(a);
    const other = await teacher(a, "other");
    const anna = await student(a, ksenia);
    const boris = await student(a, other, "boris", "B1");
    const p = (await pay(a, ksenia, anna.id, { lessons: 4, amount_rub: 6000, method: "card" })).json().payment;

    expect((await pay(a, other, anna.id, { lessons: 4, amount_rub: 1, method: "cash" })).statusCode).toBe(404);
    expect((await a.inject({ url: `/school/students/${anna.id}/balance`, headers: auth(other) })).statusCode).toBe(404);
    expect((await a.inject({ method: "POST", url: `/school/payments/${p.payment_id}/void`, headers: auth(other), payload: {} })).statusCode).toBe(404);
    expect((await a.inject({ url: `/school/students/${anna.id}/balance`, headers: auth(boris.token) })).statusCode).toBe(404);
    // A student cannot record a payment, not even for themself.
    expect((await pay(a, anna.token, anna.id, { lessons: 4, amount_rub: 1, method: "cash" })).statusCode).toBe(403);
    expect((await a.inject({ url: "/school/finance", headers: auth(anna.token) })).statusCode).toBe(403);
    expect((await a.inject({ url: "/admin/finance" })).statusCode).toBe(401);
  });

  it("shows the teacher every student once with the balance, and the money of the month", async () => {
    const a = await app();
    const t = await teacher(a);
    const anna = await student(a, t);
    const boris = await student(a, t, "boris", "B1");
    // Anna is in both groups.
    const code = (await a.inject({ method: "POST", url: `/school/groups/${boris.groupId}/invites`, headers: auth(t) })).json().code;
    await a.inject({ method: "POST", url: `/invites/${code}/join`, headers: auth(anna.token) });
    await pay(a, t, anna.id, { lessons: 8, amount_rub: 12000, method: "transfer" });
    await pay(a, t, boris.id, { lessons: 4, amount_rub: 6500, method: "cash", paid_on: "2026-10-31" });

    const f = (await a.inject({ url: "/school/finance", headers: auth(t) })).json();
    expect(f.month).toEqual({ from: "2026-11-01", amount_rub: 12000, lessons: 8, payments: 1 });
    expect(f.students).toEqual([
      { id: anna.id, name: "anna", groups: ["A1 вечер", "B1"], balance: 8, lessons_held: 0, last_paid_on: "2026-11-30" },
      { id: boris.id, name: "boris", groups: ["B1"], balance: 4, lessons_held: 0, last_paid_on: "2026-10-31" },
    ]);
  });

  it("lets the admin list every balance and record a payment for any student", async () => {
    const a = await app();
    const t = await teacher(a);
    const s = await student(a, t);
    const res = await a.inject({ method: "POST", url: `/admin/students/${s.id}/payments`, headers: auth("admin-secret"), payload: { lessons: 2, amount_rub: 3000, method: "cash" } });
    expect(res.statusCode).toBe(201);
    const all = (await a.inject({ url: "/admin/finance", headers: auth("admin-secret") })).json();
    expect(all.students).toEqual([{ id: s.id, name: "anna", login: "anna", balance: 2, lessons_held: 0, last_paid_on: "2026-11-30" }]);
    const entry = (await a.inject({ url: `/school/students/${s.id}/balance`, headers: auth(s.token) })).json().entries[0];
    expect(entry.by).toBeNull();
  });
});
