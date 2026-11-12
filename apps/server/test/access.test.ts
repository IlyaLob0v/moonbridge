// Who may call what: every route of the gateway against every kind of caller.
//
// The routes come from the running app, so a new route without a line in `ROUTES` fails the
// first test: nobody can add an endpoint and forget to decide who may use it. Each line names the
// callers that are let through; everybody else must be refused (401, 403 or 404 for "not yours").
// The bodies are valid, so a refusal is the access check speaking, not the body validation.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { validateContent } from "@moonbridge/content";
import { buildBundle, loadContentDir } from "@moonbridge/content/node";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LiveContent } from "../src/content/live.js";
import { ContentVersions } from "../src/content/versions.js";
import { migrate, type Sql } from "../src/db/sql.js";
import { MailLinks } from "../src/mail/links.js";
import { MemoryMailer } from "../src/mail/mailer.js";
import { EmailStore } from "../src/mail/store.js";
import { DiskFileStore } from "../src/school/files.js";
import { SchoolStore } from "../src/school/store.js";
import { CONTENT_DIR, harness } from "./harness.js";

const ROLES = ["none", "guest", "student", "otherStudent", "teacher", "otherTeacher", "admin", "adminToken"] as const;
type Role = (typeof ROLES)[number];

/** Ids of the records the fixture made: the student's, in the teacher's group. */
interface Ids {
  studentId: string;
  groupId: string;
  homeworkId: string;
  submissionId: string;
  lessonId: string;
  lessonFileId: string;
  paymentId: string;
  inviteCode: string;
  playerId: string;
}

interface Route {
  /** Who is let through. `public` routes are open to anyone by design (sign-in, links from e-mails, LTI). */
  allow: readonly Role[] | "public";
  req: (ids: Ids) => InjectOptions;
}

const ACCOUNTS: readonly Role[] = ["student", "otherStudent", "teacher", "otherTeacher", "admin"];
const SESSIONS: readonly Role[] = ["guest", ...ACCOUNTS];
/** Any teacher: these read or make the teacher's own things (their groups, their students), or the shared course content. */
const TEACHERS: readonly Role[] = ["teacher", "otherTeacher"];
/** Only the teacher of the student's group. */
const TEACHER: readonly Role[] = ["teacher"];
const ADMIN: readonly Role[] = ["admin", "adminToken"];
/** Read by a one-off link from POST …/link; a header gets nobody in. */
const BY_LINK: readonly Role[] = [];

const json = (method: InjectOptions["method"], url: string, payload?: unknown): InjectOptions => ({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
const file = (url: string): InjectOptions => ({ method: "PUT", url: `${url}?name=note.pdf`, headers: { "content-type": "application/pdf" }, payload: Buffer.from("%PDF-1.4 test") });

const ROUTES: Record<string, Route> = {
  // Public by design
  "GET /health": { allow: "public", req: () => json("GET", "/health") },
  "GET /content/bundle": { allow: "public", req: () => json("GET", "/content/bundle") },
  "GET /content/manifest": { allow: "public", req: () => json("GET", "/content/manifest") },
  "GET /content/media/*": { allow: "public", req: () => json("GET", "/content/media/none.png") },
  "GET /auth/options": { allow: "public", req: () => json("GET", "/auth/options") },
  "POST /auth/login": { allow: "public", req: () => json("POST", "/auth/login", { login: "nobody", password: "nope-nope" }) },
  "POST /auth/forgot": { allow: "public", req: () => json("POST", "/auth/forgot", { login: "nobody" }) },
  "GET /auth/reset/:token": { allow: "public", req: () => json("GET", "/auth/reset/not-a-token-0000") },
  "POST /auth/reset": { allow: "public", req: () => json("POST", "/auth/reset", { token: "not-a-token-0000", password: "new-pass-1" }) },
  "GET /email/verify": { allow: "public", req: () => json("GET", "/email/verify?t=bad") },
  "GET /email/unsubscribe": { allow: "public", req: () => json("GET", "/email/unsubscribe?t=bad") },
  "POST /email/unsubscribe": { allow: "public", req: () => json("POST", "/email/unsubscribe?t=bad") },
  "GET /email/go/:id": { allow: "public", req: () => json("GET", "/email/go/none") },
  "GET /invites/:code": { allow: "public", req: (i) => json("GET", `/invites/${i.inviteCode}`) },
  "POST /invites/:code/join": { allow: "public", req: (i) => json("POST", `/invites/${i.inviteCode}/join`, { name: "Вера", login: "vera-new", password: "secret-1" }) },
  "POST /session/guest": { allow: "public", req: () => json("POST", "/session/guest", {}) },
  "GET /lti/login": { allow: "public", req: () => json("GET", "/lti/login") },
  "POST /lti/login": { allow: "public", req: () => json("POST", "/lti/login", {}) },
  "POST /lti/launch": { allow: "public", req: () => json("POST", "/lti/launch", {}) },
  "GET /.well-known/jwks.json": { allow: "public", req: () => json("GET", "/.well-known/jwks.json") },

  // Whoever runs the school: the admin token (curl), or the admin's account where it says so
  "PUT /content/source": { allow: ["adminToken"], req: () => json("PUT", "/content/source", {}) },
  "POST /admin/teachers": { allow: ["adminToken"], req: () => json("POST", "/admin/teachers", { name: "Новый", login: "new-teacher", password: "teach-123", email: "new-teacher@school.test" }) },
  "POST /admin/admins": { allow: ["adminToken"], req: () => json("POST", "/admin/admins", { name: "Новый", login: "new-admin", password: "admin-123", email: "new-admin@school.test" }) },
  "GET /admin/feedback": { allow: ["adminToken"], req: () => json("GET", "/admin/feedback") },
  "GET /admin/finance": { allow: ADMIN, req: () => json("GET", "/admin/finance") },
  "PUT /admin/students/:id/price": { allow: ADMIN, req: (i) => json("PUT", `/admin/students/${i.studentId}/price`, { price_rub: 1500 }) },
  "POST /admin/students/:id/payments": { allow: ADMIN, req: (i) => json("POST", `/admin/students/${i.studentId}/payments`, { amount_rub: 100, method: "cash" }) },
  "POST /admin/students/:id/corrections": { allow: ADMIN, req: (i) => json("POST", `/admin/students/${i.studentId}/corrections`, { amount_rub: 10, note: "проверка доступа" }) },
  "POST /admin/payments/:id/void": { allow: ADMIN, req: (i) => json("POST", `/admin/payments/${i.paymentId}/void`, { reason: "проверка доступа" }) },

  // Any session, guests included: the game itself
  "GET /session/me": { allow: SESSIONS, req: () => json("GET", "/session/me") },
  "POST /xapi/statements": { allow: SESSIONS, req: () => json("POST", "/xapi/statements", []) },
  "POST /progress/module-result": { allow: SESSIONS, req: () => json("POST", "/progress/module-result", { module_id: "A1_PastSimple_01", correct: 1, total: 10 }) },
  "PUT /progress/snapshot": { allow: SESSIONS, req: () => json("PUT", "/progress/snapshot", { saved_at: "2026-11-01T08:00:00.000Z", snapshot: { progress: { xp: 1 } } }) },
  "GET /progress/snapshot": { allow: SESSIONS, req: () => json("GET", "/progress/snapshot") },

  // Any account: one's own things
  "GET /school/dashboard": { allow: ACCOUNTS, req: () => json("GET", "/school/dashboard") },
  "GET /school/lessons": { allow: ACCOUNTS, req: () => json("GET", "/school/lessons") },
  "POST /feedback": { allow: ACCOUNTS, req: () => json("POST", "/feedback", { message: "проверка доступа", page: "/" }) },
  "POST /account/email/resend": { allow: ACCOUNTS, req: () => json("POST", "/account/email/resend") },
  "PUT /account/email": { allow: ACCOUNTS, req: () => json("PUT", "/account/email", { email: null }) },
  "PUT /account/reminders": { allow: ACCOUNTS, req: () => json("PUT", "/account/reminders", { on: true }) },

  // The student and the people responsible for them
  "GET /school/students/:id/report": { allow: ["student", "teacher"], req: (i) => json("GET", `/school/students/${i.studentId}/report`) },
  // The admin token reads balances through GET /admin/finance.
  "GET /school/students/:id/balance": { allow: ["teacher", "admin"], req: (i) => json("GET", `/school/students/${i.studentId}/balance`) },
  "PUT /school/homework/:id/submission": { allow: ["student"], req: (i) => file(`/school/homework/${i.homeworkId}/submission`) },
  "POST /school/submissions/:id/link": { allow: ["student", "teacher"], req: (i) => json("POST", `/school/submissions/${i.submissionId}/link`) },
  // With the session of the student or their teacher, or with the one-off link.
  "GET /school/submissions/:id/file": { allow: ["student", "teacher"], req: (i) => json("GET", `/school/submissions/${i.submissionId}/file`) },
  "POST /school/lesson-files/:fileId/link": { allow: ["student", "teacher"], req: (i) => json("POST", `/school/lesson-files/${i.lessonFileId}/link`) },
  "GET /school/lesson-files/:fileId/file": { allow: BY_LINK, req: (i) => json("GET", `/school/lesson-files/${i.lessonFileId}/file`) },

  // The group's teacher only
  "GET /school/finance": { allow: TEACHERS, req: () => json("GET", "/school/finance") },
  "GET /school/review-queue": { allow: TEACHERS, req: () => json("GET", "/school/review-queue") },
  "GET /school/catalog": { allow: TEACHERS, req: () => json("GET", "/school/catalog") },
  "GET /school/content": { allow: TEACHERS, req: () => json("GET", "/school/content") },
  "GET /school/content/sheet": { allow: TEACHERS, req: () => json("GET", "/school/content/sheet") },
  "POST /school/content/check": { allow: TEACHERS, req: () => ({ method: "POST", url: "/school/content/check", headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, payload: Buffer.from("not a workbook") }) },
  "POST /school/content/publish": { allow: TEACHERS, req: () => ({ method: "POST", url: "/school/content/publish", headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, payload: Buffer.from("not a workbook") }) },
  "POST /school/groups": { allow: TEACHERS, req: () => json("POST", "/school/groups", { name: "Новая группа" }) },
  "PATCH /school/groups/:id": { allow: TEACHER, req: (i) => json("PATCH", `/school/groups/${i.groupId}`, { name: "A1 вечер" }) },
  "GET /school/groups/:id/progress": { allow: TEACHER, req: (i) => json("GET", `/school/groups/${i.groupId}/progress`) },
  "GET /school/groups/:id/metrics": { allow: TEACHER, req: (i) => json("GET", `/school/groups/${i.groupId}/metrics`) },
  "PUT /school/groups/:id/pilot": { allow: TEACHER, req: (i) => json("PUT", `/school/groups/${i.groupId}/pilot`, { from: "2026-11-23" }) },
  "POST /school/groups/:id/invites": { allow: TEACHER, req: (i) => json("POST", `/school/groups/${i.groupId}/invites`) },
  "POST /school/groups/:id/homework": { allow: TEACHER, req: (i) => json("POST", `/school/groups/${i.groupId}/homework`, { title: "Проверка", needs_file: false }) },
  "GET /school/groups/:id/lessons": { allow: TEACHER, req: (i) => json("GET", `/school/groups/${i.groupId}/lessons`) },
  "POST /school/groups/:id/lessons": { allow: TEACHER, req: (i) => json("POST", `/school/groups/${i.groupId}/lessons`, { starts_at: "2026-12-05T15:00:00.000Z", minutes: 60 }) },
  "PATCH /school/lessons/:id": { allow: TEACHER, req: (i) => json("PATCH", `/school/lessons/${i.lessonId}`, { topic: "Past Simple" }) },
  "PUT /school/lessons/:id/attendance": { allow: TEACHER, req: (i) => json("PUT", `/school/lessons/${i.lessonId}/attendance`, { marks: [] }) },
  "PUT /school/lessons/:id/files": { allow: TEACHER, req: (i) => file(`/school/lessons/${i.lessonId}/files`) },
  "DELETE /school/lessons/:id/files/:fileId": { allow: TEACHER, req: (i) => json("DELETE", `/school/lessons/${i.lessonId}/files/${i.lessonFileId}`) },
  "POST /school/submissions/:id/review": { allow: TEACHER, req: (i) => json("POST", `/school/submissions/${i.submissionId}/review`, { grade: 5 }) },
  "POST /school/students/:id/password": { allow: TEACHER, req: (i) => json("POST", `/school/students/${i.studentId}/password`) },
};

/** "GET /a/:id" for every method of every route the app serves; HEAD is GET's twin. */
function routesOf(app: FastifyInstance): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    const m = /^((?:│ {3}| {4})*)(?:├── |└── )(\S+)(?: \(([^)]+)\))?$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack.push(m[2]!);
    const path = stack.join("");
    for (const method of m[3]?.split(", ") ?? []) if (method !== "HEAD") out.push(`${method} ${path}`);
  }
  return out;
}

let pglite: PGlite;
let uploads: string;
let app: FastifyInstance;
let ids: Ids;
const tokens = {} as Record<Role, string | undefined>;
const clock = new Date("2026-11-30T09:00:00Z");

beforeAll(async () => {
  pglite = new PGlite();
  const sql = { query: (text, params) => pglite.query(text, params), exec: (text) => pglite.exec(text) } as Sql;
  await migrate(sql);
  uploads = await mkdtemp(join(tmpdir(), "moonbridge-access-"));
  const { source } = await loadContentDir(CONTENT_DIR);
  const content = new LiveContent(buildBundle(validateContent(source).content!), source, new ContentVersions(sql));
  const links = new MailLinks({ publicUrl: "https://moonbridge.test/api", clientUrl: "https://app.moonbridge.test/", sessionSecret: "dev-only-session-secret-change-me-0123456789" });
  const mail = { store: new EmailStore(sql), mailer: new MemoryMailer(), links, delivers: true, verification: false };
  app = (await harness({ school: { store: new SchoolStore(sql), files: new DiskFileStore(uploads), mail, now: () => clock }, content }, { keepOpen: true })).app;

  const ok = async (opts: InjectOptions, status = 200) => {
    const res = await app.inject(opts);
    expect(res.statusCode, `${opts.method} ${opts.url}: ${res.body}`).toBe(status);
    return res.json();
  };
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const signIn = async (login: string, password: string) => (await ok({ method: "POST", url: "/auth/login", payload: { login, password } })).token as string;

  tokens.none = undefined;
  tokens.adminToken = "admin-secret";
  tokens.guest = (await ok({ method: "POST", url: "/session/guest", payload: {} })).token;
  await ok({ method: "POST", url: "/admin/admins", headers: as("admin-secret"), payload: { name: "Илья", login: "ilya", password: "admin-123", email: "ilya@school.test" } }, 201);
  tokens.admin = await signIn("ilya", "admin-123");
  for (const [role, login] of [["teacher", "ksenia"], ["otherTeacher", "olga"]] as const) {
    await ok({ method: "POST", url: "/admin/teachers", headers: as("admin-secret"), payload: { name: login, login, password: "teach-123", email: `${login}@school.test` } }, 201);
    tokens[role] = await signIn(login, "teach-123");
  }
  const groupOf = async (teacher: string, name: string) => {
    const groupId = (await ok({ method: "POST", url: "/school/groups", headers: as(teacher), payload: { name } }, 201)).group.group_id as string;
    const code = (await ok({ method: "POST", url: `/school/groups/${groupId}/invites`, headers: as(teacher) }, 201)).code as string;
    return { groupId, code };
  };
  const mine = await groupOf(tokens.teacher!, "A1 вечер");
  const theirs = await groupOf(tokens.otherTeacher!, "A2 утро");
  const anna = await ok({ method: "POST", url: `/invites/${mine.code}/join`, payload: { name: "Анна", login: "anna", password: "secret-1", email: "anna@mail.test" } }, 201);
  tokens.student = anna.token;
  tokens.otherStudent = (await ok({ method: "POST", url: `/invites/${theirs.code}/join`, payload: { name: "Борис", login: "boris", password: "secret-1", email: "boris@mail.test" } }, 201)).token;

  const homeworkId = (await ok({ method: "POST", url: `/school/groups/${mine.groupId}/homework`, headers: as(tokens.teacher!), payload: { title: "Расскажи о себе", needs_file: true } }, 201)).homework.homework_id as string;
  const handedIn = await ok({ ...file(`/school/homework/${homeworkId}/submission`), headers: { ...as(tokens.student!), "content-type": "application/pdf" } }, 201);
  const lesson = (await ok({ method: "POST", url: `/school/groups/${mine.groupId}/lessons`, headers: as(tokens.teacher!), payload: { starts_at: "2026-12-01T15:30:00.000Z", minutes: 60 } }, 201)).lesson;
  const lessonFile = await ok({ ...file(`/school/lessons/${lesson.lesson_id}/files`), headers: { ...as(tokens.teacher!), "content-type": "application/pdf" } }, 201);
  const payment = await ok({ method: "POST", url: `/admin/students/${anna.account.id}/payments`, headers: as(tokens.admin!), payload: { amount_rub: 3000, method: "transfer" } }, 201);
  ids = {
    studentId: anna.account.id,
    groupId: mine.groupId,
    homeworkId,
    submissionId: handedIn.submission.submission_id,
    lessonId: lesson.lesson_id,
    lessonFileId: lessonFile.lesson.files[0].file_id,
    paymentId: payment.payment.payment_id,
    inviteCode: mine.code,
    playerId: anna.account.player_id ?? "",
  };
});

afterAll(async () => {
  await app.close();
  await pglite.close();
  await rm(uploads, { recursive: true, force: true });
});

const call = (route: string, role: Role) => {
  const opts = ROUTES[route]!.req(ids);
  const token = tokens[role];
  return app.inject({ ...opts, headers: { ...(opts.headers as Record<string, string> | undefined), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
};

const guarded = Object.entries(ROUTES).filter(([, r]) => r.allow !== "public");
const refusals = guarded.flatMap(([route, r]) => ROLES.filter((role) => !(r.allow as readonly Role[]).includes(role)).map((role) => [route, role] as const));

describe("access to every route", () => {
  it("has a decision for every route the gateway serves, and no stale ones", () => {
    const served = routesOf(app).map((r) => (r === "GET *" ? "GET /content/media/*" : r));
    expect(served.filter((r) => !(r in ROUTES)), "routes without a line in ROUTES").toEqual([]);
    expect(Object.keys(ROUTES).filter((r) => !served.includes(r)), "lines in ROUTES the gateway no longer serves").toEqual([]);
  });

  it.each(refusals)("%s refuses %s", async (route, role) => {
    const res = await call(route, role);
    expect([401, 403, 404], `${route} as ${role}: ${res.statusCode} ${res.body.slice(0, 200)}`).toContain(res.statusCode);
  });

  // After the refusals, so that the changes these make cannot hide a refusal. A 400 here means the
  // line's body is wrong, which would make its refusals prove nothing.
  const allowed = guarded.flatMap(([route, r]) => (r.allow as readonly Role[]).map((role) => [route, role] as const));
  it.each(allowed)("%s lets %s in", async (route, role) => {
    const res = await call(route, role);
    expect([400, 401, 403, 404], `${route} as ${role}: ${res.statusCode} ${res.body.slice(0, 200)}`).not.toContain(res.statusCode);
  });
});
