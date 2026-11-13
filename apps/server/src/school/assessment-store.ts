import { randomBytes } from "node:crypto";
import type { Sql } from "../db/sql.js";

export interface OpenAssessment {
  groupId: string;
  assessmentId: string;
  openedAt: Date;
  closedAt: Date | null;
}

export interface AssessmentResult {
  resultId: string;
  accountId: string;
  groupId: string;
  assessmentId: string;
  answers: unknown;
  scoreRight: number | null;
  scoreTotal: number | null;
  submittedAt: Date;
}

interface ResultRow {
  result_id: string;
  account_id: string;
  group_id: string;
  assessment_id: string;
  answers: unknown;
  score_right: number | null;
  score_total: number | null;
  submitted_at: Date;
}

const result = (r: ResultRow): AssessmentResult => ({
  resultId: r.result_id,
  accountId: r.account_id,
  groupId: r.group_id,
  assessmentId: r.assessment_id,
  answers: r.answers,
  scoreRight: r.score_right,
  scoreTotal: r.score_total,
  submittedAt: r.submitted_at,
});

/** The tests and surveys a teacher opened for a group, and each student's one result. */
export class AssessmentStore {
  constructor(private readonly sql: Sql) {}

  /** Opens (or opens again) the test for the group. */
  async open(groupId: string, assessmentId: string, at: Date): Promise<void> {
    await this.sql.query(
      `INSERT INTO group_assessments (group_id, assessment_id, opened_at) VALUES ($1, $2, $3)
       ON CONFLICT (group_id, assessment_id) DO UPDATE SET closed_at = NULL`,
      [groupId, assessmentId, at],
    );
  }

  async close(groupId: string, assessmentId: string, at: Date): Promise<void> {
    await this.sql.query("UPDATE group_assessments SET closed_at = $3 WHERE group_id = $1 AND assessment_id = $2 AND closed_at IS NULL", [groupId, assessmentId, at]);
  }

  async ofGroups(groupIds: string[]): Promise<OpenAssessment[]> {
    if (!groupIds.length) return [];
    const { rows } = await this.sql.query<{ group_id: string; assessment_id: string; opened_at: Date; closed_at: Date | null }>(
      "SELECT group_id, assessment_id, opened_at, closed_at FROM group_assessments WHERE group_id = ANY($1::text[]) ORDER BY opened_at",
      [groupIds],
    );
    return rows.map((r) => ({ groupId: r.group_id, assessmentId: r.assessment_id, openedAt: r.opened_at, closedAt: r.closed_at }));
  }

  /** Keeps the result; a second one for the same test is refused (undefined). */
  async submit(r: { accountId: string; groupId: string; assessmentId: string; answers: unknown; scoreRight: number | null; scoreTotal: number | null; at: Date }): Promise<AssessmentResult | undefined> {
    const { rows } = await this.sql.query<ResultRow>(
      `INSERT INTO assessment_results (result_id, account_id, group_id, assessment_id, answers, score_right, score_total, submitted_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       ON CONFLICT (account_id, group_id, assessment_id) DO NOTHING
       RETURNING result_id, account_id, group_id, assessment_id, answers, score_right, score_total, submitted_at`,
      [`res_${randomBytes(8).toString("hex")}`, r.accountId, r.groupId, r.assessmentId, JSON.stringify(r.answers), r.scoreRight, r.scoreTotal, r.at],
    );
    return rows[0] && result(rows[0]);
  }

  async results(groupId: string): Promise<AssessmentResult[]> {
    const { rows } = await this.sql.query<ResultRow>(
      "SELECT result_id, account_id, group_id, assessment_id, answers, score_right, score_total, submitted_at FROM assessment_results WHERE group_id = $1 ORDER BY submitted_at",
      [groupId],
    );
    return rows.map(result);
  }

  async resultsOf(accountId: string): Promise<AssessmentResult[]> {
    const { rows } = await this.sql.query<ResultRow>(
      "SELECT result_id, account_id, group_id, assessment_id, answers, score_right, score_total, submitted_at FROM assessment_results WHERE account_id = $1",
      [accountId],
    );
    return rows.map(result);
  }
}
