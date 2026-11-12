import { createEmptyCard, fsrs, FSRSVersion, generatorParameters, State, type Card, type FSRS, type Grade, type ReviewLog } from "ts-fsrs";

/** One FSRS card per concept, as stored. Dates are ISO strings so the state survives JSON. */
export interface StoredConceptCard {
  concept_id: string;
  card: Omit<Card, "due" | "last_review"> & { due: string; last_review?: string };
  /** Algorithm version and target retention the card was last scheduled with. */
  scheduler: { fsrs_version: string; request_retention: number };
}

export interface SchedulerOptions {
  /** Target probability of recall; also the default "needs repair" threshold for buildings. */
  requestRetention?: number;
  enableFuzz?: boolean;
  /** Optimized FSRS weights, once enough history exists; defaults otherwise. */
  w?: number[];
  /** Minute-long learning steps for new cards (FSRS default). Off: every review schedules whole days. */
  shortTerm?: boolean;
}

export interface ConceptReview {
  conceptId: string;
  card: Card;
  log: ReviewLog;
}

/**
 * FSRS scheduling at the concept level ("irregular verbs in Past Simple"), not the
 * question level: any task of the concept reviews the same card, so the player
 * learns the rule rather than memorizing one answer.
 */
export class ConceptScheduler {
  private readonly cards = new Map<string, Card>();
  private readonly f: FSRS;
  readonly requestRetention: number;

  constructor(options: SchedulerOptions = {}, stored: StoredConceptCard[] = []) {
    this.requestRetention = options.requestRetention ?? 0.9;
    this.f = fsrs(
      generatorParameters({
        request_retention: this.requestRetention,
        enable_fuzz: options.enableFuzz ?? true,
        ...(options.shortTerm === false ? { enable_short_term: false } : {}),
        ...(options.w ? { w: options.w } : {}),
      }),
    );
    for (const s of stored) {
      this.cards.set(s.concept_id, {
        ...s.card,
        due: new Date(s.card.due),
        ...(s.card.last_review ? { last_review: new Date(s.card.last_review) } : {}),
      } as Card);
    }
  }

  has(conceptId: string): boolean {
    return this.cards.has(conceptId);
  }

  card(conceptId: string, now: Date = new Date()): Card {
    return this.cards.get(conceptId) ?? createEmptyCard(now);
  }

  review(conceptId: string, grade: Grade, now: Date = new Date()): ConceptReview {
    const { card, log } = this.f.next(this.card(conceptId, now), now, grade);
    this.cards.set(conceptId, card);
    return { conceptId, card, log };
  }

  /** Probability of recall now, 0..1; undefined for a concept never reviewed. */
  retrievability(conceptId: string, now: Date = new Date()): number | undefined {
    const card = this.cards.get(conceptId);
    if (!card || card.state === State.New) return undefined;
    return this.f.get_retrievability(card, now, false);
  }

  /** Reviewed concepts due by `until`, weakest first. */
  due(until: Date = new Date(), conceptIds?: Iterable<string>): string[] {
    const ids = conceptIds ? [...conceptIds].filter((id) => this.cards.has(id)) : [...this.cards.keys()];
    return ids
      .filter((id) => this.cards.get(id)!.due.getTime() <= until.getTime())
      .map((id) => ({ id, r: this.retrievability(id, until) ?? 0 }))
      .sort((a, b) => a.r - b.r || a.id.localeCompare(b.id))
      .map((x) => x.id);
  }

  /**
   * True when any studied concept of a building's module has fallen below the
   * threshold: the building shows as damaged until those concepts are repeated.
   */
  needsRepair(conceptIds: Iterable<string>, now: Date = new Date(), threshold = this.requestRetention): boolean {
    for (const id of conceptIds) {
      const r = this.retrievability(id, now);
      if (r !== undefined && r < threshold) return true;
    }
    return false;
  }

  toJSON(): StoredConceptCard[] {
    return [...this.cards].map(([concept_id, { due, last_review, ...rest }]) => ({
      concept_id,
      card: {
        ...rest,
        due: due.toISOString(),
        ...(last_review ? { last_review: new Date(last_review).toISOString() } : {}),
      },
      scheduler: { fsrs_version: FSRSVersion, request_retention: this.requestRetention },
    }));
  }
}
