import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AttendanceStatus, Lesson, LessonChanges, Mark } from "./lesson-store.js";
import type { Account, Group, SchoolStore } from "./store.js";

/**
 * Where a held lesson is paid for. The school's finances implement it (a lesson debited from
 * the student's balance); both calls must be safe to repeat. A student marked present on a held
 * lesson is charged; a mark changed to absent, or a lesson that is no longer held, is uncharged.
 * Students who missed the lesson ("absent") are not charged.
 */
export interface LessonBilling {
  charge(accountId: string, lessonId: string, at: Date, byAccountId: string): Promise<void>;
  uncharge(accountId: string, lessonId: string): Promise<void>;
}

export interface LessonDeps {
  school: SchoolStore;
  now: () => Date;
  billing?: LessonBilling;
  requireAccount: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  requireTeacher: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

const DAY_MS = 24 * 3600_000;
const URL_FIELD = { type: "string", pattern: "^https?://", maxLength: 500 } as const;
const nullableUrl = { anyOf: [URL_FIELD, { type: "null" }] } as const;
const materials = {
  type: "array",
  maxItems: 10,
  items: {
    type: "object",
    required: ["title", "url"],
    additionalProperties: false,
    properties: { title: { type: "string", minLength: 1, maxLength: 120 }, url: URL_FIELD },
  },
} as const;
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

/** The lesson as students and teachers see it; the call link falls back to the group's. */
export const lessonView = (l: Lesson, g: Group) => ({
  lesson_id: l.lessonId,
  group_id: l.groupId,
  group_name: g.name,
  starts_at: l.startsAt.toISOString(),
  ends_at: new Date(l.startsAt.getTime() + l.minutes * 60_000).toISOString(),
  minutes: l.minutes,
  status: l.status,
  topic: l.topic,
  call_url: l.callUrl ?? g.callUrl,
  materials: l.materials,
  recording_url: l.recordingUrl,
  note: l.note,
});

/** The lessons of the account's groups between two dates, with attendance: their own for a student, everyone's for a teacher. */
export async function lessonsFor(school: SchoolStore, a: Account, groups: Group[], from: Date, to: Date, now: Date) {
  for (const g of groups) await school.lessons.sync(g, now);
  const lessons = await school.lessons.between(groups.map((g) => g.groupId), from, to);
  const byId = new Map(groups.map((g) => [g.groupId, g]));
  if (a.role === "student") {
    const marks = await school.lessons.marks(lessons.map((l) => l.lessonId), a.accountId);
    return lessons.map((l) => ({ ...lessonView(l, byId.get(l.groupId)!), attendance: (l.status === "held" && marks.find((m) => m.lessonId === l.lessonId)?.status) || null }));
  }
  const marks = await school.lessons.marks(lessons.map((l) => l.lessonId));
  const members = new Map(await Promise.all(groups.map(async (g) => [g.groupId, await school.members(g.groupId)] as const)));
  return lessons.map((l) => teacherLessonView(l, byId.get(l.groupId)!, members.get(l.groupId) ?? [], marks));
}

function teacherLessonView(l: Lesson, g: Group, members: Account[], marks: Mark[]) {
  return {
    ...lessonView(l, g),
    attendance: members.map((m) => ({ account_id: m.accountId, name: m.name, status: marks.find((x) => x.lessonId === l.lessonId && x.accountId === m.accountId)?.status ?? null })),
  };
}

/**
 * The lessons on the dashboard. A student: the coming two weeks and the last month's lessons
 * (materials, recordings). A teacher: the coming week and the ended lessons still waiting for
 * attendance.
 */
export async function dashboardLessons(school: SchoolStore, a: Account, groups: Group[], now: Date) {
  const all = await lessonsFor(school, a, groups, new Date(now.getTime() - 30 * DAY_MS), new Date(now.getTime() + (a.role === "student" ? 14 : 7) * DAY_MS), now);
  if (a.role === "student") return all;
  return all.filter((l) => (l.status === "planned" && Date.parse(l.ends_at) <= now.getTime()) || Date.parse(l.ends_at) > now.getTime());
}

/** A student's lessons in a week, for the weekly report: held ones with their attendance, and cancelled ones. */
export async function weekAttendance(school: SchoolStore, student: Account, groups: Group[], from: Date, to: Date, now: Date) {
  const lessons = (await lessonsFor(school, student, groups, from, to, now)) as (ReturnType<typeof lessonView> & { attendance: AttendanceStatus | null })[];
  const past = lessons.filter((l) => Date.parse(l.starts_at) <= now.getTime());
  const held = past.filter((l) => l.status === "held");
  return {
    lessons: past,
    held: held.length,
    present: held.filter((l) => l.attendance === "present").length,
    absent: held.filter((l) => l.attendance === "absent").length,
  };
}

interface LessonBody {
  starts_at?: string;
  minutes?: number;
  status?: "planned" | "cancelled";
  topic?: string;
  call_url?: string | null;
  materials?: { title: string; url: string }[];
  recording_url?: string | null;
  note?: string;
}

/**
 * Lessons: generated from the group's weekly schedule, edited by the teacher (topic,
 * materials, the recording, moved or cancelled), attendance marked after the lesson. The
 * lesson itself happens in the video service behind `call_url`.
 */
export async function lessonRoutes(app: FastifyInstance, d: LessonDeps): Promise<void> {
  const { school } = d;

  const range = (q: { from?: string; to?: string }, back: number, ahead: number) => {
    const now = d.now();
    const from = q.from && dateOnly.test(q.from) ? new Date(`${q.from}T00:00:00+03:00`) : new Date(now.getTime() - back * DAY_MS);
    const to = q.to && dateOnly.test(q.to) ? new Date(`${q.to}T00:00:00+03:00`) : new Date(now.getTime() + ahead * DAY_MS);
    // No more than half a year in one answer.
    return { from, to: new Date(Math.min(to.getTime(), from.getTime() + 183 * DAY_MS)) };
  };

  /** The lesson and its group, if the signed-in teacher runs the group. */
  const ownLesson = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const l = await school.lessons.lesson(req.params.id);
    const g = l && (await school.group(l.groupId));
    if (!l || !g || g.teacherId !== req.account!.accountId) {
      reply.code(404).send({ error: "no such lesson" });
      return undefined;
    }
    return { lesson: l, group: g };
  };

  const ownGroup = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const g = await school.group(req.params.id);
    if (!g || g.teacherId !== req.account!.accountId) {
      reply.code(404).send({ error: "no such group" });
      return undefined;
    }
    return g;
  };

  const viewFor = async (l: Lesson, g: Group) => teacherLessonView(l, g, await school.members(g.groupId), await school.lessons.marks([l.lessonId]));

  /** The signed-in account's lessons: the last two months and the coming four weeks by default; `from`/`to` are Moscow dates. */
  app.get<{ Querystring: { from?: string; to?: string } }>("/school/lessons", { preHandler: d.requireAccount }, async (req) => {
    const a = req.account!;
    const { from, to } = range(req.query, 60, 28);
    return { lessons: await lessonsFor(school, a, await school.groupsOf(a), from, to, d.now()) };
  });

  /** One group's lessons for its teacher, with every student's attendance: four weeks back and ahead by default. */
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>("/school/groups/:id/lessons", { preHandler: d.requireTeacher }, async (req, reply) => {
    const g = await ownGroup(req, reply);
    if (!g) return;
    const { from, to } = range(req.query, 28, 28);
    return { group: { group_id: g.groupId, name: g.name, call_url: g.callUrl }, lessons: await lessonsFor(school, req.account!, [g], from, to, d.now()) };
  });

  /** An extra lesson outside the weekly schedule: a make-up, an individual session. */
  app.post<{ Params: { id: string }; Body: { starts_at: string; minutes: number; topic?: string } }>(
    "/school/groups/:id/lessons",
    {
      preHandler: d.requireTeacher,
      schema: {
        body: {
          type: "object",
          required: ["starts_at", "minutes"],
          additionalProperties: false,
          properties: { starts_at: { type: "string", format: "date-time" }, minutes: { type: "integer", minimum: 15, maximum: 240 }, topic: { type: "string", maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      const g = await ownGroup(req, reply);
      if (!g) return;
      const l = await school.lessons.create({ groupId: g.groupId, startsAt: new Date(req.body.starts_at), minutes: req.body.minutes, topic: (req.body.topic ?? "").trim() });
      return reply.code(201).send({ lesson: await viewFor(l, g) });
    },
  );

  /** Topic, materials, the recording, another time or call link, a note; cancels a lesson or brings it back. */
  app.patch<{ Params: { id: string }; Body: LessonBody }>(
    "/school/lessons/:id",
    {
      preHandler: d.requireTeacher,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            starts_at: { type: "string", format: "date-time" },
            minutes: { type: "integer", minimum: 15, maximum: 240 },
            status: { enum: ["planned", "cancelled"] },
            topic: { type: "string", maxLength: 200 },
            call_url: nullableUrl,
            materials,
            recording_url: nullableUrl,
            note: { type: "string", maxLength: 1000 },
          },
        },
      },
    },
    async (req, reply) => {
      const own = await ownLesson(req, reply);
      if (!own) return;
      const b = req.body;
      const c: LessonChanges = {
        ...(b.starts_at !== undefined ? { startsAt: new Date(b.starts_at) } : {}),
        ...(b.minutes !== undefined ? { minutes: b.minutes } : {}),
        ...(b.status !== undefined ? { status: b.status } : {}),
        ...(b.topic !== undefined ? { topic: b.topic.trim() } : {}),
        ...(b.call_url !== undefined ? { callUrl: b.call_url } : {}),
        ...(b.materials !== undefined ? { materials: b.materials.map((m) => ({ title: m.title.trim(), url: m.url.trim() })) } : {}),
        ...(b.recording_url !== undefined ? { recordingUrl: b.recording_url } : {}),
        ...(b.note !== undefined ? { note: b.note.trim() } : {}),
      };
      // A held lesson that is cancelled or reopened is no longer paid for; its marks go.
      if (own.lesson.status === "held" && c.status) {
        for (const accountId of await school.lessons.clearMarks(own.lesson.lessonId)) await d.billing?.uncharge(accountId, own.lesson.lessonId);
      }
      const l = await school.lessons.update(own.lesson.lessonId, c);
      return { lesson: await viewFor(l!, own.group) };
    },
  );

  /** Attendance after the lesson: present or absent for each student. The lesson becomes held. */
  app.put<{ Params: { id: string }; Body: { marks: { account_id: string; status: AttendanceStatus }[] } }>(
    "/school/lessons/:id/attendance",
    {
      preHandler: d.requireTeacher,
      schema: {
        body: {
          type: "object",
          required: ["marks"],
          additionalProperties: false,
          properties: {
            marks: {
              type: "array",
              maxItems: 100,
              items: { type: "object", required: ["account_id", "status"], additionalProperties: false, properties: { account_id: { type: "string" }, status: { enum: ["present", "absent"] } } },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const own = await ownLesson(req, reply);
      if (!own) return;
      const at = d.now();
      if (own.lesson.startsAt > at) return reply.code(409).send({ error: "not_started", message: "Урок ещё не начался" });
      const members = new Set((await school.members(own.group.groupId)).map((m) => m.accountId));
      if (req.body.marks.some((m) => !members.has(m.account_id))) return reply.code(400).send({ error: "not_member", message: "В отметках есть ученик не из этой группы" });
      const marks = req.body.marks.map((m) => ({ accountId: m.account_id, status: m.status }));
      await school.lessons.mark(own.lesson.lessonId, marks, req.account!.accountId, at);
      if (d.billing) {
        for (const m of marks) {
          if (m.status === "present") await d.billing.charge(m.accountId, own.lesson.lessonId, own.lesson.startsAt, req.account!.accountId);
          else await d.billing.uncharge(m.accountId, own.lesson.lessonId);
        }
      }
      return { lesson: await viewFor((await school.lessons.lesson(own.lesson.lessonId))!, own.group) };
    },
  );
}
