import type { Character, ContentSource, Course, Episode, EpisodeStep, ErrorTaxonomy, KnownError, Module, Place, Task, TaskSet } from "../types.js";
import { validateContent, type Issue, type ValidatedContent } from "../validate.js";
import {
  CONCEPT_COLS,
  EMOTIONS,
  EPISODE_COLS,
  ERROR_COLS,
  errorTypePairs,
  key,
  LEVELS,
  lookup,
  OPTION_LETTERS,
  PLACE_COLS,
  SHEETS,
  SKILLS,
  speakerPairs,
  splitList,
  STEP_KINDS,
  TASK_COLS,
  TASK_TYPES,
  TIMES,
  TRANSITIONS,
  UNIT_COLS,
} from "./format.js";
import type { Workbook } from "./xlsx.js";

/** What the sheet holds: the course's units with their tasks, and Moonbridge episodes and places. */
export interface SheetContent {
  /** Unit ids in course order. */
  units: string[];
  modules: Module[];
  taskSets: TaskSet[];
  episodes: Episode[];
  places: Place[];
}

export interface SheetIssue {
  severity: "error" | "warning";
  /** "Задания, строка 12" or a sheet name. */
  where: string;
  message: string;
}

export interface SheetCheck {
  ok: boolean;
  issues: SheetIssue[];
  sheet?: SheetContent;
  /** Present when ok: the full content (the sheet over the repository's base), ready for buildBundle. */
  content?: ValidatedContent;
}

const UNIT_ID = /^(A1|A2|B1|B2|C1|C2)_[A-Za-z0-9]+_[0-9]{2}$/;
const LEVEL_PREFIX = /^(A1|A2|B1|B2|C1|C2)_/;

interface Row {
  n: number;
  get(col: string): string;
}

/** A sheet as rows addressed by header; tells about missing and unknown columns. */
function table(book: Workbook, sheet: string, required: string[], known: (header: string) => boolean, issues: SheetIssue[]): Row[] | undefined {
  const rows = Object.entries(book).find(([name]) => key(name) === key(sheet))?.[1];
  if (!rows) {
    issues.push({ severity: "error", where: sheet, message: `в таблице нет листа «${sheet}»` });
    return undefined;
  }
  const header = (rows[0] ?? []).map(key);
  const missing = required.filter((h) => !header.includes(key(h)));
  if (missing.length) {
    issues.push({ severity: "error", where: sheet, message: `нет колонок: ${missing.map((m) => `«${m}»`).join(", ")}` });
    return undefined;
  }
  const unknown = (rows[0] ?? []).filter((h) => h.trim() && !known(key(h)));
  if (unknown.length) issues.push({ severity: "warning", where: sheet, message: `колонки не используются: ${unknown.map((u) => `«${u}»`).join(", ")}` });
  const index = new Map(header.map((h, i) => [h, i]));
  return rows
    .slice(1)
    .map((cells, i) => ({
      n: i + 2,
      cells,
      get: (col: string) => {
        const at = index.get(key(col));
        return at === undefined ? "" : (cells[at] ?? "").trim();
      },
    }))
    .filter((r) => r.cells.some((c) => c.trim() !== ""));
}

const knownIn = (cols: Record<string, string>) => {
  const set = new Set(Object.values(cols).map(key));
  return (h: string) => set.has(h);
};

function yes(cell: string): boolean | undefined {
  const k = key(cell);
  if (!k) return undefined;
  if (["да", "yes", "true", "1", "+", "истина"].includes(k)) return true;
  if (["нет", "no", "false", "0", "-", "ложь"].includes(k)) return false;
  return undefined;
}

/** "0.8", "0,8", "80%", "80" → 0.8 */
function share(cell: string): number | undefined {
  const n = Number(cell.replace("%", "").replace(",", ".").trim());
  if (!cell.trim() || !Number.isFinite(n)) return undefined;
  return n > 1 ? n / 100 : n;
}

function integer(cell: string): number | undefined {
  const n = Number(cell.replace(",", ".").trim());
  return cell.trim() && Number.isInteger(n) ? n : undefined;
}

/** Short ids get the unit's prefix: "hello" in unit A1_Hello_01 → "A1_Hello_01_hello". */
function withUnit(unit: string, id: string): string {
  return LEVEL_PREFIX.test(id) ? id : `${unit}_${id}`;
}

/** Order-words tokens from the answer when the sheet leaves them out: shuffled the same way every time, never in answer order. */
export function shuffledTokens(answer: string, seed: string): string[] {
  const words = answer.replace(/[.!?]+$/, "").split(/\s+/).filter(Boolean);
  const score = (w: string, i: number) => {
    let h = 2166136261;
    for (const ch of `${seed}:${w}:${i}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return h >>> 0;
  };
  const out = words.map((w, i) => ({ w, s: score(w, i) })).sort((a, b) => a.s - b.s).map((x) => x.w);
  if (out.length > 1 && out.join(" ") === words.join(" ")) out.push(out.shift()!);
  return out;
}

/** Reads the sheet into content. Row-level problems come back in Russian with the sheet and row. */
export function readSheet(book: Workbook, base: { taxonomy: ErrorTaxonomy; characters: Character[] }): { sheet?: SheetContent; issues: SheetIssue[]; locate: Map<string, string> } {
  const issues: SheetIssue[] = [];
  const locate = new Map<string, string>();
  const at = (sheet: string, row: Row) => `${sheet}, строка ${row.n}`;
  const err = (where: string, message: string) => issues.push({ severity: "error", where, message });
  const warn = (where: string, message: string) => issues.push({ severity: "warning", where, message });
  const errorTypes = errorTypePairs(base.taxonomy);
  const speakers = speakerPairs(base.characters);

  // ---------- Units
  const units = table(book, SHEETS.units, [UNIT_COLS.id, UNIT_COLS.titleEn, UNIT_COLS.titleRu], knownIn(UNIT_COLS), issues);
  const concepts = table(book, SHEETS.concepts, [CONCEPT_COLS.unit, CONCEPT_COLS.id, CONCEPT_COLS.label], knownIn(CONCEPT_COLS), issues);
  const errorHeader = (h: string) => new RegExp(`^(${key(ERROR_COLS.match)}|${key(ERROR_COLS.type)}|${key(ERROR_COLS.feedback)}) [0-9]+$`).test(h);
  const tasks = table(book, SHEETS.tasks, [TASK_COLS.unit, TASK_COLS.id, TASK_COLS.concept, TASK_COLS.type, TASK_COLS.prompt, TASK_COLS.accepted], (h) => knownIn(TASK_COLS)(h) || errorHeader(h), issues);
  const episodes = table(book, SHEETS.episodes, [EPISODE_COLS.id, EPISODE_COLS.kind], knownIn(EPISODE_COLS), issues);
  const places = table(book, SHEETS.places, [PLACE_COLS.id, PLACE_COLS.nameEn, PLACE_COLS.nameRu, PLACE_COLS.unlockedBy], knownIn(PLACE_COLS), issues);
  if (!units || !concepts || !tasks || !episodes || !places) return { issues, locate };

  const modules = new Map<string, Module>();
  for (const row of units) {
    const where = at(SHEETS.units, row);
    const id = row.get(UNIT_COLS.id);
    if (!UNIT_ID.test(id)) {
      err(where, `id юнита «${id}» не подходит: нужен вид A1_NiceToMeetYou_01 (уровень, название латиницей без пробелов, номер из двух цифр)`);
      continue;
    }
    if (modules.has(id)) {
      err(where, `юнит ${id} уже есть выше`);
      continue;
    }
    locate.set(`${SHEETS.units} › ${id}`, where);
    const level = (row.get(UNIT_COLS.level) || id.slice(0, 2)).toUpperCase();
    if (!(LEVELS as readonly string[]).includes(level)) err(where, `уровень «${level}» не знаком, нужен один из ${LEVELS.join(", ")}`);
    const skillCell = row.get(UNIT_COLS.skill);
    const skill = skillCell ? lookup(SKILLS, skillCell) : "grammar";
    if (!skill) err(where, `навык «${skillCell}» не знаком, нужен один из: ${SKILLS.map(([, l]) => l).join(", ")}`);
    const pass = row.get(UNIT_COLS.pass) ? share(row.get(UNIT_COLS.pass)) : 0.8;
    if (pass === undefined || pass <= 0 || pass > 1) err(where, `порог проверки «${row.get(UNIT_COLS.pass)}» не число от 0 до 1 (или процент)`);
    const check = row.get(UNIT_COLS.check) ? integer(row.get(UNIT_COLS.check)) : undefined;
    if (row.get(UNIT_COLS.check) && (check === undefined || check < 1)) err(where, `заданий в проверке «${row.get(UNIT_COLS.check)}» должно быть целым числом больше нуля`);
    const version = row.get(UNIT_COLS.version) ? integer(row.get(UNIT_COLS.version)) : 1;
    if (version === undefined || version < 1) err(where, `версия «${row.get(UNIT_COLS.version)}» должна быть целым числом от 1`);
    const descEn = row.get(UNIT_COLS.descEn);
    const descRu = row.get(UNIT_COLS.descRu);
    modules.set(id, {
      schema_version: "2.0",
      module_id: id,
      version: version ?? 1,
      cefr_level: level as Module["cefr_level"],
      title: { en: row.get(UNIT_COLS.titleEn), ru: row.get(UNIT_COLS.titleRu) },
      ...(descEn || descRu ? { description: { en: descEn || descRu, ru: descRu || descEn } } : {}),
      skill: skill ?? "grammar",
      ...(row.get(UNIT_COLS.grammar) ? { grammar_topic: row.get(UNIT_COLS.grammar) } : {}),
      ...(row.get(UNIT_COLS.vocabulary) ? { vocabulary_set: row.get(UNIT_COLS.vocabulary) } : {}),
      prerequisites: splitList(row.get(UNIT_COLS.prerequisites).replace(/,/g, "|")),
      concepts: [],
      // A missing count is filled in below, once the unit's tasks are known.
      mastery: { check_task_count: check ?? 0, pass_score: pass ?? 0.8 },
      tasks: [],
    });
    if (!row.get(UNIT_COLS.titleEn) || !row.get(UNIT_COLS.titleRu)) err(where, "нужно название на обоих языках");
  }
  const unitOf = (where: string, cell: string): Module | undefined => {
    const m = modules.get(cell);
    if (!m) err(where, cell ? `юнита ${cell} нет на листе «${SHEETS.units}»` : "не указан юнит");
    return m;
  };

  // ---------- Concepts
  for (const row of concepts) {
    const where = at(SHEETS.concepts, row);
    const m = unitOf(where, row.get(CONCEPT_COLS.unit));
    if (!m) continue;
    const id = row.get(CONCEPT_COLS.id);
    const explanation = row.get(CONCEPT_COLS.explanation);
    m.concepts.push({ concept_id: id, label: row.get(CONCEPT_COLS.label), ...(explanation ? { explanation_ru: explanation } : {}) });
  }

  // ---------- Tasks
  const taskSets = new Map<string, TaskSet>();
  const groups = new Set<number>();
  for (const name of Object.entries(book).find(([n]) => key(n) === key(SHEETS.tasks))![1][0] ?? []) {
    const m = new RegExp(`^${key(ERROR_COLS.match)} ([0-9]+)$`).exec(key(name));
    if (m) groups.add(Number(m[1]));
  }
  for (const row of tasks) {
    const where = at(SHEETS.tasks, row);
    const m = unitOf(where, row.get(TASK_COLS.unit));
    if (!m) continue;
    const shortId = row.get(TASK_COLS.id);
    if (!shortId) {
      err(where, "не указан id задания: напишите коротко латиницей, например hello");
      continue;
    }
    const id = withUnit(m.module_id, shortId);
    if (!/^[A-Za-z0-9_]+$/.test(shortId)) err(where, `id задания «${shortId}» — только латиница, цифры и _, без пробелов`);
    locate.set(`${SHEETS.tasks} › ${id}`, where);
    const typeCell = row.get(TASK_COLS.type);
    const type = lookup(TASK_TYPES, typeCell);
    if (!type) {
      err(where, `тип «${typeCell}» не знаком, нужен один из: ${TASK_TYPES.map(([, l]) => l).join(", ")}`);
      continue;
    }
    const difficulty = row.get(TASK_COLS.difficulty) ? integer(row.get(TASK_COLS.difficulty)) : 1;
    if (difficulty === undefined || difficulty < 1 || difficulty > 5) err(where, `сложность «${row.get(TASK_COLS.difficulty)}» — целое число от 1 до 5`);

    const options = OPTION_LETTERS.map((letter) => ({ id: letter, text: row.get(TASK_COLS[letter]) })).filter((o) => o.text);
    const usesOptions = type === "choice" || type === "translate_en_ru";
    const tokenCell = row.get(TASK_COLS.tokens);
    let accepted = splitList(row.get(TASK_COLS.accepted));
    if (!accepted.length) err(where, "нет верного ответа");
    let tokens: string[] | undefined = tokenCell ? tokenCell.split(/\s+/).filter(Boolean) : undefined;
    if (type === "order_words" && !tokens && accepted[0]) tokens = shuffledTokens(accepted[0], id);
    if (type === "find_error" && !tokens) err(where, "для «найди ошибку» нужна фраза в колонке «слова»");

    // Answers by letter for options, by word or number for find_error.
    const answerRef = (a: string): string => {
      if (usesOptions) {
        const letter = a.toLowerCase().replace(/[).]$/, "");
        if (!options.some((o) => o.id === letter)) {
          const byText = options.find((o) => key(o.text) === key(a));
          if (byText) return byText.id;
          err(where, `ответ «${a}» должен быть буквой заполненного варианта (${options.map((o) => o.id).join(", ") || "варианты не заполнены"})`);
        }
        return letter;
      }
      if (type === "find_error" && tokens) {
        if (/^[0-9]+$/.test(a)) {
          const n = Number(a);
          if (n < 1 || n > tokens.length) err(where, `слова номер ${a} нет: во фразе ${tokens.length} слов`);
          return String(n - 1);
        }
        const hits = tokens.flatMap((t, i) => (key(t) === key(a) ? [i] : []));
        if (hits.length === 1) return String(hits[0]);
        err(where, hits.length ? `слово «${a}» встречается во фразе несколько раз: укажите его номер` : `слова «${a}» нет во фразе`);
        return a;
      }
      return a;
    };
    accepted = accepted.map(answerRef);

    const known: KnownError[] = [];
    for (const g of [...groups].sort((a, b) => a - b)) {
      const match = splitList(row.get(`${ERROR_COLS.match} ${g}`));
      const typeText = row.get(`${ERROR_COLS.type} ${g}`);
      const feedback = row.get(`${ERROR_COLS.feedback} ${g}`);
      if (!match.length && !typeText && !feedback) continue;
      if (!match.length) {
        err(where, `в «${ERROR_COLS.type} ${g}» или «${ERROR_COLS.feedback} ${g}» что-то есть, а сама «${ERROR_COLS.match} ${g}» пустая`);
        continue;
      }
      const errorType = typeText ? lookup(errorTypes, typeText) : "unclassified";
      if (!errorType) err(where, `тип ошибки «${typeText}» не знаком: выберите из листа «${SHEETS.lists}»`);
      known.push({ match: match.map(answerRef), error_type: errorType ?? "unclassified", ...(feedback ? { feedback } : {}) });
    }

    const text = (col: string) => row.get(col) || undefined;
    const time = row.get(TASK_COLS.timeLimit) ? integer(row.get(TASK_COLS.timeLimit)) : undefined;
    if (row.get(TASK_COLS.timeLimit) && time === undefined) err(where, `время «${row.get(TASK_COLS.timeLimit)}» — целое число секунд`);
    const caseSensitive = yes(row.get(TASK_COLS.caseSensitive));
    const ignoreArticles = yes(row.get(TASK_COLS.ignoreArticles));
    const tags = splitList(row.get(TASK_COLS.tags).replace(/,/g, "|"));
    const correction = text(TASK_COLS.correction);
    const presentation: Task["presentation"] = { prompt: row.get(TASK_COLS.prompt) };
    if (text(TASK_COLS.instruction)) presentation.instruction_ru = text(TASK_COLS.instruction)!;
    if (text(TASK_COLS.hint)) presentation.hint = text(TASK_COLS.hint)!;
    if (text(TASK_COLS.source)) presentation.source = text(TASK_COLS.source)!;
    if (text(TASK_COLS.audio)) presentation.audio = text(TASK_COLS.audio)!;
    if (usesOptions) presentation.options = options;
    else if (options.length) warn(where, `варианты a–d используются только в типах «выбор» и «перевод EN→RU»`);
    if (tokens && (type === "order_words" || type === "find_error")) presentation.tokens = tokens;
    const task: Task = {
      task_id: id,
      concept_id: row.get(TASK_COLS.concept),
      type,
      difficulty: difficulty ?? 1,
      presentation,
      answer: {
        accepted,
        ...(caseSensitive !== undefined ? { case_sensitive: caseSensitive } : {}),
        ...(ignoreArticles !== undefined ? { ignore_articles: ignoreArticles } : {}),
        ...(correction ? { correction } : {}),
        ...(known.length ? { known_errors: known } : {}),
      },
      ...(time !== undefined ? { time_limit_s: time } : {}),
      ...(tags.length ? { tags } : {}),
    };
    const set = taskSets.get(m.module_id) ?? { schema_version: "2.0" as const, module_id: m.module_id, tasks: [] };
    if (set.tasks.some((t) => t.task_id === id)) err(where, `задание ${shortId} уже есть в этом юните выше`);
    set.tasks.push(task);
    taskSets.set(m.module_id, set);
    m.tasks.push(id);
  }
  for (const m of modules.values()) {
    if (!m.mastery.check_task_count) m.mastery.check_task_count = Math.max(1, Math.min(6, m.tasks.length));
    if (!m.tasks.length) err(locate.get(`${SHEETS.units} › ${m.module_id}`)!, `у юнита ${m.module_id} нет заданий на листе «${SHEETS.tasks}»`);
    if (!m.concepts.length) err(locate.get(`${SHEETS.units} › ${m.module_id}`)!, `у юнита ${m.module_id} нет понятий на листе «${SHEETS.concepts}»`);
  }

  // ---------- Places
  const placeList: Place[] = [];
  for (const row of places) {
    const where = at(SHEETS.places, row);
    const id = row.get(PLACE_COLS.id);
    locate.set(`${SHEETS.places} › ${id}`, where);
    const unlock = row.get(PLACE_COLS.unlockedBy);
    const residents = splitList(row.get(PLACE_COLS.characters).replace(/,/g, "|")).map((c) => {
      const found = lookup(speakers, c);
      if (!found || found === "narrator" || found === "player") err(where, `жителя «${c}» нет среди персонажей: ${base.characters.map((ch) => ch.name).join(", ")}`);
      return found ?? c;
    });
    placeList.push({
      place_id: id,
      name: { en: row.get(PLACE_COLS.nameEn), ru: row.get(PLACE_COLS.nameRu) },
      background: row.get(PLACE_COLS.background) || `places/${id}.png`,
      ...(row.get(PLACE_COLS.backgroundDay) ? { background_day: row.get(PLACE_COLS.backgroundDay) } : {}),
      unlocked_by: unlock && !["сразу", "-", "нет"].includes(key(unlock)) ? unlock : null,
      characters: residents,
    });
  }

  // ---------- Episodes: one row per step; an empty episode cell continues the episode above.
  const eps: { ep: Episode; where: string; rows: Row[] }[] = [];
  let current: (typeof eps)[number] | undefined;
  for (const row of episodes) {
    const where = at(SHEETS.episodes, row);
    const idCell = row.get(EPISODE_COLS.id);
    if (idCell && (!current || idCell !== current.rows[0]!.get(EPISODE_COLS.id))) {
      current = { ep: { schema_version: "2.0", episode_id: idCell, module_id: "", place_id: "", title: { en: "", ru: "" }, steps: [] }, where, rows: [] };
      eps.push(current);
    }
    if (!current) {
      err(where, "не указан эпизод");
      continue;
    }
    current.rows.push(row);
  }
  const episodeList: Episode[] = [];
  for (const { ep, where, rows } of eps) {
    const pick = (col: string) => {
      const values = [...new Set(rows.map((r) => r.get(col)).filter(Boolean))];
      if (values.length > 1) err(where, `у эпизода ${ep.episode_id} разные значения в колонке «${col}»: ${values.join(", ")}`);
      return values[0] ?? "";
    };
    const unit = pick(EPISODE_COLS.unit);
    const m = unitOf(where, unit);
    if (!m) continue;
    ep.module_id = m.module_id;
    ep.place_id = pick(EPISODE_COLS.place);
    ep.title = { en: pick(EPISODE_COLS.titleEn), ru: pick(EPISODE_COLS.titleRu) };
    const timeCell = pick(EPISODE_COLS.time);
    const time = timeCell ? lookup(TIMES, timeCell) : undefined;
    if (timeCell && !time) err(where, `время суток «${timeCell}» не знакомо, нужно: ${TIMES.map(([, l]) => l).join(" или ")}`);
    if (time) ep.time_of_day = time;
    const side = yes(pick(EPISODE_COLS.side));
    if (side !== undefined) ep.side = side;
    if (!ep.place_id) err(where, `у эпизода ${ep.episode_id} не указано место`);
    if (!ep.title.en || !ep.title.ru) err(where, `у эпизода ${ep.episode_id} нужно название на обоих языках`);
    if (!/^[A-Za-z0-9_]+$/.test(ep.episode_id)) err(where, `id эпизода «${ep.episode_id}» — только латиница, цифры и _`);
    const path = `${SHEETS.episodes} › ${ep.episode_id}`;
    locate.set(path, where);
    rows.forEach((row, i) => {
      const rowWhere = at(SHEETS.episodes, row);
      const id = row.get(EPISODE_COLS.step) || `step_${i + 1}`;
      locate.set(`${path} › ${id}`, rowWhere);
      const kindCell = row.get(EPISODE_COLS.kind);
      const kind = kindCell ? lookup(STEP_KINDS, kindCell) : row.get(EPISODE_COLS.task) ? "task" : row.get(EPISODE_COLS.textEn) ? "line" : undefined;
      if (!kind) {
        err(rowWhere, kindCell ? `«${kindCell}» не знаком, нужно: ${STEP_KINDS.map(([, l]) => l).join(", ")}` : "непонятно, что это за шаг: заполните «что»");
        return;
      }
      const speakerCell = row.get(EPISODE_COLS.speaker);
      const speaker = speakerCell ? lookup(speakers, speakerCell) : undefined;
      if (speakerCell && !speaker) err(rowWhere, `«${speakerCell}» нет среди персонажей: ${base.characters.map((c) => c.name).join(", ")}, рассказчик, игрок`);
      const emotionCell = row.get(EPISODE_COLS.emotion);
      const emotion = emotionCell ? lookup(EMOTIONS, emotionCell) : undefined;
      if (emotionCell && !emotion) err(rowWhere, `эмоция «${emotionCell}» не знакома, нужно: ${EMOTIONS.map(([, l]) => l).join(", ")}`);
      const opt = (col: string) => row.get(col) || undefined;
      let step: EpisodeStep;
      if (kind === "end") step = { id, kind };
      else if (kind === "scene") {
        const to = row.get(EPISODE_COLS.to);
        if (!to) err(rowWhere, "у смены места не указано, куда (колонка «куда»)");
        const transitionCell = row.get(EPISODE_COLS.transition);
        const transition = transitionCell ? lookup(TRANSITIONS, transitionCell) : undefined;
        if (transitionCell && !transition) err(rowWhere, `переход «${transitionCell}» не знаком, нужно: ${TRANSITIONS.map(([, l]) => l).join(", ")}`);
        step = { id, kind, place_id: to, ...(transition ? { transition } : {}), ...(opt(EPISODE_COLS.next) ? { next: opt(EPISODE_COLS.next)! } : {}) };
      }
      else if (kind === "line") {
        if (!speaker) err(rowWhere, "у реплики не указано, кто говорит");
        if (!row.get(EPISODE_COLS.textEn)) err(rowWhere, "у реплики нет текста EN");
        const ru = opt(EPISODE_COLS.textRu);
        step = {
          id,
          kind,
          speaker: speaker ?? "narrator",
          ...(emotion ? { emotion } : {}),
          text: { en: row.get(EPISODE_COLS.textEn), ...(ru ? { ru } : {}) },
          ...(opt(EPISODE_COLS.next) ? { next: opt(EPISODE_COLS.next)! } : {}),
        };
      } else {
        const taskCell = row.get(EPISODE_COLS.task);
        if (!taskCell) err(rowWhere, "у шага-задания не указано задание");
        step = {
          id,
          kind,
          task_id: withUnit(m.module_id, taskCell),
          ...(speaker ? { speaker } : {}),
          ...(emotion ? { emotion } : {}),
          ...(opt(EPISODE_COLS.onCorrect) ? { on_correct: opt(EPISODE_COLS.onCorrect)! } : {}),
          ...(opt(EPISODE_COLS.onWrong) ? { on_wrong: opt(EPISODE_COLS.onWrong)! } : {}),
        };
      }
      ep.steps.push(step);
    });
    // Steps last, as in the hand-written files.
    const { steps, ...head } = ep;
    episodeList.push({ ...head, steps });
  }

  if (issues.some((i) => i.severity === "error")) return { issues, locate };
  return {
    sheet: { units: [...modules.keys()], modules: [...modules.values()], taskSets: [...taskSets.values()], episodes: episodeList, places: placeList },
    issues,
    locate,
  };
}

/** The repository's content with the sheet's parts swapped in: units, tasks, episodes, places and the course's unit order. */
export function withSheet(base: ContentSource, sheet: SheetContent): ContentSource {
  const [course, ...otherCourses] = base.courses;
  const courseFile = course
    ? [{ path: SHEETS.units, data: { ...(course.data as Course), units: sheet.units } }, ...otherCourses]
    : [];
  return {
    ...base,
    modules: sheet.modules.map((m) => ({ path: `${SHEETS.units} › ${m.module_id}`, data: m })),
    taskSets: sheet.taskSets.map((s) => ({ path: SHEETS.tasks, data: s })),
    courses: courseFile,
    places: [{ path: SHEETS.places, data: { schema_version: "2.0", places: sheet.places } }],
    episodes: sheet.episodes.map((e) => ({ path: `${SHEETS.episodes} › ${e.episode_id}`, data: e })),
  };
}

/**
 * A unit whose content changed gets its version raised past the live one, unless the sheet already did:
 * the version goes into every xAPI statement, so answers to the old and new wording stay apart.
 */
export function bumpVersions(sheet: SheetContent, live: { modules: Module[]; tasks: Task[] }): void {
  // Key order and the "$schema" of hand-written files are not content.
  const plain = (v: object) =>
    JSON.stringify(v, (k, x: unknown) =>
      k === "$schema" ? undefined : x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x,
    );
  const fingerprint = (m: Module, tasks: Task[]) => plain([{ ...m, version: 0 }, tasks.filter((t) => m.tasks.includes(t.task_id))]);
  for (const m of sheet.modules) {
    const before = live.modules.find((x) => x.module_id === m.module_id);
    if (!before || m.version > before.version) continue;
    const tasks = sheet.taskSets.find((s) => s.module_id === m.module_id)?.tasks ?? [];
    if (fingerprint(m, tasks) !== fingerprint(before, live.tasks)) m.version = before.version + 1;
    else m.version = before.version;
  }
}

/** Plain-Russian hints for the validator's checks, shown under its message. */
const HINTS: Record<string, string> = {
  schema: "значение не подходит по формату",
  "ref.concept": `такого понятия у юнита нет на листе «${SHEETS.concepts}»`,
  "ref.module": "такого юнита нет",
  "ref.place": `такого места нет на листе «${SHEETS.places}»`,
  "ref.task": "такого задания нет в юните этого эпизода",
  "ref.step": "шага с таким именем в эпизоде нет",
  "ref.character": "такого персонажа нет",
  "ref.emotion": "у персонажа нет портрета с этой эмоцией",
  "ref.error_type": "такого типа ошибки нет в справочнике",
  "answer.conflict": "один и тот же ответ записан и верным, и ошибкой",
  "answer.tokens": "верный ответ нельзя собрать из этих слов",
  "answer.token_ref": "номер слова вне фразы",
  "answer.untagged_option": "у неверного варианта не указана ошибка: ученик получит «не классифицировано»",
  "presentation.gap": "в тексте пропуска нет ___",
  "mastery.pool": "в юните меньше заданий, чем нужно для итоговой проверки",
  "concept.no_tasks": "на понятие нет ни одного задания",
  "order.prerequisites": "юнит стоит раньше юнита, который для него нужен",
  "order.place": "место открывается позже эпизода, который в нём идёт",
  "duplicate.unlock": "один юнит открывает два места",
  "duplicate.concept_id": "понятие с таким id уже есть в другом юните",
  "duplicate.task_id": "задание с таким id уже есть",
  "duplicate.step_id": "два шага с одним именем",
  "step.dangling": "после последнего шага нет конца: добавьте «конец» или укажите, куда идти",
  "step.unreachable": "до этого шага нельзя дойти с начала эпизода",
  "step.no_end": "из этого шага нельзя дойти до конца эпизода",
  "speaker.elsewhere": "персонаж не живёт в этом месте",
  "episode.no_tasks": "в эпизоде нет заданий",
};

/** Puts a validator issue into the sheet's words: the row it came from and a Russian hint. */
export function sheetIssue(issue: Issue, locate: Map<string, string>): SheetIssue {
  let where = issue.file;
  for (let path = issue.file; path; path = path.includes(" › ") ? path.slice(0, path.lastIndexOf(" › ")) : "") {
    const hit = locate.get(path);
    if (hit) {
      where = hit;
      break;
    }
  }
  const hint = HINTS[issue.code];
  return { severity: issue.severity, where, message: hint ? `${hint} (${issue.message})` : issue.message };
}

/** Reads and checks a sheet against the repository's base content; `live` raises versions of changed units. */
export function checkSheet(book: Workbook, base: ContentSource, live?: { modules: Module[]; tasks: Task[] }): SheetCheck {
  const taxonomy = (base.taxonomy[0]?.data ?? { error_types: [] }) as ErrorTaxonomy;
  const characters = ((base.characters?.[0]?.data as { characters?: Character[] } | undefined)?.characters ?? []) as Character[];
  const read = readSheet(book, { taxonomy, characters });
  if (!read.sheet) return { ok: false, issues: read.issues };
  if (live) bumpVersions(read.sheet, live);
  const result = validateContent(withSheet(base, read.sheet));
  const issues = [...read.issues, ...result.issues.map((i) => sheetIssue(i, read.locate))];
  return { ok: result.ok, issues, sheet: read.sheet, ...(result.content ? { content: result.content } : {}) };
}
