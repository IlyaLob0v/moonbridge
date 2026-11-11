import type { Sql } from "../db/sql.js";

// A student's money at the school (schema: migrations/008_finance.sql). Each student has a
// price per lesson; payments add roubles, every held lesson takes its price, voids and
// corrections fix mistakes. The balance is the sum of the ledger; lessons left are the balance
// divided by the price. Access rules live in the routes; the store only reads and writes.

export type PaymentMethod = "cash" | "transfer" | "card" | "online";
export type EntryKind = "payment" | "void" | "lesson" | "correction";

export interface Payment {
  paymentId: string;
  accountId: string;
  amountKop: number;
  currency: string;
  method: PaymentMethod;
  provider: "manual" | "yookassa";
  status: "pending" | "succeeded" | "canceled";
  /** Moscow date, YYYY-MM-DD. */
  paidOn: string;
  note: string;
  recordedBy: string | null;
  createdAt: Date;
  voidedAt: Date | null;
}

export interface LedgerEntry {
  entryId: string;
  /** Kopecks; null for a lesson held before the student had a price. */
  amountKop: number | null;
  kind: EntryKind;
  at: Date;
  note: string;
  lessonId: string | null;
  /** Who made the entry; null for the admin token, the payment provider or the lessons' attendance. */
  byName: string | null;
  payment: { paymentId: string; method: PaymentMethod; voided: boolean } | null;
}

/** A student's account, summed up: what the top of the page shows. */
export interface Summary {
  accountId: string;
  /** The current price per lesson, if set. */
  priceKop: number | null;
  /** Paid minus held, plus corrections; below zero is a debt. */
  balanceKop: number;
  /** Whole lessons the balance pays for at the current price; null without a price. */
  lessonsLeft: number | null;
  paidKop: number;
  lessonsHeld: number;
  heldKop: number;
  /** Held lessons still waiting for a price. */
  unpriced: number;
  /** The day of the latest payment that is not voided. */
  lastPaidOn: string | null;
}

/** Thrown by voidPayment when the payment does not exist or is already voided. */
export class PaymentNotVoidableError extends Error {
  constructor() {
    super("payment cannot be voided");
  }
}

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v));

interface PaymentRow {
  payment_id: string;
  account_id: string;
  amount_kop: string | number;
  currency: string;
  method: PaymentMethod;
  provider: Payment["provider"];
  status: Payment["status"];
  paid_on: string;
  note: string;
  recorded_by: string | null;
  created_at: Date;
  voided_at: Date | null;
}
const PAYMENT =
  "p.payment_id, p.account_id, p.amount_kop, p.currency, p.method, p.provider, p.status, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.note, p.recorded_by, p.created_at, p.voided_at";
const payment = (r: PaymentRow): Payment => ({
  paymentId: r.payment_id,
  accountId: r.account_id,
  amountKop: Number(r.amount_kop),
  currency: r.currency,
  method: r.method,
  provider: r.provider,
  status: r.status,
  paidOn: r.paid_on,
  note: r.note,
  recordedBy: r.recorded_by,
  createdAt: new Date(r.created_at),
  voidedAt: r.voided_at ? new Date(r.voided_at) : null,
});

export class FinanceStore {
  constructor(private readonly sql: Sql) {}

  /** Sets the student's price per lesson; lessons held before there was any price take it now. */
  async setPrice(accountId: string, priceKop: number, by: string | null): Promise<void> {
    await this.sql.query(
      `INSERT INTO lesson_prices (account_id, price_kop, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET price_kop = EXCLUDED.price_kop, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [accountId, priceKop, by],
    );
    await this.sql.query("UPDATE balance_entries SET amount_kop = -$2::bigint WHERE account_id = $1 AND kind = 'lesson' AND amount_kop IS NULL", [accountId, priceKop]);
  }

  async price(accountId: string): Promise<number | null> {
    const { rows } = await this.sql.query<{ price_kop: string | number }>("SELECT price_kop FROM lesson_prices WHERE account_id = $1", [accountId]);
    return num(rows[0]?.price_kop);
  }

  /**
   * Records a payment and, once it has succeeded, adds it to the balance in the same
   * statement. A manual payment has succeeded at once; an online one will come in 'pending'.
   */
  async recordPayment(p: { accountId: string; amountKop: number; method: PaymentMethod; paidOn: string; note: string; recordedBy: string | null }): Promise<Payment> {
    const { rows } = await this.sql.query<PaymentRow>(
      `WITH p AS (
         INSERT INTO payments (payment_id, account_id, amount_kop, method, paid_on, note, recorded_by)
         VALUES ($1, $2, $3, $4, $5::date, $6, $7) RETURNING *
       ), e AS (
         INSERT INTO balance_entries (entry_id, account_id, amount_kop, kind, payment_id, at, note, created_by)
         SELECT $8, account_id, amount_kop, 'payment', payment_id, (paid_on + time '12:00') AT TIME ZONE 'Europe/Moscow', note, recorded_by FROM p WHERE status = 'succeeded'
       )
       SELECT ${PAYMENT} FROM p`,
      [newId("pay"), p.accountId, p.amountKop, p.method, p.paidOn, p.note, p.recordedBy, newId("bal")],
    );
    return payment(rows[0]!);
  }

  async payment(paymentId: string): Promise<Payment | undefined> {
    const { rows } = await this.sql.query<PaymentRow>(`SELECT ${PAYMENT} FROM payments p WHERE p.payment_id = $1`, [paymentId]);
    return rows[0] && payment(rows[0]);
  }

  /** Cancels a payment entered by mistake: its money leaves the balance, both lines stay in the history. */
  async voidPayment(paymentId: string, by: string | null, at: Date, reason: string): Promise<Payment> {
    const { rows } = await this.sql.query<{ payment_id: string }>(
      `WITH p AS (
         UPDATE payments SET voided_at = $2, voided_by = $3 WHERE payment_id = $1 AND voided_at IS NULL AND status = 'succeeded' RETURNING *
       ), e AS (
         INSERT INTO balance_entries (entry_id, account_id, amount_kop, kind, payment_id, at, note, created_by)
         SELECT $4, account_id, -amount_kop, 'void', payment_id, $2, $5, $3 FROM p
       )
       SELECT payment_id FROM p`,
      [paymentId, at, by, newId("bal"), reason],
    );
    if (!rows[0]) throw new PaymentNotVoidableError();
    return (await this.payment(paymentId))!;
  }

  /** Money added or taken by hand, e.g. a free trial lesson or a balance carried over from before the platform. */
  async addCorrection(c: { accountId: string; amountKop: number; note: string; by: string | null; at: Date }): Promise<void> {
    await this.sql.query("INSERT INTO balance_entries (entry_id, account_id, amount_kop, kind, at, note, created_by) VALUES ($1, $2, $3, 'correction', $4, $5, $6)", [
      newId("bal"),
      c.accountId,
      c.amountKop,
      c.at,
      c.note,
      c.by,
    ]);
  }

  /** Charges a held lesson at the student's current price. Saving the same attendance again changes nothing. */
  async chargeLesson(accountId: string, lessonId: string, at: Date, byAccountId: string | null): Promise<void> {
    await this.sql.query(
      `INSERT INTO balance_entries (entry_id, account_id, amount_kop, kind, lesson_id, at, created_by)
       VALUES ($1, $2, -(SELECT price_kop FROM lesson_prices WHERE account_id = $2), 'lesson', $3, $4, $5)
       ON CONFLICT (account_id, lesson_id) WHERE kind = 'lesson' DO NOTHING`,
      [newId("bal"), accountId, lessonId, at, byAccountId],
    );
  }

  /** Gives the lesson back: the student was marked absent after all, or the lesson did not take place. */
  async unchargeLesson(accountId: string, lessonId: string): Promise<void> {
    await this.sql.query("DELETE FROM balance_entries WHERE account_id = $1 AND lesson_id = $2 AND kind = 'lesson'", [accountId, lessonId]);
  }

  async summary(accountId: string): Promise<Summary> {
    return (await this.summaries([accountId]))[0]!;
  }

  /** Each account summed up, in the order given. */
  async summaries(accountIds: string[]): Promise<Summary[]> {
    if (!accountIds.length) return [];
    const { rows } = await this.sql.query<{
      account_id: string;
      price: string | number | null;
      balance: string | number;
      paid: string | number;
      held: number;
      held_kop: string | number;
      unpriced: number;
      last_paid: string | null;
    }>(
      `SELECT ids.account_id,
              (SELECT price_kop FROM lesson_prices lp WHERE lp.account_id = ids.account_id) AS price,
              COALESCE((SELECT sum(amount_kop) FROM balance_entries b WHERE b.account_id = ids.account_id), 0) AS balance,
              COALESCE((SELECT sum(amount_kop) FROM balance_entries b WHERE b.account_id = ids.account_id AND b.kind IN ('payment', 'void')), 0) AS paid,
              (SELECT count(*) FROM balance_entries b WHERE b.account_id = ids.account_id AND b.kind = 'lesson')::int AS held,
              COALESCE((SELECT -sum(amount_kop) FROM balance_entries b WHERE b.account_id = ids.account_id AND b.kind = 'lesson'), 0) AS held_kop,
              (SELECT count(*) FROM balance_entries b WHERE b.account_id = ids.account_id AND b.kind = 'lesson' AND b.amount_kop IS NULL)::int AS unpriced,
              (SELECT to_char(max(paid_on), 'YYYY-MM-DD') FROM payments p WHERE p.account_id = ids.account_id AND p.status = 'succeeded' AND p.voided_at IS NULL) AS last_paid
       FROM unnest($1::text[]) AS ids(account_id)`,
      [accountIds],
    );
    const byId = new Map(rows.map((r) => [r.account_id, r]));
    return accountIds.map((id) => {
      const r = byId.get(id);
      const priceKop = num(r?.price ?? null);
      const balanceKop = Number(r?.balance ?? 0);
      return {
        accountId: id,
        priceKop,
        balanceKop,
        lessonsLeft: priceKop ? Math.trunc(balanceKop / priceKop) : null,
        paidKop: Number(r?.paid ?? 0),
        lessonsHeld: r?.held ?? 0,
        heldKop: Number(r?.held_kop ?? 0),
        unpriced: r?.unpriced ?? 0,
        lastPaidOn: r?.last_paid ?? null,
      };
    });
  }

  /** The account's ledger, the newest first. */
  async ledger(accountId: string, limit = 300): Promise<LedgerEntry[]> {
    const { rows } = await this.sql.query<{
      entry_id: string;
      amount_kop: string | number | null;
      kind: EntryKind;
      at: Date;
      note: string;
      lesson_id: string | null;
      by_name: string | null;
      payment_id: string | null;
      method: PaymentMethod | null;
      voided_at: Date | null;
    }>(
      `SELECT b.entry_id, b.amount_kop, b.kind, b.at, b.note, b.lesson_id, a.name AS by_name, p.payment_id, p.method, p.voided_at
       FROM balance_entries b
       LEFT JOIN accounts a ON a.account_id = b.created_by
       LEFT JOIN payments p ON p.payment_id = b.payment_id
       WHERE b.account_id = $1 ORDER BY b.at DESC, b.created_at DESC LIMIT $2`,
      [accountId, limit],
    );
    return rows.map((r) => ({
      entryId: r.entry_id,
      amountKop: num(r.amount_kop),
      kind: r.kind,
      at: new Date(r.at),
      note: r.note,
      lessonId: r.lesson_id,
      byName: r.by_name,
      payment: r.payment_id ? { paymentId: r.payment_id, method: r.method!, voided: r.voided_at !== null } : null,
    }));
  }

  /** A period's money for these students: payments received (not voided) and lessons held with what they cost. */
  async period(accountIds: string[], from: Date, to: Date): Promise<{ receivedKop: number; payments: number; lessonsHeld: number; heldKop: number }> {
    if (!accountIds.length) return { receivedKop: 0, payments: 0, lessonsHeld: 0, heldKop: 0 };
    const { rows } = await this.sql.query<{ received: string | number | null; n: number; held: number; held_kop: string | number | null }>(
      `SELECT
         (SELECT sum(amount_kop) FROM payments WHERE account_id = ANY($1::text[]) AND status = 'succeeded' AND voided_at IS NULL
            AND (paid_on + time '12:00') AT TIME ZONE 'Europe/Moscow' >= $2 AND (paid_on + time '12:00') AT TIME ZONE 'Europe/Moscow' < $3) AS received,
         (SELECT count(*) FROM payments WHERE account_id = ANY($1::text[]) AND status = 'succeeded' AND voided_at IS NULL
            AND (paid_on + time '12:00') AT TIME ZONE 'Europe/Moscow' >= $2 AND (paid_on + time '12:00') AT TIME ZONE 'Europe/Moscow' < $3)::int AS n,
         (SELECT count(*) FROM balance_entries WHERE account_id = ANY($1::text[]) AND kind = 'lesson' AND at >= $2 AND at < $3)::int AS held,
         (SELECT -sum(amount_kop) FROM balance_entries WHERE account_id = ANY($1::text[]) AND kind = 'lesson' AND at >= $2 AND at < $3) AS held_kop`,
      [accountIds, from, to],
    );
    const r = rows[0]!;
    return { receivedKop: Number(r.received ?? 0), payments: r.n, lessonsHeld: r.held, heldKop: Number(r.held_kop ?? 0) };
  }

  /** Every student of the school, for the admin. */
  async students(): Promise<{ accountId: string; name: string; login: string }[]> {
    const { rows } = await this.sql.query<{ account_id: string; name: string; login: string }>("SELECT account_id, name, login FROM accounts WHERE role = 'student' ORDER BY name");
    return rows.map((r) => ({ accountId: r.account_id, name: r.name, login: r.login }));
  }
}
