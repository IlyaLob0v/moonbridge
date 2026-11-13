import type { Assessment, ContentBundle, Task } from "@moonbridge/content";
import { checkAnswer } from "@moonbridge/learning";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AssessmentResult } from "./assessment-store.js";
import type { Account, Group, SchoolStore } from "./store.js";

// The entry and final tests and the end-of-pilot survey. The teacher opens one for a group;
// each student of the group takes it once. A test has no hints and no feedback, and its answers
// never leave the gateway: the student's phone gets the tasks without them, the gateway checks.

export interface AssessmentDeps {
  school: SchoolStore;
  bundle: () => ContentBundle | undefined;
  now: () => Date;
  requireAccount: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  requireTeacher: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  ownGroup: (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => Promise<Group | undefined>;
}

const assessmentsOf = (b: ContentBundle | undefined): Assessment[] => b?.school?.assessments ?? [];

/** A task as the student's phone gets it: no answers, no hint, no author's feedback. */
export function blindTask(t: Task): Task {
  const { hint: _hint, ...presentation } = t.presentation;
  // A recording that is not there yet is read aloud from the first answer; only for listening.
  const accepted = t.type === "listen_type" && !presentation.audio ? t.answer.accepted.slice(0, 1) : [];
  return { task_id: t.task_id, concept_id: t.concept_id, type: t.type, difficulty: t.difficulty, presentation, answer: { accepted } };
}

/** What the student sees about a test: whether it is open and done. */
export interface AssessmentCard {
  assessment_id: string;
  group_id: string;
  kind: Assessment["kind"];
  title: string;
  items: number;
  done: boolean;
}

/** The open tests of the student's groups, for Today. */
export async function studentAssessments(school: SchoolStore, bundle: ContentBundle | undefined, a: Account, groups: Group[]): Promise<AssessmentCard[]> {
  const all = assessmentsOf(bundle);
  if (!all.length || !groups.length) return [];
  const open = (await school.assessments.ofGroups(groups.map((g) => g.groupId))).filter((o) => !o.closedAt);
  const mine = await school.assessments.resultsOf(a.accountId);
  return open.flatMap((o) => {
    const x = all.find((y) => y.assessment_id === o.assessmentId);
    if (!x) return [];
    return [
      {
        assessment_id: x.assessment_id,
        group_id: o.groupId,
        kind: x.kind,
        title: x.title,
        items: x.kind === "test" ? x.tasks.length : x.questions.length,
        done: mine.some((r) => r.groupId === o.groupId && r.assessmentId === x.assessment_id),
      },
    ];
  });
}

type SurveyAnswers = Record<string, string | number>;

export async function assessmentRoutes(app: FastifyInstance, d: AssessmentDeps): Promise<void> {
  const find = (id: string) => assessmentsOf(d.bundle()).find((x) => x.assessment_id === id);

  /** The test or survey a student may take now: open for one of their groups and not taken yet. */
  const takeable = async (req: FastifyRequest<{ Params: { group: string; id: string } }>, reply: FastifyReply): Promise<Assessment | undefined> => {
    const a = req.account!;
    const x = find(req.params.id);
    const open = x && (await d.school.isMember(req.params.group, a.accountId)) && (await d.school.assessments.ofGroups([req.params.group])).some((o) => o.assessmentId === x.assessment_id && !o.closedAt);
    if (!x || !open) {
      reply.code(404).send({ error: "assessment", message: "Тест закрыт или не для вашей группы" });
      return undefined;
    }
    if ((await d.school.assessments.resultsOf(a.accountId)).some((r) => r.groupId === req.params.group && r.assessmentId === x.assessment_id)) {
      reply.code(409).send({ error: "done", message: "Вы уже прошли этот тест" });
      return undefined;
    }
    return x;
  };

  app.get<{ Params: { group: string; id: string } }>("/school/assessments/:group/:id", { preHandler: d.requireAccount }, async (req, reply) => {
    const x = await takeable(req, reply);
    if (!x) return;
    return { assessment: x.kind === "test" ? { ...x, tasks: x.tasks.map(blindTask) } : x };
  });

  app.post<{ Params: { group: string; id: string }; Body: { answers: unknown } }>(
    "/school/assessments/:group/:id",
    { preHandler: d.requireAccount, schema: { body: { type: "object", required: ["answers"], additionalProperties: false, properties: { answers: {} } } } },
    async (req, reply) => {
      const x = await takeable(req, reply);
      if (!x) return;
      const raw = req.body.answers;
      let stored: unknown;
      let right: number | null = null;
      let total: number | null = null;
      if (x.kind === "test") {
        const given = new Map<string, unknown>(Array.isArray(raw) ? raw.filter((r) => r && typeof r === "object").map((r: { task_id?: unknown; response?: unknown }) => [String(r.task_id), r.response]) : []);
        // Every task gets a line; one the student skipped counts as wrong.
        const lines = x.tasks.map((t) => {
          const r = given.get(t.task_id);
          const response = typeof r === "string" ? r.slice(0, 500) : Array.isArray(r) ? r.filter((w): w is string => typeof w === "string").slice(0, 50) : "";
          const outcome = response.length ? checkAnswer(t, response) : undefined;
          // A typo is right in a test too: the student knows the word.
          const correct = !!outcome && (outcome.correct || outcome.match === "typo");
          return { task_id: t.task_id, response, correct, ...(outcome && !correct && outcome.errorType ? { error_type: outcome.errorType } : {}) };
        });
        right = lines.filter((l) => l.correct).length;
        total = lines.length;
        stored = lines;
      } else {
        const answers: SurveyAnswers = {};
        const given = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
        for (const q of x.questions) {
          const v = given[q.id];
          if (q.kind === "scale" && typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5) answers[q.id] = v;
          else if (q.kind === "choice" && typeof v === "string" && q.options?.includes(v)) answers[q.id] = v;
          else if (q.kind === "text" && typeof v === "string" && v.trim()) answers[q.id] = v.trim().slice(0, 2000);
          else if (!q.optional) return reply.code(400).send({ error: "answers", message: `Ответьте на вопрос: «${q.text}»` });
        }
        stored = answers;
      }
      const saved = await d.school.assessments.submit({ accountId: req.account!.accountId, groupId: req.params.group, assessmentId: x.assessment_id, answers: stored, scoreRight: right, scoreTotal: total, at: d.now() });
      if (!saved) return reply.code(409).send({ error: "done", message: "Вы уже прошли этот тест" });
      // The student sees no score: a test is for the teacher's comparison, not a grade.
      return reply.code(201).send({ ok: true });
    },
  );

  /** The teacher: every test and survey of the content, whether it is open for the group, each student's result. */
  app.get<{ Params: { id: string } }>("/school/groups/:id/assessments", { preHandler: d.requireTeacher }, async (req, reply) => {
    const g = await d.ownGroup(req, reply);
    if (!g) return;
    const members = (await d.school.members(g.groupId)).filter((m) => m.role === "student");
    const open = await d.school.assessments.ofGroups([g.groupId]);
    const results = await d.school.assessments.results(g.groupId);
    const view = (r: AssessmentResult | undefined) =>
      r ? { submitted_at: r.submittedAt.toISOString(), score: r.scoreTotal !== null ? { right: r.scoreRight ?? 0, total: r.scoreTotal } : null, answers: r.answers } : null;
    return {
      assessments: assessmentsOf(d.bundle()).map((x) => {
        const o = open.find((y) => y.assessmentId === x.assessment_id);
        return {
          assessment_id: x.assessment_id,
          kind: x.kind,
          title: x.title,
          ...(x.kind === "test" && x.pair ? { pair: x.pair } : {}),
          ...(x.kind === "survey" ? { questions: x.questions.map((q) => ({ id: q.id, kind: q.kind, text: q.text })) } : { items: x.tasks.length }),
          state: o ? (o.closedAt ? "closed" : "open") : "not_opened",
          opened_at: o?.openedAt.toISOString() ?? null,
          results: members.map((m) => ({ id: m.accountId, name: m.name, result: view(results.find((r) => r.accountId === m.accountId && r.assessmentId === x.assessment_id)) })),
        };
      }),
    };
  });

  app.post<{ Params: { id: string; aid: string; action: string } }>("/school/groups/:id/assessments/:aid/:action", { preHandler: d.requireTeacher }, async (req, reply) => {
    const g = await d.ownGroup(req, reply);
    if (!g) return;
    if (!find(req.params.aid)) return reply.code(404).send({ error: "assessment", message: "Такого теста нет в контенте" });
    if (req.params.action === "open") await d.school.assessments.open(g.groupId, req.params.aid, d.now());
    else if (req.params.action === "close") await d.school.assessments.close(g.groupId, req.params.aid, d.now());
    else return reply.code(404).send({ error: "action" });
    return { ok: true };
  });
}
