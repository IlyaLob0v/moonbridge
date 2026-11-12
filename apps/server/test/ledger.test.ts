// The money, under pressure: long random runs of everything the admin and the teacher can do to a
// student's balance, checked step by step against a model written in a few lines, and the same
// action sent twice at once (a double tap on a phone, two tabs).
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
let uploads: string;
const clock = new Date("2026-11-30T09:00:00Z");

beforeAll(async () => {
  pglite = new PGlite();
  sql = { query: (text, params) => pglite.query(text, params), exec: (text) => pglite.exec(text) } as Sql;
  await migrate(sql);
  uploads = await mkdtemp(join(tmpdir(), "moonbridge-ledger-"));
});

afterAll(async () => {
  await pglite.close();
  await rm(uploads, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.exec("TRUNCATE accounts, school_groups, group_members, invites, payments, balance_entries, lesson_prices, lessons, lesson_attendance CASCADE");
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** A teacher with one group, Анна in it, an admin, and `lessons` lessons that have already started. */
async function school(lessons: number) {
  const app = (await harness({ school: { store: new SchoolStore(sql), files: new DiskFileStore(uploads), now: () => clock } })).app;
  const ok = async (method: "POST" | "PUT", url: string, payload: object, token = "admin-secret") => {
    const res = await app.inject({ method, url, headers: auth(token), payload });
    expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
    return res.json();
  };
  await ok("POST", "/admin/admins", { name: "Илья", login: "ilya", password: "admin-123" });
  await ok("POST", "/admin/teachers", { name: "Ксения", login: "ksenia", password: "teach-123" });
  const admin = (await ok("POST", "/auth/login", { login: "ilya", password: "admin-123" })).token as string;
  const teacher = (await ok("POST", "/auth/login", { login: "ksenia", password: "teach-123" })).token as string;
  const groupId = (await ok("POST", "/school/groups", { name: "A1 вечер" }, teacher)).group.group_id as string;
  const code = (await ok("POST", `/school/groups/${groupId}/invites`, {}, teacher)).code as string;
  const studentId = (await ok("POST", `/invites/${code}/join`, { name: "Анна", login: "anna", password: "secret-1" })).account.id as string;
  const lessonIds: string[] = [];
  for (let i = 0; i < lessons; i++) {
    const startsAt = new Date(Date.UTC(2026, 10, 2 + i, 15, 30)).toISOString();
    lessonIds.push((await ok("POST", `/school/groups/${groupId}/lessons`, { starts_at: startsAt, minutes: 60 }, teacher)).lesson.lesson_id);
  }
  return { app, admin, teacher, studentId, lessonIds };
}

/** Small and reproducible: the same seed makes the same run, so a failure can be replayed. */
function random(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { int: (n: number) => Math.floor(next() * n), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]! };
}

/** What the balance must be, in kopecks, computed the plain way. */
interface Model {
  price: number | null;
  payments: { id: string; kop: number; voided: boolean }[];
  corrections: number;
  /** Lesson → the price it was charged at (null: held before there was a price). */
  charged: Map<string, number | null>;
}

const rub = (kop: number) => kop / 100;

async function expectMatches(app: FastifyInstance, admin: string, studentId: string, m: Model, step: string) {
  const b = (await app.inject({ url: `/school/students/${studentId}/balance`, headers: auth(admin) })).json();
  const paid = m.payments.filter((p) => !p.voided).reduce((n, p) => n + p.kop, 0);
  const held = [...m.charged.values()].reduce<number>((n, k) => n + (k ?? 0), 0);
  const balance = paid + m.corrections - held;
  expect(b, step).toMatchObject({
    price_rub: m.price === null ? null : rub(m.price),
    paid_rub: rub(paid),
    held_rub: rub(held),
    balance_rub: rub(balance),
    lessons_held: m.charged.size,
    unpriced: [...m.charged.values()].filter((k) => k === null).length,
    lessons_left: m.price ? Math.trunc(balance / m.price) || 0 : null,
  });
  // The history adds up to the balance, line by line, and keeps every payment and its void.
  const lines = b.entries as { amount_rub: number | null; kind: string }[];
  expect(Math.round(lines.reduce((n, e) => n + (e.amount_rub ?? 0) * 100, 0)), `${step}: the history adds up`).toBe(balance);
  expect(lines.filter((e) => e.kind === "payment"), step).toHaveLength(m.payments.length);
  expect(lines.filter((e) => e.kind === "void"), step).toHaveLength(m.payments.filter((p) => p.voided).length);
}

describe("the balance", () => {
  it.each([1, 2, 3])("matches the plain sum after every step of a random run (seed %i)", async (seed) => {
    const { app, admin, teacher, studentId, lessonIds } = await school(4);
    const r = random(seed);
    const m: Model = { price: null, payments: [], corrections: 0, charged: new Map() };
    const post = (url: string, payload: object, token = admin) => app.inject({ method: "POST", url, headers: auth(token), payload });

    for (let step = 0; step < 40; step++) {
      const op = r.pick(["price", "pay", "pay", "void", "correct", "present", "present", "absent"] as const);
      let what = `step ${step} (seed ${seed}): ${op}`;
      if (op === "price") {
        const kop = r.pick([90000, 150000, 175050]);
        expect((await app.inject({ method: "PUT", url: `/admin/students/${studentId}/price`, headers: auth(admin), payload: { price_rub: rub(kop) } })).statusCode).toBe(200);
        m.price = kop;
        for (const [l, k] of m.charged) if (k === null) m.charged.set(l, kop);
        what += ` ${rub(kop)}`;
      } else if (op === "pay") {
        const kop = 100 + r.int(500_000);
        const res = await post(`/admin/students/${studentId}/payments`, { amount_rub: rub(kop), method: r.pick(["cash", "transfer", "card"]) });
        expect(res.statusCode, what).toBe(201);
        m.payments.push({ id: res.json().payment.payment_id, kop, voided: false });
        what += ` ${rub(kop)}`;
      } else if (op === "void") {
        if (!m.payments.length) continue;
        const p = r.pick(m.payments);
        const res = await post(`/admin/payments/${p.id}/void`, { reason: "ошибка" });
        expect(res.statusCode, what).toBe(p.voided ? 409 : 200);
        p.voided = true;
      } else if (op === "correct") {
        const kop = (r.int(2) ? 1 : -1) * (1 + r.int(300_000));
        expect((await post(`/admin/students/${studentId}/corrections`, { amount_rub: rub(kop), note: "по договорённости" })).statusCode, what).toBe(201);
        m.corrections += kop;
        what += ` ${rub(kop)}`;
      } else {
        const lesson = r.pick(lessonIds);
        const res = await app.inject({ method: "PUT", url: `/school/lessons/${lesson}/attendance`, headers: auth(teacher), payload: { marks: [{ account_id: studentId, status: op }] } });
        expect(res.statusCode, what).toBe(200);
        if (op === "absent") m.charged.delete(lesson);
        else if (!m.charged.has(lesson)) m.charged.set(lesson, m.price);
      }
      await expectMatches(app, admin, studentId, m, what);
    }
  });
});

describe("the same action twice at once", () => {
  it("charges a lesson once when «был» is sent twice", async () => {
    const { app, admin, teacher, studentId, lessonIds } = await school(1);
    await app.inject({ method: "PUT", url: `/admin/students/${studentId}/price`, headers: auth(admin), payload: { price_rub: 1500 } });
    const mark = () => app.inject({ method: "PUT", url: `/school/lessons/${lessonIds[0]}/attendance`, headers: auth(teacher), payload: { marks: [{ account_id: studentId, status: "present" }] } });
    const res = await Promise.all([mark(), mark(), mark()]);
    expect(res.map((x) => x.statusCode)).toEqual([200, 200, 200]);
    const b = (await app.inject({ url: `/school/students/${studentId}/balance`, headers: auth(admin) })).json();
    expect(b).toMatchObject({ lessons_held: 1, held_rub: 1500, balance_rub: -1500 });
  });

  it("voids a payment once when the button is pressed twice", async () => {
    const { app, admin, studentId } = await school(0);
    const p = (await app.inject({ method: "POST", url: `/admin/students/${studentId}/payments`, headers: auth(admin), payload: { amount_rub: 3000, method: "cash" } })).json().payment;
    const voidIt = () => app.inject({ method: "POST", url: `/admin/payments/${p.payment_id}/void`, headers: auth(admin), payload: {} });
    const res = await Promise.all([voidIt(), voidIt()]);
    expect(res.map((x) => x.statusCode).sort()).toEqual([200, 409]);
    const b = (await app.inject({ url: `/school/students/${studentId}/balance`, headers: auth(admin) })).json();
    expect(b).toMatchObject({ paid_rub: 0, balance_rub: 0 });
    expect(b.entries.map((e: { kind: string }) => e.kind).sort()).toEqual(["payment", "void"]);
  });

  it("ends with the charge matching the mark when «был» and «не был» cross", async () => {
    const { app, admin, teacher, studentId, lessonIds } = await school(1);
    await app.inject({ method: "PUT", url: `/admin/students/${studentId}/price`, headers: auth(admin), payload: { price_rub: 1500 } });
    const mark = (status: string) => app.inject({ method: "PUT", url: `/school/lessons/${lessonIds[0]}/attendance`, headers: auth(teacher), payload: { marks: [{ account_id: studentId, status }] } });
    for (let i = 0; i < 20; i++) {
      const order = i % 2 ? (["present", "absent"] as const) : (["absent", "present"] as const);
      await Promise.all(order.map(mark));
      const { rows } = await sql.query<{ status: string }>("SELECT status FROM lesson_attendance WHERE lesson_id = $1 AND account_id = $2", [lessonIds[0], studentId]);
      const b = (await app.inject({ url: `/school/students/${studentId}/balance`, headers: auth(admin) })).json();
      expect(b.lessons_held, `round ${i}: marked ${rows[0]!.status}`).toBe(rows[0]!.status === "present" ? 1 : 0);
    }
  });
});
