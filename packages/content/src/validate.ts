import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import moduleSchema from "../schemas/module.schema.json" with { type: "json" };
import taskSetSchema from "../schemas/task-set.schema.json" with { type: "json" };
import courseSchema from "../schemas/course.schema.json" with { type: "json" };
import errorsSchema from "../schemas/errors.schema.json" with { type: "json" };
import placesSchema from "../schemas/places.schema.json" with { type: "json" };
import charactersSchema from "../schemas/characters.schema.json" with { type: "json" };
import episodeSchema from "../schemas/episode.schema.json" with { type: "json" };
import dailySchema from "../schemas/daily.schema.json" with { type: "json" };
import welcomeSchema from "../schemas/welcome.schema.json" with { type: "json" };
import { normalizeAnswer, tokenize } from "./normalize.js";
import type {
  Character,
  ContentSource,
  Course,
  DailyContent,
  Episode,
  EpisodeStep,
  ErrorTaxonomy,
  Module,
  MoonbridgeContent,
  Place,
  SourceFile,
  Task,
  TaskSet,
  Welcome,
  WelcomeStep,
} from "./types.js";

export type Severity = "error" | "warning";

export interface Issue {
  severity: Severity;
  file: string;
  /** Stable machine-readable code, e.g. "ref.concept" or "cycle.prerequisites". */
  code: string;
  message: string;
}

export interface ValidatedContent {
  taxonomy: ErrorTaxonomy;
  modules: Module[];
  taskSets: TaskSet[];
  courses: Course[];
  moonbridge?: MoonbridgeContent;
}

export interface ValidationResult {
  ok: boolean;
  issues: Issue[];
  /** Present only when ok: the content, typed. */
  content?: ValidatedContent;
}

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
const validators = {
  module: ajv.compile(moduleSchema),
  taskSet: ajv.compile(taskSetSchema),
  course: ajv.compile(courseSchema),
  errors: ajv.compile(errorsSchema),
  places: ajv.compile(placesSchema),
  characters: ajv.compile(charactersSchema),
  episode: ajv.compile(episodeSchema),
  daily: ajv.compile(dailySchema),
  welcome: ajv.compile(welcomeSchema),
};

function schemaPass<T>(files: SourceFile[], validate: ValidateFunction, issues: Issue[]): SourceFile<T>[] {
  const valid: SourceFile<T>[] = [];
  for (const file of files) {
    if (validate(file.data)) {
      valid.push(file as SourceFile<T>);
      continue;
    }
    for (const err of validate.errors ?? []) {
      issues.push({
        severity: "error",
        file: file.path,
        code: "schema",
        message: `${err.instancePath || "/"} ${err.message ?? "is invalid"}${
          err.params && "allowedValues" in err.params ? `: ${JSON.stringify(err.params.allowedValues)}` : ""
        }${err.params && "additionalProperty" in err.params ? `: "${String(err.params.additionalProperty)}"` : ""}`,
      });
    }
  }
  return valid;
}

/**
 * Validates content in two passes: JSON Schema per file, then cross-file checks
 * (references, cycles, duplicates, answer consistency). Any error fails the build;
 * warnings are reported but do not block.
 */
export function validateContent(source: ContentSource): ValidationResult {
  const issues: Issue[] = [];
  const err = (file: string, code: string, message: string) => issues.push({ severity: "error", file, code, message });
  const warn = (file: string, code: string, message: string) => issues.push({ severity: "warning", file, code, message });

  const taxonomyFiles = schemaPass<ErrorTaxonomy>(source.taxonomy, validators.errors, issues);
  const moduleFiles = schemaPass<Module>(source.modules, validators.module, issues);
  const taskSetFiles = schemaPass<TaskSet>(source.taskSets, validators.taskSet, issues);
  const courseFiles = schemaPass<Course>(source.courses, validators.course, issues);
  const placeFiles = schemaPass<{ places: Place[] }>(source.places ?? [], validators.places, issues);
  const characterFiles = schemaPass<{ characters: Character[] }>(source.characters ?? [], validators.characters, issues);
  const episodeFiles = schemaPass<Episode>(source.episodes ?? [], validators.episode, issues);
  const dailyFiles = schemaPass<DailyContent>(source.daily ?? [], validators.daily, issues);
  const welcomeFiles = schemaPass<Welcome>(source.welcome ?? [], validators.welcome, issues);

  if (source.taxonomy.length !== 1) {
    err("taxonomy/", "taxonomy.count", `expected exactly one error taxonomy file, found ${source.taxonomy.length}`);
  }
  if (source.courses.length === 0) err("courses/", "course.count", "expected at least one course file");
  const hasMoonbridge = [source.places, source.characters, source.episodes, source.daily, source.welcome].some((f) => (f?.length ?? 0) > 0);
  if (hasMoonbridge && (source.places?.length !== 1 || source.characters?.length !== 1 || (source.daily?.length ?? 0) > 1 || (source.welcome?.length ?? 0) > 1)) {
    err("moonbridge/", "moonbridge.files", "Moonbridge needs exactly one places.json and one characters.json, and at most one daily.json and one welcome.json");
  }
  // Cross-file checks only make sense on schema-valid data; stop here otherwise.
  if (issues.some((i) => i.severity === "error")) return { ok: false, issues };

  const taxonomy = taxonomyFiles[0]!.data;
  const errorTypes = new Set<string>();
  for (const et of taxonomy.error_types) {
    if (errorTypes.has(et.id)) err(taxonomyFiles[0]!.path, "duplicate.error_type", `error type "${et.id}" is defined twice`);
    errorTypes.add(et.id);
  }
  if (!errorTypes.has("unclassified")) err(taxonomyFiles[0]!.path, "taxonomy.unclassified", `taxonomy must define "unclassified"`);

  // Modules and concepts.
  const modules = new Map<string, { file: string; module: Module }>();
  const conceptOwner = new Map<string, string>();
  for (const { path, data: m } of moduleFiles) {
    if (modules.has(m.module_id)) {
      err(path, "duplicate.module_id", `module "${m.module_id}" is also defined in ${modules.get(m.module_id)!.file}`);
      continue;
    }
    modules.set(m.module_id, { file: path, module: m });
    const words = new Set<string>();
    for (const w of m.words ?? []) {
      const id = wordKey(w.en);
      if (words.has(id)) err(`${path} › ${w.en}`, "duplicate.word", `word "${w.en}" is listed twice in the unit`);
      words.add(id);
    }
    for (const c of m.concepts) {
      const owner = conceptOwner.get(c.concept_id);
      if (owner) err(path, "duplicate.concept_id", `concept "${c.concept_id}" is already defined in module "${owner}"`);
      else conceptOwner.set(c.concept_id, m.module_id);
    }
  }
  for (const { file, module: m } of modules.values()) {
    for (const p of m.prerequisites) {
      if (p === m.module_id) err(file, "cycle.prerequisites", `module "${p}" lists itself as a prerequisite`);
      else if (!modules.has(p)) err(file, "ref.module", `prerequisite "${p}" does not exist`);
    }
  }
  for (const cycle of findCycles(new Map([...modules].map(([id, { module }]) => [id, module.prerequisites])))) {
    err(modules.get(cycle[0]!)!.file, "cycle.prerequisites", `prerequisite cycle: ${[...cycle, cycle[0]].join(" → ")}`);
  }

  // Tasks.
  const tasks = new Map<string, { file: string; module_id: string; task: Task }>();
  const taskSetByModule = new Map<string, string>();
  for (const { path, data: set } of taskSetFiles) {
    const mod = modules.get(set.module_id);
    if (!mod) {
      err(path, "ref.module", `task set refers to unknown module "${set.module_id}"`);
      continue;
    }
    if (taskSetByModule.has(set.module_id)) {
      err(path, "duplicate.task_set", `module "${set.module_id}" already has a task set in ${taskSetByModule.get(set.module_id)}`);
    }
    taskSetByModule.set(set.module_id, path);
    const moduleConcepts = new Set(mod.module.concepts.map((c) => c.concept_id));
    for (const task of set.tasks) {
      const where = `${path} › ${task.task_id}`;
      if (tasks.has(task.task_id)) {
        err(path, "duplicate.task_id", `task "${task.task_id}" is also defined in ${tasks.get(task.task_id)!.file}`);
        continue;
      }
      tasks.set(task.task_id, { file: path, module_id: set.module_id, task });
      if (!task.task_id.startsWith(`${set.module_id}_`)) {
        err(where, "id.task_prefix", `task id must start with its module id "${set.module_id}_"`);
      }
      if (!moduleConcepts.has(task.concept_id)) {
        err(where, "ref.concept", `concept "${task.concept_id}" is not defined in module "${set.module_id}"`);
      }
      checkAnswer(task, where, errorTypes, err, warn);
    }
  }
  for (const { file, module: m } of modules.values()) {
    const pool = m.tasks.filter((id) => {
      const t = tasks.get(id);
      if (!t) err(file, "ref.task", `task "${id}" is not defined in any task set`);
      else if (t.module_id !== m.module_id) err(file, "ref.task", `task "${id}" belongs to module "${t.module_id}"`);
      return t?.module_id === m.module_id;
    });
    if (pool.length < m.mastery.check_task_count) {
      err(file, "mastery.pool", `the unit check needs ${m.mastery.check_task_count} tasks but the pool has ${pool.length}`);
    }
    const conceptsWithTasks = new Set(pool.map((id) => tasks.get(id)!.task.concept_id));
    for (const c of m.concepts) {
      if (!conceptsWithTasks.has(c.concept_id)) err(file, "concept.no_tasks", `concept "${c.concept_id}" has no active tasks`);
    }
  }
  for (const [id, t] of tasks) {
    if (!modules.get(t.module_id)?.module.tasks.includes(id)) {
      warn(t.file, "task.inactive", `task "${id}" is not in module "${t.module_id}" task pool and will not be used`);
    }
  }

  // Courses: references and prerequisite order. The position of a unit in each course is kept
  // for the Moonbridge checks below.
  const courseIds = new Set<string>();
  const positions: Map<string, number>[] = [];
  for (const { path, data: course } of courseFiles) {
    if (courseIds.has(course.course_id)) err(path, "duplicate.course_id", `course "${course.course_id}" is defined twice`);
    courseIds.add(course.course_id);
    const position = new Map<string, number>();
    course.units.forEach((id, i) => {
      const where = `${path} › ${id}`;
      const mod = modules.get(id);
      if (!mod) err(where, "ref.module", `unit "${id}" does not exist`);
      for (const p of mod?.module.prerequisites ?? []) {
        if (!position.has(p)) err(where, "order.prerequisites", `prerequisite "${p}" must come earlier in the course than "${id}"`);
      }
      position.set(id, i);
    });
    positions.push(position);
  }

  const moonbridge = hasMoonbridge
    ? checkMoonbridge(placeFiles, characterFiles, episodeFiles, dailyFiles, welcomeFiles, modules, tasks, positions, err, warn)
    : undefined;

  const ok = !issues.some((i) => i.severity === "error");
  return {
    ok,
    issues,
    content: ok
      ? {
          taxonomy,
          modules: [...modules.values()].map((m) => m.module),
          taskSets: taskSetFiles.map((f) => f.data),
          courses: courseFiles.map((f) => f.data),
          ...(moonbridge ? { moonbridge } : {}),
        }
      : undefined,
  };
}

function checkAnswer(
  task: Task,
  where: string,
  errorTypes: Set<string>,
  err: Report,
  warn: Report,
) {
  const cs = task.answer.case_sensitive ?? false;
  const accepted = new Set(task.answer.accepted.map((a) => normalizeAnswer(a, cs)));
  const known = task.answer.known_errors ?? [];

  for (const ke of known) {
    if (!errorTypes.has(ke.error_type)) err(where, "ref.error_type", `error type "${ke.error_type}" is not in the taxonomy`);
    for (const m of ke.match) {
      if (accepted.has(normalizeAnswer(m, cs))) err(where, "answer.conflict", `"${m}" is both accepted and a known error`);
    }
  }

  if (task.type === "choice" || task.type === "translate_en_ru") {
    const optionIds = new Set(task.presentation.options?.map((o) => o.id));
    if (optionIds.size !== task.presentation.options?.length) err(where, "answer.options", "option ids must be unique");
    for (const a of task.answer.accepted) {
      if (!optionIds.has(a)) err(where, "answer.option_ref", `accepted "${a}" is not an option id`);
    }
    for (const ke of known) {
      for (const m of ke.match) if (!optionIds.has(m)) err(where, "answer.option_ref", `known error "${m}" is not an option id`);
    }
    const coveredWrong = new Set(known.flatMap((k) => k.match));
    const uncovered = [...optionIds].filter((id) => !accepted.has(id) && !coveredWrong.has(id));
    if (uncovered.length) warn(where, "answer.untagged_option", `wrong options without an error type: ${uncovered.join(", ")}`);
  }

  if (task.type === "order_words") {
    const tokens = tokenize(task.presentation.tokens!.join(" ")).sort().join(" ");
    for (const a of task.answer.accepted) {
      if (tokenize(a).sort().join(" ") !== tokens) {
        err(where, "answer.tokens", `accepted "${a}" cannot be built from the given tokens`);
      }
    }
  }

  if (task.type === "find_error") {
    const count = task.presentation.tokens!.length;
    for (const a of [...task.answer.accepted, ...known.flatMap((k) => k.match)]) {
      if (!/^[0-9]+$/.test(a) || Number(a) >= count) err(where, "answer.token_ref", `"${a}" is not a token index (0–${count - 1})`);
    }
  }

  if (task.type === "gap_fill" && !task.presentation.prompt.includes("___")) {
    err(where, "presentation.gap", 'gap_fill prompt must contain a "___" gap');
  }
}

type Report = (file: string, code: string, message: string) => void;

/**
 * Cross-file checks of the Moonbridge section: every reference resolves, every episode can be
 * played to an end, and no episode takes place somewhere its unit has not opened yet.
 */
function checkMoonbridge(
  placeFiles: SourceFile<{ places: Place[] }>[],
  characterFiles: SourceFile<{ characters: Character[] }>[],
  episodeFiles: SourceFile<Episode>[],
  dailyFiles: SourceFile<DailyContent>[],
  welcomeFiles: SourceFile<Welcome>[],
  modules: Map<string, { file: string; module: Module }>,
  tasks: Map<string, { file: string; module_id: string; task: Task }>,
  coursePositions: Map<string, number>[],
  err: Report,
  warn: Report,
): MoonbridgeContent {
  const characters = collectUnique(characterFiles, (d) => d.characters, (c) => c.character_id, "character_id", err);
  const places = collectUnique(placeFiles, (d) => d.places, (p) => p.place_id, "place_id", err);

  const unlockedBy = new Map<string, string>();
  for (const { path, data } of placeFiles) {
    for (const place of data.places) {
      const where = `${path} › ${place.place_id}`;
      for (const c of place.characters) {
        if (!characters.has(c)) err(where, "ref.character", `character "${c}" does not exist`);
      }
      if (place.unlocked_by === null) continue;
      if (!modules.has(place.unlocked_by)) err(where, "ref.module", `unit "${place.unlocked_by}" does not exist`);
      const other = unlockedBy.get(place.unlocked_by);
      if (other) err(where, "duplicate.unlock", `unit "${place.unlocked_by}" already opens "${other}"`);
      unlockedBy.set(place.unlocked_by, place.place_id);
    }
  }

  const episodes = collectUnique(episodeFiles, (d) => [d], (e) => e.episode_id, "episode_id", err);
  for (const { path, data: ep } of episodeFiles) {
    if (!modules.has(ep.module_id)) err(path, "ref.module", `unit "${ep.module_id}" does not exist`);
    // The episode's own place and every place a scene step moves to.
    const visited: Place[] = [];
    const visit = (placeId: string, where: string) => {
      const place = places.get(placeId);
      if (!place) return err(where, "ref.place", `place "${placeId}" does not exist`);
      visited.push(place);
      if (place.unlocked_by === null || place.unlocked_by === ep.module_id) return;
      // The place must already be open when the student reaches the episode's unit, in every course that has both.
      for (const pos of coursePositions) {
        const opens = pos.get(place.unlocked_by);
        const at = pos.get(ep.module_id);
        if (at !== undefined && (opens === undefined || opens > at)) {
          err(where, "order.place", `place "${place.place_id}" opens with "${place.unlocked_by}", after unit "${ep.module_id}"`);
          break;
        }
      }
    };
    visit(ep.place_id, path);
    for (const step of ep.steps) if (step.kind === "scene") visit(step.place_id, `${path} › ${step.id}`);
    checkSteps(ep, path, visited, characters, tasks, err, warn);
  }

  let welcome: Welcome | undefined;
  for (const { path, data } of welcomeFiles) {
    const place = places.get(data.place_id);
    if (!place) err(path, "ref.place", `place "${data.place_id}" does not exist`);
    else if (place.unlocked_by !== null) warn(path, "welcome.place", `the welcome must take place somewhere open from the start, "${data.place_id}" opens with "${place.unlocked_by}"`);
    checkSteps(data, path, place ? [place] : [], characters, tasks, err, warn);
    welcome = data;
  }

  let daily: DailyContent | undefined;
  for (const { path, data } of dailyFiles) {
    const guests = collectUnique([{ path, data }], (d) => d.guests, (g) => g.guest_id, "guest_id", err);
    const items = collectUnique([{ path, data }], (d) => d.lost_items, (i) => i.item_id, "item_id", err);
    for (const g of guests.values()) {
      if (g.host && !characters.has(g.host)) err(`${path} › ${g.guest_id}`, "ref.character", `host "${g.host}" does not exist`);
    }
    daily = { guests: [...guests.values()], lost_items: [...items.values()] };
  }

  return {
    places: [...places.values()],
    characters: [...characters.values()],
    episodes: [...episodes.values()],
    ...(daily ? { daily } : {}),
    ...(welcome ? { welcome } : {}),
  };
}

/** Words are told apart by their English side, ignoring case and spaces: "Good evening" = "good  evening". */
export function wordKey(en: string): string {
  return en.trim().toLowerCase().replace(/\s+/g, " ");
}

function checkSteps(
  ep: Episode | Welcome,
  path: string,
  places: Place[],
  characters: Map<string, Character>,
  tasks: Map<string, { file: string; module_id: string; task: Task }>,
  err: Report,
  warn: Report,
) {
  const index = new Map<string, number>();
  ep.steps.forEach((step, i) => {
    if (index.has(step.id)) err(`${path} › ${step.id}`, "duplicate.step_id", `step "${step.id}" is defined twice`);
    else index.set(step.id, i);
  });

  const successors = (step: EpisodeStep | WelcomeStep, i: number): string[] => {
    const following = ep.steps[i + 1]?.id;
    const out =
      step.kind === "line" || step.kind === "scene" ? [step.next ?? following] : step.kind === "task" ? [step.on_correct ?? following, step.on_wrong ?? following] : [];
    return out.filter((id): id is string => id !== undefined);
  };

  ep.steps.forEach((step, i) => {
    const where = `${path} › ${step.id}`;
    if (step.kind === "scene") {
      if (step.next !== undefined && !index.has(step.next)) err(where, "ref.step", `step "${step.next}" does not exist`);
      if (successors(step, i).length < 1) err(where, "step.dangling", "the last step must be an end, or name where to go next");
    }
    if (step.kind === "line") {
      for (const [, name] of [...step.text.en.matchAll(/\{([^}]*)\}/g), ...(step.text.ru ?? "").matchAll(/\{([^}]*)\}/g)]) {
        if (name !== "name") err(where, "text.placeholder", `"{${name}}" is not known; a line may only say {name}`);
      }
    }
    if (step.kind === "line" || step.kind === "task") {
      const targets = step.kind === "line" ? [step.next] : [step.on_correct, step.on_wrong];
      for (const target of targets) {
        if (target !== undefined && !index.has(target)) err(where, "ref.step", `step "${target}" does not exist`);
      }
      if (successors(step, i).length < (step.kind === "line" ? 1 : 2)) {
        err(where, "step.dangling", "the last step must be an end, or name where to go next");
      }
      const speaker = step.speaker;
      if (speaker !== undefined && speaker !== "narrator" && speaker !== "player") {
        const character = characters.get(speaker);
        if (!character) err(where, "ref.character", `speaker "${speaker}" does not exist`);
        else {
          const byDay = "time_of_day" in ep && ep.time_of_day === "day" && character.day;
          if (step.emotion && step.emotion !== "neutral" && !(byDay ? character.day!.portraits : character.portraits)[step.emotion]) {
            err(where, "ref.emotion", `"${speaker}" has no "${step.emotion}" portrait${byDay ? " by day" : ""}`);
          }
          if (places.length && !places.some((p) => p.characters.includes(speaker))) {
            warn(where, "speaker.elsewhere", `"${speaker}" does not live in ${places.map((p) => `"${p.place_id}"`).join(" or ")}`);
          }
        }
      }
    }
    if (step.kind === "task") {
      const t = tasks.get(step.task_id);
      if (!t) err(where, "ref.task", `task "${step.task_id}" does not exist`);
      else if ("module_id" in ep && t.module_id !== ep.module_id) err(where, "ref.task", `task "${step.task_id}" belongs to unit "${t.module_id}", not "${ep.module_id}"`);
    }
  });
  if ("episode_id" in ep && !ep.steps.some((s) => s.kind === "task")) warn(path, "episode.no_tasks", "the episode has no tasks");

  // Every step must be reachable from the start, and an end must be reachable from every step.
  const graph = new Map(ep.steps.map((s, i) => [s.id, successors(s, i).filter((id) => index.has(id))]));
  const reached = new Set<string>();
  const walk = (id: string) => {
    if (reached.has(id)) return;
    reached.add(id);
    for (const next of graph.get(id) ?? []) walk(next);
  };
  walk(ep.steps[0]!.id);
  for (const s of ep.steps) {
    if (!reached.has(s.id)) err(`${path} › ${s.id}`, "step.unreachable", "no path from the start leads to this step");
  }
  const canEnd = new Set(ep.steps.filter((s) => s.kind === "end").map((s) => s.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, next] of graph) {
      if (!canEnd.has(id) && next.some((n) => canEnd.has(n))) {
        canEnd.add(id);
        grew = true;
      }
    }
  }
  for (const s of ep.steps) {
    if (reached.has(s.id) && !canEnd.has(s.id)) err(`${path} › ${s.id}`, "step.no_end", "the episode cannot end from this step (a loop without exit)");
  }
}

function collectUnique<D, T>(
  files: SourceFile<D>[],
  items: (d: D) => T[],
  idOf: (t: T) => string,
  label: string,
  err: (file: string, code: string, message: string) => void,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const { path, data } of files) {
    for (const item of items(data)) {
      const id = idOf(item);
      if (out.has(id)) err(path, `duplicate.${label}`, `${label} "${id}" is defined twice`);
      else out.set(id, item);
    }
  }
  return out;
}

/** Returns each elementary cycle once (as found by DFS) in a dependency graph. */
export function findCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (node: string) => {
    state.set(node, "visiting");
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next) || next === node) continue;
      const s = state.get(next);
      if (s === "visiting") cycles.push(stack.slice(stack.indexOf(next)));
      else if (s === undefined) visit(next);
    }
    stack.pop();
    state.set(node, "done");
  };
  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  return cycles;
}
