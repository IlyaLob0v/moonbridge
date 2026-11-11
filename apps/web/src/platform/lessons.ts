import { ApiError, type Api, type Dashboard, type LessonMaterial, type LessonView, type StudentLesson, type TeacherLesson } from "../net/api.js";
import type { KeyValue } from "../storage/idb.js";
import { el } from "../ui/dom.js";
import { fileSize, loadDashboard, when } from "./school.js";
import { moscowInputToIso } from "./teacher.js";

// Lessons as the platform keeps them: the lesson itself happens in a video service; here are
// its time, the call link, the materials, the teacher's recording and who came.

const MSK_MS = 3 * 3600_000;

const ends = (l: LessonView) => Date.parse(l.ends_at);
const starts = (l: LessonView) => Date.parse(l.starts_at);

/** "вт, 1 декабря, 18:30" (Moscow time). */
export function lessonDate(l: LessonView): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", weekday: "short", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(l.starts_at));
}

/** ISO → the value of a datetime-local input in Moscow time. */
export function isoToMoscowInput(iso: string): string {
  return new Date(Date.parse(iso) + MSK_MS).toISOString().slice(0, 16);
}

/** The lesson going on now or the next one that is not cancelled. */
export function nextScheduled(lessons: LessonView[], now: Date): LessonView | undefined {
  return lessons.filter((l) => l.status !== "cancelled" && ends(l) > now.getTime()).sort((a, b) => starts(a) - starts(b))[0];
}

/** Ended lessons the teacher has not marked yet, the oldest first. */
export function toMark<T extends LessonView>(lessons: T[], now: Date): T[] {
  return lessons.filter((l) => l.status === "planned" && ends(l) <= now.getTime()).sort((a, b) => starts(a) - starts(b));
}

/**
 * Materials typed one per line: "Рабочий лист https://…", "https://… — слова", or a bare link.
 * Lines without a link are skipped.
 */
export function parseMaterials(text: string): LessonMaterial[] {
  const out: LessonMaterial[] = [];
  for (const line of text.split("\n")) {
    const url = /https?:\/\/\S+/.exec(line)?.[0];
    if (!url) continue;
    const title = line.replace(url, "").replace(/^[\s:—–|-]+|[\s:—–|-]+$/g, "").trim();
    out.push({ title: title || `Материал ${out.length + 1}`, url });
  }
  return out;
}

export const materialsText = (m: LessonMaterial[]) => m.map((x) => `${x.title} ${x.url}`).join("\n");

const STATUS: Record<string, string> = { present: "был(а) на уроке", absent: "пропуск" };

function links(l: LessonView): HTMLElement[] {
  const items = [
    // Opened by openLessonFile (main.ts): the download link is asked for on tap and lives five minutes.
    ...(l.files ?? []).map((f) => el("a", { href: "#", "data-lesson-file": f.file_id, title: fileSize(f.size) }, f.file_name)),
    ...l.materials.map((m) => el("a", { href: m.url, target: "_blank", rel: "noopener", "data-material": "" }, m.title)),
    ...(l.recording_url ? [el("a", { href: l.recording_url, target: "_blank", rel: "noopener", "data-recording": "" }, "Запись урока")] : []),
  ];
  return items.length ? [el("p", { class: "lesson-links" }, ...items)] : [];
}

/** A lesson in the student's lists: when, topic, their mark, materials and recording. */
function studentLessonItem(l: StudentLesson, now: Date): HTMLElement {
  const past = starts(l) <= now.getTime();
  const status =
    l.status === "cancelled" ? `Отменён${l.note ? `: ${l.note}` : ""}` :
    l.status === "held" ? (l.attendance ? STATUS[l.attendance]! : "прошёл") :
    past ? "ждёт отметки преподавателя" : "";
  return el(
    "li",
    { class: `lesson-item ${l.status}`, "data-lesson": l.lesson_id, "data-status": l.status, ...(l.attendance ? { "data-attendance": l.attendance } : {}) },
    el("p", {}, el("b", {}, lessonDate(l)), ` · ${l.group_name}`),
    ...(l.topic ? [el("p", { class: "lesson-topic" }, l.topic)] : []),
    ...(status ? [el("p", { class: "muted" }, status)] : []),
    ...(l.status !== "cancelled" && l.note ? [el("p", { class: "muted" }, l.note)] : []),
    ...links(l),
  );
}

/** Today's lesson card from the generated lessons: a cancellation or a moved lesson shows here. */
export function lessonCard(d: Dashboard, lessons: StudentLesson[], now: Date): HTMLElement {
  const next = nextScheduled(lessons, now);
  const live = next && starts(next) <= now.getTime();
  const cancelled = lessons.filter((l) => l.status === "cancelled" && ends(l) > now.getTime() && (!next || starts(l) < starts(next)));
  return el(
    "div",
    { class: "card", "data-card": "lesson" },
    el("h2", {}, live ? "Занятие идёт сейчас" : "Следующее занятие"),
    ...cancelled.map((l) => el("p", { class: "form-error", "data-cancelled": l.lesson_id }, `${when(new Date(l.starts_at), now)} — урок отменён${l.note ? `: ${l.note}` : ""}`)),
    el("p", {}, next ? `${live ? `до ${new Date(ends(next) + MSK_MS).toISOString().slice(11, 16)}` : when(new Date(next.starts_at), now)} · ${next.group_name}` : "В расписании пока нет занятий"),
    ...(next?.topic ? [el("p", { class: "lesson-topic" }, next.topic)] : []),
    ...(next && next.note ? [el("p", { class: "muted" }, next.note)] : []),
    ...(next ? links(next) : []),
    ...(next?.call_url ? [el("a", { class: "button primary call", href: next.call_url, target: "_blank", rel: "noopener" }, live ? "Подключиться" : "Ссылка на занятие")] : []),
    ...(d.groups.length ? [el("a", { class: "card-action", href: "/lessons", "data-link": "", "data-all-lessons": "" }, "Все занятия, материалы и записи →")] : []),
  );
}

/** The last lessons with materials or a recording, for Today. */
export function pastLessonsCard(lessons: StudentLesson[], now: Date): HTMLElement | undefined {
  const past = lessons.filter((l) => l.status === "held" && starts(l) <= now.getTime() && (l.materials.length || l.recording_url || l.files?.length)).sort((a, b) => starts(b) - starts(a)).slice(0, 2);
  if (!past.length) return undefined;
  return el("div", { class: "card", "data-card": "past-lessons" }, el("h2", {}, "Прошедшие занятия"), el("ul", { class: "lesson-list" }, ...past.map((l) => studentLessonItem(l, now))));
}

export interface StudentLessonsDeps {
  api: Api;
  token: string | undefined;
  kv: KeyValue;
  now?: Date;
}

/** The student's lessons: what is coming and what has been, with materials, recordings and marks. */
export async function renderStudentLessons(root: HTMLElement, d: StudentLessonsDeps): Promise<void> {
  const now = d.now ?? new Date();
  let lessons: StudentLesson[] | undefined;
  let offline = false;
  if (d.token) lessons = await d.api.lessons(d.token).then((r) => r.lessons, () => undefined);
  if (!lessons) {
    // Offline: the month the dashboard keeps on the device.
    offline = true;
    lessons = ((await loadDashboard(d.api, undefined, d.kv))?.lessons ?? []) as StudentLesson[];
  }
  const coming = lessons.filter((l) => ends(l) > now.getTime()).sort((a, b) => starts(a) - starts(b));
  const past = lessons.filter((l) => ends(l) <= now.getTime()).sort((a, b) => starts(b) - starts(a));
  const held = past.filter((l) => l.status === "held");
  root.replaceChildren(
    el(
      "div",
      { class: "lessons-page" },
      el("header", { class: "section-head" }, el("a", { href: "/", "data-link": "", class: "back" }, "← Сегодня"), el("h1", {}, "Занятия")),
      ...(offline ? [el("p", { class: "form-error" }, "Нет связи с сервером: показано то, что было при последнем входе.")] : []),
      el("section", { class: "card", "data-lessons": "coming" }, el("h2", {}, "Впереди"), coming.length ? el("ul", { class: "lesson-list" }, ...coming.map((l) => studentLessonItem(l, now))) : el("p", { class: "muted" }, "Занятий пока нет.")),
      el(
        "section",
        { class: "card", "data-lessons": "past" },
        el("h2", {}, "Прошли"),
        ...(held.length ? [el("p", { class: "muted" }, `Был(а) на ${held.filter((l) => l.attendance === "present").length} из ${held.length}`)] : []),
        past.length ? el("ul", { class: "lesson-list" }, ...past.map((l) => studentLessonItem(l, now))) : el("p", { class: "muted" }, "Здесь появятся прошедшие занятия с материалами и записями."),
      ),
    ),
  );
}

/** Downloads a lesson file: a short-lived link, opened like any download so the file keeps its name. */
export async function openLessonFile(api: Api, token: string | undefined, fileId: string, a: HTMLElement): Promise<void> {
  if (!token) {
    a.textContent = "Файл скачивается, когда есть связь с сервером";
    return;
  }
  try {
    location.assign(await api.lessonFileLink(token, fileId));
  } catch (e) {
    a.textContent = messageOf(e);
  }
}

// ---------- The teacher's lessons of a group

export interface GroupLessonsDeps {
  api: Api;
  token: string | undefined;
  now?: () => Date;
}

function messageOf(e: unknown): string {
  return e instanceof ApiError && e.userMessage ? e.userMessage : "Не получилось. Проверьте интернет и попробуйте ещё раз.";
}

/** The group's lessons for the teacher: the ones to mark first, then the coming ones, then the past. */
export async function renderGroupLessons(root: HTMLElement, groupId: string, d: GroupLessonsDeps): Promise<void> {
  const back = el("a", { href: "/teacher", "data-link": "", class: "back" }, "← Кабинет");
  if (!d.token) {
    root.replaceChildren(el("div", { class: "card" }, back, el("p", { class: "form-error" }, "Уроки открываются, когда есть связь с сервером.")));
    return;
  }
  let data: Awaited<ReturnType<Api["groupLessons"]>>;
  try {
    data = await d.api.groupLessons(d.token, groupId);
  } catch (e) {
    root.replaceChildren(el("div", { class: "card" }, back, el("p", { class: "form-error" }, e instanceof ApiError && e.status === 404 ? "Такой группы нет среди ваших." : messageOf(e))));
    return;
  }
  const now = (d.now ?? (() => new Date()))();
  const rerender = () => void renderGroupLessons(root, groupId, d);
  const marking = toMark(data.lessons, now);
  const coming = data.lessons.filter((l) => ends(l) > now.getTime());
  const past = data.lessons.filter((l) => ends(l) <= now.getTime() && !marking.includes(l)).reverse();
  const item = (l: TeacherLesson) => teacherLessonItem(l, now, d.token!, d.api, rerender);
  root.replaceChildren(
    el(
      "div",
      { class: "teacher lessons-page" },
      el("header", { class: "section-head" }, back, el("h1", {}, `Уроки: ${data.group.name}`)),
      ...(marking.length ? [el("section", { class: "card to-mark", "data-lessons": "to-mark" }, el("h2", {}, `Отметьте посещаемость: ${marking.length}`), ...marking.map(item))] : []),
      el("section", { class: "card", "data-lessons": "coming" }, el("h2", {}, "Впереди"), ...(coming.length ? coming.map(item) : [el("p", { class: "muted" }, "Занятий нет: задайте дни в расписании группы или добавьте урок.")]), newLessonForm(groupId, d, rerender)),
      ...(past.length ? [el("section", { class: "card", "data-lessons": "past" }, el("h2", {}, "Прошли"), ...past.map(item))] : []),
    ),
  );
}

function teacherLessonItem(l: TeacherLesson, now: Date, token: string, api: Api, rerender: () => void): HTMLElement {
  const started = starts(l) <= now.getTime();
  const error = el("p", { class: "form-error", role: "alert" });
  const run = (button: HTMLButtonElement, action: () => Promise<unknown>) => async () => {
    button.disabled = true;
    error.textContent = "";
    try {
      await action();
      rerender();
    } catch (e) {
      error.textContent = messageOf(e);
      button.disabled = false;
    }
  };

  const present = l.attendance.filter((a) => a.status === "present").length;
  const summary =
    l.status === "held" ? `прошёл · были ${present} из ${l.attendance.length}` :
    l.status === "cancelled" ? `отменён${l.note ? `: ${l.note}` : ""}` :
    started ? "нужно отметить посещаемость" : "";
  const parts: HTMLElement[] = [el("p", {}, el("b", {}, lessonDate(l)), `, ${l.minutes} мин`, summary ? ` · ${summary}` : ""), ...(l.topic ? [el("p", { class: "lesson-topic" }, l.topic)] : []), ...links(l)];

  // Attendance: everyone ticked by default, the teacher unticks who did not come.
  if (started && l.status !== "cancelled" && l.attendance.length) {
    const boxes = l.attendance.map((a) => ({ a, box: el("input", { type: "checkbox", "data-student": a.account_id, ...(a.status !== "absent" ? { checked: "" } : {}) }) as HTMLInputElement }));
    const save = el("button", { class: "primary", type: "button", "data-mark": l.lesson_id }, l.status === "held" ? "Сохранить отметки" : "Урок прошёл") as HTMLButtonElement;
    save.addEventListener("click", run(save, () => api.markAttendance(token, l.lesson_id, boxes.map((x) => ({ account_id: x.a.account_id, status: x.box.checked ? "present" : "absent" })))));
    parts.push(
      el("fieldset", { class: "attendance" }, el("legend", {}, "Кто был"), ...boxes.map((x) => el("label", { class: "day" }, x.box, x.a.name))),
      save,
    );
  }

  const topic = el("input", { class: "answer", maxlength: "200", value: l.topic, "aria-label": "Тема" }) as HTMLInputElement;
  const mats = el("textarea", { class: "answer", rows: "3", "aria-label": "Материалы", placeholder: "Рабочий лист https://disk.yandex.ru/…" }) as HTMLTextAreaElement;
  mats.value = materialsText(l.materials);
  const recording = el("input", { class: "answer", type: "url", value: l.recording_url ?? "", placeholder: "https://…", "aria-label": "Запись урока" }) as HTMLInputElement;
  const note = el("input", { class: "answer", maxlength: "1000", value: l.note, "aria-label": "Заметка для учеников" }) as HTMLInputElement;
  const at = el("input", { class: "answer", type: "datetime-local", value: isoToMoscowInput(l.starts_at), "aria-label": "Начало" }) as HTMLInputElement;
  const save = el("button", { class: "primary", type: "submit" }, "Сохранить") as HTMLButtonElement;
  const form = el(
    "form",
    {
      class: "hw-form lesson-form",
      "data-lesson-form": l.lesson_id,
      onsubmit: (e: Event) => {
        e.preventDefault();
        const startsAt = moscowInputToIso(at.value);
        void run(save, () =>
          api.updateLesson(token, l.lesson_id, {
            topic: topic.value.trim(),
            materials: parseMaterials(mats.value),
            recording_url: recording.value.trim() || null,
            note: note.value.trim(),
            ...(startsAt && startsAt !== new Date(l.starts_at).toISOString() ? { starts_at: startsAt } : {}),
          }),
        )();
      },
    },
    el("label", {}, "Тема", topic),
    el("label", {}, "Материалы: по одному на строку, название и ссылка", mats),
    el("label", {}, "Запись урока (ссылка)", recording),
    el("label", {}, "Заметка для учеников", note),
    el("label", {}, "Начало (по Москве)", at),
    save,
  );
  const toggle = el("button", { type: "button", class: "link", "data-cancel": l.lesson_id }, l.status === "cancelled" ? "Вернуть урок" : "Отменить урок") as HTMLButtonElement;
  toggle.addEventListener("click", () => {
    if (l.status !== "cancelled" && !confirm(l.status === "held" ? "Урок уже отмечен. Отменить его и снять отметки?" : "Отменить урок? Ученики увидят это на «Сегодня».")) return;
    void run(toggle, () => api.updateLesson(token, l.lesson_id, { status: l.status === "cancelled" ? "planned" : "cancelled", ...(l.status !== "cancelled" ? { note: note.value.trim() } : {}) }))();
  });
  parts.push(el("details", { class: "new-homework" }, el("summary", {}, "Тема, материалы, запись"), form, lessonFiles(l, token, api, rerender), toggle), error);
  return el("div", { class: `hw-item lesson-item ${l.status}`, "data-lesson": l.lesson_id, "data-status": l.status }, ...parts);
}

/** The lesson's files: each with a remove button, and an upload from the phone or computer (up to 50 MB). */
function lessonFiles(l: TeacherLesson, token: string, api: Api, rerender: () => void): HTMLElement {
  const MAX = 50 * 1024 * 1024;
  const error = el("p", { class: "form-error", role: "alert" });
  const list = (l.files ?? []).map((f) => {
    const remove = el("button", { type: "button", class: "link", "data-remove-file": f.file_id }, "Удалить") as HTMLButtonElement;
    remove.addEventListener("click", async () => {
      if (!confirm(`Удалить ${f.file_name}? Ученики больше не смогут его скачать.`)) return;
      remove.disabled = true;
      try {
        await api.deleteLessonFile(token, l.lesson_id, f.file_id);
        rerender();
      } catch (e) {
        error.textContent = messageOf(e);
        remove.disabled = false;
      }
    });
    return el("li", {}, el("a", { href: "#", "data-lesson-file": f.file_id }, f.file_name), el("span", { class: "muted" }, ` ${fileSize(f.size)} `), remove);
  });
  const input = el("input", { type: "file", class: "file-input", accept: ".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.odp,.txt,image/*,audio/*,video/*", "aria-label": "Файл к уроку" }) as HTMLInputElement;
  const bar = el("progress", { max: "1", value: "0", hidden: "" }) as HTMLProgressElement;
  input.addEventListener("change", async () => {
    const f = input.files?.[0];
    if (!f) return;
    error.textContent = "";
    if (f.size > MAX) {
      error.textContent = "Файл больше 50 МБ. Положите его на диск и добавьте ссылкой.";
      input.value = "";
      return;
    }
    input.disabled = true;
    bar.hidden = false;
    try {
      await api.uploadLessonFile(token, l.lesson_id, f, (x) => (bar.value = x));
      rerender();
    } catch (e) {
      error.textContent = messageOf(e);
      input.disabled = false;
      bar.hidden = true;
      input.value = "";
    }
  });
  return el(
    "div",
    { class: "uploader lesson-files", "data-lesson-files": l.lesson_id },
    el("p", { class: "muted" }, "Файлы: рабочий лист, слайды, аудио, до 50 МБ каждый"),
    ...(list.length ? [el("ul", { class: "lesson-file-list" }, ...list)] : []),
    el("label", { class: "file-pick button" }, input, "Загрузить файл"),
    bar,
    error,
  );
}

function newLessonForm(groupId: string, d: GroupLessonsDeps, rerender: () => void): HTMLElement {
  const at = el("input", { class: "answer", type: "datetime-local", required: "", "aria-label": "Начало" }) as HTMLInputElement;
  const minutes = el("input", { class: "answer", type: "number", value: "60", min: "15", max: "240", step: "5", "aria-label": "Минут" }) as HTMLInputElement;
  const topic = el("input", { class: "answer", maxlength: "200", "aria-label": "Тема" }) as HTMLInputElement;
  const error = el("p", { class: "form-error", role: "alert" });
  const form = el(
    "form",
    {
      class: "hw-form",
      "data-form": "lesson",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const startsAt = moscowInputToIso(at.value);
        if (!d.token || !startsAt) return;
        try {
          await d.api.createLesson(d.token, groupId, { starts_at: startsAt, minutes: Number(minutes.value), topic: topic.value.trim() });
          rerender();
        } catch (err) {
          error.textContent = messageOf(err);
        }
      },
    },
    el("label", {}, "Начало (по Москве)", at),
    el("label", {}, "Минут", minutes),
    el("label", {}, "Тема", topic),
    error,
    el("button", { class: "primary", type: "submit" }, "Добавить урок"),
  );
  return el("details", { class: "new-homework" }, el("summary", {}, "Дополнительный урок"), form);
}
