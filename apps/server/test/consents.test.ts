import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { validateContent, type ContentBundle } from "@moonbridge/content";
import { buildBundle, loadContentDir } from "@moonbridge/content/node";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LiveContent } from "../src/content/live.js";
import { migrate, type Sql } from "../src/db/sql.js";
import { MailLinks } from "../src/mail/links.js";
import { MemoryMailer } from "../src/mail/mailer.js";
import { EmailStore } from "../src/mail/store.js";
import { blindTask } from "../src/school/assessments.js";
import { DiskFileStore } from "../src/school/files.js";
import { SchoolStore } from "../src/school/store.js";
import { harness } from "./harness.js";

// The repository's own content: it has the legal pages, the rubrics and the tests.
const REPO_CONTENT = new URL("../../../content", import.meta.url).pathname;

let pglite: PGlite;
let sql: Sql;
let uploads: string;
let repo: ContentBundle;
let mailer: MemoryMailer;
let live: LiveContent;
const clock = new Date("2026-11-30T09:00:00Z");
const links = new MailLinks({ publicUrl: "https://moonbridge.test/api", clientUrl: "https://app.moonbridge.test/", sessionSecret: "dev-only-session-secret-change-me-0123456789" });

beforeAll(async () => {
  pglite = new PGlite();
  sql = { query: (text, params) => pglite.query(text, params), exec: (text) => pglite.exec(text) } as Sql;
  await migrate(sql);
  uploads = await mkdtemp(join(tmpdir(), "moonbridge-uploads-"));
  const { source } = await loadContentDir(REPO_CONTENT);
  const result = validateContent(source);
  expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  repo = buildBundle(result.content!);
});

afterAll(async () => {
  await pglite.close();
  await rm(uploads, { recursive: true, force: true });
});

beforeEach(async () => {
  mailer = new MemoryMailer();
  live = new LiveContent(structuredClone(repo));
  await sql.exec("TRUNCATE accounts, school_groups, group_members, invites, homework, submissions, attempts, emails, consents, parent_requests, group_assessments, assessment_results CASCADE");
});

async function school(): Promise<FastifyInstance> {
  const h = await harness({
    school: { store: new SchoolStore(sql), files: new DiskFileStore(uploads), mail: { store: new EmailStore(sql), mailer, links, delivers: true, verification: false }, now: () => clock },
    content: live,
  });
  return h.app;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function setup(app: FastifyInstance) {
  await app.inject({ method: "POST", url: "/admin/teachers", headers: auth("admin-secret"), payload: { name: "Ксения", login: "ksenia", password: "teach-123", email: "ksenia@school.test" } });
  const t = (await app.inject({ method: "POST", url: "/auth/login", payload: { login: "ksenia", password: "teach-123" } })).json().token as string;
  const groupId = (await app.inject({ method: "POST", url: "/school/groups", headers: auth(t), payload: { name: "A1 вечер" } })).json().group.group_id as string;
  const code = (await app.inject({ method: "POST", url: `/school/groups/${groupId}/invites`, headers: auth(t) })).json().code as string;
  return { t, groupId, code };
}

const join_ = (app: FastifyInstance, code: string, extra: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/invites/${code}/join`, payload: { name: "Анна", login: "anna", password: "secret-1", email: "anna@mail.test", ...extra } });

const parentLink = () => {
  const m = mailer.sent.find((x) => x.subject.startsWith("Согласие на занятия"));
  const url = new URL(/https:\/\/moonbridge\.test\/api\/consent\/parent\?t=[\w-]+/.exec(m!.text)![0]);
  return `${url.pathname.replace(/^\/api/, "")}${url.search}`;
};

describe("legal pages and consents", () => {
  it("serves the pages to anyone, for the sign-up's links", async () => {
    const app = await school();
    const list = (await app.inject({ url: "/pages" })).json().pages as { page_id: string; version?: string }[];
    expect(list.map((p) => p.page_id)).toEqual(expect.arrayContaining(["privacy", "terms", "consent", "parent-consent", "faq", "student-guide", "teacher-guide"]));
    expect(list.find((p) => p.page_id === "terms")?.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const faq = await app.inject({ url: "/pages/faq" });
    expect(faq.json().page.body).toContain("пароль");
    expect((await app.inject({ url: "/pages/nope" })).statusCode).toBe(404);
  });

  it("takes the documents with the account and keeps who accepted which edition", async () => {
    const app = await school();
    const { code } = await setup(app);
    const refused = await join_(app, code, {});
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe("accept");

    const joined = await join_(app, code, { accept_terms: true });
    expect(joined.statusCode).toBe(201);
    const dash = (await app.inject({ url: "/school/dashboard", headers: auth(joined.json().token) })).json();
    expect(dash.consent).toMatchObject({ required: false, terms: "ok", minor: false, parent: "not_needed" });
    const { rows } = await sql.query<{ kind: string; method: string; versions: Record<string, string> }>("SELECT kind, method, versions FROM consents");
    expect(rows).toEqual([{ kind: "terms", method: "click", versions: { terms: expect.any(String), privacy: expect.any(String), consent: expect.any(String) } }]);
  });

  it("asks a minor's parent by e-mail and opens the platform once the parent agrees", async () => {
    const app = await school();
    const { code } = await setup(app);
    expect((await join_(app, code, { accept_terms: true, minor: true })).statusCode).toBe(400);
    const joined = await join_(app, code, { accept_terms: true, minor: true, parent_name: "Ольга", parent_email: "olga@mail.test" });
    expect(joined.statusCode).toBe(201);
    const token = joined.json().token as string;

    const dash = (await app.inject({ url: "/school/dashboard", headers: auth(token) })).json();
    expect(dash.consent).toMatchObject({ required: true, terms: "ok", minor: true, parent: "pending", parent_email: "olga@mail.test" });
    // Until then the school is closed to the student.
    const lessons = await app.inject({ url: "/school/lessons", headers: auth(token) });
    expect(lessons.statusCode).toBe(403);
    expect(lessons.json().error).toBe("consent_required");

    const mail = mailer.sent.find((m) => m.to === "olga@mail.test")!;
    expect(mail.text).toContain("Анна");
    const page = await app.inject({ url: parentLink() });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Согласие родителя");
    expect(page.body).toContain("<b>Анна</b>");
    expect(page.body).not.toContain("<script");

    // The box must be ticked; then the link is used up.
    expect((await app.inject({ method: "POST", url: parentLink(), payload: "x=1", headers: { "content-type": "application/x-www-form-urlencoded" } })).statusCode).toBe(400);
    const agreed = await app.inject({ method: "POST", url: parentLink(), payload: "agree=yes", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(agreed.statusCode).toBe(200);
    expect(agreed.body).toContain("Согласие получено");
    expect((await app.inject({ method: "POST", url: parentLink(), payload: "agree=yes", headers: { "content-type": "application/x-www-form-urlencoded" } })).statusCode).toBe(404);

    const after = (await app.inject({ url: "/school/dashboard", headers: auth(token) })).json();
    expect(after.consent).toMatchObject({ required: false, parent: "ok", parent_method: "email" });
    expect((await app.inject({ url: "/school/lessons", headers: auth(token) })).statusCode).toBe(200);
  });

  it("asks again for a new edition, and keeps the earlier acceptance on record", async () => {
    const app = await school();
    const { code } = await setup(app);
    const token = (await join_(app, code, { accept_terms: true })).json().token as string;
    live.bundle.school!.pages.find((p) => p.page_id === "terms")!.version = "2027-01-01";

    expect((await app.inject({ url: "/school/dashboard", headers: auth(token) })).json().consent).toMatchObject({ required: true, terms: "needed" });
    expect((await app.inject({ method: "POST", url: "/account/consent", headers: auth(token), payload: {} })).statusCode).toBe(400);
    const accepted = await app.inject({ method: "POST", url: "/account/consent", headers: auth(token), payload: { accept: true, minor: false } });
    expect(accepted.json().consent).toMatchObject({ required: false, terms: "ok" });
    expect((await sql.query("SELECT 1 FROM consents WHERE kind = 'terms'")).rows).toHaveLength(2);
  });

  it("lets the teacher record a parent's consent signed on paper", async () => {
    const app = await school();
    const { t, groupId, code } = await setup(app);
    const joined = await join_(app, code, { accept_terms: true, minor: true, parent_name: "Ольга", parent_email: "olga@mail.test" });
    const id = joined.json().account.id as string;
    const progress = (await app.inject({ url: `/school/groups/${groupId}/progress`, headers: auth(t) })).json();
    expect(progress.students[0].consent).toEqual({ required: true, minor: true, parent: "pending" });

    const paper = await app.inject({ method: "POST", url: `/school/students/${id}/parent-consent`, headers: auth(t), payload: { parent_name: "Ольга Петрова" } });
    expect(paper.json().consent).toMatchObject({ required: false, parent: "ok", parent_method: "paper" });
    // Only the student's own teacher may.
    const other = await app.inject({ method: "POST", url: "/admin/teachers", headers: auth("admin-secret"), payload: { name: "Ира", login: "ira", password: "teach-123", email: "ira@school.test" } });
    expect(other.statusCode).toBe(201);
    const ira = (await app.inject({ method: "POST", url: "/auth/login", payload: { login: "ira", password: "teach-123" } })).json().token as string;
    expect((await app.inject({ method: "POST", url: `/school/students/${id}/parent-consent`, headers: auth(ira), payload: {} })).statusCode).toBe(404);
  });
});

describe("entry and final tests, the survey", () => {
  it("keeps the tests' answers off the content bundle", async () => {
    const app = await school();
    const bundle = (await app.inject({ url: "/content/bundle" })).json() as ContentBundle;
    expect(bundle.school?.pages.length).toBeGreaterThan(0);
    expect(bundle.school?.assessments).toEqual([]);
    const test = repo.school!.assessments.find((a) => a.kind === "test");
    if (test?.kind !== "test") throw new Error("the content has a test");
    const blind = blindTask({ ...test.tasks[0]!, presentation: { ...test.tasks[0]!.presentation, hint: "I + am" } });
    expect(blind.answer).toEqual({ accepted: [] });
    expect(blind.presentation.hint).toBeUndefined();
  });

  it("is opened by the teacher, taken once without answers on the phone, and scored on the gateway", async () => {
    const app = await school();
    const { t, groupId, code } = await setup(app);
    const s = (await join_(app, code, { accept_terms: true })).json().token as string;
    expect((await app.inject({ url: `/school/assessments/${groupId}/entry`, headers: auth(s) })).statusCode).toBe(404);

    expect((await app.inject({ method: "POST", url: `/school/groups/${groupId}/assessments/entry/open`, headers: auth(t) })).statusCode).toBe(200);
    const dash = (await app.inject({ url: "/school/dashboard", headers: auth(s) })).json();
    expect(dash.assessments).toEqual([expect.objectContaining({ assessment_id: "entry", group_id: groupId, kind: "test", done: false })]);

    const test = (await app.inject({ url: `/school/assessments/${groupId}/entry`, headers: auth(s) })).json().assessment;
    expect(test.tasks.length).toBeGreaterThan(3);
    for (const task of test.tasks) expect(task.answer).toEqual({ accepted: [] });

    const real = repo.school!.assessments.find((a) => a.assessment_id === "entry")!;
    if (real.kind !== "test") throw new Error("entry is a test");
    // Right on all but the last, which is skipped.
    const answers = real.tasks.slice(0, -1).map((x) => ({ task_id: x.task_id, response: x.answer.accepted[0] }));
    const sent = await app.inject({ method: "POST", url: `/school/assessments/${groupId}/entry`, headers: auth(s), payload: { answers } });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toEqual({ ok: true });
    expect((await app.inject({ method: "POST", url: `/school/assessments/${groupId}/entry`, headers: auth(s), payload: { answers } })).statusCode).toBe(409);

    const board = (await app.inject({ url: `/school/groups/${groupId}/assessments`, headers: auth(t) })).json();
    const entry = board.assessments.find((a: { assessment_id: string }) => a.assessment_id === "entry");
    expect(entry).toMatchObject({ state: "open", pair: "final" });
    expect(entry.results[0].result.score).toEqual({ right: real.tasks.length - 1, total: real.tasks.length });

    await app.inject({ method: "POST", url: `/school/groups/${groupId}/assessments/entry/close`, headers: auth(t) });
    expect((await app.inject({ url: "/school/dashboard", headers: auth(s) })).json().assessments).toEqual([]);
  });

  it("checks the survey's required answers", async () => {
    const app = await school();
    const { t, groupId, code } = await setup(app);
    const s = (await join_(app, code, { accept_terms: true })).json().token as string;
    await app.inject({ method: "POST", url: `/school/groups/${groupId}/assessments/pilot_survey/open`, headers: auth(t) });
    const missing = await app.inject({ method: "POST", url: `/school/assessments/${groupId}/pilot_survey`, headers: auth(s), payload: { answers: { overall: 5 } } });
    expect(missing.statusCode).toBe(400);
    const ok = await app.inject({
      method: "POST",
      url: `/school/assessments/${groupId}/pilot_survey`,
      headers: auth(s),
      payload: { answers: { overall: 5, game: 4, time: "10–15 минут", continue: "Да", best: "  Rocco  ", worst: "" } },
    });
    expect(ok.statusCode).toBe(201);
    const board = (await app.inject({ url: `/school/groups/${groupId}/assessments`, headers: auth(t) })).json();
    const survey = board.assessments.find((a: { assessment_id: string }) => a.assessment_id === "pilot_survey");
    expect(survey.results[0].result.answers).toEqual({ overall: 5, game: 4, time: "10–15 минут", continue: "Да", best: "Rocco" });
  });
});

describe("file homework with criteria", () => {
  it("gives a unit's prompt with its rubric and grades by points", async () => {
    const app = await school();
    const { t, groupId, code } = await setup(app);
    const s = (await join_(app, code, { accept_terms: true })).json().token as string;
    const prompt = repo.school!.homework_prompts[0]!;
    const hw = (await app.inject({ method: "POST", url: `/school/groups/${groupId}/homework`, headers: auth(t), payload: { prompt_id: prompt.prompt_id, due_at: null } })).json().homework;
    expect(hw).toMatchObject({ title: prompt.title, description: prompt.instruction_ru, needs_file: true, module_id: null });
    expect(hw.rubric.criteria.length).toBeGreaterThan(1);

    const put = await app.inject({ method: "PUT", url: `/school/homework/${hw.homework_id}/submission?name=voice.m4a`, headers: { ...auth(s), "content-type": "audio/mp4" }, payload: Buffer.from("voice") });
    expect(put.statusCode).toBe(201);
    const sub = put.json().submission.submission_id as string;
    const [first, second] = hw.rubric.criteria as { id: string; max: number }[];
    const tooMany = await app.inject({ method: "POST", url: `/school/submissions/${sub}/review`, headers: auth(t), payload: { grade: 5, scores: { [first!.id]: first!.max + 1 } } });
    expect(tooMany.statusCode).toBe(400);
    const graded = await app.inject({ method: "POST", url: `/school/submissions/${sub}/review`, headers: auth(t), payload: { grade: 4, scores: { [first!.id]: first!.max, [second!.id]: 1, unknown: 3 } } });
    expect(graded.json().submission.review).toMatchObject({ grade: 4, scores: { [first!.id]: first!.max, [second!.id]: 1 } });
    const mine = (await app.inject({ url: "/school/dashboard", headers: auth(s) })).json().homework[0];
    expect(mine.rubric.title).toBeTruthy();
    expect(mine.submission.review.scores[first!.id]).toBe(first!.max);
  });

  it("puts a rubric on the teacher's own file homework, never on a unit", async () => {
    const app = await school();
    const { t, groupId } = await setup(app);
    const own = (await app.inject({ method: "POST", url: `/school/groups/${groupId}/homework`, headers: auth(t), payload: { title: "Рассказ", needs_file: true, rubric_id: "writing", due_at: null } })).json().homework;
    expect(own.rubric.title).toBe("Короткий текст");
    const unit = (await app.inject({ method: "POST", url: `/school/groups/${groupId}/homework`, headers: auth(t), payload: { module_id: repo.modules[0]!.module_id, rubric_id: "writing", due_at: null } })).json().homework;
    expect(unit.rubric).toBeNull();
    expect((await app.inject({ method: "POST", url: `/school/groups/${groupId}/homework`, headers: auth(t), payload: { title: "x", needs_file: true, rubric_id: "nope", due_at: null } })).statusCode).toBe(404);
  });
});
