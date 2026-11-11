import { ApiError, type Api, type Dashboard, type GroupView, type HomeworkView, type SlotView } from "../net/api.js";
import type { KeyValue } from "../storage/idb.js";
import { el } from "../ui/dom.js";

// The student's school on the platform: the next lesson, the call link and the homework.
// The same data feeds the board in the Moonbridge lobby.

const DASHBOARD_KEY = "school-dashboard";
/** Moscow has no daylight saving time: lessons are always UTC+3. */
const MSK_MS = 3 * 3600_000;
const DAY_MS = 24 * 3600_000;
const WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

/** The dashboard from the gateway, kept on the device so the schedule and homework show offline too. */
export async function loadDashboard(api: Api, token: string | undefined, kv: KeyValue): Promise<Dashboard | undefined> {
  if (token) {
    try {
      const fresh = await api.dashboard(token);
      await kv.set(DASHBOARD_KEY, fresh);
      return fresh;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw e;
    }
  }
  return kv.get<Dashboard>(DASHBOARD_KEY);
}

export interface Lesson {
  group: GroupView;
  start: Date;
  end: Date;
}

/** The lesson going on now, or the next one, across the student's groups. */
export function nextLesson(groups: GroupView[], now: Date): Lesson | undefined {
  const local = new Date(now.getTime() + MSK_MS);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - MSK_MS;
  let best: Lesson | undefined;
  for (const group of groups) {
    for (const slot of group.schedule) {
      for (let d = 0; d <= 7; d++) {
        const dayStart = midnight + d * DAY_MS;
        if (weekdayOf(new Date(dayStart)) !== slot.weekday) continue;
        const [h, m] = slot.time.split(":").map(Number) as [number, number];
        const start = dayStart + (h * 60 + m) * 60_000;
        const end = start + slot.minutes * 60_000;
        if (end <= now.getTime()) continue;
        if (!best || start < best.start.getTime()) best = { group, start: new Date(start), end: new Date(end) };
        break;
      }
    }
  }
  return best;
}

/** 1 = Monday … 7 = Sunday, in Moscow. */
function weekdayOf(at: Date): number {
  return ((new Date(at.getTime() + MSK_MS).getUTCDay() + 6) % 7) + 1;
}

function moscowDay(at: Date): number {
  return Math.floor((at.getTime() + MSK_MS) / DAY_MS);
}

function hhmm(at: Date): string {
  const local = new Date(at.getTime() + MSK_MS);
  return `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
}

/** "сегодня в 18:30", "завтра в 18:30", "чт, 3 декабря, 18:30" (Moscow time). */
export function when(at: Date, now: Date): string {
  const days = moscowDay(at) - moscowDay(now);
  if (days === 0) return `сегодня в ${hhmm(at)}`;
  if (days === 1) return `завтра в ${hhmm(at)}`;
  const date = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long" }).format(at);
  return `${WEEKDAYS[weekdayOf(at) - 1]}, ${date}, ${hhmm(at)}`;
}

/** "вт и чт в 18:30" */
export function scheduleText(schedule: SlotView[]): string {
  if (!schedule.length) return "Расписание пока не задано";
  const byTime = new Map<string, number[]>();
  for (const s of [...schedule].sort((a, b) => a.weekday - b.weekday)) byTime.set(s.time, [...(byTime.get(s.time) ?? []), s.weekday]);
  return [...byTime].map(([time, days]) => `${days.map((d) => WEEKDAYS[d - 1]).join(days.length === 2 ? " и " : ", ")} в ${time}`).join("; ");
}

export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;
}

/** Homework still waiting for the student, the nearest deadline first: a file to hand in or a unit to play. */
export function openHomework(d: Dashboard): HomeworkView[] {
  return d.homework.filter((h) => (h.needs_file || h.module_id) && !h.submission);
}

/** "8 из 10 с первого раза" */
export function scoreText(score: { right: number; total: number }): string {
  return `${score.right} из ${score.total} с первого раза`;
}

/** The first episode of a unit homework the student has not played yet, or the first one to replay. */
export function nextUnitEpisode(h: HomeworkView): string | undefined {
  const episodes = h.unit?.episodes ?? [];
  return (episodes.find((e) => !e.done) ?? episodes[0])?.episode_id;
}

function homeworkStatus(h: HomeworkView, now: Date): string {
  if (h.submission?.review) return `Оценка ${h.submission.review.grade}`;
  if (h.submission?.score) return `Пройдено: ${scoreText(h.submission.score)}, ждёт оценки`;
  if (h.submission) return `Сдано: ${h.submission.file_name}`;
  if (h.module_id) {
    const episodes = h.unit?.episodes ?? [];
    const done = episodes.filter((e) => e.done).length;
    const late = h.due_at && new Date(h.due_at) < now ? "Срок прошёл, но пройти ещё можно. " : "";
    return `${late}${done ? `Moonbridge: пройдено ${done} из ${episodes.length} эпизодов` : "Пройти в Moonbridge"}`;
  }
  if (!h.needs_file) return "Делается на уроке или в Moonbridge";
  if (h.due_at && new Date(h.due_at) < now) return "Срок прошёл, но сдать ещё можно";
  return "Нужно сдать файлом";
}

/** Today's cards for a student in a group: the next lesson with its call link, and the homework. */
export function studentCards(d: Dashboard, now: Date): HTMLElement[] {
  if (!d.groups.length) {
    return [el("div", { class: "card muted-card" }, el("h2", {}, "Расписание и домашка"), el("p", { class: "muted" }, "Появятся, когда преподаватель добавит вас в группу."))];
  }
  const lesson = nextLesson(d.groups, now);
  const live = lesson && lesson.start <= now;
  const lessonCard = el(
    "div",
    { class: "card", "data-card": "lesson" },
    el("h2", {}, live ? "Занятие идёт сейчас" : "Следующее занятие"),
    el("p", {}, lesson ? `${live ? `до ${hhmm(lesson.end)}` : when(lesson.start, now)} · ${lesson.group.name}` : "В расписании пока нет занятий"),
    ...d.groups.map((g) => el("p", { class: "muted" }, `${g.name}: ${scheduleText(g.schedule)}`)),
    ...(lesson?.group.call_url ? [el("a", { class: "button primary call", href: lesson.group.call_url, target: "_blank", rel: "noopener" }, live ? "Подключиться" : "Ссылка на занятие")] : []),
  );
  const list = el("ul", { class: "homework-list" });
  for (const h of d.homework) {
    list.append(
      el(
        "li",
        {},
        el(
          "a",
          { href: `/homework/${h.homework_id}`, "data-link": "", "data-homework": h.homework_id, class: h.submission ? "done" : "" },
          el("span", { class: "hw-title" }, h.title),
          el("span", { class: "muted" }, `${h.due_at ? `до ${when(new Date(h.due_at), now)} · ` : ""}${homeworkStatus(h, now)}`),
        ),
      ),
    );
  }
  const open = openHomework(d).length;
  const homeworkCard = el(
    "div",
    { class: "card", "data-card": "homework" },
    el("h2", {}, open ? `Домашка: ${open} ждёт` : "Домашка"),
    d.homework.length ? list : el("p", { class: "muted" }, "Пока ничего не задано."),
  );
  return [lessonCard, homeworkCard];
}

export interface HomeworkPageDeps {
  api: Api;
  token: string | undefined;
  kv: KeyValue;
  navigate: (path: string) => void;
  now?: Date;
}

/** One homework: what to do, by when, and the hand-in of a file from the phone (up to 50 MB). */
export async function renderHomework(root: HTMLElement, homeworkId: string, d: HomeworkPageDeps): Promise<void> {
  const dash = await loadDashboard(d.api, d.token, d.kv);
  const h = dash?.homework.find((x) => x.homework_id === homeworkId);
  if (!dash || !h) return d.navigate("/");
  const now = d.now ?? new Date();
  const group = dash.groups.find((g) => g.group_id === h.group_id);
  // The grade has its own note below; the status line says which file it is for.
  const status = el(
    "p",
    { class: "hw-status", "data-status": h.submission ? "submitted" : "open" },
    h.submission?.review ? (h.submission.score ? `Пройдено: ${scoreText(h.submission.score)}` : `Сдано: ${h.submission.file_name}`) : homeworkStatus(h, now),
  );
  const parts: HTMLElement[] = [
    el("header", { class: "section-head" }, el("a", { href: "/", "data-link": "", class: "back" }, "← Сегодня")),
    el("h1", {}, h.title),
    el("p", { class: "muted" }, [group?.name, h.due_at ? `сдать до ${when(new Date(h.due_at), now)}` : undefined].filter(Boolean).join(" · ")),
    ...(h.description ? [el("p", { class: "hw-description" }, h.description)] : []),
    status,
    ...(h.submission?.review ? [reviewNote(h.submission.review)] : []),
  ];
  if (h.needs_file) parts.push(uploader(h, status, d));
  if (h.module_id) parts.push(unitPlan(h, d));
  root.replaceChildren(el("div", { class: "card homework-page", "data-homework-page": h.homework_id }, ...parts));
}

/** A unit homework: its episodes with a tick for each one played, and the button into the hotel. */
function unitPlan(h: HomeworkView, d: HomeworkPageDeps): HTMLElement {
  const episodes = h.unit?.episodes ?? [];
  const next = nextUnitEpisode(h);
  const allDone = episodes.length > 0 && episodes.every((e) => e.done);
  return el(
    "div",
    { class: "unit-plan", "data-unit": h.module_id ?? "" },
    el("p", { class: "muted" }, `Юнит Moonbridge «${h.unit?.title ?? h.module_id}». Результат придёт преподавателю сам, когда вы пройдёте все эпизоды.`),
    el("ul", { class: "unit-episodes" }, ...episodes.map((e) => el("li", { class: e.done ? "done" : "", "data-episode": e.episode_id }, `${e.done ? "✓" : "○"} ${e.title}`))),
    ...(next
      ? [el("button", { class: allDone ? "" : "primary", type: "button", "data-play": next, onclick: () => d.navigate(`/moonbridge/episode/${next}`) }, allDone ? "Сыграть ещё раз" : "Играть в Moonbridge")]
      : [el("p", { class: "muted" }, "Эпизоды этого юнита пока не загружены. Обновите страницу, когда будет интернет.")]),
  );
}

/** The teacher's grade and comment on the hand-in. */
function reviewNote(r: { grade: number; comment: string }): HTMLElement {
  return el(
    "div",
    { class: "review-note", "data-grade": String(r.grade) },
    el("p", {}, el("b", {}, `Оценка: ${r.grade}`)),
    ...(r.comment ? [el("p", { class: "hw-description" }, r.comment)] : []),
  );
}

function uploader(h: HomeworkView, status: HTMLElement, d: HomeworkPageDeps): HTMLElement {
  const MAX = 50 * 1024 * 1024;
  const input = el("input", { type: "file", class: "file-input", accept: "audio/*,image/*,video/*,.pdf,.doc,.docx,.txt", "aria-label": "Файл" }) as HTMLInputElement;
  const chosen = el("p", { class: "muted" });
  const bar = el("progress", { max: "1", value: "0", hidden: "" }) as HTMLProgressElement;
  const error = el("p", { class: "form-error", role: "alert" });
  const send = el("button", { class: "primary", type: "button", disabled: "" }, h.submission ? "Заменить файл" : "Сдать") as HTMLButtonElement;
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    error.textContent = "";
    chosen.textContent = f ? `${f.name}, ${fileSize(f.size)}` : "";
    send.disabled = !f || f.size > MAX || !d.token;
    if (f && f.size > MAX) error.textContent = "Файл больше 50 МБ. Запишите покороче или сожмите фото.";
    if (!d.token) error.textContent = "Нет связи с сервером. Сдать файл получится, когда появится интернет.";
  });
  send.addEventListener("click", async () => {
    const f = input.files?.[0];
    if (!f || !d.token) return;
    send.disabled = input.disabled = true;
    bar.hidden = false;
    error.textContent = "";
    try {
      const s = await d.api.uploadSubmission(d.token, h.homework_id, f, (x) => (bar.value = x));
      status.textContent = `Сдано: ${s.file_name}, ${fileSize(s.size ?? f.size)}`;
      status.dataset.status = "submitted";
      send.textContent = "Заменить файл";
      chosen.textContent = "";
      input.value = "";
      await loadDashboard(d.api, d.token, d.kv);
    } catch (e) {
      error.textContent = e instanceof ApiError && e.userMessage ? e.userMessage : "Не получилось отправить файл. Попробуйте ещё раз.";
      send.disabled = false;
    } finally {
      input.disabled = false;
      bar.hidden = true;
    }
  });
  return el(
    "div",
    { class: "uploader" },
    el("p", { class: "muted" }, "Запись с диктофона, фото тетради или документ, до 50 МБ"),
    // The native picker's own caption is in the phone's language; this button always says the same.
    el("label", { class: "file-pick button" }, input, h.submission ? "Выбрать другой файл" : "Выбрать файл"),
    chosen,
    bar,
    error,
    send,
  );
}
