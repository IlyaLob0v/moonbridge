import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, type Sql } from "../src/db/sql.js";
import { MailLinks } from "../src/mail/links.js";
import { encodeFrom, MemoryMailer, PostboxMailer } from "../src/mail/mailer.js";
import { Reminders } from "../src/mail/reminders.js";
import { EmailStore, MAX_ATTEMPTS } from "../src/mail/store.js";
import { DiskFileStore } from "../src/school/files.js";
import { emailMetrics } from "../src/school/metrics.js";
import { SchoolStore } from "../src/school/store.js";
import { harness } from "./harness.js";

let pglite: PGlite;
let sql: Sql;
let uploads: string;
// Monday 30 November 2026, 12:00 in Moscow.
let clock = new Date("2026-11-30T09:00:00Z");
let mailer: MemoryMailer;

const links = new MailLinks({ publicUrl: "https://moonbridge.test/api", clientUrl: "https://app.moonbridge.test/", sessionSecret: "dev-only-session-secret-change-me-0123456789" });

beforeAll(async () => {
  pglite = new PGlite();
  sql = { query: (text, params) => pglite.query(text, params), exec: (text) => pglite.exec(text) } as Sql;
  await migrate(sql);
  uploads = await mkdtemp(join(tmpdir(), "moonbridge-uploads-"));
});

afterAll(async () => {
  await pglite.close();
  await rm(uploads, { recursive: true, force: true });
});

beforeEach(async () => {
  clock = new Date("2026-11-30T09:00:00Z");
  mailer = new MemoryMailer();
  await sql.exec("TRUNCATE accounts, school_groups, group_members, invites, homework, submissions, attempts, emails, password_resets, email_verifications CASCADE");
});

const store = () => new EmailStore(sql);
const reminders = () => new Reminders(store(), mailer, links, { eveningHour: 19 }, () => undefined);

async function school(verification = false) {
  const h = await harness({ school: { store: new SchoolStore(sql), files: new DiskFileStore(uploads), mail: { store: store(), mailer, links, delivers: true, verification }, now: () => clock } });
  return h.app;
}

const VERIFY_SUBJECT = "Подтвердите почту для школы английского";
/** Confirms every address as if its link had been opened, and drops the confirmation e-mails. */
async function confirmAll() {
  await sql.query("UPDATE accounts SET email_verified_at = now() WHERE email IS NOT NULL AND email_verified_at IS NULL");
  const rest = mailer.sent.filter((m) => m.subject !== VERIFY_SUBJECT);
  mailer.sent.splice(0, mailer.sent.length, ...rest);
}
const verifyLink = (to: string) => {
  const m = mailer.sent.filter((x) => x.subject === VERIFY_SUBJECT && x.to === to).at(-1);
  const url = new URL(/https:\/\/moonbridge\.test\/api\/email\/verify\?t=[\w-]+/.exec(m!.text)![0]);
  return `${url.pathname.replace(/^\/api/, "")}${url.search}`;
};

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function setup(app: FastifyInstance) {
  await app.inject({ method: "POST", url: "/admin/teachers", headers: auth("admin-secret"), payload: { name: "Ксения", login: "ksenia", password: "teach-123", email: "ksenia@school.test" } });
  await confirmAll();
  const t = (await app.inject({ method: "POST", url: "/auth/login", payload: { login: "ksenia", password: "teach-123" } })).json().token as string;
  const groupId = (await app.inject({ method: "POST", url: "/school/groups", headers: auth(t), payload: { name: "A1 вечер" } })).json().group.group_id as string;
  const code = (await app.inject({ method: "POST", url: `/school/groups/${groupId}/invites`, headers: auth(t) })).json().code as string;
  return { t, groupId, code };
}

/** Joins by the invitation; the address is confirmed unless `confirmed` is false. */
async function enrol(app: FastifyInstance, code: string, fields: Record<string, string>, confirmed = true) {
  const res = await app.inject({ method: "POST", url: `/invites/${code}/join`, payload: { name: "Анна", password: "secret-1", ...fields } });
  if (confirmed) await confirmAll();
  return res;
}

async function answer(playerId: string, at: Date) {
  await sql.query(
    `INSERT INTO attempts (statement_id, player_id, answered_at, task_id, module_id, concept_id, success, error_type, attempt_no, duration_ms, mode)
     VALUES (gen_random_uuid(), $1, $2, 't1', 'm1', 'c1', true, NULL, 1, 20000, 'moonbridge_episode')`,
    [playerId, at],
  );
}

async function playerOf(accountId: string): Promise<string> {
  return (await sql.query<{ player_id: string }>("SELECT player_id FROM accounts WHERE account_id = $1", [accountId])).rows[0]!.player_id;
}

describe("the address on the account", () => {
  it("is asked at the invitation, taken from a login that is an e-mail, and checked for typos", async () => {
    const app = await school();
    const { code } = await setup(app);
    const anna = await enrol(app, code, { login: "anna", email: " Anna@Mail.RU " });
    expect(anna.statusCode).toBe(201);
    expect(anna.json().account).toMatchObject({ login: "anna", email: "anna@mail.ru", reminders: true });

    const boris = await enrol(app, code, { login: "Boris@Yandex.ru" });
    expect(boris.json().account.email).toBe("boris@yandex.ru");

    const typo = await enrol(app, code, { login: "vera", email: "vera@mail" });
    expect(typo.statusCode).toBe(400);
    expect(typo.json().error).toBe("email");

    const gleb = await enrol(app, code, { login: "gleb" });
    expect(gleb.statusCode).toBe(400);
    expect(gleb.json().message).toContain("Укажите почту");
  });

  it("can be added, changed and removed later, and reminders switched off and on", async () => {
    const app = await school();
    const { code } = await setup(app);
    const s = (await enrol(app, code, { login: "gleb", email: "g@mail.ru" })).json().token as string;
    expect((await app.inject({ method: "PUT", url: "/account/email", headers: auth(s), payload: { email: "nope" } })).statusCode).toBe(400);
    const set = await app.inject({ method: "PUT", url: "/account/email", headers: auth(s), payload: { email: "Gleb@Mail.ru" } });
    expect(set.json().account).toMatchObject({ email: "gleb@mail.ru", reminders: true });
    const off = await app.inject({ method: "PUT", url: "/account/reminders", headers: auth(s), payload: { on: false } });
    expect(off.json().account.reminders).toBe(false);
    expect((await app.inject({ url: "/school/dashboard", headers: auth(s) })).json().account).toMatchObject({ email: "gleb@mail.ru", reminders: false });
    const cleared = await app.inject({ method: "PUT", url: "/account/email", headers: auth(s), payload: { email: null } });
    expect(cleared.json().account.email).toBeNull();
    expect((await app.inject({ method: "PUT", url: "/account/email", payload: { email: "x@y.ru" } })).statusCode).toBe(401);
  });
});

describe("confirming the address", () => {
  it("is asked of every new account, whatever its role, by a link in an e-mail", async () => {
    const app = await school(true);
    const bare = await app.inject({ method: "POST", url: "/admin/teachers", headers: auth("admin-secret"), payload: { name: "Ксения", login: "ksenia", password: "teach-123" } });
    expect(bare.statusCode).toBe(400);
    const teacher = await app.inject({ method: "POST", url: "/admin/teachers", headers: auth("admin-secret"), payload: { name: "Ксения", login: "ksenia", password: "teach-123", email: "ksenia@school.test" } });
    expect(teacher.json().account).toMatchObject({ email: "ksenia@school.test", email_verified: false });
    const admin = await app.inject({ method: "POST", url: "/admin/admins", headers: auth("admin-secret"), payload: { name: "Илья", login: "ilya@school.test", password: "admin-123" } });
    expect(admin.json().account).toMatchObject({ email: "ilya@school.test", email_verified: false });
    expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([
      ["ksenia@school.test", VERIFY_SUBJECT],
      ["ilya@school.test", VERIFY_SUBJECT],
    ]);
    expect(mailer.sent[0]!.text).toContain("Подтвердить почту: https://moonbridge.test/api/email/verify?t=");
    expect(mailer.sent[0]!.headers).toBeUndefined();

    // Until then only Today and the address itself work.
    const t = (await app.inject({ method: "POST", url: "/auth/login", payload: { login: "ksenia", password: "teach-123" } })).json().token as string;
    const blocked = await app.inject({ method: "POST", url: "/school/groups", headers: auth(t), payload: { name: "A1" } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe("email_unverified");
    expect((await app.inject({ url: "/school/dashboard", headers: auth(t) })).json().account.email_verified).toBe(false);

    const opened = await app.inject({ url: verifyLink("ksenia@school.test") });
    expect(opened.statusCode).toBe(302);
    expect(opened.headers.location).toBe("https://app.moonbridge.test/?email=confirmed");
    // Mail scanners open links too: a second open is fine.
    expect((await app.inject({ url: verifyLink("ksenia@school.test") })).statusCode).toBe(302);
    expect((await app.inject({ method: "POST", url: "/school/groups", headers: auth(t), payload: { name: "A1" } })).statusCode).toBe(201);
    expect((await app.inject({ url: "/email/verify?t=forged-token-123" })).statusCode).toBe(404);
  });

  it("starts over when the address changes; resending is limited and an old link does not confirm a new address", async () => {
    const app = await school(true);
    const { code } = await setup(app);
    const s = (await enrol(app, code, { login: "anna", email: "anna@mail.ru" })).json().token as string;
    expect((await app.inject({ url: "/school/dashboard", headers: auth(s) })).json().account.email_verified).toBe(true);
    // The same address again keeps the confirmation.
    expect((await app.inject({ method: "PUT", url: "/account/email", headers: auth(s), payload: { email: "anna@mail.ru" } })).json().account.email_verified).toBe(true);
    expect(mailer.sent).toHaveLength(0);

    const changed = await app.inject({ method: "PUT", url: "/account/email", headers: auth(s), payload: { email: "anna@yandex.ru" } });
    expect(changed.json().account).toMatchObject({ email: "anna@yandex.ru", email_verified: false });
    const old = verifyLink("anna@yandex.ru");
    expect((await app.inject({ url: "/school/students/acc_x/report", headers: auth(s) })).statusCode).toBe(403);

    await app.inject({ method: "PUT", url: "/account/email", headers: auth(s), payload: { email: "anna@gmail.com" } });
    expect((await app.inject({ url: old })).statusCode).toBe(404);
    // Three confirmation e-mails an hour per account: the one at joining and the two changes.
    const resend = () => app.inject({ method: "POST", url: "/account/email/resend", headers: auth(s) });
    expect((await resend()).statusCode).toBe(429);
    clock = new Date(clock.getTime() + 61 * 60_000);
    for (let i = 0; i < 3; i++) expect((await resend()).statusCode).toBe(200);
    expect((await resend()).statusCode).toBe(429);
    expect(mailer.sent.filter((m) => m.to === "anna@gmail.com")).toHaveLength(4);
    expect((await app.inject({ url: verifyLink("anna@gmail.com") })).statusCode).toBe(302);
    expect((await app.inject({ url: "/school/dashboard", headers: auth(s) })).json().account.email_verified).toBe(true);
  });

  it("lets one address open at most three accounts", async () => {
    const app = await school();
    const { code } = await setup(app);
    for (const login of ["kid1", "kid2", "kid3"]) expect((await enrol(app, code, { login, email: "mama@mail.ru" })).statusCode).toBe(201);
    const fourth = await enrol(app, code, { login: "kid4", email: "mama@mail.ru" });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().error).toBe("email_taken");
    const s = (await enrol(app, code, { login: "kid5", email: "kid5@mail.ru" })).json().token as string;
    expect((await app.inject({ method: "PUT", url: "/account/email", headers: auth(s), payload: { email: "mama@mail.ru" } })).statusCode).toBe(409);
  });

  it("is needed for a reset link: an unconfirmed address gets none", async () => {
    const app = await school();
    const { code } = await setup(app);
    await enrol(app, code, { login: "anna", email: "anna@mail.ru" }, false);
    mailer.sent.splice(0);
    await app.inject({ method: "POST", url: "/auth/forgot", payload: { login: "anna" } });
    expect(mailer.sent).toHaveLength(0);
  });
});

describe("reminders", () => {
  it("sends the evening reminder once, only to students in a group who have not practised today", async () => {
    const app = await school();
    const { code } = await setup(app);
    const anna = (await enrol(app, code, { login: "anna", email: "anna@mail.ru" })).json().account;
    const boris = (await enrol(app, code, { login: "boris", email: "boris@mail.ru" })).json().account;
    await enrol(app, code, { login: "gleb", email: "gleb@mail.ru" }, false); // not confirmed: no reminders
    mailer.sent.splice(0);
    await answer(await playerOf(boris.id), new Date("2026-11-30T06:00:00Z")); // 9:00 Moscow today
    await answer(await playerOf(anna.id), new Date("2026-11-29T18:00:00Z")); // yesterday

    // 18:30 Moscow: too early.
    expect((await reminders().run(new Date("2026-11-30T15:30:00Z"))).sent).toBe(0);
    const evening = new Date("2026-11-30T16:30:00Z");
    expect(await reminders().run(evening)).toEqual({ sent: 1, failed: 0 });
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.to).toBe("anna@mail.ru");
    expect(mail.subject).toBe("Смена в Hotel Hello ждёт");
    expect(mail.text).toContain("https://moonbridge.test/api/email/go/em_");
    expect(mail.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/moonbridge\.test\/api\/email\/unsubscribe\?t=/);
    expect(mail.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    expect((await reminders().run(new Date("2026-11-30T17:30:00Z"))).sent).toBe(0);
    // 22:30 Moscow the next day: too late, nothing at night.
    expect((await reminders().run(new Date("2026-12-01T19:30:00Z"))).sent).toBe(0);
    expect((await reminders().run(new Date("2026-12-01T16:30:00Z"))).sent).toBe(2);
  });

  it("never reminds teachers or admins, even with an address and in a group", async () => {
    const app = await school();
    const { groupId } = await setup(app);
    const admin = await app.inject({ method: "POST", url: "/admin/admins", headers: auth("admin-secret"), payload: { name: "Илья", login: "ilya@school.ru", password: "admin-123" } });
    expect(admin.json().account).toMatchObject({ role: "admin", email: "ilya@school.ru" });
    await confirmAll();
    await sql.query("INSERT INTO group_members (group_id, account_id) SELECT $1, account_id FROM accounts WHERE role <> 'student'", [groupId]);
    expect((await reminders().run(new Date("2026-11-30T16:30:00Z"))).sent).toBe(0);
  });

  it("reminds of a file homework 24 hours before it is due, unless it is handed in", async () => {
    const app = await school();
    const { t, groupId, code } = await setup(app);
    const anna = (await enrol(app, code, { login: "anna", email: "anna@mail.ru" })).json().token as string;
    await enrol(app, code, { login: "boris", email: "boris@mail.ru" });
    const hw = (
      await app.inject({ method: "POST", url: `/school/groups/${groupId}/homework`, headers: auth(t), payload: { title: "Расскажи о себе", due_at: "2026-12-01T15:00:00.000Z", needs_file: true } })
    ).json().homework.homework_id as string;
    await app.inject({ method: "POST", url: `/school/groups/${groupId}/homework`, headers: auth(t), payload: { title: "Без файла", due_at: "2026-12-01T15:00:00.000Z", needs_file: false } });
    await app.inject({ method: "PUT", url: `/school/homework/${hw}/submission?name=a.m4a`, headers: { ...auth(anna), "content-type": "audio/mp4" }, payload: Buffer.from("voice") });

    // Monday 12:00 Moscow: more than a day before Tuesday 18:00.
    expect((await reminders().run(clock)).sent).toBe(0);
    const r = await reminders().run(new Date("2026-11-30T16:00:00Z"));
    expect(r.sent).toBe(3); // Boris's deadline + the two evening reminders
    const deadline = mailer.sent.filter((m) => m.subject.startsWith("Домашка"));
    expect(deadline.map((m) => m.to)).toEqual(["boris@mail.ru"]);
    expect(deadline[0]!.subject).toBe("Домашка до 1 декабря в 18:00: Расскажи о себе");
  });

  it("reminds only the student a homework was given to", async () => {
    const app = await school();
    const { t, groupId, code } = await setup(app);
    const boris = (await enrol(app, code, { login: "boris", email: "boris@mail.ru" })).json().account.id as string;
    await enrol(app, code, { login: "anna", email: "anna@mail.ru" });
    await app.inject({
      method: "POST",
      url: `/school/groups/${groupId}/homework`,
      headers: auth(t),
      payload: { title: "Только Борису", due_at: "2026-12-01T15:00:00.000Z", needs_file: true, account_id: boris },
    });
    await reminders().run(new Date("2026-11-30T16:00:00Z"));
    expect(mailer.sent.filter((m) => m.subject.startsWith("Домашка")).map((m) => m.to)).toEqual(["boris@mail.ru"]);
  });

  it("sends the grade with the teacher's comment; the button counts the return and opens the homework", async () => {
    const app = await school();
    const { t, groupId, code } = await setup(app);
    const anna = (await enrol(app, code, { login: "anna", email: "anna@mail.ru" })).json().token as string;
    const hw = (await app.inject({ method: "POST", url: `/school/groups/${groupId}/homework`, headers: auth(t), payload: { title: "Расскажи о себе", needs_file: true } })).json().homework
      .homework_id as string;
    const sub = (await app.inject({ method: "PUT", url: `/school/homework/${hw}/submission?name=a.m4a`, headers: { ...auth(anna), "content-type": "audio/mp4" }, payload: Buffer.from("voice") })).json()
      .submission.submission_id;
    await app.inject({ method: "POST", url: `/school/submissions/${sub}/review`, headers: auth(t), payload: { grade: 5, comment: "Отличное произношение!" } });

    expect((await reminders().run(clock)).sent).toBe(1);
    const mail = mailer.sent[0]!;
    expect(mail.subject).toBe("Оценка за «Расскажи о себе»: 5");
    expect(mail.text).toContain("Комментарий: Отличное произношение!");
    expect(mail.html).toContain("Отличное произношение!");
    expect((await reminders().run(clock)).sent).toBe(0);

    const go = /https:\/\/moonbridge\.test\/api(\/email\/go\/em_[0-9a-f]+)/.exec(mail.text)![1]!;
    const res = await app.inject({ url: go });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`https://app.moonbridge.test/homework/${hw}`);
    expect((await sql.query<{ clicked_at: Date | null }>("SELECT clicked_at FROM emails")).rows[0]!.clicked_at).not.toBeNull();
    expect((await app.inject({ url: "/email/go/em_000000000000000000000000" })).headers.location).toBe("https://app.moonbridge.test/");
  });

  it("retries a failed send a few times, then gives up", async () => {
    const app = await school();
    const { code } = await setup(app);
    await enrol(app, code, { login: "anna", email: "anna@mail.ru" });
    mailer.failWith = new Error("Postbox: HTTP 503");
    const evening = new Date("2026-11-30T16:30:00Z");
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect(await reminders().run(evening)).toEqual({ sent: 0, failed: 1 });
    expect(await reminders().run(evening)).toEqual({ sent: 0, failed: 0 });
    mailer.failWith = undefined;
    expect((await reminders().run(evening)).sent).toBe(0);
  });
});

describe("unsubscribe", () => {
  it("asks first on GET, unsubscribes on POST (the button or the mail client's one click), and stops the reminders", async () => {
    const app = await school();
    const { code } = await setup(app);
    const s = (await enrol(app, code, { login: "anna", email: "anna@mail.ru" })).json().token as string;
    await reminders().run(new Date("2026-11-30T16:30:00Z"));
    const url = new URL(/<(.+)>/.exec(mailer.sent[0]!.headers!["List-Unsubscribe"]!)![1]!);
    const path = `${url.pathname.replace(/^\/api/, "")}${url.search}`;

    const ask = await app.inject({ url: path });
    expect(ask.statusCode).toBe(200);
    expect(ask.body).toContain("Не присылать напоминания?");
    expect((await app.inject({ url: "/school/dashboard", headers: auth(s) })).json().account.reminders).toBe(true);

    const done = await app.inject({ method: "POST", url: path, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "List-Unsubscribe=One-Click" });
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain("Напоминаний больше не будет");
    expect((await app.inject({ url: "/school/dashboard", headers: auth(s) })).json().account.reminders).toBe(false);
    expect((await reminders().run(new Date("2026-12-01T16:30:00Z"))).sent).toBe(0);

    expect((await app.inject({ method: "POST", url: "/email/unsubscribe?t=forged" })).statusCode).toBe(404);
  });
});

describe("forgotten password", () => {
  it("sends a one-off link to the account's address; the link sets a new password and signs in", async () => {
    const app = await school();
    const { code } = await setup(app);
    await enrol(app, code, { login: "anna", email: "anna@mail.ru" });
    expect((await app.inject({ url: "/auth/options" })).json()).toEqual({ guest: true, password_reset: true });

    const asked = await app.inject({ method: "POST", url: "/auth/forgot", payload: { login: "Anna@Mail.ru" } });
    expect(asked.statusCode).toBe(200);
    const unknown = await app.inject({ method: "POST", url: "/auth/forgot", payload: { login: "nobody" } });
    expect(unknown.json()).toEqual(asked.json());
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.to).toBe("anna@mail.ru");
    expect(mail.text).toContain("Ваш логин: anna");
    expect(mail.headers).toBeUndefined();
    const token = /https:\/\/app\.moonbridge\.test\/reset\/([\w-]+)/.exec(mail.text)![1]!;

    expect((await app.inject({ url: `/auth/reset/${token}` })).statusCode).toBe(200);
    const reset = await app.inject({ method: "POST", url: "/auth/reset", payload: { token, password: "new-secret" } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ account: { login: "anna" }, token: expect.any(String) });
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { login: "anna", password: "new-secret" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { login: "anna", password: "secret-1" } })).statusCode).toBe(401);

    expect((await app.inject({ method: "POST", url: "/auth/reset", payload: { token, password: "again-123" } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/auth/reset/${token}` })).statusCode).toBe(404);
  });

  it("expires the link after an hour and sends at most three an hour to one account", async () => {
    const app = await school();
    const { code } = await setup(app);
    await enrol(app, code, { login: "anna", email: "anna@mail.ru" });
    for (let i = 0; i < 5; i++) await app.inject({ method: "POST", url: "/auth/forgot", payload: { login: "anna" } });
    expect(mailer.sent).toHaveLength(3);
    const token = /\/reset\/([\w-]+)/.exec(mailer.sent[0]!.text)![1]!;
    clock = new Date(clock.getTime() + 61 * 60_000);
    expect((await app.inject({ method: "POST", url: "/auth/reset", payload: { token, password: "new-secret" } })).statusCode).toBe(404);
  });
});

describe("pilot metrics", () => {
  it("counts reminders sent, opened from the button and followed by practice", () => {
    const from = new Date("2026-11-29T21:00:00Z");
    const m = emailMetrics({
      from,
      now: new Date("2026-12-07T09:00:00Z"),
      students: 3,
      withEmail: 2,
      unsubscribed: 1,
      emails: [
        { playerId: "p1", kind: "evening", sentAt: new Date("2026-11-30T16:00:00Z"), clickedAt: new Date("2026-11-30T17:00:00Z") },
        { playerId: "p1", kind: "evening", sentAt: new Date("2026-12-01T16:00:00Z"), clickedAt: new Date("2026-12-01T17:00:00Z") },
        { playerId: "p2", kind: "grade", sentAt: new Date("2026-12-02T10:00:00Z"), clickedAt: null },
        { playerId: "p2", kind: "deadline", sentAt: new Date("2026-12-06T10:00:00Z"), clickedAt: null },
      ],
      attempts: [{ playerId: "p1", answeredAt: new Date("2026-11-30T17:05:00Z"), taskId: "t", success: true, errorType: null, attemptNo: 1, durationMs: 1000, mode: null }],
    });
    expect(m).toMatchObject({ sent: 4, clicked: 2, practiced: 1, students: 3, withEmail: 2, unsubscribed: 1 });
    expect(m.byKind).toEqual({ evening: { sent: 2, clicked: 2, practiced: 1 }, deadline: { sent: 1, clicked: 0, practiced: 0 }, grade: { sent: 1, clicked: 0, practiced: 0 } });
    expect(m.weeks.map((w) => [w.from, w.sent])).toEqual([
      ["2026-11-30", 4],
      ["2026-12-07", 0],
    ]);
  });

  it("are part of the group's metrics page", async () => {
    const app = await school();
    const { t, groupId, code } = await setup(app);
    await enrol(app, code, { login: "anna", email: "anna@mail.ru" });
    await enrol(app, code, { login: "boris", email: "boris@mail.ru" }, false);
    await reminders().run(new Date("2026-11-30T16:30:00Z"));
    clock = new Date("2026-11-30T18:00:00Z");
    const res = (await app.inject({ url: `/school/groups/${groupId}/metrics`, headers: auth(t) })).json();
    expect(res.email).toMatchObject({ sent: 1, clicked: 0, students: 2, withEmail: 1, unsubscribed: 0 });
  });
});

describe("Postbox", () => {
  it("posts a signed SES v2 SendEmail request with the unsubscribe headers", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: URL, init: RequestInit) => (calls.push({ url: String(url), init }), Response.json({ MessageId: "m1" }))) as unknown as typeof fetch;
    const mailerP = new PostboxMailer(
      { endpoint: "https://postbox.cloud.yandex.net", region: "ru-central1", accessKeyId: "AKID", secretAccessKey: "secret", from: "Школа английского <hello@school.test>" },
      fake,
      () => new Date("2026-11-30T09:00:00Z"),
    );
    await mailerP.send({ to: "anna@mail.ru", subject: "Тема", text: "Текст", html: "<p>Текст</p>", headers: { "List-Unsubscribe": "<https://x/u>" } });
    expect(calls[0]!.url).toBe("https://postbox.cloud.yandex.net/v2/email/outbound-emails");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/20261130\/ru-central1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.FromEmailAddress).toBe(`=?UTF-8?B?${Buffer.from("Школа английского").toString("base64")}?= <hello@school.test>`);
    expect(body.Destination).toEqual({ ToAddresses: ["anna@mail.ru"] });
    expect(body.Content.Simple.Headers).toEqual([{ Name: "List-Unsubscribe", Value: "<https://x/u>" }]);

    const failing = new PostboxMailer({ endpoint: "https://p.test", region: "ru-central1", accessKeyId: "a", secretAccessKey: "b", from: "x@y.z" }, (async () =>
      new Response('{"Code":"MessageRejected"}', { status: 400 })) as unknown as typeof fetch);
    await expect(failing.send({ to: "a@b.ru", subject: "s", text: "t", html: "h" })).rejects.toThrow(/HTTP 400.*MessageRejected/);
  });

  it("encodes the sender's name", () => {
    expect(encodeFrom("Moonbridge <hi@x.ru>")).toBe('"Moonbridge" <hi@x.ru>');
    expect(encodeFrom("hi@x.ru")).toBe("hi@x.ru");
  });
});
