import { ApiError, type Api, type Dashboard, type GroupProgress, type GroupView, type HomeworkView, type QueueItem, type SlotView } from "../net/api.js";
import type { KeyValue } from "../storage/idb.js";
import { el } from "../ui/dom.js";
import { weekDots } from "./report.js";
import { fileSize, loadDashboard, scheduleText, scoreText, when } from "./school.js";

// The teacher's cabinet: the files waiting for a grade, then each group with its students'
// week (days with practice, first-try accuracy, the most frequent error), the invitation
// link and the homework. A student's name opens the weekly report on them.

export interface TeacherDeps {
  api: Api;
  token: string | undefined;
  kv: KeyValue;
  now?: Date;
}

const MSK_MS = 3 * 3600_000;
const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

/** "2026-12-03T18:00" typed in Moscow time → ISO. */
export function moscowInputToIso(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - MSK_MS).toISOString();
}

export function messageOf(e: unknown): string {
  return e instanceof ApiError && e.userMessage ? e.userMessage : "Не получилось. Проверьте интернет и попробуйте ещё раз.";
}

export async function renderTeacher(root: HTMLElement, d: TeacherDeps): Promise<void> {
  const dash = await loadDashboard(d.api, d.token, d.kv);
  const now = d.now ?? new Date();
  const rerender = () => void renderTeacher(root, d);
  const groups = dash?.groups ?? [];
  // Online only: the queue and the students' week are not kept on the device.
  const [queue, progress] = d.token
    ? await Promise.all([
        d.api.reviewQueue(d.token).then((r) => r.submissions, () => undefined),
        Promise.all(groups.map((g) => d.api.groupProgress(d.token!, g.group_id).catch(() => undefined))),
      ])
    : [undefined, []];
  root.replaceChildren(
    el(
      "div",
      { class: "teacher" },
      el("header", { class: "section-head" }, el("a", { href: "/", "data-link": "", class: "back" }, "← Сегодня"), el("h1", {}, "Кабинет преподавателя")),
      ...(d.token ? [] : [el("p", { class: "form-error" }, "Нет связи с сервером: показано то, что было при последнем входе.")]),
      ...(queue ? [reviewQueue(queue, d, rerender)] : []),
      ...groups.map((g, i) => groupCard(g, dash!, progress[i], now, d, rerender)),
      newGroupForm(d, rerender, groups.length === 0),
      el(
        "section",
        { class: "card content-link" },
        el("div", {}, el("h2", {}, "Каталог уроков"), el("p", { class: "muted" }, "Юниты Moonbridge: задать группе или ученику как домашку со сроком.")),
        el("a", { class: "button", href: "/teacher/catalog", "data-link": "", "data-catalog-link": "" }, "Открыть"),
      ),
      el(
        "section",
        { class: "card content-link" },
        el("div", {}, el("h2", {}, "Контент курса"), el("p", { class: "muted" }, "Юниты, задания и эпизоды Moonbridge — в таблице.")),
        el("a", { class: "button", href: "/teacher/content", "data-link": "" }, "Открыть"),
      ),
    ),
  );
}

/** Files waiting for a grade, the oldest first: listen or look, give 1–5 and a comment. */
function reviewQueue(queue: QueueItem[], d: TeacherDeps, rerender: () => void): HTMLElement {
  if (!queue.length) {
    return el("section", { class: "card review-queue", "data-queue": "0" }, el("h2", {}, "Проверка"), el("p", { class: "muted" }, "Всё сданное проверено."));
  }
  return el(
    "section",
    { class: "card review-queue", "data-queue": String(queue.length) },
    el("h2", {}, `Проверка: ${queue.length}`),
    ...queue.map((s) => reviewItem(s, d, rerender)),
  );
}

function reviewItem(s: QueueItem, d: TeacherDeps, rerender: () => void): HTMLElement {
  const preview = el("div", { class: "preview" });
  const open = el("button", { type: "button", "data-open": s.submission_id }, "Открыть файл") as HTMLButtonElement;
  open.addEventListener("click", async () => {
    if (!d.token) return;
    open.disabled = true;
    try {
      const url = await d.api.submissionLink(d.token, s.submission_id);
      const kind = (s.mime ?? "").split("/")[0];
      // Recordings and photos open right here; anything else downloads.
      const media =
        kind === "audio" ? el("audio", { controls: "", src: url, preload: "metadata" }) :
        kind === "image" ? el("img", { src: url, alt: s.file_name ?? "" }) :
        kind === "video" ? el("video", { controls: "", src: url, preload: "metadata", playsinline: "" }) :
        undefined;
      preview.replaceChildren(...(media ? [media] : []), el("a", { href: url, class: "muted" }, `Скачать ${s.file_name}`));
    } catch (e) {
      preview.replaceChildren(el("p", { class: "form-error" }, messageOf(e)));
      open.disabled = false;
    }
  });
  const grades = el("div", { class: "grades", role: "radiogroup", "aria-label": "Оценка" });
  // A unit's result comes with the grade its score suggests, already chosen: one tap confirms it.
  let grade = s.score?.suggested_grade ?? 0;
  const save = el("button", { class: "primary", type: "submit", ...(grade ? {} : { disabled: "" }) }, grade ? "Подтвердить оценку" : "Сохранить оценку") as HTMLButtonElement;
  for (let g = 5; g >= 1; g--) {
    const b = el("button", { type: "button", class: "grade", role: "radio", "aria-checked": String(g === grade), "data-grade": String(g) }, String(g)) as HTMLButtonElement;
    b.addEventListener("click", () => {
      grade = g;
      grades.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      save.disabled = false;
      save.textContent = g === s.score?.suggested_grade ? "Подтвердить оценку" : "Сохранить оценку";
    });
    grades.append(b);
  }
  const comment = el("textarea", { class: "answer", rows: "2", maxlength: "4000", "aria-label": "Комментарий", placeholder: "Что получилось, над чем поработать" }) as HTMLTextAreaElement;
  const error = el("p", { class: "form-error", role: "alert" });
  const form = el(
    "form",
    {
      class: "review-form",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!d.token || !grade) return;
        save.disabled = true;
        try {
          await d.api.review(d.token, s.submission_id, grade, comment.value.trim());
          rerender();
        } catch (err) {
          error.textContent = messageOf(err);
          save.disabled = false;
        }
      },
    },
    grades,
    comment,
    error,
    save,
  );
  const head = el("p", {}, el("b", {}, s.student_name), ` · ${s.homework_title}`);
  if (s.score) {
    const percent = s.score.total ? Math.round((s.score.right / s.score.total) * 100) : 100;
    return el(
      "div",
      { class: "review-item unit-result", "data-review": s.submission_id, "data-score": `${s.score.right}/${s.score.total}` },
      head,
      el("p", { class: "muted" }, `Moonbridge: ${scoreText(s.score)} (${percent}%), пройдено ${when(new Date(s.submitted_at), new Date())}`),
      el("p", { class: "muted" }, `По результату предлагается ${s.score.suggested_grade}: от 90% — 5, от 75% — 4, от 50% — 3.`),
      form,
    );
  }
  return el(
    "div",
    { class: "review-item", "data-review": s.submission_id },
    head,
    el("p", { class: "muted" }, `${s.file_name}, ${fileSize(s.size ?? 0)}, сдано ${when(new Date(s.submitted_at), new Date())}`),
    open,
    preview,
    form,
  );
}

/** The group's students this week; a name opens the weekly report. */
function studentsTable(progress: GroupProgress): HTMLElement {
  if (!progress.students.length) return el("p", {}, "Учеников пока нет");
  return el(
    "ul",
    { class: "students" },
    ...progress.students.map((s) =>
      el(
        "li",
        {},
        el(
          "a",
          { href: `/teacher/student/${s.id}`, "data-link": "", "data-student": s.id },
          el("span", { class: "student-name" }, s.name),
          weekDots(progress.week.from, s.week.days),
          el(
            "span",
            { class: "muted" },
            [
              s.week.accuracy === null ? "нет ответов" : `${s.week.accuracy}% с первого раза`,
              s.week.errors[0] ? `чаще всего: ${s.week.errors[0].label.toLowerCase()}` : undefined,
              s.homework_open ? `не сдано: ${s.homework_open}` : undefined,
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        ),
      ),
    ),
  );
}

function groupCard(g: GroupView, dash: Dashboard, progress: GroupProgress | undefined, now: Date, d: TeacherDeps, rerender: () => void): HTMLElement {
  const members = g.members ?? [];
  const inviteBox = el("div", { class: "invite" });
  const inviteButton = el("button", { type: "button", "data-invite": g.group_id }, "Пригласить ученика") as HTMLButtonElement;
  inviteButton.addEventListener("click", async () => {
    if (!d.token) return;
    inviteButton.disabled = true;
    try {
      const inv = await d.api.createInvite(d.token, g.group_id);
      const field = el("input", { class: "answer invite-url", readonly: "", value: inv.url, "aria-label": "Ссылка-приглашение" }) as HTMLInputElement;
      const copy = el("button", { type: "button" }, "Скопировать") as HTMLButtonElement;
      copy.addEventListener("click", () => {
        field.select();
        void navigator.clipboard?.writeText(inv.url).then(() => (copy.textContent = "Скопировано"));
      });
      inviteBox.replaceChildren(
        field,
        copy,
        el("p", { class: "muted" }, `Ссылка действует до ${when(new Date(inv.expires_at), new Date())}. По ней ученик сам заводит логин и пароль.`),
      );
    } catch (e) {
      inviteBox.replaceChildren(el("p", { class: "form-error" }, messageOf(e)));
    } finally {
      inviteButton.disabled = false;
    }
  });

  const homework = dash.homework.filter((h) => h.group_id === g.group_id);
  return el(
    "section",
    { class: "card group", "data-group": g.group_id },
    el("h2", {}, g.name),
    el("p", { class: "muted" }, scheduleText(g.schedule)),
    ...(g.call_url ? [el("p", { class: "muted" }, "Звонок: ", el("a", { href: g.call_url, target: "_blank", rel: "noopener" }, g.call_url))] : []),
    el("h3", { "data-members": String(members.length) }, `Ученики: ${members.length}`),
    progress ? studentsTable(progress) : el("p", {}, members.length ? members.map((m) => m.name).join(", ") : "Учеников пока нет"),
    inviteButton,
    inviteBox,
    el("a", { class: "metrics-link", href: `/teacher/metrics/${g.group_id}`, "data-link": "", "data-metrics": g.group_id }, "Метрики пилота →"),
    el("h3", {}, "Домашка"),
    ...(homework.length ? homework.map((h) => homeworkItem(h, members.length, now, d)) : [el("p", { class: "muted" }, "Ещё ничего не задано.")]),
    newHomeworkForm(g, d, rerender),
  );
}

function homeworkItem(h: HomeworkView, members: number, now: Date, d: TeacherDeps): HTMLElement {
  const subs = h.submissions ?? [];
  const of = h.account_id ? 1 : members;
  const late = (at: string) => (h.due_at && new Date(at) > new Date(h.due_at) ? ", после срока" : "");
  return el(
    "div",
    { class: "hw-item", "data-homework": h.homework_id, ...(h.module_id ? { "data-unit": h.module_id } : {}) },
    el("p", { class: "hw-title" }, h.title),
    el(
      "p",
      { class: "muted" },
      [
        h.assignee_name ? `только ${h.assignee_name}` : undefined,
        h.due_at ? `до ${when(new Date(h.due_at), now)}` : "без срока",
        h.module_id ? `юнит Moonbridge · прошли ${subs.length} из ${of}${h.auto_grade ? " · оценка автоматически" : ""}` : h.needs_file ? `сдали ${subs.length} из ${of}` : "без файла",
      ]
        .filter(Boolean)
        .join(" · "),
    ),
    ...subs.map((s) => {
      if (s.score) {
        return el(
          "p",
          { class: "muted", "data-submission": s.submission_id },
          `${s.student_name}: ${scoreText(s.score)}${late(s.submitted_at)}${s.review ? `, оценка ${s.review.grade}` : ", ждёт оценки"}`,
        );
      }
      const open = el(
        "button",
        { type: "button", class: "link", "data-submission": s.submission_id },
        `${s.student_name}: ${s.file_name} (${fileSize(s.size ?? 0)})${late(s.submitted_at)}${s.review ? `, оценка ${s.review.grade}` : ", ждёт проверки"}`,
      ) as HTMLButtonElement;
      open.addEventListener("click", async () => {
        if (!d.token) return;
        try {
          // The server names the file (Content-Disposition), so it keeps its Cyrillic name everywhere.
          location.assign(await d.api.submissionLink(d.token, s.submission_id));
        } catch (e) {
          open.textContent = messageOf(e);
        }
      });
      return open;
    }),
  );
}

function newHomeworkForm(g: GroupView, d: TeacherDeps, rerender: () => void): HTMLElement {
  const title = el("input", { class: "answer", name: "title", maxlength: "120", required: "", "aria-label": "Название" }) as HTMLInputElement;
  const description = el("textarea", { class: "answer", name: "description", rows: "3", maxlength: "4000", "aria-label": "Что сделать" }) as HTMLTextAreaElement;
  const due = el("input", { class: "answer", type: "datetime-local", name: "due", "aria-label": "Срок" }) as HTMLInputElement;
  const needsFile = el("input", { type: "checkbox", name: "needs_file", checked: "" }) as HTMLInputElement;
  const who = assigneeSelect(g);
  const error = el("p", { class: "form-error", role: "alert" });
  const form = el(
    "form",
    {
      class: "hw-form",
      "data-form": "homework",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!d.token) return;
        try {
          await d.api.createHomework(d.token, g.group_id, {
            title: title.value.trim(),
            description: description.value.trim(),
            due_at: due.value ? moscowInputToIso(due.value) : null,
            needs_file: needsFile.checked,
            account_id: who.value || null,
          });
          rerender();
        } catch (err) {
          error.textContent = messageOf(err);
        }
      },
    },
    el("label", {}, "Название", title),
    el("label", {}, "Что сделать", description),
    el("label", {}, "Кому", who),
    el("label", {}, "Срок (по Москве)", due),
    el("label", { class: "check" }, needsFile, "Сдаётся файлом: запись, фото или документ"),
    error,
    el("button", { class: "primary", type: "submit" }, "Задать"),
    el("p", { class: "muted" }, "Юнит Moonbridge задаётся из ", el("a", { href: "/teacher/catalog", "data-link": "" }, "каталога уроков"), "."),
  );
  return el("details", { class: "new-homework" }, el("summary", {}, "Новая домашка"), form);
}

/** "Вся группа" or one of its students; the value is the student's account id, empty for the group. */
export function assigneeSelect(g: GroupView): HTMLSelectElement {
  return el(
    "select",
    { class: "answer", name: "account_id", "aria-label": "Кому" },
    el("option", { value: "" }, "Вся группа"),
    ...(g.members ?? []).map((m) => el("option", { value: m.id }, m.name)),
  ) as HTMLSelectElement;
}

function newGroupForm(d: TeacherDeps, rerender: () => void, open: boolean): HTMLElement {
  const name = el("input", { class: "answer", name: "name", maxlength: "80", required: "", "aria-label": "Название группы" }) as HTMLInputElement;
  const call = el("input", { class: "answer", type: "url", name: "call_url", placeholder: "https://telemost.yandex.ru/…", "aria-label": "Ссылка на звонок" }) as HTMLInputElement;
  const days = DAYS.map((label, i) => ({ day: i + 1, box: el("input", { type: "checkbox", name: `day${i + 1}`, "aria-label": label }) as HTMLInputElement, label }));
  const time = el("input", { class: "answer", type: "time", name: "time", value: "18:30", "aria-label": "Время" }) as HTMLInputElement;
  const minutes = el("input", { class: "answer", type: "number", name: "minutes", value: "60", min: "15", max: "240", step: "5", "aria-label": "Минут" }) as HTMLInputElement;
  const error = el("p", { class: "form-error", role: "alert" });
  const form = el(
    "form",
    {
      class: "card group-form",
      "data-form": "group",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!d.token) return;
        const schedule: SlotView[] = days.filter((x) => x.box.checked).map((x) => ({ weekday: x.day, time: time.value, minutes: Number(minutes.value) }));
        try {
          await d.api.createGroup(d.token, { name: name.value.trim(), call_url: call.value.trim() || null, schedule });
          rerender();
        } catch (err) {
          error.textContent = messageOf(err);
        }
      },
    },
    el("h2", {}, open ? "Первая группа" : "Новая группа"),
    el("label", {}, "Название", name),
    el("label", {}, "Ссылка на звонок", call),
    el("fieldset", { class: "days" }, el("legend", {}, "Дни занятий"), ...days.map((x) => el("label", { class: "day" }, x.box, x.label))),
    el("div", { class: "row" }, el("label", {}, "Время (по Москве)", time), el("label", {}, "Минут", minutes)),
    error,
    el("button", { class: "primary", type: "submit" }, "Создать группу"),
  );
  return form;
}
