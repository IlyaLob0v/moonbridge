import type { ContentBundle, Task } from "../types.js";
import type { ValidatedContent } from "../validate.js";
import {
  CONCEPT_COLS,
  DEFAULT_ERROR_GROUPS,
  EMOTIONS,
  EPISODE_COLS,
  ERROR_COLS,
  errorTypePairs,
  HELP,
  labelOf,
  LEVELS,
  LIST_SEPARATOR,
  OPTION_LETTERS,
  PLACE_COLS,
  SHEETS,
  SKILLS,
  speakerPairs,
  STEP_KINDS,
  TASK_COLS,
  TASK_TYPES,
  TIMES,
  TRANSITIONS,
  UNIT_COLS,
} from "./format.js";
import type { SheetLayout, Workbook } from "./xlsx.js";

/** The bundle back as validated content (the shape the exporter and the importer share). */
export function bundleContent(bundle: ContentBundle): ValidatedContent {
  const sets = new Map<string, Task[]>();
  for (const { module_id, ...task } of Object.values(bundle.tasks)) sets.set(module_id, [...(sets.get(module_id) ?? []), task]);
  return {
    taxonomy: bundle.taxonomy,
    modules: bundle.modules,
    taskSets: bundle.modules.map((m) => ({
      schema_version: "2.0" as const,
      module_id: m.module_id,
      // Pool order first, so the sheet lists tasks the way the unit uses them.
      tasks: [...(sets.get(m.module_id) ?? [])].sort((a, b) => rank(m.tasks, a.task_id) - rank(m.tasks, b.task_id)),
    })),
    courses: bundle.courses,
    ...(bundle.moonbridge ? { moonbridge: bundle.moonbridge } : {}),
  };
}

function rank(list: string[], id: string): number {
  const i = list.indexOf(id);
  return i === -1 ? list.length : i;
}

const short = (unit: string, id: string) => (id.startsWith(`${unit}_`) ? id.slice(unit.length + 1) : id);
const list = (values: string[]) => values.join(LIST_SEPARATOR);

function sheet(cols: string[], rows: string[][]): string[][] {
  return [cols, ...rows.map((r) => cols.map((_, i) => r[i] ?? ""))];
}

/**
 * The content as the teacher's sheet: one row per unit, concept, task, episode step and place, in
 * course order. Importing the result gives the same content back.
 */
export function contentToSheet(content: ValidatedContent): { book: Workbook; layout: Record<string, SheetLayout> } {
  const errorTypes = errorTypePairs(content.taxonomy);
  const characters = content.moonbridge?.characters ?? [];
  const speakers = speakerPairs(characters);
  const course = content.courses[0];
  const order = [...(course?.units ?? []), ...content.modules.map((m) => m.module_id).filter((id) => !course?.units.includes(id))];
  const modules = order.map((id) => content.modules.find((m) => m.module_id === id)).filter((m) => m !== undefined);

  const unitCols = Object.values(UNIT_COLS);
  const units = modules.map((m) => [
    m.module_id,
    m.cefr_level,
    m.title.en,
    m.title.ru,
    m.description?.en ?? "",
    m.description?.ru ?? "",
    labelOf(SKILLS, m.skill),
    m.grammar_topic ?? "",
    m.vocabulary_set ?? "",
    list(m.prerequisites),
    String(m.mastery.check_task_count),
    String(m.mastery.pass_score),
    String(m.version),
  ]);

  const conceptCols = Object.values(CONCEPT_COLS);
  const concepts = modules.flatMap((m) => m.concepts.map((c) => [m.module_id, c.concept_id, c.label, c.explanation_ru ?? ""]));

  const tasks = modules.flatMap((m) => {
    const set = content.taskSets.find((s) => s.module_id === m.module_id)?.tasks ?? [];
    return [...set].sort((a, b) => rank(m.tasks, a.task_id) - rank(m.tasks, b.task_id)).map((t) => ({ unit: m.module_id, task: t }));
  });
  const groups = Math.max(DEFAULT_ERROR_GROUPS, ...tasks.map(({ task }) => task.answer.known_errors?.length ?? 0));
  const taskCols = [...Object.values(TASK_COLS), ...Array.from({ length: groups }, (_, i) => [`${ERROR_COLS.match} ${i + 1}`, `${ERROR_COLS.type} ${i + 1}`, `${ERROR_COLS.feedback} ${i + 1}`]).flat()];
  const taskRows = tasks.map(({ unit, task: t }) => {
    const p = t.presentation;
    const usesOptions = t.type === "choice" || t.type === "translate_en_ru";
    // Options become letters by position; answers follow them.
    const letterOf = new Map((p.options ?? []).map((o, i) => [o.id, OPTION_LETTERS[i] ?? o.id]));
    const tokens = p.tokens ?? [];
    const ref = (a: string): string => {
      if (usesOptions) return letterOf.get(a) ?? a;
      if (t.type === "find_error") {
        const word = tokens[Number(a)];
        return word !== undefined && tokens.filter((x) => x === word).length === 1 ? word : String(Number(a) + 1);
      }
      return a;
    };
    const flag = (v: boolean | undefined) => (v === undefined ? "" : v ? "да" : "нет");
    const row: Record<string, string> = {
      [TASK_COLS.unit]: unit,
      [TASK_COLS.id]: short(unit, t.task_id),
      [TASK_COLS.concept]: t.concept_id,
      [TASK_COLS.type]: labelOf(TASK_TYPES, t.type),
      [TASK_COLS.difficulty]: String(t.difficulty),
      [TASK_COLS.prompt]: p.prompt,
      [TASK_COLS.instruction]: p.instruction_ru ?? "",
      [TASK_COLS.source]: p.source ?? "",
      [TASK_COLS.hint]: p.hint ?? "",
      [TASK_COLS.audio]: p.audio ?? "",
      [TASK_COLS.tokens]: tokens.join(" "),
      [TASK_COLS.accepted]: list(t.answer.accepted.map(ref)),
      [TASK_COLS.correction]: t.answer.correction ?? "",
      [TASK_COLS.caseSensitive]: flag(t.answer.case_sensitive),
      [TASK_COLS.ignoreArticles]: flag(t.answer.ignore_articles),
      [TASK_COLS.timeLimit]: t.time_limit_s === undefined ? "" : String(t.time_limit_s),
      [TASK_COLS.tags]: list(t.tags ?? []),
    };
    (p.options ?? []).forEach((o, i) => {
      const letter = OPTION_LETTERS[i];
      if (letter) row[TASK_COLS[letter]] = o.text;
    });
    (t.answer.known_errors ?? []).forEach((ke, i) => {
      row[`${ERROR_COLS.match} ${i + 1}`] = list(ke.match.map(ref));
      row[`${ERROR_COLS.type} ${i + 1}`] = labelOf(errorTypes, ke.error_type);
      row[`${ERROR_COLS.feedback} ${i + 1}`] = ke.feedback ?? "";
    });
    return taskCols.map((c) => row[c] ?? "");
  });

  const episodeCols = Object.values(EPISODE_COLS);
  const episodes = (content.moonbridge?.episodes ?? [])
    .slice()
    .sort((a, b) => rank(order, a.module_id) - rank(order, b.module_id))
    .flatMap((ep) =>
      ep.steps.map((s, i) => {
        const first = i === 0;
        const row: Record<string, string> = {
          [EPISODE_COLS.id]: first ? ep.episode_id : "",
          [EPISODE_COLS.unit]: first ? ep.module_id : "",
          [EPISODE_COLS.place]: first ? ep.place_id : "",
          [EPISODE_COLS.titleEn]: first ? ep.title.en : "",
          [EPISODE_COLS.titleRu]: first ? ep.title.ru : "",
          [EPISODE_COLS.time]: first && ep.time_of_day ? labelOf(TIMES, ep.time_of_day) : "",
          [EPISODE_COLS.side]: first && ep.side !== undefined ? (ep.side ? "да" : "нет") : "",
          // Generated names stay out of the sheet: the importer gives them back.
          [EPISODE_COLS.step]: s.id === `step_${i + 1}` ? "" : s.id,
          [EPISODE_COLS.kind]: labelOf(STEP_KINDS, s.kind),
        };
        if (s.kind === "line" || s.kind === "task") {
          if (s.speaker) row[EPISODE_COLS.speaker] = labelOf(speakers, s.speaker);
          if (s.emotion) row[EPISODE_COLS.emotion] = labelOf(EMOTIONS, s.emotion);
        }
        if (s.kind === "line") {
          row[EPISODE_COLS.textEn] = s.text.en;
          row[EPISODE_COLS.textRu] = s.text.ru ?? "";
          row[EPISODE_COLS.next] = s.next ?? "";
        }
        if (s.kind === "scene") {
          row[EPISODE_COLS.to] = s.place_id;
          row[EPISODE_COLS.transition] = s.transition ? labelOf(TRANSITIONS, s.transition) : "";
          row[EPISODE_COLS.next] = s.next ?? "";
        }
        if (s.kind === "task") {
          row[EPISODE_COLS.task] = short(ep.module_id, s.task_id);
          row[EPISODE_COLS.onCorrect] = s.on_correct ?? "";
          row[EPISODE_COLS.onWrong] = s.on_wrong ?? "";
        }
        return episodeCols.map((c) => row[c] ?? "");
      }),
    );

  const placeCols = Object.values(PLACE_COLS);
  const places = (content.moonbridge?.places ?? [])
    .slice()
    .sort((a, b) => (a.unlocked_by === null ? -1 : rank(order, a.unlocked_by)) - (b.unlocked_by === null ? -1 : rank(order, b.unlocked_by)))
    .map((p) => [p.place_id, p.name.en, p.name.ru, p.background, p.background_day ?? "", p.building ?? "", p.unlocked_by ?? "", list(p.characters.map((c) => labelOf(speakers, c)))]);

  const lists = [
    ["типы заданий", "типы ошибок", "шаги", "эмоции", "навыки", "кто", "уровни", "время суток", "переходы"],
    ...Array.from({ length: Math.max(TASK_TYPES.length, errorTypes.length, speakers.length) }, (_, i) => [
      TASK_TYPES[i]?.[1] ?? "",
      errorTypes[i]?.[1] ?? "",
      STEP_KINDS[i]?.[1] ?? "",
      EMOTIONS[i]?.[1] ?? "",
      SKILLS[i]?.[1] ?? "",
      speakers[i]?.[1] ?? "",
      LEVELS[i] ?? "",
      TIMES[i]?.[1] ?? "",
      TRANSITIONS[i]?.[1] ?? "",
    ]),
  ];
  const range = (col: string, count: number) => `'${SHEETS.lists}'!$${col}$2:$${col}$${count + 1}`;
  const colOf = (cols: string[], name: string) => cols.indexOf(name);

  const book: Workbook = {
    [SHEETS.help]: HELP.map((line) => [line]),
    [SHEETS.units]: sheet(unitCols, units),
    [SHEETS.concepts]: sheet(conceptCols, concepts),
    [SHEETS.tasks]: sheet(taskCols, taskRows),
    [SHEETS.episodes]: sheet(episodeCols, episodes),
    [SHEETS.places]: sheet(placeCols, places),
    [SHEETS.lists]: lists,
  };
  const layout: Record<string, SheetLayout> = {
    [SHEETS.help]: { widths: [120] },
    [SHEETS.units]: {
      widths: [24, 8, 22, 22, 30, 30, 12, 24, 14, 20, 10, 10, 8],
      lists: [
        { column: colOf(unitCols, UNIT_COLS.skill), range: range("E", SKILLS.length) },
        { column: colOf(unitCols, UNIT_COLS.level), range: range("G", LEVELS.length) },
      ],
    },
    [SHEETS.concepts]: { widths: [24, 24, 30, 50] },
    [SHEETS.tasks]: {
      widths: [24, 18, 22, 18, 9, 36, 28, 28, 16, 16, 18, 18, 18, 18, 24, 32, 14, 8, 8, 8, 12, ...Array.from({ length: groups }, () => [24, 20, 36]).flat()],
      lists: [
        { column: colOf(taskCols, TASK_COLS.type), range: range("A", TASK_TYPES.length) },
        ...Array.from({ length: groups }, (_, i) => ({ column: colOf(taskCols, `${ERROR_COLS.type} ${i + 1}`), range: range("B", errorTypes.length) })),
      ],
    },
    [SHEETS.episodes]: {
      widths: [16, 24, 12, 22, 22, 10, 10, 12, 12, 12, 11, 40, 40, 18, 12, 12, 12, 12, 12],
      lists: [
        { column: colOf(episodeCols, EPISODE_COLS.kind), range: range("C", STEP_KINDS.length) },
        { column: colOf(episodeCols, EPISODE_COLS.emotion), range: range("D", EMOTIONS.length) },
        { column: colOf(episodeCols, EPISODE_COLS.speaker), range: range("F", speakers.length) },
        { column: colOf(episodeCols, EPISODE_COLS.time), range: range("H", TIMES.length) },
        { column: colOf(episodeCols, EPISODE_COLS.transition), range: range("I", TRANSITIONS.length) },
      ],
    },
    [SHEETS.places]: { widths: [14, 18, 18, 26, 26, 26, 24, 24] },
    [SHEETS.lists]: { widths: [24, 40, 14, 12, 14, 14, 8, 12, 12] },
  };
  return { book, layout };
}
