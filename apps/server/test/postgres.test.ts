import { PGlite } from "@electric-sql/pglite";
import { StatementBuilder } from "@moonbridge/xapi";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, type Sql } from "../src/db/sql.js";
import { PgGradeStore, PgIdentityStore, PgLoginStates, PgOutboxStore, PgProgressStore, PgScoreStore } from "../src/db/stores.js";
import type { GradeJob } from "../src/grades.js";
import { harness, idToken, launch, login, sessionFrom } from "./harness.js";

// The Postgres stores against real Postgres SQL (PGlite: Postgres compiled to WASM, in-process).
let pglite: PGlite;
let sql: Sql;

beforeAll(async () => {
  pglite = new PGlite();
  sql = { query: (text, params) => pglite.query(text, params), exec: (text) => pglite.exec(text) } as Sql;
  expect(await migrate(sql)).toEqual(["001_init.sql", "002_school.sql", "003_review.sql", "004_content.sql", "005_pilot.sql", "006_email.sql"]);
});

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  await sql.exec("TRUNCATE lti_identities, lti_login_states, module_scores, grade_outbox, xapi_outbox, player_progress");
});

const stores = () => ({
  loginStates: new PgLoginStates(sql),
  identities: new PgIdentityStore(sql),
  scores: new PgScoreStore(sql),
  progress: new PgProgressStore(sql),
  outboxStore: new PgOutboxStore(sql),
  gradeStore: new PgGradeStore(sql),
});

describe("migrations", () => {
  it("apply once", async () => {
    expect(await migrate(sql)).toEqual([]);
  });
});

describe("LTI over Postgres", () => {
  it("finishes a launch on a restarted gateway and keeps the LMS user's player", async () => {
    const before = await harness(stores());
    const { state, nonce } = await login(before.app);
    await before.app.close();

    // A new process: the login state and the identity link come from the database.
    const after = await harness(stores());
    const first = decodeJwt(sessionFrom((await launch(after.app, { id_token: await idToken(nonce), state })).body)).sub;
    expect((await launch(after.app, { id_token: await idToken(nonce), state })).json().error).toBe("launch.state");

    const again = await login(after.app);
    const second = decodeJwt(sessionFrom((await launch(after.app, { id_token: await idToken(again.nonce), state: again.state })).body)).sub;
    expect(second).toBe(first);
    expect((await sql.query("SELECT * FROM lti_identities")).rows).toHaveLength(1);
  });

  it("expires login states", async () => {
    let now = 1_000_000;
    const states = new PgLoginStates(sql, 1000, () => now);
    const { state } = await states.create("https://moodle.test", "c");
    now += 1001;
    expect(await states.consume(state)).toBeUndefined();
  });

  it("queues a grade through an LMS outage and sends it once it is back", async () => {
    const h = await harness(stores());
    const { state, nonce } = await login(h.app);
    const token = sessionFrom((await launch(h.app, { id_token: await idToken(nonce), state })).body);
    const post = (correct: number) =>
      h.app.inject({ method: "POST", url: "/progress/module-result", headers: { authorization: `Bearer ${token}` }, payload: { module_id: "A1_PastSimple_01", correct, total: 10 } });

    h.lms.down = true;
    expect((await post(7)).json()).toMatchObject({ lms: "queued", best: 0.7 });
    expect((await post(9)).json()).toMatchObject({ lms: "queued", best: 0.9 });
    const [row] = (await sql.query<{ score_given: number; status: string; attempts: number }>("SELECT score_given, status, attempts FROM grade_outbox")).rows;
    expect(row).toMatchObject({ score_given: 90, status: "pending", attempts: 1 });

    h.lms.down = false;
    expect(await h.grades.flush()).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect((await post(5)).json()).toMatchObject({ lms: "not_improved", best: 0.9 });
    const scores = h.agsCalls.filter((c) => c.url.includes("/scores")).map((c) => JSON.parse(c.init.body as string).scoreGiven);
    expect(scores).toEqual([90]);
  });
});

describe("Postgres stores", () => {
  it("keeps the best score per player and module", async () => {
    const scores = new PgScoreStore(sql);
    expect(await scores.record("p1", "m1", 0.5)).toEqual({ best: 0.5, improved: true });
    expect(await scores.record("p1", "m1", 0.4)).toEqual({ best: 0.5, improved: false });
    expect(await scores.record("p1", "m1", 0.8)).toEqual({ best: 0.8, improved: true });
    expect(await scores.record("p2", "m1", 0.1)).toEqual({ best: 0.1, improved: true });
  });

  it("deduplicates xAPI statements by id, also after they were sent", async () => {
    const outbox = new PgOutboxStore(sql);
    const b = new StatementBuilder();
    const [a, c] = [b.unlocked({ playerId: "p1", placeId: "reception", moduleId: "A1_VerbToBe_01" }), b.unlocked({ playerId: "p1", placeId: "reception", moduleId: "A1_VerbToBe_01" })];
    expect(await outbox.enqueue([a, c], 1000)).toBe(2);
    expect(await outbox.enqueue([a], 1000)).toBe(0);
    expect((await outbox.due(1000, 10)).map((e) => e.statement.id)).toEqual([a.id, c.id]);

    await outbox.markSent([a.id]);
    await outbox.reschedule([c.id], 5000, "HTTP 503");
    expect(await outbox.enqueue([a], 2000)).toBe(0);
    expect(await outbox.due(2000, 10)).toEqual([]);
    expect(await outbox.due(5000, 10)).toMatchObject([{ attempts: 1, lastError: "HTTP 503", nextAttemptAt: 5000 }]);
    expect(await outbox.pendingCount()).toBe(1);
    await outbox.markDead([c.id], "HTTP 400");
    expect(await outbox.pendingCount()).toBe(0);
  });

  it("replaces a pending grade with a better one and never resends an accepted score", async () => {
    const grades = new PgGradeStore(sql);
    const job: GradeJob = { playerId: "p1", moduleId: "m1", contextKey: "k", label: "M1", scoreGiven: 60, iss: "i", clientId: "c", sub: "s", ags: { scope: [] } };
    expect(await grades.offer(job, 0)).toBe(true);
    const [due] = await grades.due(0, 10);
    await grades.offer({ ...job, scoreGiven: 80 }, 0);
    await grades.markSent(due!); // the 60 went out, but 80 is now queued: it stays pending
    expect((await grades.due(0, 10)).map((g) => g.scoreGiven)).toEqual([80]);
    await grades.markSent({ ...job, scoreGiven: 80, attempts: 0 });
    expect(await grades.due(0, 10)).toEqual([]);
    expect(await grades.offer({ ...job, scoreGiven: 80 }, 0)).toBe(false);
  });

  it("keeps the newest progress snapshot", async () => {
    const progress = new PgProgressStore(sql);
    expect(await progress.get("p1")).toBeUndefined();
    const t1 = new Date("2026-10-26T10:00:00Z");
    expect(await progress.put("p1", { xp: 1 }, t1)).toEqual({ accepted: true, savedAt: t1 });
    expect(await progress.put("p1", { xp: 0 }, new Date("2026-10-26T09:00:00Z"))).toEqual({ accepted: false, savedAt: t1 });
    expect(await progress.get("p1")).toEqual({ snapshot: { xp: 1 }, savedAt: t1 });
  });
});
