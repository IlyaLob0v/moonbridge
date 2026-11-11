// The moonbridge-v1 xAPI profile: every verb, activity type and extension IRI the platform
// emits is defined here, so that their meaning cannot drift between client, server
// and analytics. Never change the meaning of an existing IRI; add a new one instead.

export const DEFAULT_BASE_IRI = "https://moonbridge.example.com";

export const ADL_VERBS = {
  answered: "http://adlnet.gov/expapi/verbs/answered",
  launched: "http://adlnet.gov/expapi/verbs/launched",
  completed: "http://adlnet.gov/expapi/verbs/completed",
  passed: "http://adlnet.gov/expapi/verbs/passed",
  failed: "http://adlnet.gov/expapi/verbs/failed",
  mastered: "http://adlnet.gov/expapi/verbs/mastered",
} as const;

export const ACTIVITY_TYPES = {
  interaction: "http://adlnet.gov/expapi/activities/cmi.interaction",
  module: "http://adlnet.gov/expapi/activities/module",
  course: "http://adlnet.gov/expapi/activities/course",
  /** A Moonbridge episode: a scene the student plays through, with tasks inside. */
  episode: "http://adlnet.gov/expapi/activities/simulation",
} as const;

export type VerbKey = keyof typeof ADL_VERBS | "unlocked";
export type ExtensionKey =
  | "error-type"
  | "correct-form"
  | "hint-used"
  | "attempt"
  | "concept"
  | "content-version"
  | "game-context"
  | "cefr-level"
  | "retrievability"
  | "fsrs-rating";

/** IRIs for a deployment. The base IRI should be a domain you control (it identifies your data forever). */
export class XapiProfile {
  constructor(readonly baseIri: string = DEFAULT_BASE_IRI) {
    if (baseIri.endsWith("/")) this.baseIri = baseIri.slice(0, -1);
  }

  get id(): string {
    return `${this.baseIri}/xapi/profile/moonbridge-v1`;
  }

  verb(key: VerbKey): { id: string; display: { "en-US": string } } {
    const id = key in ADL_VERBS ? ADL_VERBS[key as keyof typeof ADL_VERBS] : `${this.baseIri}/xapi/verbs/${key}`;
    return { id, display: { "en-US": key } };
  }

  ext(key: ExtensionKey): string {
    return `${this.baseIri}/xapi/ext/${key}`;
  }

  task(taskId: string): string {
    return `${this.baseIri}/xapi/tasks/${encodeURIComponent(taskId)}`;
  }

  module(moduleId: string): string {
    return `${this.baseIri}/xapi/modules/${encodeURIComponent(moduleId)}`;
  }

  concept(conceptId: string): string {
    return `${this.baseIri}/xapi/concepts/${encodeURIComponent(conceptId)}`;
  }

  course(courseId: string): string {
    return `${this.baseIri}/xapi/courses/${encodeURIComponent(courseId)}`;
  }

  /** A Moonbridge place (reception, Night Café…). */
  place(placeId: string): string {
    return `${this.baseIri}/xapi/moonbridge/places/${encodeURIComponent(placeId)}`;
  }

  /** A Moonbridge episode (one scene of a unit). */
  episode(episodeId: string): string {
    return `${this.baseIri}/xapi/moonbridge/episodes/${encodeURIComponent(episodeId)}`;
  }

  /** "grammar.overgeneralization" → …/xapi/errors/grammar/overgeneralization */
  errorType(errorTypeId: string): string {
    return `${this.baseIri}/xapi/errors/${errorTypeId.split(".").map(encodeURIComponent).join("/")}`;
  }

  /** The actor's account home page: the platform itself, so the actor never carries email or name. */
  get accountHomePage(): string {
    return this.baseIri;
  }
}
