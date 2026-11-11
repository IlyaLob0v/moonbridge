import { ApiError, type Api, type FinanceOverview, type LedgerEntryView, type MoneySummary, type NewPayment, type PaymentMethod, type StudentBalance } from "../net/api.js";
import { el } from "../ui/dom.js";

// Finances: each student has a price per lesson; the teacher records payments by hand, and
// every held lesson costs the price by itself (from the lessons' attendance). On top of each
// page the totals: lessons held and what they cost, paid, and what is left (or owed). Below
// it the held lessons and the payments.

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
const lessons = (n: number) => `${n} ${lessonsWord(n)}`;

/** 12000 → "12 000 ₽", 6000.5 → "6 000,50 ₽". */
export function rub(amount: number): string {
  return `${new Intl.NumberFormat("ru-RU", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 }).format(amount)} ₽`;
}

const dayMonth = (at: Date) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long" }).format(at);
const moscowToday = (now: Date) => new Date(now.getTime() + MSK_MS).toISOString().slice(0, 10);
const onDay = (date: string) => dayMonth(new Date(`${date}T12:00:00+03:00`));

/** "Осталось 6 уроков" / "Долг 2 000 ₽" / "Оплаченных уроков нет". */
export function leftText(s: MoneySummary): string {
  if (s.balance_rub < 0) return `Долг ${rub(-s.balance_rub)}`;
  if (s.lessons_left !== null) return s.lessons_left > 0 ? `Осталось ${lessons(s.lessons_left)}` : s.balance_rub > 0 ? `Остаток ${rub(s.balance_rub)}` : "Оплаченных уроков нет";
  return s.balance_rub > 0 ? `Остаток ${rub(s.balance_rub)}` : "Оплаченных уроков нет";
}

const state = (s: MoneySummary) => (s.balance_rub < 0 || (s.lessons_left ?? 0) <= 0 ? "empty" : s.lessons_left === 1 ? "low" : "ok");

function messageOf(e: unknown): string {
  return e instanceof ApiError && e.userMessage ? e.userMessage : "Не получилось. Проверьте интернет и попробуйте ещё раз.";
}

/** The totals on top: held and what it cost, paid, left. */
function totals(s: MoneySummary): HTMLElement {
  const owe = s.balance_rub < 0;
  return el(
    "div",
    { class: "totals", "data-totals": String(s.balance_rub) },
    el("div", { class: "total-row" }, el("span", {}, "Проведено"), el("b", { "data-held": String(s.held_rub) }, `${lessons(s.lessons_held)} · ${rub(s.held_rub)}`)),
    el("div", { class: "total-row" }, el("span", {}, "Оплачено"), el("b", { "data-paid": String(s.paid_rub) }, rub(s.paid_rub))),
    el(
      "div",
      { class: `total-row total-main ${owe ? "owe" : ""}` },
      el("span", {}, owe ? "Долг" : "Остаток"),
      el("b", { "data-left": String(s.balance_rub) }, `${rub(Math.abs(s.balance_rub))}${!owe && s.lessons_left ? ` · ${lessons(s.lessons_left)}` : ""}`),
    ),
    el(
      "p",
      { class: "muted" },
      s.price_rub !== null ? `Цена урока ${rub(s.price_rub)}.` : "Цена урока пока не задана.",
      ...(s.unpriced ? [` Ждут цены: ${lessons(s.unpriced)}.`] : []),
      ...(s.last_paid_on ? [` Последняя оплата ${onDay(s.last_paid_on)}.`] : []),
    ),
  );
}

/** The held lessons, the newest first, with what each cost. */
function lessonList(entries: LedgerEntryView[]): HTMLElement {
  const held = entries.filter((e) => e.kind === "lesson");
  if (!held.length) return el("p", { class: "muted" }, "Проведённых занятий пока нет.");
  return el(
    "ul",
    { class: "ledger", "data-list": "lessons" },
    ...held.map((e) => el("li", { "data-entry": "lesson" }, el("span", {}, `Урок ${dayMonth(new Date(e.at))}`), el("span", { class: "amount minus" }, e.amount_rub === null ? "цена не задана" : rub(e.amount_rub)))),
  );
}

function moneyText(e: LedgerEntryView): string {
  const at = dayMonth(new Date(e.at));
  switch (e.kind) {
    case "payment":
      return `Оплата ${at}${e.payment ? `, ${METHODS[e.payment.method]}` : ""}${e.payment?.voided ? " (отменена)" : ""}`;
    case "void":
      return `Оплата отменена ${at}`;
    default:
      return `${(e.amount_rub ?? 0) > 0 ? "Начислено" : "Списано"} ${at}`;
  }
}

/** Payments, voids and corrections, the newest first; for the teacher with "Отменить" on each payment. */
function moneyList(entries: LedgerEntryView[], onVoid?: (paymentId: string, button: HTMLButtonElement) => void): HTMLElement {
  const money = entries.filter((e) => e.kind !== "lesson");
  if (!money.length) return el("p", { class: "muted" }, "Оплат пока не было.");
  return el(
    "ul",
    { class: "ledger", "data-list": "payments" },
    ...money.map((e) => {
      const canVoid = onVoid && e.kind === "payment" && e.payment && !e.payment.voided;
      const button = canVoid ? (el("button", { type: "button", class: "link", "data-void": e.payment!.payment_id }, "Отменить") as HTMLButtonElement) : undefined;
      if (button) button.addEventListener("click", () => onVoid!(e.payment!.payment_id, button));
      const amount = e.amount_rub ?? 0;
      return el(
        "li",
        { "data-entry": e.kind },
        el(
          "span",
          {},
          moneyText(e),
          ...(e.note ? [el("span", { class: "muted" }, ` · ${e.note}`)] : []),
          ...(onVoid && e.by ? [el("span", { class: "muted" }, ` · ${e.by}`)] : []),
          ...(button ? [" ", button] : []),
        ),
        el("span", { class: `amount ${amount > 0 ? "plus" : "minus"}` }, `${amount > 0 ? "+" : "−"}${rub(Math.abs(amount))}`),
      );
    }),
  );
}

// ---------- The student

/** On Today: what is left, with a nudge when it is time to pay. */
export function balanceCard(s: MoneySummary): HTMLElement {
  return el(
    "a",
    { class: `card balance-card ${state(s)}`, href: "/balance", "data-link": "", "data-card": "balance", "data-balance": String(s.balance_rub) },
    el("h2", {}, "Оплата уроков"),
    el("p", { class: "balance-number" }, leftText(s)),
    el("p", { class: "muted" }, `Проведено ${lessons(s.lessons_held)} на ${rub(s.held_rub)}, оплачено ${rub(s.paid_rub)}.`),
    ...(state(s) !== "ok" ? [el("p", { class: "muted" }, s.lessons_left === 1 ? "Остался последний урок: пора продлить." : "Чтобы заниматься дальше, оплатите уроки у преподавателя.")] : []),
    el("span", { class: "card-action" }, "Подробнее →"),
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
      el("header", { class: "section-head" }, el("a", { href: "/", "data-link": "", class: "back" }, "← Сегодня"), el("h1", {}, "Оплата уроков")),
      el("section", { class: `card balance-card ${state(b)}` }, totals(b)),
      el("section", { class: "card" }, el("h2", {}, "Занятия"), lessonList(b.entries)),
      el("section", { class: "card" }, el("h2", {}, "Оплаты"), moneyList(b.entries)),
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
  root.replaceChildren(
    el(
      "div",
      { class: "finance" },
      head,
      el(
        "section",
        { class: "card totals", "data-month": String(f.month.received_rub) },
        el("h2", {}, `За ${month}`),
        el("div", { class: "total-row" }, el("span", {}, "Проведено"), el("b", {}, `${lessons(f.month.lessons_held)} · ${rub(f.month.held_rub)}`)),
        el("div", { class: "total-row" }, el("span", {}, "Получено"), el("b", {}, `${rub(f.month.received_rub)} · оплат ${f.month.payments}`)),
        ...(f.total.debt_rub < 0 ? [el("div", { class: "total-row total-main owe", "data-debt": String(-f.total.debt_rub) }, el("span", {}, "Долг учеников"), el("b", {}, rub(-f.total.debt_rub)))] : []),
      ),
      ...(f.students.length ? f.students.map((s) => studentRow(s, d, root)) : [el("p", { class: "muted" }, "Учеников пока нет: пригласите их в группу из кабинета.")]),
    ),
  );
}

function studentRow(s: FinanceOverview["students"][number], d: FinanceDeps, root: HTMLElement): HTMLElement {
  const token = d.token!;
  const badge = s.price_rub === null ? "—" : s.balance_rub < 0 ? `−${rub(-s.balance_rub)}` : String(s.lessons_left ?? 0);
  const body = el("div", { class: "student-finance" });
  const row = el(
    "details",
    { class: "card finance-student", "data-student": s.id },
    el(
      "summary",
      {},
      el("span", { class: "student-name" }, s.name),
      el("span", { class: `balance-badge ${s.price_rub === null ? "none" : state(s)}`, "data-badge": badge }, badge),
      el(
        "span",
        { class: "muted" },
        [s.groups.join(", "), leftText(s).toLowerCase(), s.price_rub !== null ? `${rub(s.price_rub)} за урок` : "цена не задана"].join(" · "),
      ),
    ),
    body,
  );
  // After a change the whole page is drawn again: the badge, the line and the month's totals all move.
  const changed = () => renderFinance(root, { ...d, open: s.id });
  const load = async () => {
    body.replaceChildren(el("p", { class: "muted" }, "Загрузка…"));
    try {
      const b = await d.api.studentBalance(token, s.id);
      body.replaceChildren(
        totals(b),
        priceForm(s.id, b.price_rub, d, changed),
        paymentForm(s.id, b.price_rub, d, changed),
        correctionForm(s.id, b.price_rub, d, changed),
        el("h3", {}, "Занятия"),
        lessonList(b.entries),
        el("h3", {}, "Оплаты"),
        moneyList(b.entries, async (paymentId, button) => {
          const reason = prompt("Отменить оплату? Сумма уйдёт из баланса. Причина (необязательно):");
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

const parseRub = (v: string) => Number(v.replace(/\s/g, "").replace(",", "."));

function priceForm(studentId: string, current: number | null, d: FinanceDeps, done: () => Promise<void>): HTMLElement {
  const price = el("input", { class: "answer", type: "number", name: "price", min: "1", step: "0.01", inputmode: "decimal", required: "", value: current === null ? "" : String(current), "aria-label": "Цена урока, ₽" }) as HTMLInputElement;
  const error = el("p", { class: "form-error", role: "alert" });
  return el(
    "form",
    {
      class: "finance-form price-form",
      "data-form": "price",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!d.token) return;
        try {
          await d.api.setPrice(d.token, studentId, parseRub(price.value));
          await done();
        } catch (err) {
          error.textContent = messageOf(err);
        }
      },
    },
    el("div", { class: "row" }, el("label", {}, "Цена урока, ₽", price), el("button", { type: "submit" }, current === null ? "Задать" : "Изменить")),
    ...(current === null ? [el("p", { class: "muted" }, "По этой цене каждый проведённый урок списывается сам.")] : []),
    error,
  );
}

function paymentForm(studentId: string, priceRub: number | null, d: FinanceDeps, done: () => Promise<void>): HTMLElement {
  const amount = el("input", { class: "answer", type: "number", name: "amount", min: "0.01", step: "0.01", required: "", inputmode: "decimal", "aria-label": "Сумма, ₽" }) as HTMLInputElement;
  const hint = el("p", { class: "muted", "data-hint": "" });
  const showHint = () => {
    const v = parseRub(amount.value);
    hint.textContent = priceRub && v > 0 ? `= ${lessons(Math.floor(v / priceRub))} по ${rub(priceRub)}${v % priceRub ? `, и ещё ${rub(Math.round((v % priceRub) * 100) / 100)}` : ""}` : "";
  };
  amount.addEventListener("input", showHint);
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
        const payment: NewPayment = { amount_rub: parseRub(amount.value), method: method.value as NewPayment["method"], paid_on: date.value };
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
    el("label", {}, "Сумма, ₽", amount),
    hint,
    el("div", { class: "row" }, el("label", {}, "Как", method), el("label", {}, "Когда", date)),
    el("label", {}, "Комментарий", note),
    error,
    save,
  );
}

/** A free trial lesson, a balance carried over from before the platform, a lesson given back. */
function correctionForm(studentId: string, priceRub: number | null, d: FinanceDeps, done: () => Promise<void>): HTMLElement {
  const value = el("input", { class: "answer", type: "number", name: "value", step: "any", value: "1", required: "", "aria-label": "Сколько, + или −" }) as HTMLInputElement;
  const unit = el(
    "select",
    { class: "answer", name: "unit", "aria-label": "В чём" },
    ...(priceRub !== null ? [el("option", { value: "lessons" }, "уроков")] : []),
    el("option", { value: "rub" }, "рублей"),
  ) as HTMLSelectElement;
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
        const n = parseRub(value.value);
        if (!n || (unit.value === "lessons" && !Number.isInteger(n))) return void (error.textContent = "Сколько добавить (+) или списать (−)");
        try {
          await d.api.addCorrection(d.token, studentId, unit.value === "lessons" ? { lessons: n } : { amount_rub: n }, note.value.trim());
          await done();
        } catch (err) {
          error.textContent = messageOf(err);
        }
      },
    },
    el("div", { class: "row" }, el("label", {}, "Сколько, + или −", value), el("label", {}, "В чём", unit)),
    el("label", {}, "За что", note),
    error,
    el("button", { type: "submit" }, "Исправить баланс"),
  );
  return el("details", { class: "correction" }, el("summary", {}, "Исправить баланс вручную"), form);
}
