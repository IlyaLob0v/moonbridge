import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "../db/sql.js";

export type EmailKind = "evening" | "deadline" | "grade";

/** A student a reminder may go to: has an address and has not unsubscribed. */
export interface Addressee {
  accountId: string;
  name: string;
  email: string;
  playerId: string;
}

export interface DeadlineDue extends Addressee {
  homeworkId: string;
  title: string;
  dueAt: Date;
}

export interface GradeDue extends Addressee {
  submissionId: string;
  homeworkId: string;
  title: string;
  grade: number;
  comment: string;
  teacherName: string;
  reviewedAt: Date;
}

/** One reminder as the pilot's metrics see it. */
export interface EmailRecord {
  accountId: string;
  playerId: string;
  kind: EmailKind;
  sentAt: Date;
  clickedAt: Date | null;
}

/** After this many failed sends a reminder is given up. */
export const MAX_ATTEMPTS = 3;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

interface AddresseeRow {
  account_id: string;
  name: string;
  email: string;
  player_id: string;
}
const addressee = (r: AddresseeRow): Addressee => ({ accountId: r.account_id, name: r.name, email: r.email, playerId: r.player_id });
const REACHABLE = "a.role = 'student' AND a.email IS NOT NULL AND a.reminders";

/** Addresses, the reminders sent and password reset links (schema: migrations/006_email.sql). */
export class EmailStore {
  constructor(private readonly sql: Sql) {}

  async setEmail(accountId: string, email: string | null): Promise<void> {
    await this.sql.query("UPDATE accounts SET email = $2 WHERE account_id = $1", [accountId, email]);
  }

  async setReminders(accountId: string, on: boolean): Promise<void> {
    await this.sql.query("UPDATE accounts SET reminders = $2 WHERE account_id = $1", [accountId, on]);
  }

  async contact(accountId: string): Promise<{ email: string | null; reminders: boolean } | undefined> {
    const { rows } = await this.sql.query<{ email: string | null; reminders: boolean }>("SELECT email, reminders FROM accounts WHERE account_id = $1", [accountId]);
    return rows[0];
  }

  /** Accounts that use this address or this login, for "Забыли пароль?". At most a few: a family may share one address. */
  async byLoginOrEmail(s: string): Promise<{ accountId: string; name: string; login: string; email: string }[]> {
    const { rows } = await this.sql.query<{ account_id: string; name: string; login: string; email: string }>(
      "SELECT account_id, name, login, email FROM accounts WHERE email IS NOT NULL AND (login = $1 OR email = $1) ORDER BY created_at LIMIT 5",
      [s],
    );
    return rows.map((r) => ({ accountId: r.account_id, name: r.name, login: r.login, email: r.email }));
  }

  /** Students in a group with no answer since `since` (the start of the Moscow day). */
  async idleSince(since: Date): Promise<Addressee[]> {
    const { rows } = await this.sql.query<AddresseeRow>(
      `SELECT a.account_id, a.name, a.email, a.player_id FROM accounts a
       WHERE ${REACHABLE}
         AND EXISTS (SELECT 1 FROM group_members m WHERE m.account_id = a.account_id)
         AND NOT EXISTS (SELECT 1 FROM attempts t WHERE t.player_id = a.player_id AND t.answered_at >= $1)`,
      [since],
    );
    return rows.map(addressee);
  }

  /** File homework due in (from, to] that the student has not handed in. */
  async deadlines(from: Date, to: Date): Promise<DeadlineDue[]> {
    const { rows } = await this.sql.query<AddresseeRow & { homework_id: string; title: string; due_at: Date }>(
      `SELECT a.account_id, a.name, a.email, a.player_id, h.homework_id, h.title, h.due_at
       FROM homework h JOIN group_members m ON m.group_id = h.group_id JOIN accounts a ON a.account_id = m.account_id
       WHERE ${REACHABLE} AND h.needs_file AND h.due_at > $1 AND h.due_at <= $2
         AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.homework_id = h.homework_id AND s.account_id = a.account_id)`,
      [from, to],
    );
    return rows.map((r) => ({ ...addressee(r), homeworkId: r.homework_id, title: r.title, dueAt: new Date(r.due_at) }));
  }

  /** Reviews made since `since`. */
  async reviewedSince(since: Date): Promise<GradeDue[]> {
    const { rows } = await this.sql.query<
      AddresseeRow & { submission_id: string; homework_id: string; title: string; grade: number; teacher_comment: string | null; teacher_name: string; reviewed_at: Date }
    >(
      `SELECT a.account_id, a.name, a.email, a.player_id, s.submission_id, h.homework_id, h.title, s.grade, s.teacher_comment, t.name AS teacher_name, s.reviewed_at
       FROM submissions s JOIN homework h ON h.homework_id = s.homework_id JOIN accounts a ON a.account_id = s.account_id
       JOIN school_groups g ON g.group_id = h.group_id JOIN accounts t ON t.account_id = g.teacher_id
       WHERE ${REACHABLE} AND s.reviewed_at >= $1 AND s.grade IS NOT NULL`,
      [since],
    );
    return rows.map((r) => ({
      ...addressee(r),
      submissionId: r.submission_id,
      homeworkId: r.homework_id,
      title: r.title,
      grade: r.grade,
      comment: r.teacher_comment ?? "",
      teacherName: r.teacher_name,
      reviewedAt: new Date(r.reviewed_at),
    }));
  }

  /**
   * Takes a reminder to send: a new one, or one that failed fewer than MAX_ATTEMPTS times. Returns
   * its id, or undefined when it was sent already (or is being sent by another run).
   */
  async claim(e: { accountId: string; kind: EmailKind; ref: string; target: string }): Promise<string | undefined> {
    const id = `em_${randomBytes(12).toString("hex")}`;
    const { rows } = await this.sql.query<{ email_id: string }>(
      `INSERT INTO emails (email_id, account_id, kind, ref, target, status) VALUES ($1, $2, $3, $4, $5, 'sending')
       ON CONFLICT (account_id, kind, ref) DO UPDATE SET status = 'sending', attempts = emails.attempts + 1
         WHERE emails.status = 'failed' AND emails.attempts < ${MAX_ATTEMPTS}
       RETURNING email_id`,
      [id, e.accountId, e.kind, e.ref, e.target],
    );
    return rows[0]?.email_id;
  }

  async sent(emailId: string, at: Date): Promise<void> {
    await this.sql.query("UPDATE emails SET status = 'sent', sent_at = $2, error = NULL WHERE email_id = $1", [emailId, at]);
  }

  async failed(emailId: string, error: string): Promise<void> {
    await this.sql.query("UPDATE emails SET status = 'failed', error = $2 WHERE email_id = $1", [emailId, error.slice(0, 500)]);
  }

  /** Notes the first click on the e-mail's button; returns the page it leads to. */
  async click(emailId: string, at: Date): Promise<string | undefined> {
    const { rows } = await this.sql.query<{ target: string }>(
      "UPDATE emails SET clicked_at = COALESCE(clicked_at, $2) WHERE email_id = $1 RETURNING target",
      [emailId, at],
    );
    return rows[0]?.target;
  }

  /** Reminders sent to these accounts in a time window, for the pilot's metrics. */
  async sentTo(accountIds: string[], from: Date, to: Date): Promise<EmailRecord[]> {
    if (!accountIds.length) return [];
    const { rows } = await this.sql.query<{ account_id: string; player_id: string; kind: EmailKind; sent_at: Date; clicked_at: Date | null }>(
      `SELECT e.account_id, a.player_id, e.kind, e.sent_at, e.clicked_at FROM emails e JOIN accounts a ON a.account_id = e.account_id
       WHERE e.account_id = ANY($1::text[]) AND e.sent_at >= $2 AND e.sent_at < $3 ORDER BY e.sent_at`,
      [accountIds, from, to],
    );
    return rows.map((r) => ({ accountId: r.account_id, playerId: r.player_id, kind: r.kind, sentAt: new Date(r.sent_at), clickedAt: r.clicked_at ? new Date(r.clicked_at) : null }));
  }

  /** Reset links asked for this account since `since`: a limit on how many e-mails one address gets. */
  async resetsSince(accountId: string, since: Date): Promise<number> {
    const { rows } = await this.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM password_resets WHERE account_id = $1 AND created_at >= $2", [accountId, since]);
    return rows[0]?.n ?? 0;
  }

  /** A new reset link's token; only its hash is stored. */
  async createReset(accountId: string, now: Date, expiresAt: Date): Promise<string> {
    const token = randomBytes(24).toString("base64url");
    await this.sql.query("INSERT INTO password_resets (token_hash, account_id, created_at, expires_at) VALUES ($1, $2, $3, $4)", [sha256(token), accountId, now, expiresAt]);
    return token;
  }

  /** Uses up a reset link; returns its account while the link is valid and unused. */
  async useReset(token: string, now: Date): Promise<string | undefined> {
    const { rows } = await this.sql.query<{ account_id: string }>(
      "UPDATE password_resets SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING account_id",
      [sha256(token), now],
    );
    const accountId = rows[0]?.account_id;
    // A password changed through one link makes the account's other open links useless.
    if (accountId) await this.sql.query("UPDATE password_resets SET used_at = $2 WHERE account_id = $1 AND used_at IS NULL", [accountId, now]);
    return accountId;
  }

  /** Whether a reset link is still valid, without using it (the page asks before showing the form). */
  async resetValid(token: string, now: Date): Promise<boolean> {
    const { rows } = await this.sql.query("SELECT 1 FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2", [sha256(token), now]);
    return rows.length > 0;
  }
}
