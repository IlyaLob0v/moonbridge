import { parseIsoDuration } from "./builder.js";
import { ADL_VERBS, type XapiProfile } from "./profile.js";
import type { LrsClient } from "./lrs-client.js";
import type { Statement } from "./types.js";

export interface ConceptError {
  statementId: string;
  playerId: string;
  taskId: string;
  response: string;
  /** Error type id from the taxonomy, e.g. grammar.overgeneralization; unclassified when the author did not foresee the answer. */
  errorType: string;
  correctForm?: string;
  timestamp: string;
}

/**
 * The wrong answers on one concept in a time window, straight from the LRS: the
 * concept rides in context.contextActivities.grouping of every `answered` statement,
 * so `related_activities` finds them whatever task asked about it.
 */
export async function conceptErrors(
  lrs: Pick<LrsClient, "query">,
  profile: XapiProfile,
  conceptId: string,
  window: { since: Date; until?: Date; playerId?: string },
): Promise<ConceptError[]> {
  const statements = await lrs.query({
    verb: ADL_VERBS.answered,
    activity: profile.concept(conceptId),
    related_activities: true,
    since: window.since.toISOString(),
    ...(window.until ? { until: window.until.toISOString() } : {}),
    ...(window.playerId ? { agent: { objectType: "Agent", account: { homePage: profile.accountHomePage, name: window.playerId } } } : {}),
    ascending: true,
  });
  const errorPrefix = `${profile.baseIri}/xapi/errors/`;
  return statements
    .filter((s) => s.result?.success === false)
    .map((s: Statement) => {
      const ext = s.result?.extensions ?? {};
      const errorIri = ext[profile.ext("error-type")];
      const correct = ext[profile.ext("correct-form")];
      return {
        statementId: s.id,
        playerId: s.actor.account.name,
        taskId: decodeURIComponent(s.object.id.split("/").pop() ?? ""),
        response: s.result?.response ?? "",
        errorType: typeof errorIri === "string" && errorIri.startsWith(errorPrefix) ? errorIri.slice(errorPrefix.length).split("/").map(decodeURIComponent).join(".") : "unclassified",
        ...(typeof correct === "string" ? { correctForm: correct } : {}),
        timestamp: s.timestamp ?? "",
      };
    });
}

/** One answer, as the gateway keeps it for the teacher's cabinet. */
export interface Attempt {
  statementId: string;
  playerId: string;
  answeredAt: Date;
  taskId: string;
  moduleId: string;
  conceptId: string;
  success: boolean;
  /** Undefined for a right answer; "unclassified" for a wrong one nobody foresaw. */
  errorType?: string;
  /** 1 for the first try at the task in a session. */
  attemptNo: number;
  durationMs: number;
  /** Where it was answered: moonbridge_episode, lost_and_found, guest_of_the_day… */
  mode?: string;
}

function lastSegment(iri: string | undefined, prefix: string): string | undefined {
  return iri?.startsWith(prefix) ? decodeURIComponent(iri.slice(prefix.length)) : undefined;
}

/** Reads an `answered` statement of this profile back into an attempt; undefined for any other statement. */
export function attemptOf(s: Statement, profile: XapiProfile): Attempt | undefined {
  if (s.verb.id !== ADL_VERBS.answered || !s.result) return undefined;
  const base = profile.baseIri;
  const taskId = lastSegment(s.object.id, `${base}/xapi/tasks/`);
  const moduleId = lastSegment(s.context?.contextActivities?.parent?.[0]?.id, `${base}/xapi/modules/`);
  const conceptId = lastSegment(s.context?.contextActivities?.grouping?.[0]?.id, `${base}/xapi/concepts/`);
  if (!taskId || !moduleId || !conceptId || typeof s.result.success !== "boolean") return undefined;
  const ext = s.result.extensions ?? {};
  const errorIri = ext[profile.ext("error-type")];
  const errorPrefix = `${base}/xapi/errors/`;
  const game = s.context?.extensions?.[profile.ext("game-context")] as { mode?: unknown } | undefined;
  const attempt = Number(ext[profile.ext("attempt")]);
  return {
    statementId: s.id,
    playerId: s.actor.account.name,
    answeredAt: new Date(s.timestamp ?? Date.now()),
    taskId,
    moduleId,
    conceptId,
    success: s.result.success,
    ...(!s.result.success
      ? { errorType: typeof errorIri === "string" && errorIri.startsWith(errorPrefix) ? errorIri.slice(errorPrefix.length).split("/").map(decodeURIComponent).join(".") : "unclassified" }
      : {}),
    attemptNo: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
    durationMs: parseIsoDuration(s.result.duration) ?? 0,
    ...(typeof game?.mode === "string" ? { mode: game.mode } : {}),
  };
}

/** A finished Moonbridge episode, as the gateway keeps it for homework. */
export interface EpisodeResult {
  statementId: string;
  playerId: string;
  episodeId: string;
  /** The unit the client says the episode belongs to; the gateway checks it against the live content. */
  moduleId: string;
  /** Tasks answered right on the first try, out of `tasks`. */
  right: number;
  tasks: number;
  finishedAt: Date;
}

/** Reads a `completed` episode statement back; undefined for any other statement or a score that makes no sense. */
export function episodeResultOf(s: Statement, profile: XapiProfile): EpisodeResult | undefined {
  if (s.verb.id !== ADL_VERBS.completed) return undefined;
  const base = profile.baseIri;
  const episodeId = lastSegment(s.object.id, `${base}/xapi/moonbridge/episodes/`);
  const moduleId = lastSegment(s.context?.contextActivities?.parent?.[0]?.id, `${base}/xapi/modules/`);
  const right = s.result?.score?.raw;
  const tasks = s.result?.score?.max;
  if (!episodeId || !moduleId || !Number.isInteger(right) || !Number.isInteger(tasks)) return undefined;
  if (right! < 0 || tasks! < 0 || right! > tasks! || tasks! > 1000) return undefined;
  return { statementId: s.id, playerId: s.actor.account.name, episodeId, moduleId, right: right!, tasks: tasks!, finishedAt: new Date(s.timestamp ?? Date.now()) };
}
