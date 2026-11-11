import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "../config.js";
import { PaymentNotVoidableError, type LedgerEntry, type Payment, type PaymentMethod, type Summary } from "./finance.js";
import type { Account, SchoolStore } from "./store.js";

// Finances: the teacher sets each student's price per lesson and records the payments that
// come by cash, transfer or card (the admin can too, with the admin token). Every held lesson
// costs the price (the lessons' attendance calls FinanceStore.chargeLesson). The student sees
// the same totals and history. Online payment (YooKassa) will add payments in the same table.

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
const MAX_RUB = 10_000_000;

/** Roubles with at most two digits of kopecks → kopecks; undefined otherwise. */
export function toKop(rub: number): number | undefined {
  const kop = Math.round(rub * 100);
  return Math.abs(rub * 100 - kop) > 1e-6 ? undefined : kop;
}
const rubOf = (kop: number) => kop / 100;

const paymentBody = {
  type: "object",
  required: ["amount_rub", "method"],
  additionalProperties: false,
  properties: {
    amount_rub: { type: "number", exclusiveMinimum: 0, maximum: MAX_RUB },
    method: { type: "string", enum: MANUAL_METHODS },
    paid_on: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    note: { type: "string", maxLength: 500 },
  },
} as const;
interface PaymentBody {
  amount_rub: number;
  method: PaymentMethod;
  paid_on?: string;
  note?: string;
}
const priceBody = { type: "object", required: ["price_rub"], additionalProperties: false, properties: { price_rub: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000 } } } as const;

const paymentView = (p: Payment) => ({
  payment_id: p.paymentId,
  account_id: p.accountId,
  amount_rub: rubOf(p.amountKop),
  currency: p.currency,
  method: p.method,
  status: p.status,
  paid_on: p.paidOn,
  note: p.note,
  voided: p.voidedAt !== null,
});
const entryView = (e: LedgerEntry) => ({
  entry_id: e.entryId,
  amount_rub: e.amountKop === null ? null : rubOf(e.amountKop),
  kind: e.kind,
  at: e.at.toISOString(),
  note: e.note,
  lesson_id: e.lessonId,
  by: e.byName,
  payment: e.payment ? { payment_id: e.payment.paymentId, method: e.payment.method, voided: e.payment.voided } : null,
});
const summaryView = (s: Summary) => ({
  price_rub: s.priceKop === null ? null : rubOf(s.priceKop),
  balance_rub: rubOf(s.balanceKop),
  lessons_left: s.lessonsLeft,
  paid_rub: rubOf(s.paidKop),
  lessons_held: s.lessonsHeld,
  held_rub: rubOf(s.heldKop),
  unpriced: s.unpriced,
  last_paid_on: s.lastPaidOn,
});

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
  const anyStudent = async (studentId: string): Promise<Account | undefined> => {
    const student = await d.school.accountById(studentId);
    return student?.role === "student" ? student : undefined;
  };

  /** Validates the body and records the payment; undefined when the reply has already been sent. */
  const record = async (req: FastifyRequest<{ Body: PaymentBody }>, reply: FastifyReply, student: Account, recordedBy: string | null) => {
    const b = req.body;
    const kop = toKop(b.amount_rub);
    if (kop === undefined) return void reply.code(400).send({ error: "amount", message: "Сумма: рубли и не больше двух знаков копеек" });
    const today = moscowDate(d.now());
    const paidOn = b.paid_on ?? today;
    if (Number.isNaN(Date.parse(`${paidOn}T00:00:00Z`)) || paidOn > today) return void reply.code(400).send({ error: "paid_on", message: "Дата оплаты не может быть в будущем" });
    const p = await finance.recordPayment({ accountId: student.accountId, amountKop: kop, method: b.method, paidOn, note: (b.note ?? "").trim(), recordedBy });
    return { payment: paymentView(p), ...summaryView(await finance.summary(student.accountId)) };
  };

  const setPrice = async (req: FastifyRequest<{ Body: { price_rub: number } }>, reply: FastifyReply, student: Account, by: string | null) => {
    const kop = toKop(req.body.price_rub);
    if (!kop) return void reply.code(400).send({ error: "price", message: "Цена: рубли и не больше двух знаков копеек" });
    await finance.setPrice(student.accountId, kop, by);
    return summaryView(await finance.summary(student.accountId));
  };

  /** Every student of the teacher's groups summed up, and the money of this month. */
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
    const ids = list.map((s) => s.id);
    const summaries = await finance.summaries(ids);
    const today = moscowDate(d.now());
    const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    const from = new Date(Date.UTC(y, m - 1, 1) - MSK_MS);
    const to = new Date(Date.UTC(y, m, 1) - MSK_MS);
    const month = await finance.period(ids, from, to);
    return {
      month: { from: moscowDate(from), received_rub: rubOf(month.receivedKop), payments: month.payments, lessons_held: month.lessonsHeld, held_rub: rubOf(month.heldKop) },
      total: {
        balance_rub: rubOf(summaries.reduce((n, s) => n + s.balanceKop, 0)),
        debt_rub: rubOf(summaries.reduce((n, s) => n + Math.min(0, s.balanceKop), 0)),
      },
      students: list.map((s, i) => ({ ...s, ...summaryView(summaries[i]!) })),
    };
  });

  /** A student's totals and history: for the student themself and for their teachers. */
  app.get<{ Params: { id: string } }>("/school/students/:id/balance", { preHandler: d.requireAccount }, async (req, reply) => {
    const a = req.account!;
    const student = a.accountId === req.params.id && a.role === "student" ? a : a.role === "teacher" ? await ownStudent(req, req.params.id) : undefined;
    if (!student) return reply.code(404).send({ error: "no such student" });
    return {
      student: { id: student.accountId, name: student.name },
      ...summaryView(await finance.summary(student.accountId)),
      entries: (await finance.ledger(student.accountId)).map(entryView),
    };
  });

  app.put<{ Params: { id: string }; Body: { price_rub: number } }>("/school/students/:id/price", { preHandler: d.requireTeacher, schema: { body: priceBody } }, async (req, reply) => {
    const student = await ownStudent(req, req.params.id);
    if (!student) return reply.code(404).send({ error: "no such student" });
    return setPrice(req, reply, student, req.account!.accountId);
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
        return { payment: paymentView(voided), ...summaryView(await finance.summary(p.accountId)) };
      } catch (e) {
        if (!(e instanceof PaymentNotVoidableError)) throw e;
        return reply.code(409).send({ error: "voided", message: "Эта оплата уже отменена" });
      }
    },
  );

  /** Money added or taken by hand, in roubles or in lessons at the current price, always with a reason the student sees. */
  app.post<{ Params: { id: string }; Body: { amount_rub?: number; lessons?: number; note: string } }>(
    "/school/students/:id/corrections",
    {
      preHandler: d.requireTeacher,
      schema: {
        body: {
          type: "object",
          required: ["note"],
          additionalProperties: false,
          properties: {
            amount_rub: { type: "number", minimum: -MAX_RUB, maximum: MAX_RUB, not: { const: 0 } },
            lessons: { type: "integer", minimum: -100, maximum: 100, not: { const: 0 } },
            note: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
      },
    },
    async (req, reply) => {
      const student = await ownStudent(req, req.params.id);
      if (!student) return reply.code(404).send({ error: "no such student" });
      const note = req.body.note.trim();
      if (!note) return reply.code(400).send({ error: "note", message: "Напишите, за что начисление или списание" });
      const { amount_rub, lessons } = req.body;
      if ((amount_rub === undefined) === (lessons === undefined)) return reply.code(400).send({ error: "amount", message: "Укажите сумму или число уроков" });
      let kop: number | undefined;
      if (lessons !== undefined) {
        const price = await finance.price(student.accountId);
        if (!price) return reply.code(409).send({ error: "price", message: "Сначала задайте цену урока" });
        kop = lessons * price;
      } else kop = toKop(amount_rub!);
      if (kop === undefined) return reply.code(400).send({ error: "amount", message: "Сумма: рубли и не больше двух знаков копеек" });
      await finance.addCorrection({ accountId: student.accountId, amountKop: kop, note, by: req.account!.accountId, at: d.now() });
      return reply.code(201).send(summaryView(await finance.summary(student.accountId)));
    },
  );

  // ---------- Admin (curl with the admin token): every student, prices and payments for anyone
  app.get("/admin/finance", { preHandler: requireAdmin }, async () => {
    const students = await finance.students();
    const summaries = await finance.summaries(students.map((s) => s.accountId));
    return { students: students.map((s, i) => ({ id: s.accountId, name: s.name, login: s.login, ...summaryView(summaries[i]!) })) };
  });

  app.put<{ Params: { id: string }; Body: { price_rub: number } }>("/admin/students/:id/price", { preHandler: requireAdmin, schema: { body: priceBody } }, async (req, reply) => {
    const student = await anyStudent(req.params.id);
    if (!student) return reply.code(404).send({ error: "no such student" });
    return setPrice(req, reply, student, null);
  });

  app.post<{ Params: { id: string }; Body: PaymentBody }>("/admin/students/:id/payments", { preHandler: requireAdmin, schema: { body: paymentBody } }, async (req, reply) => {
    const student = await anyStudent(req.params.id);
    if (!student) return reply.code(404).send({ error: "no such student" });
    const done = await record(req, reply, student, null);
    return done && reply.code(201).send(done);
  });
}
