import type { SurveyQuestion } from "@moonbridge/content";
import type { Response } from "@moonbridge/learning";
import { ApiError, type Api, type AssessmentCard, type AssessmentToTake, type GroupAssessment } from "../net/api.js";
import { el } from "../ui/dom.js";
import { askTask } from "../ui/task-panel.js";

// The entry and final tests and the end-of-pilot survey. A test runs task after task with no
// hints and no feedback (the phone has no answers to show), then goes to the gateway at once.
// The teacher opens and closes them on the pilot metrics page and sees the results there.

export interface AssessmentDeps {
  api: Api;
  token: string | undefined;
  navigate: (path: string) => void;
  mediaBase?: string;
}

function messageOf(e: unknown): string {
  return e instanceof ApiError && e.userMessage ? e.userMessage : "Не получилось. Проверьте интернет и попробуйте ещё раз.";
}

/** Today's card: the open tests of the student's groups not taken yet. */
export function assessmentCards(cards: AssessmentCard[] | undefined): HTMLElement[] {
  return (cards ?? [])
    .filter((c) => !c.done)
    .map((c) =>
      el(
        "a",
        { class: "card section-card assessment-card", href: `/test/${c.group_id}/${c.assessment_id}`, "data-link": "", "data-assessment": c.assessment_id },
        el("h2", {}, c.title),
        el("p", {}, c.kind === "test" ? `${c.items} заданий, минут 10. Один раз, без подсказок.` : `${c.items} вопросов, пара минут.`),
        el("span", { class: "card-action" }, "Начать →"),
      ),
    );
}

const page = (root: HTMLElement, ...children: HTMLElement[]) =>
  root.replaceChildren(el("div", { class: "card assessment-page" }, el("header", { class: "section-head" }, el("a", { href: "/", "data-link": "", class: "back" }, "← Сегодня")), ...children));

/** /test/<group>/<id>: the intro, then the test or the survey. */
export async function renderAssessment(root: HTMLElement, groupId: string, id: string, d: AssessmentDeps): Promise<void> {
  if (!d.token) return page(root, el("p", { class: "form-error" }, "Тест проходится только с интернетом."));
  let a: AssessmentToTake;
  try {
    a = (await d.api.assessment(d.token, groupId, id)).assessment;
  } catch (e) {
    return page(root, el("h1", {}, "Тест"), el("p", {}, messageOf(e)));
  }
  const start = el("button", { class: "primary", type: "button", "data-start-test": "" }, "Начать") as HTMLButtonElement;
  page(root, el("h1", {}, a.title), ...(a.intro_ru ? [el("p", {}, a.intro_ru)] : []), start);
  start.addEventListener("click", () => void (a.kind === "test" ? runTest(root, groupId, a, d) : runSurvey(root, groupId, a, d)));
}

async function runTest(root: HTMLElement, groupId: string, a: Extract<AssessmentToTake, { kind: "test" }>, d: AssessmentDeps): Promise<void> {
  const answers: { task_id: string; response: Response }[] = [];
  for (const [i, task] of a.tasks.entries()) {
    const box = el("div", { class: "test-task" });
    root.replaceChildren(el("div", { class: "card assessment-page", "data-test-step": String(i + 1) }, el("p", { class: "muted" }, `${a.title} · ${i + 1} из ${a.tasks.length}`), box));
    const answer = await askTask(box, task, d.mediaBase ? { mediaBase: d.mediaBase } : {});
    answers.push({ task_id: task.task_id, response: answer.response });
  }
  await send(root, groupId, a.assessment_id, answers, d);
}

async function send(root: HTMLElement, groupId: string, id: string, answers: unknown, d: AssessmentDeps): Promise<void> {
  const error = el("p", { class: "form-error", role: "alert" });
  const retry = el("button", { class: "primary", type: "button" }, "Отправить ещё раз") as HTMLButtonElement;
  const go = async () => {
    retry.disabled = true;
    error.textContent = "";
    try {
      await d.api.submitAssessment(d.token!, groupId, id, answers);
      page(root, el("h1", { "data-test-done": "" }, "Готово!"), el("p", {}, "Ответы отправлены преподавателю. Спасибо!"), el("button", { class: "primary", type: "button", onclick: () => d.navigate("/") }, "На главную"));
    } catch (e) {
      error.textContent = messageOf(e);
      retry.disabled = false;
      page(root, el("h1", {}, "Не отправилось"), error, retry);
    }
  };
  retry.addEventListener("click", () => void go());
  page(root, el("p", {}, "Отправляем…"));
  await go();
}

function question(q: SurveyQuestion): { node: HTMLElement; value: () => string | number | undefined } {
  if (q.kind === "text") {
    const area = el("textarea", { class: "answer", rows: "3", maxlength: "2000", name: q.id }) as HTMLTextAreaElement;
    return { node: el("label", { class: "survey-q", "data-question": q.id }, q.text, area), value: () => area.value.trim() || undefined };
  }
  const options = q.kind === "scale" ? ["1", "2", "3", "4", "5"] : (q.options ?? []);
  const inputs = options.map((o) => el("input", { type: "radio", name: q.id, value: o }) as HTMLInputElement);
  return {
    node: el(
      "fieldset",
      { class: `survey-q ${q.kind}`, "data-question": q.id },
      el("legend", {}, q.text),
      ...inputs.map((input, i) => el("label", { class: q.kind === "scale" ? "scale-option" : "check" }, input, options[i]!)),
    ),
    value: () => {
      const v = inputs.find((x) => x.checked)?.value;
      return v === undefined ? undefined : q.kind === "scale" ? Number(v) : v;
    },
  };
}

function runSurvey(root: HTMLElement, groupId: string, a: Extract<AssessmentToTake, { kind: "survey" }>, d: AssessmentDeps): void {
  const qs = a.questions.map((q) => ({ q, ...question(q) }));
  const error = el("p", { class: "form-error", role: "alert" });
  const form = el(
    "form",
    {
      class: "survey",
      "data-form": "survey",
      onsubmit: (e: Event) => {
        e.preventDefault();
        const missing = qs.find((x) => !x.q.optional && x.value() === undefined);
        if (missing) {
          error.textContent = `Ответьте на вопрос: «${missing.q.text}»`;
          missing.node.scrollIntoView({ block: "center" });
          return;
        }
        const answers = Object.fromEntries(qs.map((x) => [x.q.id, x.value()]).filter(([, v]) => v !== undefined));
        void send(root, groupId, a.assessment_id, answers, d);
      },
    },
    ...qs.map((x) => x.node),
    error,
    el("button", { class: "primary", type: "submit" }, "Отправить"),
  );
  page(root, el("h1", {}, a.title), form);
}

/** The teacher's block on the pilot metrics page: open or close each test, the scores side by side, the survey's answers. */
export async function assessmentsSection(groupId: string, d: { api: Api; token: string; rerender: () => void }): Promise<HTMLElement | undefined> {
  const list = await d.api.groupAssessments(d.token, groupId).then(
    (r) => r.assessments,
    () => undefined,
  );
  if (!list?.length) return undefined;
  const byId = new Map(list.map((a) => [a.assessment_id, a]));
  const toggle = (a: GroupAssessment) => {
    const open = a.state === "open";
    const b = el("button", { type: "button", class: open ? "" : "primary", "data-assessment-toggle": a.assessment_id }, open ? "Закрыть" : a.state === "closed" ? "Открыть снова" : "Открыть группе") as HTMLButtonElement;
    b.addEventListener("click", async () => {
      b.disabled = true;
      await d.api.setAssessment(d.token, groupId, a.assessment_id, open ? "close" : "open").catch(() => undefined);
      d.rerender();
    });
    return b;
  };
  const stateText = (a: GroupAssessment) => {
    const done = a.results.filter((r) => r.result).length;
    return `${a.state === "open" ? "открыт" : a.state === "closed" ? "закрыт" : "не открыт"} · прошли ${done} из ${a.results.length}`;
  };
  const score = (r: GroupAssessment["results"][number] | undefined) => (r?.result?.score ? `${r.result.score.right} из ${r.result.score.total}` : "—");

  const tests = list.filter((a) => a.kind === "test");
  // A pair (entry ↔ final) shows once, the entry first.
  const shown = new Set<string>();
  const testBlocks = tests.flatMap((a) => {
    if (shown.has(a.assessment_id)) return [];
    const pair = a.pair ? byId.get(a.pair) : undefined;
    shown.add(a.assessment_id);
    if (pair) shown.add(pair.assessment_id);
    const both = pair ? [a, pair] : [a];
    return [
      el(
        "div",
        { class: "assessment-block", "data-assessment-block": a.assessment_id },
        ...both.map((x) => el("div", { class: "assessment-row" }, el("b", {}, x.title), el("span", { class: "muted" }, stateText(x)), toggle(x))),
        el(
          "table",
          { class: "metrics-table" },
          el("thead", {}, el("tr", {}, el("th", {}, "Ученик"), ...both.map((x) => el("th", {}, x.title)))),
          el("tbody", {}, ...a.results.map((r) => el("tr", { "data-student": r.id }, el("td", {}, r.name), ...both.map((x) => el("td", {}, score(x.results.find((y) => y.id === r.id))))))),
        ),
      ),
    ];
  });
  const surveys = list.filter((a) => a.kind === "survey").map((a) =>
    el(
      "div",
      { class: "assessment-block", "data-assessment-block": a.assessment_id },
      el("div", { class: "assessment-row" }, el("b", {}, a.title), el("span", { class: "muted" }, stateText(a)), toggle(a)),
      ...a.results
        .filter((r) => r.result)
        .map((r) => {
          const answers = (r.result!.answers ?? {}) as Record<string, string | number>;
          return el(
            "details",
            { class: "survey-answers", "data-survey-of": r.id },
            el("summary", {}, r.name),
            el("dl", {}, ...(a.questions ?? []).flatMap((q) => (answers[q.id] === undefined ? [] : [el("dt", {}, q.text), el("dd", {}, String(answers[q.id]))]))),
          );
        }),
    ),
  );
  return el(
    "section",
    { class: "card assessments", "data-assessments": "" },
    el("h2", {}, "Тесты и анкета"),
    el("p", { class: "muted" }, "Входной тест откройте в начале пилота, итоговый и анкету в конце. Ученик проходит каждый один раз, ответы и баллы видите только вы."),
    ...testBlocks,
    ...surveys,
  );
}
