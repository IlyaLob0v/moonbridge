import type { Sql } from "../db/sql.js";
import type { Group, Slot } from "./store.js";

export type LessonStatus = "planned" | "held" | "cancelled";
/** "absent" is a lesson the student missed. */
export type AttendanceStatus = "present" | "absent";

export interface Material {
  title: string;
  url: string;
}

export interface Lesson {
  lessonId: string;
  groupId: string;
  /** The weekly slot it was generated from; null for a lesson added by hand. */
  slotAt: Date | null;
  startsAt: Date;
  minutes: number;
  status: LessonStatus;
  topic: string;
  /** This lesson's own call link; null means the group's. */
  callUrl: string | null;
  materials: Material[];
  recordingUrl: string | null;
  note: string;
}

/** A file the teacher attached to a lesson. */
export interface LessonFile {
  fileId: string;
  lessonId: string;
  fileKey: string;
  fileName: string;
  mime: string;
  size: number;
  uploadedAt: Date;
}

export interface Mark {
  lessonId: string;
  accountId: string;
  status: AttendanceStatus;
  markedAt: Date;
}

export interface LessonChanges {
  startsAt?: Date;
  minutes?: number;
  status?: "planned" | "cancelled";
  topic?: string;
  callUrl?: string | null;
  materials?: Material[];
  recordingUrl?: string | null;
  note?: string;
}

const MSK_MS = 3 * 3600_000;
const DAY_MS = 24 * 3600_000;
/** Lessons exist this far ahead, so students see the coming weeks and teachers can attach materials early. */
export const HORIZON_DAYS = 28;
/** Generation tops the horizon up once it is this close. */
const REFILL_DAYS = 21;

/** Monday 00:00 in Moscow of the week that holds `at`. */
function mondayOf(at: Date): number {
  const local = new Date(at.getTime() + MSK_MS);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - ((local.getUTCDay() + 6) % 7) * DAY_MS - MSK_MS;
}

/** The start of every slot of a weekly schedule (Moscow time) in [from, to), in time order. */
export function slotTimes(schedule: Slot[], from: Date, to: Date): { at: Date; minutes: number }[] {
  const out: { at: Date; minutes: number }[] = [];
  for (let week = mondayOf(from); week < to.getTime(); week += 7 * DAY_MS) {
    for (const s of schedule) {
      const [h, m] = s.time.split(":").map(Number) as [number, number];
      const at = week + (s.weekday - 1) * DAY_MS + (h * 60 + m) * 60_000;
      if (at >= from.getTime() && at < to.getTime()) out.push({ at: new Date(at), minutes: s.minutes });
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** The same schedule, whatever order the teacher listed the slots in. */
const scheduleKey = (s: Slot[]) => JSON.stringify([...s].map((x) => [x.weekday, x.time, x.minutes]).sort());

const newId = () => `les_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

const LESSON = "l.lesson_id, l.group_id, l.slot_at, l.starts_at, l.minutes, l.status, l.topic, l.call_url, l.materials, l.recording_url, l.note";
interface LessonRow {
  lesson_id: string;
  group_id: string;
  slot_at: Date | null;
  starts_at: Date;
  minutes: number;
  status: LessonStatus;
  topic: string;
  call_url: string | null;
  materials: Material[];
  recording_url: string | null;
  note: string;
}
const lesson = (r: LessonRow): Lesson => ({
  lessonId: r.lesson_id,
  groupId: r.group_id,
  slotAt: r.slot_at ? new Date(r.slot_at) : null,
  startsAt: new Date(r.starts_at),
  minutes: r.minutes,
  status: r.status,
  topic: r.topic,
  callUrl: r.call_url,
  materials: r.materials,
  recordingUrl: r.recording_url,
  note: r.note,
});

/**
 * Lessons and attendance (migrations/006_lessons.sql). A group's weekly schedule is the
 * template: `sync` keeps lessons generated four weeks ahead and, when the schedule changes,
 * replaces the coming lessons the teacher has not touched.
 */
export class LessonStore {
  constructor(private readonly sql: Sql) {}

  async sync(group: Group, now: Date): Promise<void> {
    const { rows } = await this.sql.query<{ schedule: Slot[]; generated_until: Date }>("SELECT schedule, generated_until FROM lesson_plans WHERE group_id = $1", [group.groupId]);
    const plan = rows[0];
    const horizon = new Date(now.getTime() + HORIZON_DAYS * DAY_MS);
    const changed = !!plan && scheduleKey(plan.schedule) !== scheduleKey(group.schedule);
    if (plan && !changed && new Date(plan.generated_until).getTime() > now.getTime() + REFILL_DAYS * DAY_MS) return;
    let from: Date;
    if (!plan) {
      // A new plan starts with this week, so the lessons already past this week can be marked too.
      from = new Date(mondayOf(now));
    } else if (changed) {
      await this.sql.query(
        "DELETE FROM lessons WHERE group_id = $1 AND slot_at IS NOT NULL AND slot_at >= $2 AND status = 'planned' AND NOT edited",
        [group.groupId, now],
      );
      from = now;
    } else {
      from = new Date(Math.max(new Date(plan.generated_until).getTime(), now.getTime() - 7 * DAY_MS));
    }
    const slots = slotTimes(group.schedule, from, horizon);
    if (slots.length) {
      await this.sql.query(
        `INSERT INTO lessons (lesson_id, group_id, slot_at, starts_at, minutes)
         SELECT s->>'id', $1, (s->>'at')::timestamptz, (s->>'at')::timestamptz, (s->>'minutes')::int FROM jsonb_array_elements($2::jsonb) AS t(s)
         ON CONFLICT (group_id, slot_at) DO NOTHING`,
        [group.groupId, JSON.stringify(slots.map((s) => ({ id: newId(), at: s.at.toISOString(), minutes: s.minutes })))],
      );
    }
    await this.sql.query(
      `INSERT INTO lesson_plans (group_id, schedule, generated_until) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (group_id) DO UPDATE SET schedule = EXCLUDED.schedule, generated_until = EXCLUDED.generated_until`,
      [group.groupId, JSON.stringify(group.schedule), horizon],
    );
  }

  async create(l: { groupId: string; startsAt: Date; minutes: number; topic: string }): Promise<Lesson> {
    const id = newId();
    await this.sql.query("INSERT INTO lessons (lesson_id, group_id, starts_at, minutes, topic, edited) VALUES ($1, $2, $3, $4, $5, true)", [id, l.groupId, l.startsAt, l.minutes, l.topic]);
    return (await this.lesson(id))!;
  }

  async lesson(lessonId: string): Promise<Lesson | undefined> {
    const { rows } = await this.sql.query<LessonRow>(`SELECT ${LESSON} FROM lessons l WHERE l.lesson_id = $1`, [lessonId]);
    return rows[0] && lesson(rows[0]);
  }

  /** Lessons of these groups starting in [from, to), in time order. */
  async between(groupIds: string[], from: Date, to: Date): Promise<Lesson[]> {
    if (!groupIds.length) return [];
    const { rows } = await this.sql.query<LessonRow>(
      `SELECT ${LESSON} FROM lessons l WHERE l.group_id = ANY($1::text[]) AND l.starts_at >= $2 AND l.starts_at < $3 ORDER BY l.starts_at, l.lesson_id`,
      [groupIds, from, to],
    );
    return rows.map(lesson);
  }

  /** Planned lessons of these groups that have ended by `now` and still wait for attendance. */
  async unmarked(groupIds: string[], since: Date, now: Date): Promise<Lesson[]> {
    if (!groupIds.length) return [];
    const { rows } = await this.sql.query<LessonRow>(
      `SELECT ${LESSON} FROM lessons l WHERE l.group_id = ANY($1::text[]) AND l.status = 'planned'
       AND l.starts_at >= $2 AND l.starts_at + make_interval(mins => l.minutes) <= $3 ORDER BY l.starts_at`,
      [groupIds, since, now],
    );
    return rows.map(lesson);
  }

  async update(lessonId: string, c: LessonChanges): Promise<Lesson | undefined> {
    await this.sql.query(
      `UPDATE lessons SET
         starts_at = COALESCE($2, starts_at),
         minutes = COALESCE($3, minutes),
         status = COALESCE($4, status),
         topic = COALESCE($5, topic),
         call_url = CASE WHEN $6::boolean THEN $7 ELSE call_url END,
         materials = COALESCE($8::jsonb, materials),
         recording_url = CASE WHEN $9::boolean THEN $10 ELSE recording_url END,
         note = COALESCE($11, note),
         edited = true
       WHERE lesson_id = $1`,
      [
        lessonId,
        c.startsAt ?? null,
        c.minutes ?? null,
        c.status ?? null,
        c.topic ?? null,
        c.callUrl !== undefined,
        c.callUrl ?? null,
        c.materials ? JSON.stringify(c.materials) : null,
        c.recordingUrl !== undefined,
        c.recordingUrl ?? null,
        c.note ?? null,
      ],
    );
    return this.lesson(lessonId);
  }

  /** Records the marks and makes the lesson held. */
  async mark(lessonId: string, marks: { accountId: string; status: AttendanceStatus }[], by: string, at: Date): Promise<void> {
    if (marks.length) {
      await this.sql.query(
        `INSERT INTO lesson_attendance (lesson_id, account_id, status, marked_at, marked_by)
         SELECT $1, m->>'accountId', m->>'status', $2, $3 FROM jsonb_array_elements($4::jsonb) AS t(m)
         ON CONFLICT (lesson_id, account_id) DO UPDATE SET status = EXCLUDED.status, marked_at = EXCLUDED.marked_at, marked_by = EXCLUDED.marked_by`,
        [lessonId, at, by, JSON.stringify(marks)],
      );
    }
    await this.sql.query("UPDATE lessons SET status = 'held', edited = true WHERE lesson_id = $1", [lessonId]);
  }

  /** Drops the marks of a lesson that is no longer held; returns who was marked present. */
  async clearMarks(lessonId: string): Promise<string[]> {
    const { rows } = await this.sql.query<{ account_id: string; status: AttendanceStatus }>("DELETE FROM lesson_attendance WHERE lesson_id = $1 RETURNING account_id, status", [lessonId]);
    return rows.filter((r) => r.status === "present").map((r) => r.account_id);
  }

  /** Marks for these lessons; only one student's when accountId is set. */
  async marks(lessonIds: string[], accountId?: string): Promise<Mark[]> {
    if (!lessonIds.length) return [];
    const { rows } = await this.sql.query<{ lesson_id: string; account_id: string; status: AttendanceStatus; marked_at: Date }>(
      "SELECT lesson_id, account_id, status, marked_at FROM lesson_attendance WHERE lesson_id = ANY($1::text[]) AND ($2::text IS NULL OR account_id = $2)",
      [lessonIds, accountId ?? null],
    );
    return rows.map((r) => ({ lessonId: r.lesson_id, accountId: r.account_id, status: r.status, markedAt: new Date(r.marked_at) }));
  }

  /** Attaches a file; the lesson counts as prepared, so a schedule change keeps it. */
  async addFile(f: { lessonId: string; fileKey: string; fileName: string; mime: string; size: number }): Promise<LessonFile> {
    const id = `lf_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await this.sql.query("INSERT INTO lesson_files (file_id, lesson_id, file_key, file_name, mime, size) VALUES ($1, $2, $3, $4, $5, $6)", [id, f.lessonId, f.fileKey, f.fileName, f.mime, f.size]);
    await this.sql.query("UPDATE lessons SET edited = true WHERE lesson_id = $1", [f.lessonId]);
    return (await this.file(id))!;
  }

  async file(fileId: string): Promise<LessonFile | undefined> {
    const { rows } = await this.sql.query<FileRow>(`SELECT ${FILE} FROM lesson_files WHERE file_id = $1`, [fileId]);
    return rows[0] && lessonFile(rows[0]);
  }

  /** Files of these lessons, the oldest first. */
  async files(lessonIds: string[]): Promise<LessonFile[]> {
    if (!lessonIds.length) return [];
    const { rows } = await this.sql.query<FileRow>(`SELECT ${FILE} FROM lesson_files WHERE lesson_id = ANY($1::text[]) ORDER BY uploaded_at, file_id`, [lessonIds]);
    return rows.map(lessonFile);
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.sql.query("DELETE FROM lesson_files WHERE file_id = $1", [fileId]);
  }
}

const FILE = "file_id, lesson_id, file_key, file_name, mime, size, uploaded_at";
interface FileRow {
  file_id: string;
  lesson_id: string;
  file_key: string;
  file_name: string;
  mime: string;
  size: string | number;
  uploaded_at: Date;
}
const lessonFile = (r: FileRow): LessonFile => ({
  fileId: r.file_id,
  lessonId: r.lesson_id,
  fileKey: r.file_key,
  fileName: r.file_name,
  mime: r.mime,
  size: Number(r.size),
  uploadedAt: new Date(r.uploaded_at),
});
