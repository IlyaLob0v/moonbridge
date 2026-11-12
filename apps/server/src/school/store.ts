import type { Attempt, EpisodeResult } from "@moonbridge/xapi";
import type { Sql } from "../db/sql.js";
import { FinanceStore } from "./finance.js";
import { LessonStore } from "./lesson-store.js";
import type { MetricAttempt } from "./metrics.js";

/** An admin handles the school's money (school/finance-routes.ts); created with the admin token. */
export type Role = "student" | "teacher" | "admin";

export interface Account {
  accountId: string;
  role: Role;
  name: string;
  login: string;
  playerId: string;
  /** Where reminders and password reset links go; null until the person gives one. */
  email: string | null;
  /** False once the person unsubscribed from reminders. */
  reminders: boolean;
  /** The person opened the confirmation link sent to `email`. */
  emailVerified: boolean;
}

/** A weekly lesson slot, Moscow time. */
export interface Slot {
  /** 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** "HH:MM". */
  time: string;
  minutes: number;
}

export interface Group {
  groupId: string;
  teacherId: string;
  teacherName: string;
  name: string;
  callUrl: string | null;
  schedule: Slot[];
  /** "assigned": a unit opens in the hotel when the teacher gives it; "course": units open in course order by themselves. */
  unitAccess: UnitAccess;
}

export type UnitAccess = "assigned" | "course";

export interface Homework {
  homeworkId: string;
  groupId: string;
  title: string;
  description: string;
  dueAt: Date | null;
  needsFile: boolean;
  /** The Moonbridge unit to play, for a unit given as homework. */
  moduleId: string | null;
  /** One student of the group, or null for the whole group. */
  accountId: string | null;
  assigneeName: string | null;
  /** A unit's result becomes the grade without the teacher. */
  autoGrade: boolean;
  createdAt: Date;
}

export interface Submission {
  submissionId: string;
  homeworkId: string;
  accountId: string;
  studentName: string;
  /** Null for a unit's result, which has a score instead of a file. */
  fileKey: string | null;
  fileName: string | null;
  mime: string | null;
  size: number | null;
  /** A unit's result: tasks right on the first try, out of all the unit's tasks. */
  score: { right: number; total: number } | null;
  submittedAt: Date;
  review: Review | null;
}

export interface Review {
  grade: number;
  comment: string;
  reviewedAt: Date;
}

/** One student's answers in a time window, summed up for the teacher. */
export interface PracticeSummary {
  /** Moscow dates (YYYY-MM-DD) with at least one answer. */
  days: string[];
  answers: number;
  /** First tries only: a second try after feedback says little about what the student knows. */
  firstTries: number;
  firstTriesRight: number;
  minutes: number;
  errors: { errorType: string; count: number }[];
  modes: { mode: string; answers: number; right: number }[];
  lastAnsweredAt: Date | null;
}

/** A tester's report of a problem, with where it happened. */
export interface Feedback {
  feedbackId: string;
  accountId: string;
  name: string;
  role: Role;
  page: string;
  message: string;
  userAgent: string;
  createdAt: Date;
}

export class LoginTakenError extends Error {
  constructor() {
    super("login taken");
  }
}

function newId(prefix: string, length = 16): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, length)}`;
}

const ACCOUNT = "a.account_id, a.role, a.name, a.login, a.player_id, a.email, a.reminders, a.email_verified_at IS NOT NULL AS email_verified";
const GROUP = "g.group_id, g.teacher_id, t.name AS teacher_name, g.name, g.call_url, g.schedule, g.unit_access";
const HOMEWORK =
  "h.homework_id, h.group_id, h.title, h.description, h.due_at, h.needs_file, h.module_id, h.account_id, (SELECT x.name FROM accounts x WHERE x.account_id = h.account_id) AS assignee_name, h.auto_grade, h.created_at";
const SUBMISSION =
  "s.submission_id, s.homework_id, s.account_id, a.name AS student_name, s.file_key, s.file_name, s.mime, s.size, s.score_right, s.score_total, s.submitted_at, s.grade, s.teacher_comment, s.reviewed_at";

interface AccountRow {
  account_id: string;
  role: Role;
  name: string;
  login: string;
  player_id: string;
  email: string | null;
  reminders: boolean;
  email_verified: boolean;
}
interface GroupRow {
  group_id: string;
  teacher_id: string;
  teacher_name: string;
  name: string;
  call_url: string | null;
  schedule: Slot[];
  unit_access: UnitAccess;
}
interface HomeworkRow {
  homework_id: string;
  group_id: string;
  title: string;
  description: string;
  due_at: Date | null;
  needs_file: boolean;
  module_id: string | null;
  account_id: string | null;
  assignee_name: string | null;
  auto_grade: boolean;
  created_at: Date;
}
interface SubmissionRow {
  submission_id: string;
  homework_id: string;
  account_id: string;
  student_name: string;
  file_key: string | null;
  file_name: string | null;
  mime: string | null;
  size: string | number | null;
  score_right: number | null;
  score_total: number | null;
  submitted_at: Date;
  grade: number | null;
  teacher_comment: string | null;
  reviewed_at: Date | null;
}

const account = (r: AccountRow): Account => ({
  accountId: r.account_id,
  role: r.role,
  name: r.name,
  login: r.login,
  playerId: r.player_id,
  email: r.email,
  reminders: r.reminders,
  emailVerified: r.email_verified,
});
const group = (r: GroupRow): Group => ({
  groupId: r.group_id,
  teacherId: r.teacher_id,
  teacherName: r.teacher_name,
  name: r.name,
  callUrl: r.call_url,
  schedule: r.schedule,
  unitAccess: r.unit_access,
});
const homework = (r: HomeworkRow): Homework => ({
  homeworkId: r.homework_id,
  groupId: r.group_id,
  title: r.title,
  description: r.description,
  dueAt: r.due_at,
  needsFile: r.needs_file,
  moduleId: r.module_id,
  accountId: r.account_id,
  assigneeName: r.assignee_name,
  autoGrade: r.auto_grade,
  createdAt: r.created_at,
});
const submission = (r: SubmissionRow): Submission => ({
  submissionId: r.submission_id,
  homeworkId: r.homework_id,
  accountId: r.account_id,
  studentName: r.student_name,
  fileKey: r.file_key,
  fileName: r.file_name,
  mime: r.mime,
  size: r.size === null ? null : Number(r.size),
  score: r.score_right !== null && r.score_total !== null ? { right: r.score_right, total: r.score_total } : null,
  submittedAt: r.submitted_at,
  review: r.reviewed_at && r.grade !== null ? { grade: r.grade, comment: r.teacher_comment ?? "", reviewedAt: r.reviewed_at } : null,
});

/**
 * The school's records in Postgres (schema: migrations/002_school.sql). Access rules live
 * in the routes; the store only reads and writes.
 */
export class SchoolStore {
  /** Lesson balances and payments (school/finance.ts). */
  readonly finance: FinanceStore;
  /** Lessons and attendance (school/lesson-store.ts). */
  readonly lessons: LessonStore;

  constructor(private readonly sql: Sql) {
    this.finance = new FinanceStore(sql);
    this.lessons = new LessonStore(sql);
  }

  async createAccount(a: {
    role: Role;
    name: string;
    login: string;
    passwordHash: string;
    playerId?: string;
    email?: string | null;
  }): Promise<Account> {
    const { rows } = await this.sql.query<AccountRow>(
      `INSERT INTO accounts (account_id, role, name, login, password_hash, player_id, email) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (login) DO NOTHING
       RETURNING account_id, role, name, login, player_id, email, reminders, email_verified_at IS NOT NULL AS email_verified`,
      [newId("acc"), a.role, a.name, a.login, a.passwordHash, a.playerId ?? newId("player"), a.email ?? null],
    );
    if (!rows[0]) throw new LoginTakenError();
    return account(rows[0]);
  }

  async accountByLogin(login: string): Promise<(Account & { passwordHash: string }) | undefined> {
    const { rows } = await this.sql.query<AccountRow & { password_hash: string }>(`SELECT ${ACCOUNT}, a.password_hash FROM accounts a WHERE a.login = $1`, [login]);
    return rows[0] && { ...account(rows[0]), passwordHash: rows[0].password_hash };
  }

  async accountById(accountId: string): Promise<Account | undefined> {
    const { rows } = await this.sql.query<AccountRow>(`SELECT ${ACCOUNT} FROM accounts a WHERE a.account_id = $1`, [accountId]);
    return rows[0] && account(rows[0]);
  }

  /** Whether a player id already belongs to an account (a guest's progress can be adopted only once). */
  async playerTaken(playerId: string): Promise<boolean> {
    const { rows } = await this.sql.query("SELECT 1 FROM accounts WHERE player_id = $1", [playerId]);
    return rows.length > 0;
  }

  async createGroup(g: { teacherId: string; name: string; callUrl: string | null; schedule: Slot[]; unitAccess?: UnitAccess }): Promise<Group> {
    const groupId = newId("grp", 12);
    await this.sql.query("INSERT INTO school_groups (group_id, teacher_id, name, call_url, schedule, unit_access) VALUES ($1, $2, $3, $4, $5::jsonb, $6)", [
      groupId,
      g.teacherId,
      g.name,
      g.callUrl,
      JSON.stringify(g.schedule),
      g.unitAccess ?? "assigned",
    ]);
    return (await this.group(groupId))!;
  }

  async updateGroup(groupId: string, g: { name?: string; callUrl?: string | null; schedule?: Slot[]; unitAccess?: UnitAccess }): Promise<Group | undefined> {
    await this.sql.query(
      `UPDATE school_groups SET
         name = COALESCE($2, name),
         call_url = CASE WHEN $3::boolean THEN $4 ELSE call_url END,
         schedule = COALESCE($5::jsonb, schedule),
         unit_access = COALESCE($6, unit_access)
       WHERE group_id = $1`,
      [groupId, g.name ?? null, g.callUrl !== undefined, g.callUrl ?? null, g.schedule ? JSON.stringify(g.schedule) : null, g.unitAccess ?? null],
    );
    return this.group(groupId);
  }

  async group(groupId: string): Promise<Group | undefined> {
    const { rows } = await this.sql.query<GroupRow>(`SELECT ${GROUP} FROM school_groups g JOIN accounts t ON t.account_id = g.teacher_id WHERE g.group_id = $1`, [groupId]);
    return rows[0] && group(rows[0]);
  }

  /** A teacher's own groups, or the groups a student is in. */
  async groupsOf(a: Account): Promise<Group[]> {
    const { rows } =
      a.role === "teacher"
        ? await this.sql.query<GroupRow>(`SELECT ${GROUP} FROM school_groups g JOIN accounts t ON t.account_id = g.teacher_id WHERE g.teacher_id = $1 ORDER BY g.created_at`, [a.accountId])
        : await this.sql.query<GroupRow>(
            `SELECT ${GROUP} FROM school_groups g JOIN accounts t ON t.account_id = g.teacher_id
             JOIN group_members m ON m.group_id = g.group_id WHERE m.account_id = $1 ORDER BY m.joined_at`,
            [a.accountId],
          );
    return rows.map(group);
  }

  async members(groupId: string): Promise<Account[]> {
    const { rows } = await this.sql.query<AccountRow>(
      `SELECT ${ACCOUNT} FROM accounts a JOIN group_members m ON m.account_id = a.account_id WHERE m.group_id = $1 ORDER BY m.joined_at`,
      [groupId],
    );
    return rows.map(account);
  }

  /** Whether the teacher runs a group the student is in. */
  async teaches(teacherId: string, accountId: string): Promise<boolean> {
    const { rows } = await this.sql.query(
      "SELECT 1 FROM group_members m JOIN school_groups g ON g.group_id = m.group_id WHERE g.teacher_id = $1 AND m.account_id = $2 LIMIT 1",
      [teacherId, accountId],
    );
    return rows.length > 0;
  }

  async isMember(groupId: string, accountId: string): Promise<boolean> {
    const { rows } = await this.sql.query("SELECT 1 FROM group_members WHERE group_id = $1 AND account_id = $2", [groupId, accountId]);
    return rows.length > 0;
  }

  async join(groupId: string, accountId: string): Promise<void> {
    await this.sql.query("INSERT INTO group_members (group_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [groupId, accountId]);
  }

  async createInvite(groupId: string, expiresAt: Date): Promise<{ code: string; expiresAt: Date }> {
    // 12 characters from a 32-letter alphabet: 60 bits, short enough to read out over a call.
    const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
    await this.sql.query("INSERT INTO invites (code, group_id, expires_at) VALUES ($1, $2, $3)", [code, groupId, expiresAt]);
    return { code, expiresAt };
  }

  /** The group an invitation leads to, while it is valid. */
  async invite(code: string, now: Date): Promise<Group | undefined> {
    const { rows } = await this.sql.query<{ group_id: string }>("SELECT group_id FROM invites WHERE code = $1 AND expires_at > $2", [code, now]);
    return rows[0] && this.group(rows[0].group_id);
  }

  async createHomework(h: {
    groupId: string;
    title: string;
    description: string;
    dueAt: Date | null;
    needsFile: boolean;
    moduleId?: string | null;
    accountId?: string | null;
    autoGrade?: boolean;
    /** A unit counts the episodes played from this moment on. */
    createdAt?: Date;
  }): Promise<Homework> {
    const homeworkId = newId("hw", 12);
    await this.sql.query(
      `INSERT INTO homework (homework_id, group_id, title, description, due_at, needs_file, module_id, account_id, auto_grade, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, now()))`,
      [homeworkId, h.groupId, h.title, h.description, h.dueAt, h.needsFile, h.moduleId ?? null, h.accountId ?? null, h.autoGrade ?? false, h.createdAt ?? null],
    );
    return (await this.homework(homeworkId))!;
  }

  async homework(homeworkId: string): Promise<Homework | undefined> {
    const { rows } = await this.sql.query<HomeworkRow>(`SELECT ${HOMEWORK} FROM homework h WHERE h.homework_id = $1`, [homeworkId]);
    return rows[0] && homework(rows[0]);
  }

  /**
   * Homework of these groups, the nearest deadline first, then the newest. With `forStudent`,
   * only what that student has to do: the group's homework and their own, not a classmate's.
   */
  async homeworkOf(groupIds: string[], forStudent?: string): Promise<Homework[]> {
    if (!groupIds.length) return [];
    const { rows } = await this.sql.query<HomeworkRow>(
      `SELECT ${HOMEWORK} FROM homework h WHERE h.group_id = ANY($1::text[]) AND ($2::text IS NULL OR h.account_id IS NULL OR h.account_id = $2)
       ORDER BY h.due_at ASC NULLS LAST, h.created_at DESC`,
      [groupIds, forStudent ?? null],
    );
    return rows.map(homework);
  }

  /** Records a hand-in; returns the file key it replaced, if any, so the old file can go. */
  async submit(s: { homeworkId: string; accountId: string; fileKey: string; fileName: string; mime: string; size: number }): Promise<{ submission: Submission; replacedKey?: string }> {
    const before = await this.sql.query<{ file_key: string }>("SELECT file_key FROM submissions WHERE homework_id = $1 AND account_id = $2", [s.homeworkId, s.accountId]);
    const { rows } = await this.sql.query<{ submission_id: string }>(
      `INSERT INTO submissions (submission_id, homework_id, account_id, file_key, file_name, mime, size) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (homework_id, account_id) DO UPDATE SET
         file_key = EXCLUDED.file_key, file_name = EXCLUDED.file_name, mime = EXCLUDED.mime, size = EXCLUDED.size, submitted_at = now(),
         grade = NULL, teacher_comment = NULL, reviewed_at = NULL
       RETURNING submission_id`,
      [newId("sub", 12), s.homeworkId, s.accountId, s.fileKey, s.fileName, s.mime, s.size],
    );
    const replaced = before.rows[0]?.file_key;
    return { submission: (await this.submission(rows[0]!.submission_id))!, ...(replaced && replaced !== s.fileKey ? { replacedKey: replaced } : {}) };
  }

  /**
   * Records a unit's result as the student's hand-in, or replaces an earlier result the teacher
   * has not graded yet. A graded result stays as it is.
   */
  async submitUnit(s: { homeworkId: string; accountId: string; right: number; total: number; at: Date }): Promise<Submission | undefined> {
    const { rows } = await this.sql.query<{ submission_id: string }>(
      `INSERT INTO submissions (submission_id, homework_id, account_id, score_right, score_total, submitted_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (homework_id, account_id) DO UPDATE SET score_right = EXCLUDED.score_right, score_total = EXCLUDED.score_total, submitted_at = EXCLUDED.submitted_at
       WHERE submissions.reviewed_at IS NULL
       RETURNING submission_id`,
      [newId("sub", 12), s.homeworkId, s.accountId, s.right, s.total, s.at],
    );
    return rows[0] && this.submission(rows[0].submission_id);
  }

  async submission(submissionId: string): Promise<Submission | undefined> {
    const { rows } = await this.sql.query<SubmissionRow>(`SELECT ${SUBMISSION} FROM submissions s JOIN accounts a ON a.account_id = s.account_id WHERE s.submission_id = $1`, [
      submissionId,
    ]);
    return rows[0] && submission(rows[0]);
  }

  /** Hand-ins for these homework items; only the given student's when accountId is set. */
  async submissionsFor(homeworkIds: string[], accountId?: string): Promise<Submission[]> {
    if (!homeworkIds.length) return [];
    const { rows } = await this.sql.query<SubmissionRow>(
      `SELECT ${SUBMISSION} FROM submissions s JOIN accounts a ON a.account_id = s.account_id
       WHERE s.homework_id = ANY($1::text[]) AND ($2::text IS NULL OR s.account_id = $2) ORDER BY s.submitted_at`,
      [homeworkIds, accountId ?? null],
    );
    return rows.map(submission);
  }

  /** Hand-ins in the teacher's groups that wait for a review, the oldest first. */
  async reviewQueue(teacherId: string): Promise<Submission[]> {
    const { rows } = await this.sql.query<SubmissionRow>(
      `SELECT ${SUBMISSION} FROM submissions s JOIN accounts a ON a.account_id = s.account_id
       JOIN homework h ON h.homework_id = s.homework_id JOIN school_groups g ON g.group_id = h.group_id
       WHERE g.teacher_id = $1 AND s.reviewed_at IS NULL ORDER BY s.submitted_at`,
      [teacherId],
    );
    return rows.map(submission);
  }

  async review(submissionId: string, grade: number, comment: string, at: Date): Promise<Submission | undefined> {
    await this.sql.query("UPDATE submissions SET grade = $2, teacher_comment = $3, reviewed_at = $4 WHERE submission_id = $1", [submissionId, grade, comment, at]);
    return this.submission(submissionId);
  }

  async setPassword(accountId: string, passwordHash: string): Promise<void> {
    await this.sql.query("UPDATE accounts SET password_hash = $2 WHERE account_id = $1", [accountId, passwordHash]);
  }

  /** Keeps the answers from the xAPI intake; a statement already kept (a resend from the offline queue) is skipped. */
  async recordAttempts(attempts: Attempt[]): Promise<void> {
    if (!attempts.length) return;
    await this.sql.query(
      `INSERT INTO attempts (statement_id, player_id, answered_at, task_id, module_id, concept_id, success, error_type, attempt_no, duration_ms, mode)
       SELECT (a->>'statementId')::uuid, a->>'playerId', (a->>'answeredAt')::timestamptz, a->>'taskId', a->>'moduleId', a->>'conceptId',
              (a->>'success')::boolean, a->>'errorType', (a->>'attemptNo')::int, (a->>'durationMs')::int, a->>'mode'
       FROM jsonb_array_elements($1::jsonb) AS t(a)
       ON CONFLICT (statement_id) DO NOTHING`,
      [JSON.stringify(attempts)],
    );
  }

  /** A player's practice between `from` and `to`, with days counted in Moscow time. */
  async practice(playerId: string, from: Date, to: Date): Promise<PracticeSummary> {
    const window = [playerId, from, to];
    const totals = await this.sql.query<{ answers: number; first_tries: number; first_right: number; ms: string | number | null; last_at: Date | null }>(
      `SELECT count(*)::int AS answers,
              count(*) FILTER (WHERE attempt_no = 1)::int AS first_tries,
              count(*) FILTER (WHERE attempt_no = 1 AND success)::int AS first_right,
              sum(duration_ms) AS ms, max(answered_at) AS last_at
       FROM attempts WHERE player_id = $1 AND answered_at >= $2 AND answered_at < $3`,
      window,
    );
    const days = await this.sql.query<{ day: string }>(
      `SELECT DISTINCT to_char(answered_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS day
       FROM attempts WHERE player_id = $1 AND answered_at >= $2 AND answered_at < $3 ORDER BY day`,
      window,
    );
    const errors = await this.sql.query<{ error_type: string; n: number }>(
      `SELECT error_type, count(*)::int AS n FROM attempts
       WHERE player_id = $1 AND answered_at >= $2 AND answered_at < $3 AND NOT success AND error_type IS NOT NULL
       GROUP BY error_type ORDER BY n DESC, error_type LIMIT 5`,
      window,
    );
    const modes = await this.sql.query<{ mode: string; n: number; right: number }>(
      `SELECT COALESCE(mode, 'other') AS mode, count(*)::int AS n, count(*) FILTER (WHERE success)::int AS right
       FROM attempts WHERE player_id = $1 AND answered_at >= $2 AND answered_at < $3 GROUP BY 1 ORDER BY 2 DESC`,
      window,
    );
    const t = totals.rows[0]!;
    return {
      days: days.rows.map((r) => r.day),
      answers: t.answers,
      firstTries: t.first_tries,
      firstTriesRight: t.first_right,
      minutes: Math.round(Number(t.ms ?? 0) / 60_000),
      errors: errors.rows.map((r) => ({ errorType: r.error_type, count: r.n })),
      modes: modes.rows.map((r) => ({ mode: r.mode, answers: r.n, right: r.right })),
      lastAnsweredAt: t.last_at,
    };
  }

  /** Every answer of these players in a time window, for the pilot's metrics. */
  async attemptsOf(playerIds: string[], from: Date, to: Date): Promise<MetricAttempt[]> {
    if (!playerIds.length) return [];
    const { rows } = await this.sql.query<{
      player_id: string;
      answered_at: Date;
      task_id: string;
      success: boolean;
      error_type: string | null;
      attempt_no: number;
      duration_ms: number;
      mode: string | null;
    }>(
      `SELECT player_id, answered_at, task_id, success, error_type, attempt_no, duration_ms, mode FROM attempts
       WHERE player_id = ANY($1::text[]) AND answered_at >= $2 AND answered_at < $3 ORDER BY answered_at`,
      [playerIds, from, to],
    );
    return rows.map((r) => ({
      playerId: r.player_id,
      answeredAt: new Date(r.answered_at),
      taskId: r.task_id,
      success: r.success,
      errorType: r.error_type,
      attemptNo: r.attempt_no,
      durationMs: r.duration_ms,
      mode: r.mode,
    }));
  }

  /** The first answer of any of these players, if there is one. */
  async firstAnswerOf(playerIds: string[]): Promise<Date | undefined> {
    if (!playerIds.length) return undefined;
    const { rows } = await this.sql.query<{ at: Date | null }>("SELECT min(answered_at) AS at FROM attempts WHERE player_id = ANY($1::text[])", [playerIds]);
    return rows[0]?.at ? new Date(rows[0].at) : undefined;
  }

  /** The Moscow date (YYYY-MM-DD) the group's pilot starts, if the teacher set it. */
  async pilotFrom(groupId: string): Promise<string | undefined> {
    const { rows } = await this.sql.query<{ d: string | null }>("SELECT to_char(pilot_from, 'YYYY-MM-DD') AS d FROM school_groups WHERE group_id = $1", [groupId]);
    return rows[0]?.d ?? undefined;
  }

  async setPilotFrom(groupId: string, date: string): Promise<void> {
    await this.sql.query("UPDATE school_groups SET pilot_from = $2::date WHERE group_id = $1", [groupId, date]);
  }

  async accountByPlayer(playerId: string): Promise<Account | undefined> {
    const { rows } = await this.sql.query<AccountRow>(`SELECT ${ACCOUNT} FROM accounts a WHERE a.player_id = $1`, [playerId]);
    return rows[0] && account(rows[0]);
  }

  /** Keeps finished episodes; a statement already kept is skipped. */
  async recordEpisodeResults(results: EpisodeResult[]): Promise<void> {
    if (!results.length) return;
    await this.sql.query(
      `INSERT INTO episode_results (statement_id, player_id, episode_id, module_id, first_try_right, tasks, finished_at)
       SELECT (r->>'statementId')::uuid, r->>'playerId', r->>'episodeId', r->>'moduleId', (r->>'right')::int, (r->>'tasks')::int, (r->>'finishedAt')::timestamptz
       FROM jsonb_array_elements($1::jsonb) AS t(r)
       ON CONFLICT (statement_id) DO NOTHING`,
      [JSON.stringify(results)],
    );
  }

  /** The best play of each episode of a unit since `since`: the most right on the first try, the earliest of equals. */
  async bestEpisodeResults(playerId: string, moduleId: string, since: Date): Promise<{ episodeId: string; right: number; tasks: number; finishedAt: Date }[]> {
    const { rows } = await this.sql.query<{ episode_id: string; first_try_right: number; tasks: number; finished_at: Date }>(
      `SELECT DISTINCT ON (episode_id) episode_id, first_try_right, tasks, finished_at FROM episode_results
       WHERE player_id = $1 AND module_id = $2 AND finished_at >= $3
       ORDER BY episode_id, (CASE WHEN tasks = 0 THEN 1 ELSE first_try_right::float / tasks END) DESC, finished_at`,
      [playerId, moduleId, since],
    );
    return rows.map((r) => ({ episodeId: r.episode_id, right: r.first_try_right, tasks: r.tasks, finishedAt: new Date(r.finished_at) }));
  }

  async addFeedback(f: { accountId: string; page: string; message: string; userAgent: string }): Promise<string> {
    const id = newId("fb", 12);
    await this.sql.query("INSERT INTO feedback (feedback_id, account_id, page, message, user_agent) VALUES ($1, $2, $3, $4, $5)", [id, f.accountId, f.page, f.message, f.userAgent]);
    return id;
  }

  /** Reports from these accounts (or from everyone), the newest first. */
  async feedback(accountIds?: string[], limit = 100): Promise<Feedback[]> {
    const { rows } = await this.sql.query<{ feedback_id: string; account_id: string; name: string; role: Role; page: string; message: string; user_agent: string; created_at: Date }>(
      `SELECT f.feedback_id, f.account_id, a.name, a.role, f.page, f.message, f.user_agent, f.created_at
       FROM feedback f JOIN accounts a ON a.account_id = f.account_id
       WHERE $1::text[] IS NULL OR f.account_id = ANY($1::text[])
       ORDER BY f.created_at DESC LIMIT $2`,
      [accountIds ?? null, limit],
    );
    return rows.map((r) => ({
      feedbackId: r.feedback_id,
      accountId: r.account_id,
      name: r.name,
      role: r.role,
      page: r.page,
      message: r.message,
      userAgent: r.user_agent,
      createdAt: new Date(r.created_at),
    }));
  }
}
