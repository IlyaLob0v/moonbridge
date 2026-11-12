import type { Episode, EpisodeStep } from "@moonbridge/content";

export type TaskStep = Extract<EpisodeStep, { kind: "task" }>;
export type LineStep = Extract<EpisodeStep, { kind: "line" }>;

/**
 * Walks an episode's steps. It knows nothing about the screen or about answers: the
 * player shows the current step and reports "next" for a line or the outcome of a task.
 * Without an explicit target a step falls through to the one below it, exactly as the
 * validator reads the episode.
 */
export class EpisodeRunner {
  private index = 0;
  private readonly byId: Map<string, number>;
  /** Step ids in the order they were shown, revisits included. */
  readonly path: string[] = [];
  /** Task step id → whether the last answer to it was right. */
  readonly results = new Map<string, boolean>();

  constructor(readonly episode: Episode) {
    this.byId = new Map(episode.steps.map((s, i) => [s.id, i]));
    this.path.push(this.current.id);
  }

  get current(): EpisodeStep {
    return this.episode.steps[this.index]!;
  }

  get finished(): boolean {
    return this.current.kind === "end";
  }

  /** After a line, or once the stage has moved to a scene step's place. */
  next(): EpisodeStep {
    const step = this.current;
    if (step.kind !== "line" && step.kind !== "scene") throw new Error(`step "${step.id}" is a ${step.kind}, not a line or a scene`);
    return this.go(step.next);
  }

  /** After a task: the right answer and the wrong one may lead to different scenes. */
  answer(correct: boolean): EpisodeStep {
    const step = this.current;
    if (step.kind !== "task") throw new Error(`step "${step.id}" is a ${step.kind}, not a task`);
    this.results.set(step.id, correct);
    return this.go(correct ? step.on_correct : step.on_wrong);
  }

  private go(target: string | undefined): EpisodeStep {
    const to = target === undefined ? this.index + 1 : this.byId.get(target);
    if (to === undefined || to >= this.episode.steps.length) throw new Error(`episode "${this.episode.episode_id}": no step "${target ?? this.index + 1}"`);
    this.index = to;
    this.path.push(this.current.id);
    return this.current;
  }
}
