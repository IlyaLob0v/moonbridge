import type { Api, CatalogUnit, Dashboard, GroupView, HomeworkView } from "../net/api.js";
import type { KeyValue } from "../storage/idb.js";
import { el } from "../ui/dom.js";
import { loadDashboard, when } from "./school.js";
import { assigneeSelect, messageOf, moscowInputToIso } from "./teacher.js";

// The lesson catalog: every unit of the course with its Moonbridge episodes. The teacher finds
// a unit and gives it to a group or to one student with a deadline; the student plays it, and
// the result comes into the review queue by itself.

export interface CatalogDeps {
  api: Api;
  token: string | undefined;
  kv: KeyValue;
  navigate: (path: string) => void;
  now?: Date;
}

const SKILLS: Record<string, string> = { grammar: "грамматика", vocabulary: "лексика", reading: "чтение", listening: "аудирование" };

export async function renderCatalog(root: HTMLElement, d: CatalogDeps): Promise<void> {
  const head = el("header", { class: "section-head" }, el("a", { href: "/teacher", "data-link": "", class: "back" }, "← Кабинет"), el("h1", {}, "Каталог уроков"));
  if (!d.token) {
    root.replaceChildren(el("div", { class: "teacher catalog" }, head, el("p", { class: "form-error" }, "Каталог открывается только с интернетом.")));
    return;
  }
  const [units, dash] = await Promise.all([d.api.catalog(d.token).then((r) => r.units, () => undefined), loadDashboard(d.api, d.token, d.kv).catch(() => undefined)]);
  const now = d.now ?? new Date();
  const groups = dash?.groups ?? [];
  const search = el("input", { class: "answer", type: "search", placeholder: "Найти юнит: название или тема", "aria-label": "Поиск по каталогу" }) as HTMLInputElement;
  const list = el("div", { class: "catalog-list" });
  const show = () => {
    const q = search.value.trim().toLowerCase();
    const found = (units ?? []).filter((u) => !q || [u.title.ru, u.title.en, u.description ?? "", u.module_id, ...u.episodes.map((e) => e.title)].some((t) => t.toLowerCase().includes(q)));
    list.replaceChildren(...(found.length ? found.map((u) => unitCard(u, groups, dash, now, d)) : [el("p", { class: "muted" }, units ? "Ничего не нашлось." : "Не получилось загрузить каталог.")]));
  };
  search.addEventListener("input", show);
  show();
  root.replaceChildren(
    el(
      "div",
      { class: "teacher catalog" },
      head,
      el("p", { class: "muted" }, "Юнит задаётся группе или одному ученику. Ученик проходит эпизоды в Moonbridge, результат сам приходит в «Проверку» с предложенной оценкой."),
      ...(groups.length ? [] : [el("p", { class: "form-error" }, "Сначала создайте группу в кабинете: задать юнит можно только ученикам группы.")]),
      search,
      list,
    ),
  );
}

/** Where the unit has been given already: "A1 вечер, до чт, 3 декабря" or "Анна (A1 вечер)". */
function givenTo(u: CatalogUnit, dash: Dashboard | undefined, now: Date): string[] {
  const groups = new Map(dash?.groups.map((g) => [g.group_id, g.name]) ?? []);
  return (dash?.homework ?? [])
    .filter((h: HomeworkView) => h.module_id === u.module_id)
    .map((h) => `${h.assignee_name ? `${h.assignee_name} (${groups.get(h.group_id) ?? ""})` : (groups.get(h.group_id) ?? "")}${h.due_at ? `, до ${when(new Date(h.due_at), now)}` : ""}`);
}

function unitCard(u: CatalogUnit, groups: GroupView[], dash: Dashboard | undefined, now: Date, d: CatalogDeps): HTMLElement {
  const given = givenTo(u, dash, now);
  const card = el(
    "section",
    { class: `card catalog-unit${u.episodes.length ? "" : " no-episodes"}`, "data-catalog-unit": u.module_id },
    el("p", { class: "muted" }, [u.cefr_level, SKILLS[u.skill] ?? u.skill].join(" · ")),
    el("h2", {}, u.title.ru),
    el("p", { class: "muted", lang: "en" }, u.title.en),
    ...(u.description ? [el("p", {}, u.description)] : []),
    u.episodes.length
      ? el("ul", { class: "unit-episodes" }, ...u.episodes.map((e) => el("li", {}, `${e.title} · ${e.place} · заданий: ${e.tasks}`)))
      : el("p", { class: "muted" }, "В этом юните пока нет эпизодов Moonbridge: задать его как домашку нельзя."),
    ...(given.length ? [el("p", { class: "muted", "data-given": String(given.length) }, `Уже задан: ${given.join("; ")}`)] : []),
  );
  if (u.episodes.length && groups.length) card.append(assignForm(u, groups, d));
  return card;
}

function assignForm(u: CatalogUnit, groups: GroupView[], d: CatalogDeps): HTMLElement {
  const group = el("select", { class: "answer", name: "group", "aria-label": "Группа" }, ...groups.map((g) => el("option", { value: g.group_id }, g.name))) as HTMLSelectElement;
  let who = assigneeSelect(groups[0]!);
  const whoLabel = el("label", {}, "Кому", who);
  group.addEventListener("change", () => {
    const next = assigneeSelect(groups.find((g) => g.group_id === group.value)!);
    who.replaceWith(next);
    who = next;
  });
  const due = el("input", { class: "answer", type: "datetime-local", name: "due", "aria-label": "Срок" }) as HTMLInputElement;
  const note = el("textarea", { class: "answer", name: "description", rows: "2", maxlength: "4000", "aria-label": "Комментарий для ученика", placeholder: "Например: пройдите до урока, обратите внимание на am/is" }) as HTMLTextAreaElement;
  const auto = el("input", { type: "checkbox", name: "auto_grade" }) as HTMLInputElement;
  const error = el("p", { class: "form-error", role: "alert" });
  const done = el("p", { class: "sheet-ok", hidden: "" });
  const submit = el("button", { class: "primary", type: "submit" }, "Задать") as HTMLButtonElement;
  const form = el(
    "form",
    {
      class: "hw-form",
      "data-form": "assign-unit",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!d.token) return;
        submit.disabled = true;
        error.textContent = "";
        try {
          const { homework } = await d.api.createHomework(d.token, group.value, {
            module_id: u.module_id,
            description: note.value.trim(),
            due_at: due.value ? moscowInputToIso(due.value) : null,
            account_id: who.value || null,
            auto_grade: auto.checked,
          });
          const g = groups.find((x) => x.group_id === group.value)!;
          done.textContent = `Задано: ${homework.assignee_name ?? `вся группа «${g.name}»`}${homework.due_at ? `, до ${when(new Date(homework.due_at), new Date())}` : ""}.`;
          done.hidden = false;
          note.value = "";
        } catch (err) {
          error.textContent = messageOf(err);
        } finally {
          submit.disabled = false;
        }
      },
    },
    el("label", {}, "Группа", group),
    whoLabel,
    el("label", {}, "Срок (по Москве)", due),
    el("label", {}, "Комментарий для ученика", note),
    el("label", { class: "check" }, auto, "Ставить оценку автоматически по результату"),
    error,
    done,
    submit,
  );
  return el("details", { class: "assign-unit" }, el("summary", {}, "Задать как домашку"), form);
}
