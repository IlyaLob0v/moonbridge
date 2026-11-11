import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, type Sql } from "../src/db/sql.js";
import { DiskFileStore } from "../src/school/files.js";
import { StatementBuilder, XapiProfile } from "@moonbridge/xapi";
import { acceptedType, MAX_UPLOAD_BYTES, weekStart } from "../src/school/routes.js";
import { SchoolStore } from "../src/school/store.js";
import { harness } from "./harness.js";

let pglite: PGlite;
let sql: Sql;
let uploads: string;
let clock = new Date("2026-11-30T09:00:00Z");

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
  await sql.exec("TRUNCATE accounts, school_groups, group_members, invites, homework, submissions, player_progress, attempts CASCADE");
});

async function school() {
  const h = await harness({ school: { store: new SchoolStore(sql), files: new DiskFileStore(uploads), now: () => clock } });
  return h.app;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function teacher(app: FastifyInstance): Promise<string> {
  const created = await app.inject({ method: "POST", url: "/admin/teachers", headers: auth("admin-secret"), payload: { name: "Ксения", login: "Ksenia@School.ru", password: "teach-123" } });
  expect(created.statusCode).toBe(201);
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { login: "ksenia@school.ru", password: "teach-123" } });
  expect(res.statusCode).toBe(200);
  return res.json().token;
}

async function groupWithInvite(app: FastifyInstance, token: string) {
  const g = await app.inject({
    method: "POST",
    url: "/school/groups",
    headers: auth(token),
    payload: { name: "A1 вечер", call_url: "https://telemost.yandex.ru/j/123", schedule: [{ weekday: 2, time: "18:30", minutes: 60 }, { weekday: 4, time: "18:30", minutes: 60 }] },
  });
  expect(g.statusCode).toBe(201);
  const groupId = g.json().group.group_id as string;
  const inv = await app.inject({ method: "POST", url: `/school/groups/${groupId}/invites`, headers: auth(token) });
  expect(inv.statusCode).toBe(201);
  return { groupId, code: inv.json().code as string, url: inv.json().url as string };
}

async function joinGroup(app: FastifyInstance, code: string, login = "anna", headers: Record<string, string> = {}) {
  return app.inject({ method: "POST", url: `/invites/${code}/join`, headers, payload: { name: "Анна", login, password: "secret-1" } });
}

async function homework(app: FastifyInstance, token: string, groupId: string, needsFile = true) {
  const res = await app.inject({
    method: "POST",
    url: `/school/groups/${groupId}/homework`,
    headers: auth(token),
    payload: { title: "Расскажи о себе", description: "Запиши 30 секунд на диктофон.", due_at: "2026-12-03T15:00:00.000Z", needs_file: needsFile },
  });
  expect(res.statusCode).toBe(201);
  return res.json().homework.homework_id as string;
}

function upload(app: FastifyInstance, token: string, homeworkId: string, body: Buffer, type = "audio/mp4", name = "Запись 1.m4a") {
  return app.inject({
    method: "PUT",
    url: `/school/homework/${homeworkId}/submission?name=${encodeURIComponent(name)}`,
    headers: { ...auth(token), "content-type": type },
    payload: body,
  });
}

describe("accounts", () => {
  it("creates teachers only with the admin token and signs them in with a login in any case", async () => {
    const app = await school();
    const anon = await app.inject({ method: "POST", url: "/admin/teachers", payload: { name: "X", login: "x-teacher", password: "teach-123" } });
    expect(anon.statusCode).toBe(401);
    await teacher(app);
    const wrong = await app.inject({ method: "POST", url: "/auth/login", payload: { login: "ksenia@school.ru", password: "nope-nope" } });
    expect(wrong.statusCode).toBe(401);
    const unknown = await app.inject({ method: "POST", url: "/auth/login", payload: { login: "nobody", password: "nope-nope" } });
    expect(unknown.json().message).toBe(wrong.json().message);
  });

  it("tells the client whether guests may play", async () => {
    const app = await school();
    expect((await app.inject({ url: "/auth/options" })).json()).toEqual({ guest: true, password_reset: false });
  });
});

describe("groups and invitations", () => {
  it("lets a student join by the link, then see the group, its schedule and its homework", async () => {
    const app = await school();
    const t = await teacher(app);
    const { groupId, code, url } = await groupWithInvite(app, t);
    expect(url).toBe(`https://app.moonbridge.test/join/${code}`);
    expect((await app.inject({ url: `/invites/${code}` })).json()).toEqual({ group: { name: "A1 вечер", teacher_name: "Ксения" } });

    const joined = await joinGroup(app, code);
    expect(joined.statusCode).toBe(201);
    const s = joined.json().token as string;
    expect(joined.json().account).toMatchObject({ name: "Анна", role: "student", login: "anna" });
    const hw = await homework(app, t, groupId);

    const dash = (await app.inject({ url: "/school/dashboard", headers: auth(s) })).json();
    expect(dash.groups).toEqual([
      { group_id: groupId, name: "A1 вечер", teacher_name: "Ксения", call_url: "https://telemost.yandex.ru/j/123", schedule: [{ weekday: 2, time: "18:30", minutes: 60 }, { weekday: 4, time: "18:30", minutes: 60 }] },
    ]);
    expect(dash.homework).toMatchObject([{ homework_id: hw, title: "Расскажи о себе", needs_file: true, due_at: "2026-12-03T15:00:00.000Z", submission: null }]);

    const teacherView = (await app.inject({ url: "/school/dashboard", headers: auth(t) })).json();
    expect(teacherView.groups[0].members).toEqual([{ id: joined.json().account.id, name: "Анна" }]);
    expect(teacherView.homework[0].submissions).toEqual([]);
  });

  it("refuses an expired invitation, a taken login and a second teacher's group", async () => {
    const app = await school();
    const t = await teacher(app);
    const { groupId, code } = await groupWithInvite(app, t);
    expect((await joinGroup(app, code)).statusCode).toBe(201);
    expect((await joinGroup(app, code)).statusCode).toBe(409);

    await app.inject({ method: "POST", url: "/admin/teachers", headers: auth("admin-secret"), payload: { name: "Другой", login: "other", password: "teach-123" } });
    const other = (await app.inject({ method: "POST", url: "/auth/login", payload: { login: "other", password: "teach-123" } })).json().token;
    expect((await app.inject({ method: "POST", url: `/school/groups/${groupId}/invites`, headers: auth(other) })).statusCode).toBe(404);

    clock = new Date(clock.getTime() + 15 * 24 * 3600_000);
    expect((await app.inject({ url: `/invites/${code}` })).statusCode).toBe(404);
    expect((await joinGroup(app, code, "late")).statusCode).toBe(404);
  });

  it("keeps a guest's progress when the guest joins with an account", async () => {
    const app = await school();
    const t = await teacher(app);
    const { code } = await groupWithInvite(app, t);
    const guest = (await app.inject({ method: "POST", url: "/session/guest" })).json();
    await app.inject({ method: "PUT", url: "/progress/snapshot", headers: auth(guest.token), payload: { saved_at: new Date().toISOString(), snapshot: { moonbridge: { completed_episodes: ["e1"] } } } });

    const joined = await joinGroup(app, code, "anna", auth(guest.token));
    expect(joined.json().player_id).toBe(guest.player_id);

    // On a new phone: sign in, and the hotel is there.
    const again = (await app.inject({ method: "POST", url: "/auth/login", payload: { login: "anna", password: "secret-1" } })).json();
    expect(again.player_id).toBe(guest.player_id);
    const snap = await app.inject({ url: "/progress/snapshot", headers: auth(again.token) });
    expect(snap.json().snapshot).toEqual({ moonbridge: { completed_episodes: ["e1"] } });
  });

  it("adds a signed-in student to a second group without a new account", async () => {
    const app = await school();
    const t = await teacher(app);
    const first = await groupWithInvite(app, t);
    const second = await groupWithInvite(app, t);
    const s = (await joinGroup(app, first.code)).json();
    const res = await app.inject({ method: "POST", url: `/invites/${second.code}/join`, headers: auth(s.token) });
    expect(res.statusCode).toBe(201);
    expect(res.json().account.id).toBe(s.account.id);
    const dash = (await app.inject({ url: "/school/dashboard", headers: auth(s.token) })).json();
    expect(dash.groups.map((g: { group_id: string }) => g.group_id)).toEqual([first.groupId, second.groupId]);
  });

  it("keeps teacher endpoints for teachers", async () => {
    const app = await school();
    const t = await teacher(app);
    const { groupId, code } = await groupWithInvite(app, t);
    const s = (await joinGroup(app, code)).json().token;
    expect((await app.inject({ method: "POST", url: "/school/groups", headers: auth(s), payload: { name: "Моя" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/school/groups/${groupId}/homework`, headers: auth(s), payload: { title: "x", needs_file: false } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/school/dashboard" })).statusCode).toBe(401);
    const patched = await app.inject({ method: "PATCH", url: `/school/groups/${groupId}`, headers: auth(t), payload: { call_url: null } });
    expect(patched.json().group.call_url).toBeNull();
    expect(patched.json().group.schedule).toHaveLength(2);
  });
});

describe("hand-in files", () => {
  it("takes a voice memo from the phone, shows it to the student and lets the teacher download it", async () => {
    const app = await school();
    const t = await teacher(app);
    const { groupId, code } = await groupWithInvite(app, t);
    const s = (await joinGroup(app, code)).json().token;
    const hw = await homework(app, t, groupId);

    const audio = Buffer.alloc(300_000, 7);
    const res = await upload(app, s, hw, audio);
    expect(res.statusCode).toBe(201);
    expect(res.json().submission).toMatchObject({ file_name: "Запись 1.m4a", mime: "audio/mp4", size: 300_000, student_name: "Анна" });

    const mine = (await app.inject({ url: "/school/dashboard", headers: auth(s) })).json().homework[0].submission;
    expect(mine.submission_id).toBe(res.json().submission.submission_id);
    const seen = (await app.inject({ url: "/school/dashboard", headers: auth(t) })).json().homework[0].submissions;
    expect(seen).toHaveLength(1);

    const file = await app.inject({ url: `/school/submissions/${mine.submission_id}/file`, headers: auth(t) });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("audio/mp4");
    expect(file.headers["content-disposition"]).toBe(`attachment; filename="______ 1.m4a"; filename*=UTF-8''${encodeURIComponent("Запись 1.m4a")}`);
    expect(file.rawPayload.equals(audio)).toBe(true);

    // A link the browser can open on its own, without the session header.
    const link = (await app.inject({ method: "POST", url: `/school/submissions/${mine.submission_id}/link`, headers: auth(t) })).json().url as string;
    const viaLink = await app.inject({ url: link });
    expect(viaLink.statusCode).toBe(200);
    expect(viaLink.rawPayload.equals(audio)).toBe(true);
    expect((await app.inject({ url: link.replace(mine.submission_id, "sub_other") })).statusCode).toBe(404);
    expect((await app.inject({ url: `${link}x` })).statusCode).toBe(404);
  });

  it("replaces the file on a second upload and deletes the old one", async () => {
    const app = await school();
    const t = await teacher(app);
    const { groupId, code } = await groupWithInvite(app, t);
    const s = (await joinGroup(app, code)).json().token;
    const hw = await homework(app, t, groupId);
    await upload(app, s, hw, Buffer.from("first"), "image/jpeg", "page.jpg");
    const second = await upload(app, s, hw, Buffer.from("second photo"), "image/jpeg", "page2.jpg");
    expect(second.json().submission).toMatchObject({ file_name: "page2.jpg", size: 12 });
    const dir = join(uploads, "homework", hw);
    const [student] = await readdir(dir);
    expect(await readdir(join(dir, student!))).toHaveLength(1);
  });

  it("refuses files over 50 MB, foreign types, strangers and homework without a file", async () => {
    const app = await school();
    const t = await teacher(app);
    const { groupId, code } = await groupWithInvite(app, t);
    const s = (await joinGroup(app, code)).json().token;
    const hw = await homework(app, t, groupId);

    const big = await upload(app, s, hw, Buffer.alloc(MAX_UPLOAD_BYTES + 1));
    expect(big.statusCode).toBe(413);
    expect((await upload(app, s, hw, Buffer.from("MZ"), "application/x-msdownload", "game.exe")).statusCode).toBe(415);

    const other = await groupWithInvite(app, t);
    const stranger = (await joinGroup(app, other.code, "boris")).json().token;
    expect((await upload(app, stranger, hw, Buffer.from("x"))).statusCode).toBe(404);

    const plain = await homework(app, t, groupId, false);
    expect((await upload(app, s, plain, Buffer.from("x"))).statusCode).toBe(409);

    const ok = await upload(app, s, hw, Buffer.from("x"));
    const id = ok.json().submission.submission_id;
    expect((await app.inject({ url: `/school/submissions/${id}/file`, headers: auth(stranger) })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/school/submissions/${id}/link`, headers: auth(stranger) })).statusCode).toBe(404);
  });

  it("knows a file by its extension when the phone does not say its type", () => {
    expect(acceptedType("application/octet-stream", "voice.M4A")).toBe("audio/mp4");
    expect(acceptedType("", "IMG_0001.HEIC")).toBe("image/heic");
    expect(acceptedType("audio/x-m4a", "x")).toBe("audio/x-m4a");
    expect(acceptedType("application/pdf", "essay")).toBe("application/pdf");
    expect(acceptedType("application/zip", "homework.zip")).toBeUndefined();
  });
});

/** A signed-in student's answers, sent the way the platform sends them. */
async function answer(app: FastifyInstance, student: { token: string; player_id: string }, answers: { at: string; success: boolean; errorType?: string; attempt?: number; mode?: string }[]) {
  const b = new StatementBuilder(new XapiProfile("https://moonbridge.example.com"));
  const statements = answers.map((a) =>
    b.answered({
      playerId: student.player_id,
      taskId: "A1_T1",
      moduleId: "A1_Unit_01",
      conceptId: "to_be.i_am",
      interactionType: "fill-in",
      correctResponses: ["am"],
      response: a.success ? "am" : "is",
      success: a.success,
      ...(a.errorType ? { errorType: a.errorType } : {}),
      hintUsed: false,
      attempt: a.attempt ?? 1,
      durationMs: 30_000,
      timestamp: new Date(a.at),
      ...(a.mode ? { gameContext: { mode: a.mode } } : {}),
    }),
  );
  const res = await app.inject({ method: "POST", url: "/xapi/statements", headers: auth(student.token), payload: statements });
  expect(res.statusCode).toBe(202);
  return statements;
}

describe("the teacher's cabinet", () => {
  it("counts each student's week from their answers: days in Moscow, first-try accuracy, frequent errors", async () => {
    const app = await school();
    const t = await teacher(app);
    const { groupId, code } = await groupWithInvite(app, t);
    const anna = (await joinGroup(app, code)).json();
    const boris = (await joinGroup(app, code, "boris")).json();
    const sent = await answer(app, anna, [
      { at: "2026-11-23T10:00:00Z", success: true }, // the week before
      { at: "2026-11-30T20:59:00Z", success: false, errorType: "grammar.agreement", mode: "moonbridge_episode" }, // Mon 23:59 Moscow
      { at: "2026-11-30T21:01:00Z", success: true, attempt: 2 }, // Tue 00:01 Moscow
      { at: "2026-12-02T08:00:00Z", success: true, mode: "lost_and_found" },
      { at: "2026-12-02T08:01:00Z", success: false, errorType: "grammar.agreement", mode: "lost_and_found" },
      { at: "2026-12-02T08:02:00Z", success: true },
    ]);
    // A resend from the offline queue changes nothing.
    await app.inject({ method: "POST", url: "/xapi/statements", headers: auth(anna.token), payload: sent });

    const progress = (await app.inject({ url: `/school/groups/${groupId}/progress`, headers: auth(t) })).json();
    expect(progress.week).toEqual({ from: "2026-11-30", to: "2026-12-06" });
    const a = progress.students.find((x: { id: string }) => x.id === anna.account.id);
    expect(a.week.days).toEqual(["2026-11-30", "2026-12-01", "2026-12-02"]);
    expect(a.week.answers).toBe(5);
    expect(a.week.accuracy).toBe(50); // 2 of 4 first tries
    expect(a.week.errors).toEqual([{ error_type: "grammar.agreement", label: "Согласование подлежащего и сказуемого", count: 2 }]);
    expect(a.week.modes).toContainEqual({ mode: "lost_and_found", answers: 2, right: 1 });
    const b = progress.students.find((x: { id: string }) => x.id === boris.account.id);
    expect(b.week).toMatchObject({ days: [], answers: 0, accuracy: null });

    const report = (await app.inject({ url: `/school/students/${anna.account.id}/report`, headers: auth(t) })).json();
    expect(report.practice.days).toHaveLength(3);
    expect(report.previous).toEqual({ days: 1, accuracy: 100 });
    const lastWeek = (await app.inject({ url: `/school/students/${anna.account.id}/report?week=2026-11-25`, headers: auth(t) })).json();
    expect(lastWeek.week).toEqual({ from: "2026-11-23", to: "2026-11-29" });
    expect(lastWeek.practice.answers).toBe(1);
  });

  it("shows the student their own report and nobody else's", async () => {
    const app = await school();
    const t = await teacher(app);
    const { code } = await groupWithInvite(app, t);
    const anna = (await joinGroup(app, code)).json();
    const boris = (await joinGroup(app, code, "boris")).json();
    expect((await app.inject({ url: `/school/students/${anna.account.id}/report`, headers: auth(anna.token) })).statusCode).toBe(200);
    expect((await app.inject({ url: `/school/students/${anna.account.id}/report`, headers: auth(boris.token) })).statusCode).toBe(404);
    await app.inject({ method: "POST", url: "/admin/teachers", headers: auth("admin-secret"), payload: { name: "Другой", login: "other", password: "teach-123" } });
    const other = (await app.inject({ method: "POST", url: "/auth/login", payload: { login: "other", password: "teach-123" } })).json().token;
    expect((await app.inject({ url: `/school/students/${anna.account.id}/report`, headers: auth(other) })).statusCode).toBe(404);
  });

  it("queues hand-ins for review; the grade and comment reach the student; a new file waits for a new review", async () => {
    const app = await school();
    const t = await teacher(app);
    const { groupId, code } = await groupWithInvite(app, t);
    const anna = (await joinGroup(app, code)).json();
    const hw = await homework(app, t, groupId);
    const id = (await upload(app, anna.token, hw, Buffer.from("voice"))).json().submission.submission_id;

    const queue = (await app.inject({ url: "/school/review-queue", headers: auth(t) })).json().submissions;
    expect(queue).toMatchObject([{ submission_id: id, student_name: "Анна", homework_title: "Расскажи о себе", review: null }]);
    expect((await app.inject({ method: "POST", url: `/school/submissions/${id}/review`, headers: auth(anna.token), payload: { grade: 5 } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/school/submissions/${id}/review`, headers: auth(t), payload: { grade: 6 } })).statusCode).toBe(400);

    const reviewed = await app.inject({ method: "POST", url: `/school/submissions/${id}/review`, headers: auth(t), payload: { grade: 4, comment: "Хорошо! Следи за am/is." } });
    expect(reviewed.json().submission.review).toEqual({ grade: 4, comment: "Хорошо! Следи за am/is.", reviewed_at: clock.toISOString() });
    expect((await app.inject({ url: "/school/review-queue", headers: auth(t) })).json().submissions).toEqual([]);
    const mine = (await app.inject({ url: "/school/dashboard", headers: auth(anna.token) })).json().homework[0].submission;
    expect(mine.review).toMatchObject({ grade: 4, comment: "Хорошо! Следи за am/is." });
    const report = (await app.inject({ url: `/school/students/${anna.account.id}/report`, headers: auth(t) })).json();
    expect(report.homework[0].submission.review.grade).toBe(4);

    await upload(app, anna.token, hw, Buffer.from("voice, take two"));
    expect((await app.inject({ url: "/school/review-queue", headers: auth(t) })).json().submissions).toHaveLength(1);
    expect((await app.inject({ url: "/school/dashboard", headers: auth(anna.token) })).json().homework[0].submission.review).toBeNull();
  });

  it("lets the student's teacher set a new password, and nobody else", async () => {
    const app = await school();
    const t = await teacher(app);
    const { code } = await groupWithInvite(app, t);
    const anna = (await joinGroup(app, code)).json();
    expect((await app.inject({ method: "POST", url: `/school/students/${anna.account.id}/password`, headers: auth(anna.token) })).statusCode).toBe(403);
    const reset = (await app.inject({ method: "POST", url: `/school/students/${anna.account.id}/password`, headers: auth(t) })).json();
    expect(reset.login).toBe("anna");
    expect(reset.password).toMatch(/^[a-z2-9]{10}$/);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { login: "anna", password: "secret-1" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { login: "anna", password: reset.password } })).statusCode).toBe(200);
  });

  it("starts the week on Monday in Moscow", () => {
    expect(weekStart(new Date("2026-12-06T20:59:00Z")).toISOString()).toBe("2026-11-29T21:00:00.000Z"); // Sun 23:59 MSK
    expect(weekStart(new Date("2026-12-06T21:00:00Z")).toISOString()).toBe("2026-12-06T21:00:00.000Z"); // Mon 00:00 MSK
  });
});

describe("the pilot", () => {
  it("counts the group's metrics from the week of its first answer, or from the day the teacher sets", async () => {
    const app = await school();
    const t = await teacher(app);
    const { groupId, code } = await groupWithInvite(app, t);
    const anna = (await joinGroup(app, code)).json();
    await joinGroup(app, code, "boris");
    clock = new Date("2026-12-09T09:00:00Z");
    await answer(app, anna, [
      { at: "2026-12-01T15:00:00Z", success: true, mode: "lost_and_found" },
      { at: "2026-12-01T15:01:00Z", success: false, errorType: "grammar.agreement", mode: "lost_and_found" },
      { at: "2026-12-08T15:00:00Z", success: true },
    ]);

    const res = await app.inject({ url: `/school/groups/${groupId}/metrics`, headers: auth(t) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.group).toEqual({ id: groupId, name: "A1 вечер" });
    expect(body.pilot_from).toBeNull();
    expect(body.metrics.from).toBe("2026-11-30");
    expect(body.metrics.weeks.map((w: { active: number }) => w.active)).toEqual([1, 1]);
    expect(body.metrics.summary.lostReturned).toMatchObject({ returned: 1, offered: 2, value: 50, status: "below" });
    expect(body.metrics.summary.active).toMatchObject({ week: 1, students: 1, of: 2 });

    expect((await app.inject({ method: "PUT", url: `/school/groups/${groupId}/pilot`, headers: auth(t), payload: { from: "2026-12-10" } })).statusCode).toBe(200);
    const moved = (await app.inject({ url: `/school/groups/${groupId}/metrics`, headers: auth(t) })).json();
    expect(moved.pilot_from).toBe("2026-12-10");
    expect(moved.metrics.from).toBe("2026-12-07");
    expect(moved.metrics.weeks).toHaveLength(1);

    expect((await app.inject({ method: "PUT", url: `/school/groups/${groupId}/pilot`, headers: auth(t), payload: { from: "10.12.2026" } })).statusCode).toBe(400);
    expect((await app.inject({ url: `/school/groups/${groupId}/metrics`, headers: auth(anna.token) })).statusCode).toBe(403);
  });

  it("takes a tester's report and shows it to their teacher and to the admin", async () => {
    const app = await school();
    const t = await teacher(app);
    const { groupId, code } = await groupWithInvite(app, t);
    const anna = (await joinGroup(app, code)).json();
    expect((await app.inject({ method: "POST", url: "/feedback", payload: { message: "x", page: "/" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/feedback", headers: auth(anna.token), payload: { message: "   ", page: "/" } })).statusCode).toBe(400);
    const sent = await app.inject({
      method: "POST",
      url: "/feedback",
      headers: { ...auth(anna.token), "user-agent": "Mozilla/5.0 (iPhone)" },
      payload: { message: "Кнопка «Дальше» не нажимается", page: "/moonbridge" },
    });
    expect(sent.statusCode).toBe(201);

    const metrics = (await app.inject({ url: `/school/groups/${groupId}/metrics`, headers: auth(t) })).json();
    expect(metrics.feedback).toMatchObject([{ name: "Анна", role: "student", page: "/moonbridge", message: "Кнопка «Дальше» не нажимается", user_agent: "Mozilla/5.0 (iPhone)" }]);
    expect((await app.inject({ url: "/admin/feedback" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/admin/feedback", headers: auth("admin-secret") })).json().feedback).toHaveLength(1);
  });
});
