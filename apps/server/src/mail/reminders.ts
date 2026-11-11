import type { MailLinks } from "./links.js";
import type { Mail, Mailer } from "./mailer.js";
import { deadlineMail, eveningMail, gradeMail } from "./messages.js";
import type { EmailKind, EmailStore } from "./store.js";

const MSK_MS = 3 * 3600_000;
const DAY_MS = 24 * 3600_000;

export interface ReminderSettings {
  /** Moscow hour the evening reminder goes out from (it is sent until EVENING_UNTIL). */
  eveningHour: number;
}

/** Nothing but the evening reminder is sent before this Moscow hour… */
export const DAY_FROM = 9;
/** …or from this one on: a grade given late at night waits for the morning. */
export const DAY_UNTIL = 22;
/** Grades older than this get no e-mail (the first deploy must not mail out every old grade). */
const GRADE_LOOKBACK_MS = 3 * DAY_MS;

const moscowHour = (at: Date) => new Date(at.getTime() + MSK_MS).getUTCHours();
const moscowDate = (at: Date) => new Date(at.getTime() + MSK_MS).toISOString().slice(0, 10);
const moscowMidnight = (at: Date) => new Date(Date.parse(`${moscowDate(at)}T00:00:00Z`) - MSK_MS);

export interface RunResult {
  sent: number;
  failed: number;
}

/**
 * The three reminders, checked every few minutes by the gateway:
 * - evening: from `eveningHour` to 22:00 Moscow, to a student who has not answered anything today;
 * - deadline: 24 hours before a file homework is due, if it is not handed in;
 * - grade: once the teacher has graded a hand-in.
 * Each goes once (the `emails` table remembers it) and only to students with an address who
 * have not unsubscribed.
 */
export class Reminders {
  private running: Promise<RunResult> | undefined;

  constructor(
    private readonly store: EmailStore,
    private readonly mailer: Mailer,
    private readonly links: MailLinks,
    private readonly settings: ReminderSettings = { eveningHour: 19 },
    private readonly log: (e: unknown, message: string) => void = (e, m) => console.warn(m, e),
  ) {}

  /** One pass; a pass still running is joined, not started twice. */
  run(now: Date): Promise<RunResult> {
    this.running ??= this.pass(now).finally(() => (this.running = undefined));
    return this.running;
  }

  private async pass(now: Date): Promise<RunResult> {
    const result: RunResult = { sent: 0, failed: 0 };
    const hour = moscowHour(now);
    if (hour < DAY_FROM || hour >= DAY_UNTIL) return result;
    const send = async (e: { accountId: string; kind: EmailKind; ref: string; target: string }, mail: (links: { go: string; unsubscribe: string }) => Mail) => {
      const id = await this.store.claim(e);
      if (!id) return;
      try {
        await this.mailer.send(mail({ go: this.links.go(id), unsubscribe: await this.links.unsubscribe(e.accountId) }));
        await this.store.sent(id, now);
        result.sent++;
      } catch (err) {
        await this.store.failed(id, err instanceof Error ? err.message : String(err));
        result.failed++;
        this.log(err, `reminder ${e.kind} to ${e.accountId} not sent`);
      }
    };

    for (const g of await this.store.reviewedSince(new Date(now.getTime() - GRADE_LOOKBACK_MS))) {
      await send({ accountId: g.accountId, kind: "grade", ref: `${g.submissionId}@${g.reviewedAt.getTime()}`, target: `/homework/${g.homeworkId}` }, (l) => gradeMail(g, g, l));
    }
    for (const h of await this.store.deadlines(now, new Date(now.getTime() + DAY_MS))) {
      await send({ accountId: h.accountId, kind: "deadline", ref: h.homeworkId, target: `/homework/${h.homeworkId}` }, (l) => deadlineMail(h, h, l));
    }
    if (hour >= this.settings.eveningHour) {
      const today = moscowDate(now);
      for (const s of await this.store.idleSince(moscowMidnight(now))) {
        await send({ accountId: s.accountId, kind: "evening", ref: today, target: "/moonbridge" }, (l) => eveningMail(s, l));
      }
    }
    return result;
  }
}
