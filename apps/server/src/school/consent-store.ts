import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "../db/sql.js";

/** Editions of the legal pages, by page id: {"terms": "2026-11-13", ...}. */
export type Versions = Record<string, string>;

export interface Consent {
  consentId: string;
  accountId: string;
  kind: "terms" | "parent";
  versions: Versions;
  method: "click" | "email" | "paper";
  parentName: string | null;
  parentEmail: string | null;
  recordedBy: string | null;
  acceptedAt: Date;
}

export interface ParentRequest {
  accountId: string;
  parentName: string;
  parentEmail: string;
  createdAt: Date;
  expiresAt: Date;
}

interface ConsentRow {
  consent_id: string;
  account_id: string;
  kind: Consent["kind"];
  versions: Versions;
  method: Consent["method"];
  parent_name: string | null;
  parent_email: string | null;
  recorded_by: string | null;
  accepted_at: Date;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const consent = (r: ConsentRow): Consent => ({
  consentId: r.consent_id,
  accountId: r.account_id,
  kind: r.kind,
  versions: r.versions,
  method: r.method,
  parentName: r.parent_name,
  parentEmail: r.parent_email,
  recordedBy: r.recorded_by,
  acceptedAt: r.accepted_at,
});

/**
 * Consents to the school's legal texts. Rows are only added: what a person accepted, and when,
 * stays on record after a new edition is accepted.
 */
export class ConsentStore {
  constructor(private readonly sql: Sql) {}

  async record(c: {
    accountId: string;
    kind: Consent["kind"];
    versions: Versions;
    method: Consent["method"];
    parentName?: string | null;
    parentEmail?: string | null;
    recordedBy?: string | null;
    ip?: string;
    userAgent?: string;
    at: Date;
  }): Promise<Consent> {
    const { rows } = await this.sql.query<ConsentRow>(
      `INSERT INTO consents (consent_id, account_id, kind, versions, method, parent_name, parent_email, recorded_by, ip, user_agent, accepted_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11)
       RETURNING consent_id, account_id, kind, versions, method, parent_name, parent_email, recorded_by, accepted_at`,
      [
        `cns_${randomBytes(8).toString("hex")}`,
        c.accountId,
        c.kind,
        JSON.stringify(c.versions),
        c.method,
        c.parentName ?? null,
        c.parentEmail ?? null,
        c.recordedBy ?? null,
        c.ip?.slice(0, 64) ?? null,
        c.userAgent?.slice(0, 300) ?? null,
        c.at,
      ],
    );
    return consent(rows[0]!);
  }

  /** The newest consent of each kind for the accounts. */
  async latest(accountIds: string[]): Promise<Map<string, { terms?: Consent; parent?: Consent }>> {
    const out = new Map<string, { terms?: Consent; parent?: Consent }>();
    if (!accountIds.length) return out;
    const { rows } = await this.sql.query<ConsentRow>(
      `SELECT DISTINCT ON (account_id, kind) consent_id, account_id, kind, versions, method, parent_name, parent_email, recorded_by, accepted_at
       FROM consents WHERE account_id = ANY($1::text[]) ORDER BY account_id, kind, seq DESC`,
      [accountIds],
    );
    for (const r of rows) {
      const entry = out.get(r.account_id) ?? {};
      entry[r.kind] = consent(r);
      out.set(r.account_id, entry);
    }
    return out;
  }

  async setMinor(accountId: string, minor: boolean): Promise<void> {
    await this.sql.query("UPDATE accounts SET minor = $2 WHERE account_id = $1", [accountId, minor]);
  }

  async isMinor(accountId: string): Promise<boolean> {
    const { rows } = await this.sql.query<{ minor: boolean }>("SELECT minor FROM accounts WHERE account_id = $1", [accountId]);
    return rows[0]?.minor ?? false;
  }

  /** A new link for the parent; only its hash is stored. */
  async createParentRequest(r: { accountId: string; parentName: string; parentEmail: string; now: Date; expiresAt: Date }): Promise<string> {
    const token = randomBytes(24).toString("base64url");
    await this.sql.query("INSERT INTO parent_requests (token_hash, account_id, parent_name, parent_email, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)", [
      sha256(token),
      r.accountId,
      r.parentName,
      r.parentEmail,
      r.now,
      r.expiresAt,
    ]);
    return token;
  }

  async requestsSince(accountId: string, since: Date): Promise<number> {
    const { rows } = await this.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM parent_requests WHERE account_id = $1 AND created_at >= $2", [accountId, since]);
    return rows[0]?.n ?? 0;
  }

  /** The newest request for the account, to show "письмо отправлено на …". */
  async lastRequest(accountId: string): Promise<ParentRequest | undefined> {
    const { rows } = await this.sql.query<{ account_id: string; parent_name: string; parent_email: string; created_at: Date; expires_at: Date }>(
      "SELECT account_id, parent_name, parent_email, created_at, expires_at FROM parent_requests WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1",
      [accountId],
    );
    const r = rows[0];
    return r && { accountId: r.account_id, parentName: r.parent_name, parentEmail: r.parent_email, createdAt: r.created_at, expiresAt: r.expires_at };
  }

  /** The request behind a parent's link while it works. Opening it does not use it: the parent still presses the button. */
  async parentRequest(token: string, now: Date): Promise<ParentRequest | undefined> {
    const { rows } = await this.sql.query<{ account_id: string; parent_name: string; parent_email: string; created_at: Date; expires_at: Date }>(
      "SELECT account_id, parent_name, parent_email, created_at, expires_at FROM parent_requests WHERE token_hash = $1 AND expires_at > $2 AND used_at IS NULL",
      [sha256(token), now],
    );
    const r = rows[0];
    return r && { accountId: r.account_id, parentName: r.parent_name, parentEmail: r.parent_email, createdAt: r.created_at, expiresAt: r.expires_at };
  }

  /** Marks the link used, once: a second press of the button finds nothing. */
  async useParentRequest(token: string, now: Date): Promise<ParentRequest | undefined> {
    const { rows } = await this.sql.query<{ account_id: string; parent_name: string; parent_email: string; created_at: Date; expires_at: Date }>(
      "UPDATE parent_requests SET used_at = $2 WHERE token_hash = $1 AND expires_at > $2 AND used_at IS NULL RETURNING account_id, parent_name, parent_email, created_at, expires_at",
      [sha256(token), now],
    );
    const r = rows[0];
    return r && { accountId: r.account_id, parentName: r.parent_name, parentEmail: r.parent_email, createdAt: r.created_at, expiresAt: r.expires_at };
  }
}
