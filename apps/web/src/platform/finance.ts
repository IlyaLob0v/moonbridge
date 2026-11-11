import { ApiError, type Api, type BalanceLineView, type FinanceOverview, type LedgerEntryView, type NewPayment, type PaymentMethod, type StudentBalance } from "../net/api.js";
import { el } from "../ui/dom.js";

// Finances: the teacher records payments by hand and sees every student's balance of paid
// lessons; the student sees their own balance and where each lesson went. Held lessons take
// one lesson off by themselves, from the lessons' attendance.

const MSK_MS = 3 * 3600_000;
export const METHODS: Record<PaymentMethod, string> = { cash: "наличные", transfer: "перевод", card: "карта", online: "онлайн" };

export function lessonsWord(n: number): string {
  const a = Math.abs(n);
  const m10 = a % 10;
  const m100 = a % 100;
  if (m10 === 1 && m100 !== 11) return "урок";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "урока";
  return "уроков";
}

/** 12000 → "12 000 ₽", 6000.5 → "6 000,50 ₽". */
export function rub(amount: number): string {
  return `${new Intl.NumberFormat("ru-RU", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 }).format(amount)} ₽`;
}

const dayMonth = (at: Date) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long" }).format(at);
const moscowToday = (now: Date) => new Date(now.getTime() + MSK_MS).toISOString().slice(0, 10);

/** "Осталось 3 урока" / "Долг: 1 урок" / "Оплаченных уроков нет". */
export function balanceText(balance: number): string {
  if (balance > 0) return `Осталось ${balance} ${lessonsWord(balance)}`;
  if (balance < 0) return `Долг: ${-balance} ${lessonsWord(balance)}`;
  return "Оплаченных уроков нет";
}

const balanceState = (balance: number) => (balance <= 0 ? "empty" : balance === 1 ? "low" : "ok");

function messageOf(e: unknown): string {
  return e instanceof ApiError && e.userMessage ? e.userMessage : "Не получилось. Проверьте интернет и попробуйте ещё раз.";
}

function entryText(e: LedgerEntryView): string {
  const at = new Date(e.at);
  switch (e.kind) {
    case "payment":
      return `Оплата ${dayMonth(at)}: ${e.payment ? `${rub(e.payment.amount_rub)}, ${METHODS[e.payment.method]}` : ""}${e.payment?.voided ? " (отменена)" : ""}`;
    case "void":
      return `Оплата отменена ${dayMonth(at)}`;
    case "lesson":
      return `Урок ${dayMonth(at)}`;
    case "correction":
      return `${e.delta > 0 ? "Начислено" : "Списано"} ${dayMonth(at)}`;
  }
}

/** The history, the newest first; for the teacher with "Отменить" on each payment. */
function ledgerList(entries: LedgerEntryView[], onVoid?: (paymentId: string, button: HTMLButtonElement) => void): HTMLElement {
  if (!entries.length) return el("p", { class: "muted" }, "Пока ни оплат, ни уроков.");
  return el(
    "ul",
    { class: "ledger" },
    ...entries.map((e) => {
      const canVoid = onVoid && e.kind === "payment" && e.payment && !e.payment.voided;
      const button = canVoid ? (el("button", { type: "button", class: "link", "data-void": e.payment!.payment_id }, "Отменить") as HTMLButtonElement) : undefined;
      if (button) button.addEventListener("click", () => onVoid!(e.payment!.payment_id, button));
      return el(
        "li",
        { "data-entry": e.kind },
        el("span", { class: `delta ${e.delta > 0 ? "plus" : "minus"}` }, `${e.delta > 0 ? "+" : "−"}${Math.abs(e.delta)}`),
        el("span", {}, entryText(e), ...(e.note ? [el("span", { class: "muted" }, ` · ${e.note}`)] : []), ...(onVoid && e.by ? [el("span", { class: "muted" }, ` · ${e.by}`)] : [])),
        ...(button ? [button] : []),
      );
    }),
  );
}

// ---------- The student

/** On Today: how many paid lessons are left, with a nudge when it is time to pay. */
export function balanceCard(b: BalanceLineView): HTMLElement {
  return el(
    "a",
    { class: `card balance-card ${balanceState(b.balance)}`, href: "/balance", "data-link": "", "data-card": "balance", "data-balance": String(b.balance) },
    el("h2", {}, "Оплаченные уроки"),
    el("p", { class: "balance-number" }, balanceText(b.balance)),
    ...(b.balance <= 1 ? [el("p", { class: "muted" }, b.balance === 1 ? "Остался последний урок: пора продлить." : "Чтобы заниматься дальше, оплатите уроки у преподавателя.")] : []),
    el("span", { class: "card-action" }, "История →"),
  );
}

export async function renderBalance(root: HTMLElement, d: { api: Api; token: string; accountId: string }): Promise<void> {
  let b: StudentBalance;
  try {
    b = await d.api.studentBalance(d.token, d.accountId);
  } catch (e) {
    root.replaceChildren(el("div", { class: "card" }, el("a", { href: "/", "data-link": "", class: "back" }, "← Сегодня"), el("p", { class: "form-error" }, messageOf(e))));
    return;
  }
  root.replaceChildren(
    el(
      "div",
      { class: "finance" },
      el("header", { class: "section-head" }, el("a", { href: "/", "data-link": "", class: "back" }, "← Сегодня"), el("h1", {}, "Оплаченные уроки")),
      el(
        "section",
        { class: `card balance-card ${balanceState(b.balance)}`, "data-balance": String(b.balance) },
        el("p", { class: "balance-number" }, balanceText(b.balance)),
        el("p", { class: "muted" }, `Проведено уроков: ${b.lessons_held}${b.last_paid_on ? ` · последняя оплата ${dayMonth(new Date(`${b.last_paid_on}T12:00:00+03:00`))}` : ""}`),
      ),
      el("section", { class: "card" }, el("h2", {}, "История"), ledgerList(b.entries)),
    ),
  );
}

// ---------- The teacher

export interface FinanceDeps {
  api: Api;
  token: string | undefined;
  now?: Date;
  /** The student whose card is open, after a change made in it. */
  open?: string;
}

export async function renderFinance(root: HTMLElement, d: FinanceDeps): Promise<void> {
  const head = el("header", { class: "section-head" }, el("a", { href: "/teacher", "data-link": "", class: "back" }, "← Кабинет"), el("h1", {}, "Оплаты"));
  if (!d.token) {
    root.replaceChildren(el("div", { class: "finance" }, head, el("p", { class: "form-error" }, "Оплаты видны только при связи с сервером.")));
    return;
  }
  let f: FinanceOverview;
  try {
    f = await d.api.finance(d.token);
  } catch (e) {
    root.replaceChildren(el("div", { class: "finance" }, head, el("p", { class: "form-error" }, messageOf(e))));
    return;
  }
  const month = new Intl.DateTimeFormat("ru-RU", { month: "long", timeZone: "UTC" }).format(new Date(`${f.month.from}T00:00:00Z`));
  const owing = f.students.filter((s) => s.balance <= 0).length;
  root.replaceChildren(
    el(
      "div",
      { class: "finance" },
      head,
      el(
        "section",
        { class: "card", "data-month": String(f.month.amount_rub) },
        el("h2", {}, `Получено за ${month}: ${rub(f.month.amount_rub)}`),
        el("p", { class: "muted" }, `Оплат: ${f.month.payments}, уроков оплачено: ${f.month.lessons}.${owing ? ` Без оплаченных уроков: ${owing}.` : ""}`),
      ),
      ...(f.students.length
        ? f.students.map((s) => studentRow(s, d, root))
        : [el("p", { class: "muted" }, "Учеников пока нет: пригласите их в группу из кабинета.")]),
    ),
  );
}

function studentRow(s: FinanceOverview["students"][number], d: FinanceDeps, root: HTMLElement): HTMLElement {
  const token = d.token!;
  const badge = el("span", { class: `balance-badge ${balanceState(s.balance)}`, "data-badge": String(s.balance) }, String(s.balance));
  const body = el("div", { class: "student-finance" });
  const row = el(
    "details",
    { class: "card finance-student", "data-student": s.id },
    el(
      "summary",
      {},
      el("span", { class: "student-name" }, s.name),
      badge,
      el("span", { class: "muted" }, [s.groups.join(", "), balanceText(s.balance).toLowerCase(), s.last_paid_on ? `оплата ${dayMonth(new Date(`${s.last_paid_on}T12:00:00+03:00`))}` : "оплат не было"].join(" · ")),
    ),
    body,
  );
  // After a change the whole page is drawn again: the badge, the line and the month's total all move.
  const changed = () => renderFinance(root, { ...d, open: s.id });
  const load = async () => {
    body.replaceChildren(el("p", { class: "muted" }, "Загрузка…"));
    try {
      const b = await d.api.studentBalance(token, s.id);
      body.replaceChildren(
        paymentForm(s.id, d, changed),
        correctionForm(s.id, d, changed),
        el("h3", {}, "История"),
        ledgerList(b.entries, async (paymentId, button) => {
          const reason = prompt("Отменить оплату? Уроки спишутся с баланса. Причина (необязательно):");
          if (reason === null) return;
          button.disabled = true;
          try {
            await d.api.voidPayment(token, paymentId, reason.trim());
            await changed();
          } catch (e) {
            button.textContent = messageOf(e);
          }
        }),
      );
    } catch (e) {
      body.replaceChildren(el("p", { class: "form-error" }, messageOf(e)));
    }
  };
  let loaded = false;
  row.addEventListener("toggle", () => {
    if ((row as HTMLDetailsElement).open && !loaded) {
      loaded = true;
      void load();
    }
  });
  if (d.open === s.id) {
    row.setAttribute("open", "");
    loaded = true;
    void load();
  }
  return row;
}

function paymentForm(studentId: string, d: FinanceDeps, done: () => Promise<void>): HTMLElement {
  const lessons = el("input", { class: "answer", type: "number", name: "lessons", min: "1", max: "200", step: "1", value: "8", required: "", "aria-label": "Уроков" }) as HTMLInputElement;
  const amount = el("input", { class: "answer", type: "number", name: "amount", min: "0", step: "0.01", required: "", inputmode: "decimal", "aria-label": "Сумма, ₽" }) as HTMLInputElement;
  const method = el("select", { class: "answer", name: "method", "aria-label": "Как оплачено" }, ...(["transfer", "cash", "card"] as const).map((m) => el("option", { value: m }, METHODS[m]))) as HTMLSelectElement;
  const today = moscowToday(d.now ?? new Date());
  const date = el("input", { class: "answer", type: "date", name: "paid_on", value: today, max: today, required: "", "aria-label": "Дата оплаты" }) as HTMLInputElement;
  const note = el("input", { class: "answer", name: "note", maxlength: "500", placeholder: "например, абонемент на декабрь", "aria-label": "Комментарий" }) as HTMLInputElement;
  const error = el("p", { class: "form-error", role: "alert" });
  const save = el("button", { class: "primary", type: "submit" }, "Записать оплату") as HTMLButtonElement;
  return el(
    "form",
    {
      class: "finance-form",
      "data-form": "payment",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!d.token) return;
        save.disabled = true;
        const payment: NewPayment = { lessons: Number(lessons.value), amount_rub: Number(amount.value.replace(",", ".")), method: method.value as NewPayment["method"], paid_on: date.value };
        if (note.value.trim()) payment.note = note.value.trim();
        try {
          await d.api.addPayment(d.token, studentId, payment);
          await done();
        } catch (err) {
          error.textContent = messageOf(err);
          save.disabled = false;
        }
      },
    },
    el("h3", {}, "Новая оплата"),
    el("div", { class: "row" }, el("label", {}, "Уроков", lessons), el("label", {}, "Сумма, ₽", amount)),
    el("div", { class: "row" }, el("label", {}, "Как", method), el("label", {}, "Когда", date)),
    el("label", {}, "Комментарий", note),
    error,
    save,
  );
}

/** A free trial lesson, a balance carried over from before the platform, a lesson given back. */
function correctionForm(studentId: string, d: FinanceDeps, done: () => Promise<void>): HTMLElement {
  const delta = el("input", { class: "answer", type: "number", name: "delta", min: "-100", max: "100", step: "1", value: "1", required: "", "aria-label": "Уроков, + или −" }) as HTMLInputElement;
  const note = el("input", { class: "answer", name: "note", maxlength: "500", required: "", placeholder: "например, пробный урок бесплатно", "aria-label": "За что" }) as HTMLInputElement;
  const error = el("p", { class: "form-error", role: "alert" });
  const form = el(
    "form",
    {
      class: "finance-form",
      "data-form": "correction",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!d.token) return;
        const n = Number(delta.value);
        if (!Number.isInteger(n) || n === 0) return void (error.textContent = "Сколько уроков добавить (+) или списать (−)");
        try {
          await d.api.addCorrection(d.token, studentId, n, note.value.trim());
          await done();
        } catch (err) {
          error.textContent = messageOf(err);
        }
      },
    },
    el("div", { class: "row" }, el("label", {}, "Уроков, + или −", delta), el("label", {}, "За что", note)),
    error,
    el("button", { type: "submit" }, "Исправить баланс"),
  );
  return el("details", { class: "correction" }, el("summary", {}, "Исправить баланс вручную"), form);
}
