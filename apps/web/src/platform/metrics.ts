import { ApiError, type Api, type EmailCounts, type EmailMetrics, type GroupMetrics, type Metric, type MetricStatus, type PilotMetrics } from "../net/api.js";
import { el } from "../ui/dom.js";
import { when } from "./school.js";

// The pilot's metrics for one group on one page: the targets from the plan, the weeks, each
// student, accuracy by error type and the testers' reports. Ilya and Ksenia read it every week.

export interface MetricsDeps {
  api: Api;
  token: string | undefined;
  now?: Date;
}

const STATUS: Record<MetricStatus, string> = { ok: "в цели", below: "ниже цели", no_data: "нет данных" };

function messageOf(e: unknown): string {
  return e instanceof ApiError && e.userMessage ? e.userMessage : "Не получилось. Проверьте интернет и попробуйте ещё раз.";
}

const shortDate = (date: string) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
const num = (n: number) => String(n).replace(".", ",");
/** Bots and a single answer make sessions shorter than a minute. */
const minutes = (n: number) => (n < 1 ? "меньше минуты" : `${num(n)} мин`);

function row(key: string, label: string, value: string, target: string, status: MetricStatus): HTMLElement {
  return el(
    "li",
    { class: `metric ${status}`, "data-metric": key, "data-status": status },
    el("span", { class: "metric-label" }, label),
    el("span", { class: "metric-value" }, value),
    el("span", { class: "metric-target muted" }, `цель: ${target}`),
    el("span", { class: "metric-status" }, STATUS[status]),
  );
}

const shown = (m: Metric, unit: string) => (m.value === null ? "—" : `${num(m.value)}${unit}`);
const shownMinutes = (m: Metric) => (m.value === null ? "—" : minutes(m.value));

/** The plan's targets, one line each. */
export function targets(m: PilotMetrics): HTMLElement {
  const s = m.summary;
  const active = s.active.week === null ? "—" : `${s.active.students} из ${s.active.of}`;
  const activeLabel = s.active.week === null || s.active.week === 4 ? "Активны на 4-й неделе" : `Активны на ${s.active.week}-й неделе (4-я ещё не прошла)`;
  const errors = s.errorTypes.compared ? `${s.errorTypes.improved} из ${s.errorTypes.compared}` : "—";
  const errorsStatus: MetricStatus = !s.errorTypes.compared ? "no_data" : s.errorTypes.improved * 2 > s.errorTypes.compared ? "ok" : "below";
  return el(
    "ul",
    { class: "metrics" },
    row("practice-days", "Дни с практикой в неделю", shown(s.practiceDays, ""), `в среднем ${s.practiceDays.target} и больше`, s.practiceDays.status),
    row("active", activeLabel, active, "3 из 4 учеников", s.active.status),
    row("session", "Медиана обязательной сессии", shownMinutes(s.sessionMinutes), `${s.sessionMinutes.target} мин и меньше`, s.sessionMinutes.status),
    row("voluntary", "Добровольные сессии", shown(s.voluntaryShare, "% учеников"), "у половины учеников раз в неделю", s.voluntaryShare.status),
    row("lost", "Вещи, возвращённые в бюро находок", s.lostReturned.offered ? `${shown(s.lostReturned, "%")} (${s.lostReturned.returned} из ${s.lostReturned.offered})` : "—", "70% и больше", s.lostReturned.status),
    row("errors", "Точность растёт по типам ошибок", errors, "у большинства типов, где было куда расти", errorsStatus),
    el("li", { class: "metric interview" }, el("span", { class: "metric-label" }, "«Сказочный отель радует или кажется детским?»"), el("span", { class: "muted" }, "по интервью в конце пилота")),
  );
}

/** One line per week: on a phone a six-column table would not fit. */
function weekList(m: PilotMetrics, students: number): HTMLElement {
  return el(
    "ul",
    { class: "metric-weeks" },
    ...m.weeks.map((w, i) =>
      el(
        "li",
        { "data-week": String(i + 1), class: w.complete ? "" : "running" },
        el("span", {}, `${i + 1}. ${shortDate(w.from)} – ${shortDate(w.to)}${w.complete ? "" : ", идёт"}`),
        el(
          "span",
          { class: "muted" },
          [
            `активны ${w.active} из ${students}`,
            `дней в среднем ${num(w.avgDays)}`,
            w.medianSessionMinutes === null ? undefined : `сессия ${minutes(w.medianSessionMinutes)}`,
            `добровольно ${w.voluntaryStudents} из ${students}`,
            w.lostOffered ? `бюро ${w.lostReturned} из ${w.lostOffered}` : undefined,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      ),
    ),
  );
}

function studentList(m: PilotMetrics): HTMLElement {
  if (!m.students.length) return el("p", { class: "muted" }, "В группе пока нет учеников.");
  return el(
    "ul",
    { class: "metric-students" },
    ...m.students.map((s) =>
      el(
        "li",
        { "data-student": s.id },
        el("a", { href: `/teacher/student/${s.id}`, "data-link": "", class: "student-name" }, s.name),
        el(
          "span",
          { class: "muted" },
          [
            `дней по неделям: ${s.days.join(" · ")}`,
            `сессий ${s.sessions}, добровольных ${s.voluntary}`,
            s.medianSessionMinutes === null ? undefined : `обычно ${minutes(s.medianSessionMinutes)}`,
            s.lostOffered ? `бюро ${s.lostReturned} из ${s.lostOffered}` : undefined,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      ),
    ),
  );
}

function errorTrends(m: PilotMetrics): HTMLElement {
  const t = m.summary.errorTypes.trends;
  if (!t.length) return el("p", { class: "muted" }, "Пока мало ответов: нужно хотя бы 5 первых попыток по типу ошибки в двух разных неделях.");
  return el(
    "ul",
    { class: "metric-errors" },
    ...t.map((x) =>
      el(
        "li",
        { "data-error": x.errorType, class: x.change > 0 ? "up" : x.change < 0 ? "down" : "" },
        el("span", {}, x.label),
        el("span", { class: "muted" }, `${x.firstAccuracy}% → ${x.lastAccuracy}% (${x.change > 0 ? "+" : x.change < 0 ? "−" : "±"}${Math.abs(x.change)}), ${shortDate(x.firstWeek)} → ${shortDate(x.lastWeek)}`),
      ),
    ),
  );
}

const share = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");
const counts = (c: EmailCounts) => `отправлено ${c.sent}, открыли ${c.clicked} (${share(c.clicked, c.sent)}), занимались после ${c.practiced}`;

/** Did the reminders bring anyone back? Daily e-mails often land in "Промоакции". */
export function emailBlock(e: EmailMetrics): HTMLElement {
  const kinds: [keyof EmailMetrics["byKind"], string][] = [
    ["evening", "Вечером, если не было смены"],
    ["deadline", "За сутки до срока домашки"],
    ["grade", "Оценка"],
  ];
  return el(
    "section",
    { class: "card", "data-email": "" },
    el("h2", {}, "Напоминания на почту"),
    el("p", { "data-email-total": "" }, e.sent ? `Вернулись по ссылке из письма: ${e.clicked} из ${e.sent} (${share(e.clicked, e.sent)}), из них занимались в течение 2 часов: ${e.practiced}.` : "Писем пока не было."),
    el("p", { class: "muted" }, `Почта указана у ${e.withEmail} из ${e.students} учеников${e.unsubscribed ? `, отписались: ${e.unsubscribed}` : ""}.`),
    el("ul", { class: "metric-weeks" }, ...kinds.map(([k, label]) => el("li", { "data-email-kind": k }, el("span", {}, label), el("span", { class: "muted" }, counts(e.byKind[k]))))),
    el("ul", { class: "metric-weeks" }, ...e.weeks.map((w, i) => el("li", { "data-email-week": String(i + 1) }, el("span", {}, `${i + 1}. с ${shortDate(w.from)}`), el("span", { class: "muted" }, counts(w))))),
  );
}

function feedbackList(g: GroupMetrics, now: Date): HTMLElement {
  if (!g.feedback.length) return el("p", { class: "muted" }, "Сообщений нет. Ученики пишут их кнопкой «Сообщить о проблеме» внизу «Сегодня» и на карте отеля.");
  return el(
    "ul",
    { class: "feedback-list" },
    ...g.feedback.map((f) =>
      el(
        "li",
        { "data-feedback": f.id },
        el("p", {}, f.message),
        el("p", { class: "muted" }, `${f.name}, ${when(new Date(f.at), now)} · ${f.page}`),
        el("p", { class: "muted small" }, f.user_agent),
      ),
    ),
  );
}

/** The weekly snapshot as CSV for a spreadsheet: one line per week. */
export function weeksCsv(g: GroupMetrics): string {
  const students = g.metrics.students.length;
  const lines = [
    ["неделя", "с", "по", "учеников", "активны", "дней в среднем", "медиана сессии, мин", "с добровольными сессиями", "бюро: предложено", "бюро: возвращено"],
    ...g.metrics.weeks.map((w, i) => [
      String(i + 1),
      w.from,
      w.to,
      String(students),
      String(w.active),
      num(w.avgDays),
      w.medianSessionMinutes === null ? "" : num(w.medianSessionMinutes),
      String(w.voluntaryStudents),
      String(w.lostOffered),
      String(w.lostReturned),
    ]),
  ];
  return lines.map((l) => l.map((c) => (/[;"\n]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c)).join(";")).join("\n") + "\n";
}

export async function renderMetrics(root: HTMLElement, groupId: string, d: MetricsDeps): Promise<void> {
  const back = el("a", { href: "/teacher", "data-link": "", class: "back" }, "← Кабинет");
  const page = (title: string, ...cards: HTMLElement[]) =>
    root.replaceChildren(el("div", { class: "teacher metrics-page" }, el("header", { class: "section-head" }, back, el("h1", {}, title)), ...cards));
  if (!d.token) return page("Метрики пилота", el("div", { class: "card" }, el("p", { class: "form-error" }, "Метрики считаются на сервере: нужна связь.")));
  const token = d.token;
  let g: GroupMetrics;
  try {
    g = await d.api.groupMetrics(token, groupId);
  } catch (e) {
    return page("Метрики пилота", el("div", { class: "card" }, el("p", { class: "form-error" }, messageOf(e))));
  }
  const now = d.now ?? new Date();
  const m = g.metrics;
  const lastDay = m.weeks[m.weeks.length - 1]!.to;

  const start = el("input", { type: "date", class: "answer", name: "pilot-from", value: g.pilot_from ?? m.from, "aria-label": "Начало пилота" }) as HTMLInputElement;
  const save = el("button", { type: "button", "data-save-pilot": "" }, "Сохранить") as HTMLButtonElement;
  const saveError = el("p", { class: "form-error", role: "alert" });
  save.addEventListener("click", async () => {
    if (!start.value) return;
    save.disabled = true;
    try {
      await d.api.setPilotFrom(token, groupId, start.value);
      await renderMetrics(root, groupId, d);
    } catch (e) {
      saveError.textContent = messageOf(e);
      save.disabled = false;
    }
  });

  const csv = el("button", { type: "button", "data-download-csv": "" }, "Скачать по неделям (.csv)") as HTMLButtonElement;
  csv.addEventListener("click", () => {
    const a = el("a", { href: URL.createObjectURL(new Blob(["﻿", weeksCsv(g)], { type: "text/csv" })), download: `moonbridge-metrics-${m.from}.csv` }) as HTMLAnchorElement;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  });

  page(
    "Метрики пилота",
    el(
      "section",
      { class: "card" },
      el("h2", {}, g.group.name),
      el("p", { class: "muted", "data-weeks": String(m.weeks.length) }, `Недель: ${m.weeks.length} (${shortDate(m.from)} – ${shortDate(lastDay)}), учеников: ${m.students.length}`),
      el("label", { class: "field" }, g.pilot_from ? "Начало пилота" : "Начало пилота (пока по первому ответу)", start),
      el("div", { class: "actions" }, save, csv),
      saveError,
    ),
    el("section", { class: "card", "data-targets": "" }, el("h2", {}, "Цели пилота"), targets(m)),
    el("section", { class: "card" }, el("h2", {}, "По неделям"), weekList(m, m.students.length)),
    el("section", { class: "card" }, el("h2", {}, "Ученики"), studentList(m)),
    el("section", { class: "card" }, el("h2", {}, "Точность по типам ошибок"), errorTrends(m)),
    ...(g.email ? [emailBlock(g.email)] : []),
    el("section", { class: "card", "data-feedback-count": String(g.feedback.length) }, el("h2", {}, `Сообщения о проблемах: ${g.feedback.length}`), feedbackList(g, now)),
    el(
      "details",
      { class: "card how" },
      el("summary", {}, "Как считается"),
      el(
        "ul",
        { class: "muted" },
        el("li", {}, "Все цифры — из ответов учеников (xAPI), отдельный журнал вести не нужно. Дни считаются по Москве, неделя — с понедельника."),
        el("li", {}, "Сессия — ответы подряд без перерыва больше 30 минут. Первая сессия дня — обязательная, следующие в тот же день — добровольные."),
        el("li", {}, "Средние берутся по завершённым неделям; пока идёт первая неделя — по ней."),
        el("li", {}, "Бюро находок: вещь вернулась, если первый ответ на неё верный."),
        el("li", {}, "Письма: «открыли» — нажали кнопку в письме (считается первое нажатие), «занимались после» — ответили хотя бы на одно задание в течение 2 часов после этого."),
        el("li", {}, "Типы ошибок: точность первых попыток по заданиям, где автор предусмотрел этот тип, в первой и последней неделе, где таких попыток 5 и больше. Типы, где в первую неделю уже было 100%, в счёт не идут."),
      ),
    ),
  );
}
