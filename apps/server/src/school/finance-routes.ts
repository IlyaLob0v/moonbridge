import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "../config.js";
import { PaymentNotVoidableError, type BalanceLine, type LedgerEntry, type Payment, type PaymentMethod } from "./finance.js";
import type { Account, SchoolStore } from "./store.js";

// Finances: the teacher (or the admin, with the admin token) records the payments that come
// by cash, transfer or card; every held lesson takes one lesson off the student's balance
// (the lessons' attendance calls FinanceStore.chargeLesson). The student sees their balance
// and its history. Online payment (YooKassa) will add payments in the same table.

export interface FinanceDeps {
  config: ServerConfig;
  school: SchoolStore;
  requireAccount: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  requireTeacher: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  now: () => Date;
}

/** Payments entered by hand; 'online' is the payment provider's. */
const MANUAL_METHODS: PaymentMethod[] = ["cash", "transfer", "card"];
const MSK_MS = 3 * 3600_000;
const moscowDate = (at: Date) => new Date(at.getTime() + MSK_MS).toISOString().slice(0, 10);

const paymentBody = {
  type: "object",
  required: ["lessons", "amount_rub", "method"],
  additionalProperties: false,
  properties: {
    lessons: { type: "integer", minimum: 1, maximum: 200 },
    amount_rub: { type: "number", minimum: 0, maximum: 10_000_000 },
    method: { type: "string", enum: MANUAL_METHODS },
    paid_on: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    note: { type: "string", maxLength: 500 },
  },
} as const;
interface PaymentBody {
  lessons: number;
  amount_rub: number;
  method: PaymentMethod;
  paid_on?: string;
  note?: string;
}

const paymentView = (p: Payment) => ({
  payment_id: p.paymentId,
  account_id: p.accountId,
  lessons: p.lessons,
  amount_rub: p.amountKop / 100,
  currency: p.currency,
  method: p.method,
  status: p.status,
  paid_on: p.paidOn,
  note: p.note,
  voided: p.voidedAt !== null,
});
const entryView = (e: LedgerEntry) => ({
  entry_id: e.entryId,
  delta: e.delta,
  kind: e.kind,
  at: e.at.toISOString(),
  note: e.note,
  lesson_id: e.lessonId,
  by: e.byName,
  payment: e.payment ? { payment_id: e.payment.paymentId, amount_rub: e.payment.amountKop / 100, method: e.payment.method, voided: e.payment.voided } : null,
});
const balanceView = (b: BalanceLine) => ({ balance: b.balance, lessons_held: b.lessonsHeld, last_paid_on: b.lastPaidOn });

export async function financeRoutes(app: FastifyInstance, d: FinanceDeps): Promise<void> {
  const finance = d.school.finance;
  const isAdmin = (req: FastifyRequest) => Boolean(d.config.adminToken) && req.headers.authorization === `Bearer ${d.config.adminToken}`;
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isAdmin(req)) return reply.code(d.config.adminToken ? 401 : 403).send({ error: "admin token required" });
  };

  /** A student the signed-in teacher teaches. */
  const ownStudent = async (req: FastifyRequest, studentId: string): Promise<Account | undefined> => {
    const student = await d.school.accountById(studentId);
    if (!student || student.role !== "student") return undefined;
    return (await d.school.teaches(req.account!.accountId, student.accountId)) ? student : undefined;
  };

  /** Validates the body and records the payment; undefined when the reply has already been sent. */
  const record = async (req: FastifyRequest<{ Body: PaymentBody }>, reply: FastifyReply, student: Account, recordedBy: string | null) => {
    const b = req.body;
    const kop = Math.round(b.amount_rub * 100);
    if (Math.abs(b.amount_rub * 100 - kop) > 1e-6) return void reply.code(400).send({ error: "amount", message: "Сумма: рубли и не больше двух знаков копеек" });
    const today = moscowDate(d.now());
    const paidOn = b.paid_on ?? today;
    if (Number.isNaN(Date.parse(`${paidOn}T00:00:00Z`)) || paidOn > today) return void reply.code(400).send({ error: "paid_on", message: "Дата оплаты не может быть в будущем" });
    const p = await finance.recordPayment({ accountId: student.accountId, lessons: b.lessons, amountKop: kop, method: b.method, paidOn, note: (b.note ?? "").trim(), recordedBy });
    return { payment: paymentView(p), balance: await finance.balance(student.accountId) };
  };

  /** Every student of the teacher's groups with their balance, and the money of this month. */
  app.get("/school/finance", { preHandler: d.requireTeacher }, async (req) => {
    const groups = await d.school.groupsOf(req.account!);
    const students = new Map<string, { id: string; name: string; groups: string[] }>();
    for (const g of groups) {
      for (const m of await d.school.members(g.groupId)) {
        if (m.role !== "student") continue;
        const s = students.get(m.accountId) ?? { id: m.accountId, name: m.name, groups: [] };
        s.groups.push(g.name);
        students.set(m.accountId, s);
      }
    }
    const list = [...students.values()];
    const balances = await finance.balances(list.map((s) => s.id));
    const today = moscowDate(d.now());
    const month = `${today.slice(0, 7)}-01`;
    const next = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1)).toISOString().slice(0, 10);
    const received = await finance.received(list.map((s) => s.id), month, next);
    return {
      month: { from: month, amount_rub: received.amountKop / 100, lessons: received.lessons, payments: received.payments },
      students: list.map((s, i) => ({ ...s, ...balanceView(balances[i]!) })),
    };
  });

  /** A student's balance and its history: for the student themself and for their teachers. */
  app.get<{ Params: { id: string } }>("/school/students/:id/balance", { preHandler: d.requireAccount }, async (req, reply) => {
    const a = req.account!;
    const student = a.accountId === req.params.id && a.role === "student" ? a : a.role === "teacher" ? await ownStudent(req, req.params.id) : undefined;
    if (!student) return reply.code(404).send({ error: "no such student" });
    const [line] = await finance.balances([student.accountId]);
    return { student: { id: student.accountId, name: student.name }, ...balanceView(line!), entries: (await finance.ledger(student.accountId)).map(entryView) };
  });

  app.post<{ Params: { id: string }; Body: PaymentBody }>("/school/students/:id/payments", { preHandler: d.requireTeacher, schema: { body: paymentBody } }, async (req, reply) => {
    const student = await ownStudent(req, req.params.id);
    if (!student) return reply.code(404).send({ error: "no such student" });
    const done = await record(req, reply, student, req.account!.accountId);
    return done && reply.code(201).send(done);
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } | undefined }>(
    "/school/payments/:id/void",
    { preHandler: d.requireTeacher, schema: { body: { type: "object", additionalProperties: false, properties: { reason: { type: "string", maxLength: 500 } } } } },
    async (req, reply) => {
      const p = await finance.payment(req.params.id);
      if (!p || !(await ownStudent(req, p.accountId))) return reply.code(404).send({ error: "no such payment" });
      try {
        const voided = await finance.voidPayment(p.paymentId, req.account!.accountId, d.now(), (req.body?.reason ?? "").trim());
        return { payment: paymentView(voided), balance: await finance.balance(p.accountId) };
      } catch (e) {
        if (!(e instanceof PaymentNotVoidableError)) throw e;
        return reply.code(409).send({ error: "voided", message: "Эта оплата уже отменена" });
      }
    },
  );

  /** Lessons added or taken by hand, always with a reason the student sees. */
  app.post<{ Params: { id: string }; Body: { delta: number; note: string } }>(
    "/school/students/:id/corrections",
    {
      preHandler: d.requireTeacher,
      schema: {
        body: {
          type: "object",
          required: ["delta", "note"],
          additionalProperties: false,
          properties: { delta: { type: "integer", minimum: -100, maximum: 100, not: { const: 0 } }, note: { type: "string", minLength: 1, maxLength: 500 } },
        },
      },
    },
    async (req, reply) => {
      const student = await ownStudent(req, req.params.id);
      if (!student) return reply.code(404).send({ error: "no such student" });
      const note = req.body.note.trim();
      if (!note) return reply.code(400).send({ error: "note", message: "Напишите, за что начисление или списание" });
      await finance.addCorrection({ accountId: student.accountId, delta: req.body.delta, note, by: req.account!.accountId, at: d.now() });
      return reply.code(201).send({ balance: await finance.balance(student.accountId) });
    },
  );

  // ---------- Admin (curl with the admin token): every student, and payments for anyone
  app.get("/admin/finance", { preHandler: requireAdmin }, async () => {
    const students = await finance.students();
    const balances = await finance.balances(students.map((s) => s.accountId));
    return { students: students.map((s, i) => ({ id: s.accountId, name: s.name, login: s.login, ...balanceView(balances[i]!) })) };
  });

  app.post<{ Params: { id: string }; Body: PaymentBody }>("/admin/students/:id/payments", { preHandler: requireAdmin, schema: { body: paymentBody } }, async (req, reply) => {
    const student = await d.school.accountById(req.params.id);
    if (!student || student.role !== "student") return reply.code(404).send({ error: "no such student" });
    const done = await record(req, reply, student, null);
    return done && reply.code(201).send(done);
  });
}
