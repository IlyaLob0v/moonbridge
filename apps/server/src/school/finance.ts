import type { Sql } from "../db/sql.js";

// A student's balance of paid lessons (schema: migrations/006_finance.sql). The balance is the
// sum of the ledger: payments add lessons, held lessons take one each, voids and corrections
// fix mistakes. Access rules live in the routes; the store only reads and writes.

export type PaymentMethod = "cash" | "transfer" | "card" | "online";
export const PAYMENT_METHODS: PaymentMethod[] = ["cash", "transfer", "card", "online"];
export type EntryKind = "payment" | "void" | "lesson" | "correction";

export interface Payment {
  paymentId: string;
  accountId: string;
  lessons: number;
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
  delta: number;
  kind: EntryKind;
  at: Date;
  note: string;
  lessonId: string | null;
  /** Who made the entry; null for the admin token or the payment provider. */
  byName: string | null;
  payment: { paymentId: string; amountKop: number; method: PaymentMethod; voided: boolean } | null;
}

export interface BalanceLine {
  accountId: string;
  balance: number;
  /** The day of the latest payment that is not voided. */
  lastPaidOn: string | null;
  /** Lessons charged so far. */
  lessonsHeld: number;
}

/** Thrown by voidPayment when the payment does not exist or is already voided. */
export class PaymentNotVoidableError extends Error {
  constructor() {
    super("payment cannot be voided");
  }
}

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

interface PaymentRow {
  payment_id: string;
  account_id: string;
  lessons: number;
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
  "p.payment_id, p.account_id, p.lessons, p.amount_kop, p.currency, p.method, p.provider, p.status, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.note, p.recorded_by, p.created_at, p.voided_at";
const payment = (r: PaymentRow): Payment => ({
  paymentId: r.payment_id,
  accountId: r.account_id,
  lessons: r.lessons,
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

  /**
   * Records a payment and, once it has succeeded, adds its lessons to the balance in the same
   * statement. A manual payment has succeeded at once; an online one will come in 'pending'.
   */
  async recordPayment(p: {
    accountId: string;
    lessons: number;
    amountKop: number;
    method: PaymentMethod;
    paidOn: string;
    note: string;
    recordedBy: string | null;
  }): Promise<Payment> {
    const { rows } = await this.sql.query<PaymentRow>(
      `WITH p AS (
         INSERT INTO payments (payment_id, account_id, lessons, amount_kop, method, paid_on, note, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8) RETURNING *
       ), e AS (
         INSERT INTO balance_entries (entry_id, account_id, delta, kind, payment_id, at, note, created_by)
         SELECT $9, account_id, lessons, 'payment', payment_id, (paid_on + time '12:00') AT TIME ZONE 'Europe/Moscow', note, recorded_by FROM p WHERE status = 'succeeded'
       )
       SELECT ${PAYMENT} FROM p`,
      [newId("pay"), p.accountId, p.lessons, p.amountKop, p.method, p.paidOn, p.note, p.recordedBy, newId("bal")],
    );
    return payment(rows[0]!);
  }

  async payment(paymentId: string): Promise<Payment | undefined> {
    const { rows } = await this.sql.query<PaymentRow>(`SELECT ${PAYMENT} FROM payments p WHERE p.payment_id = $1`, [paymentId]);
    return rows[0] && payment(rows[0]);
  }

  /** Cancels a payment entered by mistake: its lessons leave the balance, both lines stay in the history. */
  async voidPayment(paymentId: string, by: string | null, at: Date, reason: string): Promise<Payment> {
    const { rows } = await this.sql.query<{ payment_id: string }>(
      `WITH p AS (
         UPDATE payments SET voided_at = $2, voided_by = $3 WHERE payment_id = $1 AND voided_at IS NULL AND status = 'succeeded' RETURNING *
       ), e AS (
         INSERT INTO balance_entries (entry_id, account_id, delta, kind, payment_id, at, note, created_by)
         SELECT $4, account_id, -lessons, 'void', payment_id, $2, $5, $3 FROM p
       )
       SELECT payment_id FROM p`,
      [paymentId, at, by, newId("bal"), reason],
    );
    if (!rows[0]) throw new PaymentNotVoidableError();
    return (await this.payment(paymentId))!;
  }

  /** Lessons added or taken by hand, e.g. a free trial lesson or a balance carried over from before the platform. */
  async addCorrection(c: { accountId: string; delta: number; note: string; by: string | null; at: Date }): Promise<void> {
    await this.sql.query("INSERT INTO balance_entries (entry_id, account_id, delta, kind, at, note, created_by) VALUES ($1, $2, $3, 'correction', $4, $5, $6)", [
      newId("bal"),
      c.accountId,
      c.delta,
      c.at,
      c.note,
      c.by,
    ]);
  }

  /** Takes one lesson off for a held lesson. Saving the same attendance again changes nothing. */
  async chargeLesson(accountId: string, lessonId: string, at: Date, byAccountId: string | null): Promise<void> {
    await this.sql.query(
      `INSERT INTO balance_entries (entry_id, account_id, delta, kind, lesson_id, at, created_by) VALUES ($1, $2, -1, 'lesson', $3, $4, $5)
       ON CONFLICT (account_id, lesson_id) WHERE kind = 'lesson' DO NOTHING`,
      [newId("bal"), accountId, lessonId, at, byAccountId],
    );
  }

  /** Gives the lesson back: the student was marked absent after all, or the lesson did not take place. */
  async unchargeLesson(accountId: string, lessonId: string): Promise<void> {
    await this.sql.query("DELETE FROM balance_entries WHERE account_id = $1 AND lesson_id = $2 AND kind = 'lesson'", [accountId, lessonId]);
  }

  async balance(accountId: string): Promise<number> {
    return (await this.balances([accountId]))[0]!.balance;
  }

  /** Each account's balance, in the order given. */
  async balances(accountIds: string[]): Promise<BalanceLine[]> {
    if (!accountIds.length) return [];
    const { rows } = await this.sql.query<{ account_id: string; balance: number; held: number; last_paid: string | null }>(
      `SELECT ids.account_id,
              COALESCE((SELECT sum(delta) FROM balance_entries b WHERE b.account_id = ids.account_id), 0)::int AS balance,
              (SELECT count(*) FROM balance_entries b WHERE b.account_id = ids.account_id AND b.kind = 'lesson')::int AS held,
              (SELECT to_char(max(paid_on), 'YYYY-MM-DD') FROM payments p WHERE p.account_id = ids.account_id AND p.status = 'succeeded' AND p.voided_at IS NULL) AS last_paid
       FROM unnest($1::text[]) AS ids(account_id)`,
      [accountIds],
    );
    const byId = new Map(rows.map((r) => [r.account_id, r]));
    return accountIds.map((id) => {
      const r = byId.get(id);
      return { accountId: id, balance: r?.balance ?? 0, lessonsHeld: r?.held ?? 0, lastPaidOn: r?.last_paid ?? null };
    });
  }

  /** The account's ledger, the newest first. */
  async ledger(accountId: string, limit = 200): Promise<LedgerEntry[]> {
    const { rows } = await this.sql.query<{
      entry_id: string;
      delta: number;
      kind: EntryKind;
      at: Date;
      note: string;
      lesson_id: string | null;
      by_name: string | null;
      payment_id: string | null;
      amount_kop: string | number | null;
      method: PaymentMethod | null;
      voided_at: Date | null;
    }>(
      `SELECT b.entry_id, b.delta, b.kind, b.at, b.note, b.lesson_id, a.name AS by_name, p.payment_id, p.amount_kop, p.method, p.voided_at
       FROM balance_entries b
       LEFT JOIN accounts a ON a.account_id = b.created_by
       LEFT JOIN payments p ON p.payment_id = b.payment_id
       WHERE b.account_id = $1 ORDER BY b.at DESC, b.created_at DESC LIMIT $2`,
      [accountId, limit],
    );
    return rows.map((r) => ({
      entryId: r.entry_id,
      delta: r.delta,
      kind: r.kind,
      at: new Date(r.at),
      note: r.note,
      lessonId: r.lesson_id,
      byName: r.by_name,
      payment: r.payment_id ? { paymentId: r.payment_id, amountKop: Number(r.amount_kop), method: r.method!, voided: r.voided_at !== null } : null,
    }));
  }

  /** Every student of the school, for the admin. */
  async students(): Promise<{ accountId: string; name: string; login: string }[]> {
    const { rows } = await this.sql.query<{ account_id: string; name: string; login: string }>("SELECT account_id, name, login FROM accounts WHERE role = 'student' ORDER BY name");
    return rows.map((r) => ({ accountId: r.account_id, name: r.name, login: r.login }));
  }

  /** Money received in a period, for the teacher's month total: succeeded payments that are not voided. */
  async received(accountIds: string[], from: string, to: string): Promise<{ amountKop: number; lessons: number; payments: number }> {
    if (!accountIds.length) return { amountKop: 0, lessons: 0, payments: 0 };
    const { rows } = await this.sql.query<{ amount: string | number | null; lessons: number | null; n: number }>(
      `SELECT sum(amount_kop) AS amount, sum(lessons)::int AS lessons, count(*)::int AS n FROM payments
       WHERE account_id = ANY($1::text[]) AND status = 'succeeded' AND voided_at IS NULL AND paid_on >= $2::date AND paid_on < $3::date`,
      [accountIds, from, to],
    );
    const r = rows[0]!;
    return { amountKop: Number(r.amount ?? 0), lessons: r.lessons ?? 0, payments: r.n };
  }
}
