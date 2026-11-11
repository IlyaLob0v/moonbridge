import { ACTIVITY_TYPES, XapiProfile } from "./profile.js";
import type { Activity, ActivityDefinition, Context, Statement } from "./types.js";

/** ISO 8601 duration with centisecond precision, as recommended by xAPI 1.0.3. */
export function isoDuration(ms: number): string {
  const totalCs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(totalCs / 360000);
  const m = Math.floor((totalCs % 360000) / 6000);
  const s = (totalCs % 6000) / 100;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s || (!h && !m) ? `${s}S` : ""}`;
}

export interface Common {
  /** Pseudonymous player id. Never an email or a real name: those stay in the LMS. */
  playerId: string;
  /** Statement id. Pass a stable id (e.g. the attempt id) so a resend from the offline queue is idempotent. */
  id?: string;
  timestamp?: Date;
  /** One play session, or one LTI launch. */
  registration?: string;
  /** "<module_id>@<version>" or the bundle hash: lets analytics tell old task wording from new. */
  contentVersion?: string;
  cefrLevel?: string;
  gameContext?: Record<string, unknown>;
}

export interface AnsweredInput extends Common {
  taskId: string;
  moduleId: string;
  conceptId: string;
  interactionType: NonNullable<ActivityDefinition["interactionType"]>;
  correctResponses: string[];
  response: string;
  success: boolean;
  errorType?: string;
  correctForm?: string;
  hintUsed: boolean;
  attempt: number;
  durationMs: number;
  fsrsRating?: number;
}

export interface ModuleResultInput extends Common {
  moduleId: string;
  verb: "passed" | "failed" | "completed";
  scoreRaw: number;
  scoreMax: number;
  durationMs?: number;
  courseId?: string;
}

/** A Moonbridge episode played to its end, scored by the tasks answered right on the first try. */
export interface EpisodeCompletedInput extends Common {
  episodeId: string;
  moduleId: string;
  firstTryRight: number;
  tasks: number;
  durationMs?: number;
}

/**
 * Builds xAPI statements for the moonbridge-v1 profile. Pure: no I/O, no clock unless
 * no timestamp is passed. The same builder runs in the browser and on the server.
 */
export class StatementBuilder {
  constructor(readonly profile: XapiProfile = new XapiProfile()) {}

  answered(i: AnsweredInput): Statement {
    const p = this.profile;
    const ext: Record<string, unknown> = {
      [p.ext("hint-used")]: i.hintUsed,
      [p.ext("attempt")]: i.attempt,
    };
    if (i.errorType) ext[p.ext("error-type")] = p.errorType(i.errorType);
    if (i.correctForm !== undefined) ext[p.ext("correct-form")] = i.correctForm;
    if (i.fsrsRating !== undefined) ext[p.ext("fsrs-rating")] = i.fsrsRating;
    return this.base(i, "answered", {
      objectType: "Activity",
      id: p.task(i.taskId),
      definition: {
        type: ACTIVITY_TYPES.interaction,
        interactionType: i.interactionType,
        correctResponsesPattern: i.correctResponses,
      },
    }, {
      parent: [{ id: p.module(i.moduleId) }],
      grouping: [{ id: p.concept(i.conceptId) }],
    }, {
      success: i.success,
      response: i.response,
      duration: isoDuration(i.durationMs),
      extensions: ext,
    });
  }

  moduleResult(i: ModuleResultInput): Statement {
    const p = this.profile;
    return this.base(i, i.verb, {
      objectType: "Activity",
      id: p.module(i.moduleId),
      definition: { type: ACTIVITY_TYPES.module },
    }, i.courseId ? { parent: [{ id: p.course(i.courseId) }] } : {}, {
      success: i.verb === "passed" ? true : i.verb === "failed" ? false : undefined,
      completion: true,
      score: { raw: i.scoreRaw, min: 0, max: i.scoreMax, scaled: i.scoreMax > 0 ? round4(i.scoreRaw / i.scoreMax) : 0 },
      ...(i.durationMs !== undefined ? { duration: isoDuration(i.durationMs) } : {}),
    });
  }

  conceptMastered(i: Common & { conceptId: string; moduleId: string; retrievability: number }): Statement {
    const p = this.profile;
    return this.base(i, "mastered", { objectType: "Activity", id: p.concept(i.conceptId) },
      { parent: [{ id: p.module(i.moduleId) }] },
      { extensions: { [p.ext("retrievability")]: round4(i.retrievability) } });
  }

  launched(i: Common & { courseId: string }): Statement {
    return this.base(i, "launched", {
      objectType: "Activity",
      id: this.profile.course(i.courseId),
      definition: { type: ACTIVITY_TYPES.course },
    }, {});
  }

  /** The school counts these towards a unit given as homework (apps/server/src/school/units.ts). */
  episodeCompleted(i: EpisodeCompletedInput): Statement {
    const p = this.profile;
    return this.base(i, "completed", {
      objectType: "Activity",
      id: p.episode(i.episodeId),
      definition: { type: ACTIVITY_TYPES.episode },
    }, { parent: [{ id: p.module(i.moduleId) }] }, {
      completion: true,
      score: { raw: i.firstTryRight, min: 0, max: i.tasks, scaled: i.tasks > 0 ? round4(i.firstTryRight / i.tasks) : 1 },
      ...(i.durationMs !== undefined ? { duration: isoDuration(i.durationMs) } : {}),
    });
  }

  /** A Moonbridge place opened for the student: they reached the unit that unlocks it. */
  unlocked(i: Common & { placeId: string; moduleId: string }): Statement {
    const p = this.profile;
    return this.base(i, "unlocked", { objectType: "Activity", id: p.place(i.placeId) }, { parent: [{ id: p.module(i.moduleId) }] });
  }

  private base(
    c: Common,
    verb: Parameters<XapiProfile["verb"]>[0],
    object: Activity,
    contextActivities: NonNullable<Context["contextActivities"]>,
    result?: Statement["result"],
  ): Statement {
    const p = this.profile;
    const ctxExt: Record<string, unknown> = {};
    if (c.contentVersion) ctxExt[p.ext("content-version")] = c.contentVersion;
    if (c.cefrLevel) ctxExt[p.ext("cefr-level")] = c.cefrLevel;
    if (c.gameContext) ctxExt[p.ext("game-context")] = c.gameContext;
    const context: Context = {
      ...(c.registration ? { registration: c.registration } : {}),
      contextActivities: { ...contextActivities, category: [{ id: p.id }] },
      platform: "moonbridge",
      ...(Object.keys(ctxExt).length ? { extensions: ctxExt } : {}),
    };
    const statement: Statement = {
      id: c.id ?? crypto.randomUUID(),
      actor: { objectType: "Agent", account: { homePage: p.accountHomePage, name: c.playerId } },
      verb: p.verb(verb),
      object,
      context,
      timestamp: (c.timestamp ?? new Date()).toISOString(),
    };
    if (result) statement.result = stripUndefined(result);
    return statement;
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** The inverse of isoDuration for the durations this profile writes (hours, minutes, seconds). */
export function parseIsoDuration(d: string | undefined): number | undefined {
  const m = d ? /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(d) : null;
  if (!m) return undefined;
  return Math.round((Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000);
}
