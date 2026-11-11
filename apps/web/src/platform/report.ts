import { ApiError, type Api, type PracticeView, type StudentReport } from "../net/api.js";
import { el } from "../ui/dom.js";
import { scoreText, when } from "./school.js";

// The weekly report on a student: practice days, first-try accuracy, frequent errors and the
// week's homework. The teacher reads it before the lesson; the student sees their own week.

const DAY_MS = 24 * 3600_000;
const DAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const MODES: Record<string, string> = {
  moonbridge_episode: "эпизоды Moonbridge",
  lost_and_found: "бюро находок",
  guest_of_the_day: "гость дня",
};

/** "2026-11-30" + n days → "2026-12-02". */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Seven marks, Monday to Sunday, filled on the days with practice. */
export function weekDots(from: string, days: string[]): HTMLElement {
  const set = new Set(days);
  return el(
    "span",
    { class: "week-dots", "data-days": String(days.length), "aria-label": `Дней с практикой: ${days.length} из 7` },
    ...DAYS.map((label, i) => el("span", { class: set.has(addDays(from, i)) ? "dot on" : "dot", title: label })),
  );
}

export function accuracyText(p: PracticeView): string {
  return p.accuracy === null ? "ответов не было" : `с первого раза ${p.accuracy}%`;
}

function trend(now: number | null, before: number | null): string {
  if (now === null || before === null) return "";
  const diff = now - before;
  return diff === 0 ? " (как на прошлой неделе)" : ` (${diff > 0 ? "+" : "−"}${Math.abs(diff)} к прошлой неделе)`;
}

function dateRange(from: string, to: string): string {
  const f = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
  return `${f.format(new Date(`${from}T00:00:00Z`))} – ${f.format(new Date(`${to}T00:00:00Z`))}`;
}

/** The report's body: shared by the teacher's page on a student and the student's own week. */
export function reportBody(r: StudentReport, now: Date): HTMLElement[] {
  const p = r.practice;
  const parts: HTMLElement[] = [
    el("p", { class: "report-days" }, weekDots(r.week.from, p.days), ` ${p.days.length} из 7 дней`),
    el(
      "p",
      { "data-report-accuracy": String(p.accuracy ?? "") },
      p.answers ? `Ответов: ${p.answers}, около ${Math.max(1, p.minutes)} мин, ${accuracyText(p)}${trend(p.accuracy, r.previous.accuracy)}.` : "На этой неделе заданий не было.",
    ),
  ];
  if (p.errors.length) {
    parts.push(
      el("h3", {}, "Частые ошибки"),
      el("ul", { class: "report-errors" }, ...p.errors.map((e) => el("li", { "data-error": e.error_type }, `${e.label}: ${e.count}`))),
    );
  }
  if (p.modes.length) {
    parts.push(el("p", { class: "muted" }, `Где занимался: ${p.modes.map((m) => `${MODES[m.mode] ?? "другое"} (${m.answers})`).join(", ")}.`));
  }
  if (r.lessons?.lessons.length) {
    const l = r.lessons;
    parts.push(
      el("h3", {}, "Занятия"),
      el("p", { "data-report-lessons": `${l.present}/${l.held}` }, l.held ? `Был(а) на ${l.present} из ${l.held}${l.absent ? `, пропусков: ${l.absent}` : ""}.` : "Прошедшие занятия ещё не отмечены."),
      ...l.lessons
        .filter((x) => x.status === "cancelled")
        .map((x) => el("p", { class: "muted" }, `${when(new Date(x.starts_at), now)}: урок отменён`)),
    );
  }
  parts.push(el("h3", {}, "Домашка недели"));
  if (!r.homework.length) parts.push(el("p", { class: "muted" }, "На эту неделю ничего не задано."));
  for (const h of r.homework) {
    const s = h.submission;
    const status = h.module_id
      ? !s ? "юнит Moonbridge не пройден" : `${s.score ? scoreText(s.score) : "пройдено"}${s.review ? `, оценка ${s.review.grade}` : ", ждёт оценки"}`
      : !h.needs_file ? "без файла" : !s ? "не сдано" : s.review ? `оценка ${s.review.grade}` : `сдано ${when(new Date(s.submitted_at), now)}, ждёт проверки`;
    parts.push(el("p", { class: "report-homework", "data-homework": h.homework_id }, el("span", { class: "hw-title" }, h.title), ` · ${status}`));
  }
  return parts;
}

export interface ReportDeps {
  api: Api;
  token: string | undefined;
  navigate: (path: string) => void;
  now?: Date;
}

/** The teacher's page on one student: the weekly report with week navigation, and a new password if the student forgot theirs. */
export async function renderStudentReport(root: HTMLElement, accountId: string, week: string | undefined, d: ReportDeps): Promise<void> {
  const back = el("a", { href: "/teacher", "data-link": "", class: "back" }, "← Кабинет");
  if (!d.token) {
    root.replaceChildren(el("div", { class: "card" }, back, el("p", { class: "form-error" }, "Отчёт открывается, когда есть связь с сервером.")));
    return;
  }
  let r: StudentReport;
  try {
    r = await d.api.studentReport(d.token, accountId, week);
  } catch (e) {
    root.replaceChildren(el("div", { class: "card" }, back, el("p", { class: "form-error" }, e instanceof ApiError && e.status === 404 ? "Такого ученика нет в ваших группах." : "Не получилось загрузить отчёт.")));
    return;
  }
  const now = d.now ?? new Date();
  const thisWeek = addDays(r.week.to, 1) > now.toISOString().slice(0, 10);
  const go = (w: string) => d.navigate(`/teacher/student/${accountId}?week=${w}`);
  const password = el("div", { class: "password-reset" });
  const reset = el("button", { type: "button", "data-reset-password": "" }, "Сбросить пароль") as HTMLButtonElement;
  reset.addEventListener("click", async () => {
    if (!confirm(`Задать ${r.student.name} новый пароль? Старый перестанет работать.`)) return;
    reset.disabled = true;
    try {
      const p = await d.api.resetPassword(d.token!, accountId);
      password.replaceChildren(el("p", {}, "Логин: ", el("b", {}, p.login), ", новый пароль: ", el("b", { "data-new-password": "" }, p.password)), el("p", { class: "muted" }, "Передайте его ученику: пароль показан один раз."));
    } catch {
      password.replaceChildren(el("p", { class: "form-error" }, "Не получилось сбросить пароль."));
    } finally {
      reset.disabled = false;
    }
  });
  root.replaceChildren(
    el(
      "div",
      { class: "teacher" },
      el("header", { class: "section-head" }, back, el("h1", {}, r.student.name)),
      el(
        "section",
        { class: "card report", "data-report": r.week.from },
        el(
          "div",
          { class: "week-nav" },
          el("button", { type: "button", class: "link", onclick: () => go(addDays(r.week.from, -7)) }, "←"),
          el("h2", {}, thisWeek ? "Эта неделя" : dateRange(r.week.from, r.week.to)),
          ...(thisWeek ? [] : [el("button", { type: "button", class: "link", onclick: () => go(addDays(r.week.from, 7)) }, "→")]),
        ),
        ...reportBody(r, now),
      ),
      el("section", { class: "card" }, el("h2", {}, "Вход"), el("p", { class: "muted" }, "Если ученик забыл пароль, задайте новый и передайте ему."), reset, password),
    ),
  );
}

/** "Моя неделя" for the student's Today. */
export function myWeekCard(r: StudentReport): HTMLElement {
  return el(
    "div",
    { class: "card", "data-card": "my-week" },
    el("h2", {}, "Моя неделя"),
    el("p", {}, weekDots(r.week.from, r.practice.days), ` ${r.practice.days.length} из 7 дней`),
    el("p", { class: "muted" }, r.practice.answers ? `${accuracyText(r.practice)}${trend(r.practice.accuracy, r.previous.accuracy)}` : "Начните неделю с эпизода или смены в отеле."),
  );
}

