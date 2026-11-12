// Migrations on a database that already holds a school: students, homework, grades, lessons,
// money. The data is written at the schema of an older release, every later migration runs on
// top of it, and the current gateway must still show everyone their things.
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, type Sql } from "../src/db/sql.js";
import { DiskFileStore } from "../src/school/files.js";
import { hashPassword } from "../src/school/passwords.js";
import { SchoolStore } from "../src/school/store.js";
import { harness } from "./harness.js";

const DIR = new URL("../migrations/", import.meta.url);

/**
 * What every shipped migration contains. A migration that reached a database is never edited
 * (the database would not run it again); a schema change is a new file. A new file: add its line,
 * the failure message prints it.
 */
const SHIPPED: Record<string, string> = {
  "001_init.sql": "c84f7583f5607f63",
  "002_school.sql": "0d5672c026a2fd03",
  "003_review.sql": "2de513609a762f63",
  "004_content.sql": "a74e520e728bfd0c",
  "005_pilot.sql": "4d32a3b83bbd477b",
  "006_lessons.sql": "b16daa6182ba382f",
  "008_finance.sql": "9c38ae4906dd39e2",
  "009_unit_homework.sql": "9371f341e315d69f",
  "010_email.sql": "8d8e2d2ee2ed83fb",
};

const files = async () => (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();
const checksum = async (f: string) => createHash("sha256").update((await readFile(new URL(f, DIR), "utf8")).replaceAll("\r\n", "\n")).digest("hex").slice(0, 16);

describe("shipped migrations", () => {
  it("are never edited, and every new one is listed", async () => {
    const actual = Object.fromEntries(await Promise.all((await files()).map(async (f) => [f, await checksum(f)] as const)));
    for (const [f, sum] of Object.entries(SHIPPED)) expect(actual[f], `${f} was edited or removed after it shipped: make a new migration instead`).toBe(sum);
    const unlisted = Object.entries(actual).filter(([f]) => !(f in SHIPPED)).map(([f, sum]) => `"${f}": "${sum}",`);
    expect(unlisted, "new migrations: add these lines to SHIPPED").toEqual([]);
  });
});

/** The migrations up to and including `last`, alone in a folder, as an older release had them. */
async function upTo(last: string): Promise<URL> {
  const dir = await mkdtemp(join(tmpdir(), "moonbridge-migrations-"));
  for (const f of await files()) if (f <= last) await copyFile(new URL(f, DIR), join(dir, f));
  return new URL(`file://${dir}/`);
}

let pglite: PGlite;
let sql: Sql;
let uploads: string;
const temp: string[] = [];

beforeAll(async () => {
  pglite = new PGlite();
  sql = { query: (text, params) => pglite.query(text, params), exec: (text) => pglite.exec(text) } as Sql;
  uploads = await mkdtemp(join(tmpdir(), "moonbridge-uploads-"));
});

afterAll(async () => {
  await pglite.close();
  await Promise.all([uploads, ...temp].map((d) => rm(d, { recursive: true, force: true })));
});

describe("upgrading a database with a school in it", () => {
  it("keeps accounts, groups, homework, grades, lessons and money through every later migration", async () => {
    // The release with lessons, before finances: a teacher, a group with Анна, a graded voice memo, a held lesson.
    const old = await upTo("006_lessons.sql");
    temp.push(old.pathname);
    await migrate(sql, old);
    const q = (text: string, params: unknown[] = []) => sql.query(text, params);
    await q(`INSERT INTO accounts (account_id, role, name, login, password_hash, player_id) VALUES
      ('acc_t', 'teacher', 'Ксения', 'ksenia', $1, 'player_t'), ('acc_a', 'student', 'Анна', 'anna', $2, 'player_a')`, [await hashPassword("teach-123"), await hashPassword("secret-1")]);
    await q(`INSERT INTO school_groups (group_id, teacher_id, name, call_url, schedule, pilot_from) VALUES
      ('grp_1', 'acc_t', 'A1 вечер', 'https://telemost.yandex.ru/j/1', '[{"weekday":2,"time":"18:30","minutes":60}]', '2026-11-23')`);
    await q(`INSERT INTO group_members (group_id, account_id) VALUES ('grp_1', 'acc_t'), ('grp_1', 'acc_a')`);
    await q(`INSERT INTO homework (homework_id, group_id, title, due_at, needs_file) VALUES ('hw_1', 'grp_1', 'Расскажи о себе', '2026-11-26T15:00:00Z', true)`);
    await q(`INSERT INTO submissions (submission_id, homework_id, account_id, file_key, file_name, mime, size, grade, teacher_comment, reviewed_at)
      VALUES ('sub_1', 'hw_1', 'acc_a', 'hw_1/acc_a', 'Запись 1.m4a', 'audio/mp4', 1024, 5, 'Отлично!', '2026-11-25T10:00:00Z')`);
    await q(`INSERT INTO lessons (lesson_id, group_id, slot_at, starts_at, minutes, status, topic) VALUES
      ('les_1', 'grp_1', '2026-11-24T15:30:00Z', '2026-11-24T15:30:00Z', 60, 'held', 'Глагол to be')`);
    await q(`INSERT INTO lesson_attendance (lesson_id, account_id, status, marked_at, marked_by) VALUES ('les_1', 'acc_a', 'present', '2026-11-24T16:30:00Z', 'acc_t')`);
    await q(`INSERT INTO attempts (statement_id, player_id, answered_at, task_id, module_id, concept_id, success, attempt_no, duration_ms) VALUES
      ('6f0a1c2e-0000-4000-8000-000000000001', 'player_a', '2026-11-25T18:00:00Z', 'A1_VerbToBe_01_q1', 'A1_VerbToBe_01', 'to_be', true, 1, 4000)`);

    // The release with finances: Анна paid, the held lesson was charged at her price.
    const finance = await upTo("008_finance.sql");
    temp.push(finance.pathname);
    expect(await migrate(sql, finance)).toEqual(["008_finance.sql"]);
    await q(`INSERT INTO lesson_prices (account_id, price_kop) VALUES ('acc_a', 150000)`);
    await q(`INSERT INTO payments (payment_id, account_id, amount_kop, method, paid_on) VALUES ('pay_1', 'acc_a', 300000, 'transfer', '2026-11-20')`);
    await q(`INSERT INTO balance_entries (entry_id, account_id, amount_kop, kind, payment_id, lesson_id, at) VALUES
      ('ent_1', 'acc_a', 300000, 'payment', 'pay_1', NULL, '2026-11-20T09:00:00Z'),
      ('ent_2', 'acc_a', -150000, 'lesson', NULL, 'les_1', '2026-11-24T15:30:00Z')`);

    // Today's release.
    const applied = await migrate(sql);
    expect(applied).toEqual((await files()).filter((f) => f > "008_finance.sql"));

    const { app } = await harness({ school: { store: new SchoolStore(sql), files: new DiskFileStore(uploads), now: () => new Date("2026-11-30T09:00:00Z") } });
    const signIn = async (login: string, password: string) => {
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { login, password } });
      expect(res.statusCode, `${login} signs in with the password from before the upgrade`).toBe(200);
      return { authorization: `Bearer ${res.json().token}` };
    };

    const anna = await signIn("anna", "secret-1");
    const dash = (await app.inject({ url: "/school/dashboard", headers: anna })).json();
    expect(dash.account).toMatchObject({ name: "Анна", role: "student", email: null, email_verified: false, reminders: true });
    expect(dash.groups.map((g: { name: string }) => g.name)).toEqual(["A1 вечер"]);
    expect(dash.homework).toHaveLength(1);
    expect(dash.homework[0]).toMatchObject({ title: "Расскажи о себе", submission: { file_name: "Запись 1.m4a", review: { grade: 5, comment: "Отлично!" } } });
    const lessons = (await app.inject({ url: "/school/lessons?from=2026-11-01&to=2026-12-01", headers: anna })).json();
    expect(JSON.stringify(lessons)).toContain("Глагол to be");

    const ksenia = await signIn("ksenia", "teach-123");
    const balance = (await app.inject({ url: "/school/students/acc_a/balance", headers: ksenia })).json();
    expect(balance).toMatchObject({ price_rub: 1500, paid_rub: 3000, held_rub: 1500, balance_rub: 1500, lessons_held: 1, lessons_left: 1 });
    expect((await app.inject({ url: "/school/review-queue", headers: ksenia })).json().submissions).toEqual([]);
    const metrics = await app.inject({ url: "/school/groups/grp_1/metrics", headers: ksenia });
    expect(metrics.statusCode).toBe(200);
    // Two schema builds and password hashing: slower than one test's default 5 s on a shared CI runner.
  }, 30_000);

  it("does nothing the second time", async () => {
    expect(await migrate(sql)).toEqual([]);
  });
});
