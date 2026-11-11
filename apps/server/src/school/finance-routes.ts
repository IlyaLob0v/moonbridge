import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "../config.js";
import { PaymentNotVoidableError, type LedgerEntry, type Payment, type PaymentMethod, type Summary } from "./finance.js";
import type { Account, SchoolStore } from "./store.js";

// Finances. Only the admin handles money: an admin account signed in to the platform, or the
// admin token with curl. The admin sets each student's price per lesson, records the payments
// that come by cash, transfer or card, voids mistakes and makes corrections. Every held lesson
// costs the price by itself (the lessons' attendance calls FinanceStore.chargeLesson).
// Teachers see their students' totals and history but change nothing; students see nothing
// of it. Online payment (YooKassa) will add payments in the same table.

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
  const isAdminToken = (req: FastifyRequest) => Boolean(d.config.adminToken) && req.headers.authorization === `Bearer ${d.config.adminToken}`;
  /** The admin token (curl), or a signed-in admin account. */
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (isAdminToken(req)) return;
    await d.requireAccount(req, reply);
    if (!reply.sent && req.account?.role !== "admin") return reply.code(403).send({ error: "admins only" });
  };
  /** Who made a change: the admin's account, or null for the admin token. */
  const by = (req: FastifyRequest) => req.account?.accountId ?? null;

  const student = async (studentId: string): Promise<Account | undefined> => {
    const a = await d.school.accountById(studentId);
    return a?.role === "student" ? a : undefined;
  };

  /** Students with their groups' names, each summed up, and the money of this month. */
  const overview = async (list: { id: string; name: string; groups: string[] }[]) => {
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
  };

  // ---------- Reading: the teacher (own students, read only) and the admin (anyone); never a student

  app.get("/school/finance", { preHandler: d.requireTeacher }, async (req) => {
    const students = new Map<string, { id: string; name: string; groups: string[] }>();
    for (const g of await d.school.groupsOf(req.account!)) {
      for (const m of await d.school.members(g.groupId)) {
        if (m.role !== "student") continue;
        const s = students.get(m.accountId) ?? { id: m.accountId, name: m.name, groups: [] };
        s.groups.push(g.name);
        students.set(m.accountId, s);
      }
    }
    return overview([...students.values()]);
  });

  app.get<{ Params: { id: string } }>("/school/students/:id/balance", { preHandler: d.requireAccount }, async (req, reply) => {
    const a = req.account!;
    const s = await student(req.params.id);
    const visible = s && (a.role === "admin" || (a.role === "teacher" && (await d.school.teaches(a.accountId, s.accountId))));
    if (!s || !visible) return reply.code(404).send({ error: "no such student" });
    return { student: { id: s.accountId, name: s.name }, ...summaryView(await finance.summary(s.accountId)), entries: (await finance.ledger(s.accountId)).map(entryView) };
  });

  // ---------- Changing: the admin only

  app.get("/admin/finance", { preHandler: requireAdmin }, async () => {
    const all = await finance.students();
    const list = await Promise.all(
      all.map(async (s) => {
        const account = (await d.school.accountById(s.accountId))!;
        return { id: s.accountId, name: s.name, login: s.login, groups: (await d.school.groupsOf(account)).map((g) => g.name) };
      }),
    );
    return overview(list);
  });

  app.put<{ Params: { id: string }; Body: { price_rub: number } }>("/admin/students/:id/price", { preHandler: requireAdmin, schema: { body: priceBody } }, async (req, reply) => {
    const s = await student(req.params.id);
    if (!s) return reply.code(404).send({ error: "no such student" });
    const kop = toKop(req.body.price_rub);
    if (!kop) return reply.code(400).send({ error: "price", message: "Цена: рубли и не больше двух знаков копеек" });
    await finance.setPrice(s.accountId, kop, by(req));
    return summaryView(await finance.summary(s.accountId));
  });

  app.post<{ Params: { id: string }; Body: PaymentBody }>("/admin/students/:id/payments", { preHandler: requireAdmin, schema: { body: paymentBody } }, async (req, reply) => {
    const s = await student(req.params.id);
    if (!s) return reply.code(404).send({ error: "no such student" });
    const b = req.body;
    const kop = toKop(b.amount_rub);
    if (kop === undefined) return reply.code(400).send({ error: "amount", message: "Сумма: рубли и не больше двух знаков копеек" });
    const today = moscowDate(d.now());
    const paidOn = b.paid_on ?? today;
    if (Number.isNaN(Date.parse(`${paidOn}T00:00:00Z`)) || paidOn > today) return reply.code(400).send({ error: "paid_on", message: "Дата оплаты не может быть в будущем" });
    const p = await finance.recordPayment({ accountId: s.accountId, amountKop: kop, method: b.method, paidOn, note: (b.note ?? "").trim(), recordedBy: by(req) });
    return reply.code(201).send({ payment: paymentView(p), ...summaryView(await finance.summary(s.accountId)) });
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } | undefined }>(
    "/admin/payments/:id/void",
    { preHandler: requireAdmin, schema: { body: { type: "object", additionalProperties: false, properties: { reason: { type: "string", maxLength: 500 } } } } },
    async (req, reply) => {
      const p = await finance.payment(req.params.id);
      if (!p) return reply.code(404).send({ error: "no such payment" });
      try {
        const voided = await finance.voidPayment(p.paymentId, by(req), d.now(), (req.body?.reason ?? "").trim());
        return { payment: paymentView(voided), ...summaryView(await finance.summary(p.accountId)) };
      } catch (e) {
        if (!(e instanceof PaymentNotVoidableError)) throw e;
        return reply.code(409).send({ error: "voided", message: "Эта оплата уже отменена" });
      }
    },
  );

  /** Money added or taken by hand, in roubles or in lessons at the current price, always with a reason the student sees. */
  app.post<{ Params: { id: string }; Body: { amount_rub?: number; lessons?: number; note: string } }>(
    "/admin/students/:id/corrections",
    {
      preHandler: requireAdmin,
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
      const s = await student(req.params.id);
      if (!s) return reply.code(404).send({ error: "no such student" });
      const note = req.body.note.trim();
      if (!note) return reply.code(400).send({ error: "note", message: "Напишите, за что начисление или списание" });
      const { amount_rub, lessons } = req.body;
      if ((amount_rub === undefined) === (lessons === undefined)) return reply.code(400).send({ error: "amount", message: "Укажите сумму или число уроков" });
      let kop: number | undefined;
      if (lessons !== undefined) {
        const price = await finance.price(s.accountId);
        if (!price) return reply.code(409).send({ error: "price", message: "Сначала задайте цену урока" });
        kop = lessons * price;
      } else kop = toKop(amount_rub!);
      if (kop === undefined) return reply.code(400).send({ error: "amount", message: "Сумма: рубли и не больше двух знаков копеек" });
      await finance.addCorrection({ accountId: s.accountId, amountKop: kop, note, by: by(req), at: d.now() });
      return reply.code(201).send(summaryView(await finance.summary(s.accountId)));
    },
  );
}
