import { describe, expect, it } from "vitest";
import { attemptOf, conceptErrors, episodeResultOf, isoDuration, parseIsoDuration, XapiProfile, LrsClient, MemoryOutboxStore, Outbox, StatementBuilder, validateStatement, type SendOutcome, type Statement } from "../src/index.js";

const builder = new StatementBuilder(new XapiProfile("https://moonbridge.example.com/"));
const make = (n: number): Statement[] =>
  Array.from({ length: n }, (_, i) =>
    builder.unlocked({ playerId: "p1", placeId: `place_${i}`, moduleId: "A1_PastSimple_01", id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, timestamp: new Date(0) }),
  );

describe("StatementBuilder", () => {
  it("emits valid statements for every verb, with a pseudonymous account actor", () => {
    const common = { playerId: "p1", contentVersion: "A1_PastSimple_01@3", cefrLevel: "A1" };
    const all = [
      builder.launched({ ...common, courseId: "english_a1_a2" }),
      builder.unlocked({ ...common, placeId: "night_cafe", moduleId: "A1_PastSimple_01" }),
      builder.conceptMastered({ ...common, conceptId: "past_simple.irregular", moduleId: "A1_PastSimple_01", retrievability: 0.93456 }),
      builder.moduleResult({ ...common, moduleId: "A1_PastSimple_01", verb: "passed", scoreRaw: 9, scoreMax: 10, courseId: "english_a1_a2" }),
    ];
    for (const s of all) {
      expect(validateStatement(s)).toMatchObject({ ok: true });
      expect(s.actor).toEqual({ objectType: "Agent", account: { homePage: "https://moonbridge.example.com", name: "p1" } });
      expect(s.context?.contextActivities?.category).toEqual([{ id: "https://moonbridge.example.com/xapi/profile/moonbridge-v1" }]);
    }
    expect(all[1]!.verb.id).toBe("https://moonbridge.example.com/xapi/verbs/unlocked");
    expect(all[1]!.object.id).toBe("https://moonbridge.example.com/xapi/moonbridge/places/night_cafe");
    expect(all[2]!.verb.id).toBe("http://adlnet.gov/expapi/verbs/mastered");
    expect(all[3]!.context?.contextActivities?.parent).toEqual([{ id: "https://moonbridge.example.com/xapi/courses/english_a1_a2" }]);
  });

  it("formats durations as ISO 8601", () => {
    expect(isoDuration(8400)).toBe("PT8.4S");
    expect(isoDuration(0)).toBe("PT0S");
    expect(isoDuration(61_000)).toBe("PT1M1S");
    expect(isoDuration(3_600_000)).toBe("PT1H");
  });
});

describe("validateStatement", () => {
  it("rejects email actors, bad ids and out-of-range scores", () => {
    const [s] = make(1);
    expect(validateStatement({ ...s, actor: { mbox: "mailto:a@b.c", account: s!.actor.account } }).ok).toBe(false);
    expect(validateStatement({ ...s, id: "not-a-uuid" }).ok).toBe(false);
    expect(validateStatement({ ...s, result: { score: { raw: 11, min: 0, max: 10 } } }).ok).toBe(false);
    expect(validateStatement({ ...s, verb: { id: "answered" } }).ok).toBe(false);
  });
});

function fakeFetch(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? new Response(null, { status: 204 });
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("LrsClient", () => {
  it("posts to /statements with xAPI headers and basic auth", async () => {
    const f = fakeFetch([new Response(JSON.stringify(["id"]), { status: 200 })]);
    const lrs = new LrsClient({ endpoint: "https://lrs.test/xapi", key: "k", secret: "s", fetch: f.fn });
    expect(await lrs.send(make(1))).toMatchObject({ kind: "sent" });
    const { url, init } = f.calls[0]!;
    expect(url).toBe("https://lrs.test/xapi/statements");
    expect((init.headers as Record<string, string>)["X-Experience-API-Version"]).toBe("1.0.3");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa("k:s")}`);
  });

  it("classifies failures", async () => {
    const f = fakeFetch([
      new Error("ECONNRESET"),
      new Response("busy", { status: 503, headers: { "Retry-After": "7" } }),
      new Response("bad", { status: 400 }),
      new Response("conflict", { status: 409 }),
    ]);
    const lrs = new LrsClient({ endpoint: "https://lrs.test/xapi/", key: "k", secret: "s", fetch: f.fn });
    expect(await lrs.send(make(1))).toMatchObject({ kind: "retry" });
    expect(await lrs.send(make(1))).toEqual({ kind: "retry", reason: "HTTP 503", retryAfterMs: 7000 });
    expect(await lrs.send(make(1))).toMatchObject({ kind: "rejected", status: 400 });
    expect(await lrs.send(make(1))).toMatchObject({ kind: "rejected", status: 409 });
  });
});

describe("Outbox", () => {
  it("delivers offline-queued statements once the network is back, without duplicates", async () => {
    let now = 0;
    let online = false;
    const received = new Map<string, number>();
    const sink = {
      send: async (batch: Statement[]): Promise<SendOutcome> => {
        if (!online) return { kind: "retry", reason: "offline" };
        for (const s of batch) received.set(s.id, (received.get(s.id) ?? 0) + 1);
        return { kind: "sent", ids: batch.map((s) => s.id) };
      },
    };
    const store = new MemoryOutboxStore();
    const outbox = new Outbox(store, sink, { now: () => now, random: () => 1, batchSize: 10 });
    const statements = make(25);

    expect(await outbox.enqueue(statements)).toBe(25);
    expect(await outbox.enqueue(statements.slice(0, 5))).toBe(0); // resend of the same ids is ignored
    expect(await outbox.flush()).toMatchObject({ sent: 0, retried: 10 });

    online = true;
    now += 1000; // still inside the backoff window for the failed batch
    expect((await outbox.flush()).sent).toBe(15);
    now += 60_000;
    expect((await outbox.flush()).sent).toBe(10);

    expect(received.size).toBe(25);
    expect([...received.values()].every((n) => n === 1)).toBe(true);
    expect(await store.pendingCount()).toBe(0);
  });

  it("isolates one rejected statement instead of losing the batch", async () => {
    const statements = make(3);
    const bad = statements[1]!.id;
    const store = new MemoryOutboxStore();
    const outbox = new Outbox(store, {
      send: async (batch) =>
        batch.some((s) => s.id === bad) ? { kind: "rejected", status: 400, reason: "bad" } : { kind: "sent", ids: batch.map((s) => s.id) },
    });
    await outbox.enqueue(statements);
    expect(await outbox.flush()).toEqual({ sent: 2, retried: 0, dead: 1 });
    expect([...store.dead.keys()]).toEqual([bad]);
  });

  it("dead-letters after maxAttempts", async () => {
    let now = 0;
    const store = new MemoryOutboxStore();
    const outbox = new Outbox(store, { send: async () => ({ kind: "retry", reason: "down" }) }, { now: () => now, maxAttempts: 3 });
    await outbox.enqueue(make(1));
    for (let i = 0; i < 3; i++) {
      await outbox.flush();
      now += 3_600_000;
    }
    expect(store.dead.size).toBe(1);
  });
});

describe("conceptErrors", () => {
  it("asks the LRS for answered statements related to the concept and keeps the wrong ones", async () => {
    const profile = new XapiProfile("https://moonbridge.test");
    const b = new StatementBuilder(profile);
    const common = { playerId: "p1", moduleId: "A1_PastSimple_01", conceptId: "past_simple.irregular", interactionType: "fill-in" as const, correctResponses: ["went"], hintUsed: false, attempt: 1, durationMs: 1000 };
    const wrong = b.answered({ ...common, taskId: "A1_PastSimple_01_q3", response: "goed", success: false, errorType: "grammar.overgeneralization", correctForm: "went" });
    const right = b.answered({ ...common, taskId: "A1_PastSimple_01_q4", response: "went", success: true });
    const odd = b.answered({ ...common, taskId: "A1_PastSimple_01_q5", response: "wented", success: false });
    const urls: URL[] = [];
    const lrs = new LrsClient({
      endpoint: "https://lrs.test/xapi/",
      key: "k",
      secret: "s",
      fetch: (async (url: string) => {
        const u = new URL(url);
        urls.push(u);
        return u.searchParams.has("cursor")
          ? Response.json({ statements: [odd], more: "" })
          : Response.json({ statements: [wrong, right], more: "/xapi/statements?cursor=2" });
      }) as typeof fetch,
    });
    const errors = await conceptErrors(lrs, profile, "past_simple.irregular", { since: new Date("2026-10-19T00:00:00Z") });
    expect(Object.fromEntries(urls[0]!.searchParams)).toMatchObject({
      verb: "http://adlnet.gov/expapi/verbs/answered",
      activity: "https://moonbridge.test/xapi/concepts/past_simple.irregular",
      related_activities: "true",
      since: "2026-10-19T00:00:00.000Z",
    });
    expect(urls[1]!.toString()).toBe("https://lrs.test/xapi/statements?cursor=2");
    expect(errors).toEqual([
      expect.objectContaining({ statementId: wrong.id, taskId: "A1_PastSimple_01_q3", response: "goed", errorType: "grammar.overgeneralization", correctForm: "went" }),
      expect.objectContaining({ statementId: odd.id, response: "wented", errorType: "unclassified" }),
    ]);
  });
});

describe("attemptOf", () => {
  const profile = new XapiProfile("https://moonbridge.test");
  const b = new StatementBuilder(profile);
  const common = {
    playerId: "player_1",
    taskId: "A1_T1",
    moduleId: "A1_Unit_01",
    conceptId: "to_be.i_am",
    interactionType: "fill-in" as const,
    correctResponses: ["am"],
    hintUsed: false,
    durationMs: 12_340,
    timestamp: new Date("2026-12-01T10:00:00Z"),
  };

  it("reads a wrong answer back with its error type, try and mode", () => {
    const s = b.answered({ ...common, response: "is", success: false, errorType: "grammar.agreement", attempt: 2, gameContext: { mode: "lost_and_found" } });
    expect(attemptOf(s, profile)).toEqual({
      statementId: s.id,
      playerId: "player_1",
      answeredAt: new Date("2026-12-01T10:00:00Z"),
      taskId: "A1_T1",
      moduleId: "A1_Unit_01",
      conceptId: "to_be.i_am",
      success: false,
      errorType: "grammar.agreement",
      attemptNo: 2,
      durationMs: 12_340,
      mode: "lost_and_found",
    });
  });

  it("marks an unforeseen wrong answer unclassified and ignores other verbs", () => {
    const wrong = attemptOf(b.answered({ ...common, response: "x", success: false, attempt: 1 }), profile)!;
    expect(wrong.errorType).toBe("unclassified");
    const right = attemptOf(b.answered({ ...common, response: "am", success: true, attempt: 1 }), profile)!;
    expect(right.errorType).toBeUndefined();
    expect(attemptOf(b.launched({ playerId: "p", courseId: "c" }), profile)).toBeUndefined();
  });

  it("reads a finished episode back, and refuses a score that makes no sense", () => {
    const s = b.episodeCompleted({ playerId: "player_1", episodeId: "A1_Unit_01_check_in", moduleId: "A1_Unit_01", firstTryRight: 2, tasks: 3, timestamp: new Date("2026-12-01T10:05:00Z") });
    expect(validateStatement(s).ok).toBe(true);
    expect(episodeResultOf(s, profile)).toEqual({
      statementId: s.id,
      playerId: "player_1",
      episodeId: "A1_Unit_01_check_in",
      moduleId: "A1_Unit_01",
      right: 2,
      tasks: 3,
      finishedAt: new Date("2026-12-01T10:05:00Z"),
    });
    const inflated = { ...s, result: { ...s.result, score: { raw: 5, max: 3 } } };
    expect(episodeResultOf(inflated, profile)).toBeUndefined();
    expect(episodeResultOf(b.moduleResult({ playerId: "p", moduleId: "A1_Unit_01", verb: "completed", scoreRaw: 1, scoreMax: 1 }), profile)).toBeUndefined();
  });

  it("parses the durations the builder writes", () => {
    for (const ms of [0, 990, 61_000, 3_725_500]) expect(parseIsoDuration(isoDuration(ms))).toBe(ms);
  });
});
