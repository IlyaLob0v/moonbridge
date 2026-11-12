import type { ContentBundle, Task } from "@moonbridge/content";
import {
  ConceptScheduler,
  LearningEngine,
  medianDurations,
  RepeatSchedule,
  type AttemptJournal,
  type RepeatItem,
  type Response,
  type StoredConceptCard,
  type SubmitResult,
} from "@moonbridge/learning";
import { Outbox, StatementBuilder, XapiProfile, type OutboxStore, type StatementSink } from "@moonbridge/xapi";
import type { KeyValue } from "../storage/idb.js";

export interface LearnerDeps {
  bundle: ContentBundle;
  playerId: string;
  registration: string;
  xapiBaseIri: string;
  kv: KeyValue;
  journal: AttemptJournal;
  outboxStore: OutboxStore;
  sink: StatementSink;
  now?: () => Date;
}

const KEYS = { cards: "fsrs-cards", repeats: "repeats" } as const;

/**
 * The platform's learning core in the browser: every answer, from Moonbridge or from
 * homework, goes through here into one journal, one FSRS state, one 1/3/7 schedule and
 * one xAPI outbox. Sections only show tasks and react to the outcome.
 */
export class Learner {
  readonly outbox: Outbox;
  readonly scheduler: ConceptScheduler;
  readonly repeats: RepeatSchedule;
  private readonly engine: LearningEngine;
  private readonly builder: StatementBuilder;
  private readonly attemptNo = new Map<string, number>();

  private constructor(private readonly d: LearnerDeps, cards: StoredConceptCard[], repeats: RepeatItem[]) {
    this.scheduler = new ConceptScheduler({}, cards);
    this.repeats = new RepeatSchedule({}, repeats);
    this.outbox = new Outbox(d.outboxStore, d.sink);
    this.builder = new StatementBuilder(new XapiProfile(d.xapiBaseIri));
    this.engine = new LearningEngine({
      bundle: d.bundle,
      playerId: d.playerId,
      registration: d.registration,
      scheduler: this.scheduler,
      repeats: this.repeats,
      journal: d.journal,
      queue: this.outbox,
      builder: this.builder,
      ...(d.now ? { now: d.now } : {}),
    });
  }

  static async load(d: LearnerDeps): Promise<Learner> {
    const cards = (await d.kv.get<StoredConceptCard[]>(KEYS.cards)) ?? [];
    const repeats = (await d.kv.get<RepeatItem[]>(KEYS.repeats)) ?? [];
    return new Learner(d, cards, repeats);
  }

  get bundle(): ContentBundle {
    return this.d.bundle;
  }

  task(taskId: string): Task {
    return this.engine.task(taskId);
  }

  /** Checks an answer, records it everywhere and saves the schedules. `context` lands in xAPI game-context. */
  async answer(taskId: string, a: { response: Response; hintUsed: boolean; durationMs: number }, context?: Record<string, unknown>): Promise<SubmitResult> {
    const attemptNo = (this.attemptNo.get(taskId) ?? 0) + 1;
    this.attemptNo.set(taskId, attemptNo);
    const result = await this.engine.submit({ taskId, ...a, attemptNo, ...(context ? { gameContext: context } : {}) });
    await this.d.kv.set(KEYS.cards, this.scheduler.toJSON());
    await this.d.kv.set(KEYS.repeats, this.repeats.toJSON());
    return result;
  }

  /** What planning needs from the journal: when each task was last shown, and the student's pace per concept. */
  async pace(): Promise<{ lastSeen: Map<string, number>; medians: Map<string, number> }> {
    const attempts = await this.d.journal.all();
    const lastSeen = new Map<string, number>();
    for (const a of attempts) lastSeen.set(a.task_id, Math.max(lastSeen.get(a.task_id) ?? 0, Date.parse(a.timestamp)));
    return { lastSeen, medians: medianDurations(attempts) };
  }

  /** Each task the student has answered, and whether the latest answer was right: the town map lights windows with it. */
  async taskResults(): Promise<Map<string, boolean>> {
    const latest = new Map<string, { at: number; right: boolean }>();
    for (const a of await this.d.journal.all()) {
      const at = Date.parse(a.timestamp);
      const before = latest.get(a.task_id);
      if (!before || at >= before.at) latest.set(a.task_id, { at, right: a.correct });
    }
    return new Map([...latest].map(([id, r]) => [id, r.right]));
  }

  /** The school day of a moment, in the same calendar as the 1/3/7 schedule. */
  day(at: Date = this.now()): number {
    return this.repeats.day(at);
  }

  now(): Date {
    return this.d.now?.() ?? new Date();
  }

  /** A new scene or session: attempt numbers start again from 1. */
  resetAttempts(): void {
    this.attemptNo.clear();
  }

  /**
   * A Moonbridge episode played to its end. The statement goes through the same offline queue
   * as the answers; the school counts it towards a unit given as homework.
   */
  async episodeCompleted(e: { episodeId: string; moduleId: string; firstTryRight: number; tasks: number; durationMs: number }): Promise<void> {
    const module = this.d.bundle.modules.find((m) => m.module_id === e.moduleId);
    await this.outbox.enqueue([
      this.builder.episodeCompleted({
        playerId: this.d.playerId,
        registration: this.d.registration,
        timestamp: this.now(),
        ...(module ? { contentVersion: `${module.module_id}@${module.version}`, cefrLevel: module.cefr_level } : {}),
        episodeId: e.episodeId,
        moduleId: e.moduleId,
        firstTryRight: e.firstTryRight,
        tasks: e.tasks,
        durationMs: e.durationMs,
      }),
    ]);
  }

  /** Sends what the outbox holds; never throws, the outbox retries on its own schedule. */
  async sync(): Promise<void> {
    await this.outbox.flush().catch((e) => console.warn("xAPI sync: will retry", e));
  }
}
