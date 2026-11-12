import type { Character, Emotion, ErrorTaxonomy, Module, SceneTransition, TaskType, TimeOfDay } from "../types.js";

// The content sheet's vocabulary: sheet names, column headers and the Russian words the teacher
// types for enum values. The importer and the exporter share it, so a downloaded sheet always
// imports back unchanged.

export const SHEETS = {
  help: "Как заполнять",
  units: "Юниты",
  concepts: "Понятия",
  tasks: "Задания",
  episodes: "Эпизоды",
  places: "Места",
  lists: "Справочник",
} as const;

export const UNIT_COLS = {
  id: "юнит",
  level: "уровень",
  titleEn: "название EN",
  titleRu: "название RU",
  descEn: "описание EN",
  descRu: "описание RU",
  skill: "навык",
  grammar: "грамматика",
  vocabulary: "набор слов",
  prerequisites: "нужны юниты",
  check: "заданий в проверке",
  pass: "порог проверки",
  version: "версия",
} as const;

export const CONCEPT_COLS = { unit: "юнит", id: "понятие", label: "название", explanation: "объяснение RU" } as const;

export const OPTION_LETTERS = ["a", "b", "c", "d"] as const;

export const TASK_COLS = {
  unit: "юнит",
  id: "задание",
  concept: "понятие",
  type: "тип",
  difficulty: "сложность",
  prompt: "текст задания",
  instruction: "инструкция RU",
  source: "исходная фраза",
  hint: "подсказка",
  audio: "аудио",
  a: "вариант a",
  b: "вариант b",
  c: "вариант c",
  d: "вариант d",
  tokens: "слова",
  accepted: "верные ответы",
  correction: "исправление",
  caseSensitive: "регистр важен",
  ignoreArticles: "без артиклей",
  timeLimit: "время, с",
  tags: "теги",
} as const;

/** Known errors take three columns each: "ошибка 1", "тип ошибки 1", "пояснение 1", then 2, 3… */
export const ERROR_COLS = { match: "ошибка", type: "тип ошибки", feedback: "пояснение" } as const;
export const DEFAULT_ERROR_GROUPS = 4;

export const EPISODE_COLS = {
  id: "эпизод",
  unit: "юнит",
  place: "место",
  titleEn: "название EN",
  titleRu: "название RU",
  time: "время суток",
  side: "побочный",
  step: "шаг",
  kind: "что",
  speaker: "кто",
  emotion: "эмоция",
  textEn: "текст EN",
  textRu: "текст RU",
  task: "задание",
  next: "дальше",
  onCorrect: "если верно",
  onWrong: "если неверно",
  to: "куда",
  transition: "переход",
} as const;

export const PLACE_COLS = {
  id: "место",
  nameEn: "название EN",
  nameRu: "название RU",
  background: "фон",
  backgroundDay: "фон днём",
  unlockedBy: "открывает юнит",
  characters: "жители",
} as const;

export const TASK_TYPES: [TaskType, string][] = [
  ["choice", "выбор"],
  ["gap_fill", "пропуск"],
  ["transform", "трансформация"],
  ["order_words", "порядок слов"],
  ["listen_type", "послушай и напечатай"],
  ["translate_ru_en", "перевод RU→EN"],
  ["translate_en_ru", "перевод EN→RU"],
  ["find_error", "найди ошибку"],
];
export const SKILLS: [Module["skill"], string][] = [
  ["grammar", "грамматика"],
  ["vocabulary", "лексика"],
  ["reading", "чтение"],
  ["listening", "аудирование"],
];
export const STEP_KINDS: ["line" | "task" | "scene" | "end", string][] = [
  ["line", "реплика"],
  ["task", "задание"],
  ["scene", "смена места"],
  ["end", "конец"],
];
export const TIMES: [TimeOfDay, string][] = [
  ["night", "ночь"],
  ["day", "день"],
];
export const TRANSITIONS: [SceneTransition, string][] = [
  ["fade", "затемнение"],
  ["lift", "лифт"],
  ["cut", "сразу"],
];
export const EMOTIONS: [Emotion, string][] = [
  ["neutral", "спокойно"],
  ["happy", "радостно"],
  ["upset", "огорчённо"],
];
export const SPEAKERS: [string, string][] = [
  ["narrator", "рассказчик"],
  ["player", "игрок"],
];
export const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;

/** Header and enum comparison: case, ё/е, spaces and arrows do not matter. */
export function key(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/->/g, "→").replace(/\s+/g, " ").trim();
}

/** Finds the id for a typed word: either the id itself or its Russian label. */
export function lookup<T extends string>(pairs: [T, string][], typed: string): T | undefined {
  const k = key(typed);
  return pairs.find(([id, label]) => key(id) === k || key(label) === k)?.[0];
}

export function labelOf<T extends string>(pairs: [T, string][], id: T): string {
  return pairs.find(([i]) => i === id)?.[1] ?? id;
}

export function errorTypePairs(taxonomy: ErrorTaxonomy): [string, string][] {
  return taxonomy.error_types.filter((t) => !t.deprecated).map((t) => [t.id, t.label.ru]);
}

/** Speakers by id or by name ("Rocco"), plus the narrator and the player. */
export function speakerPairs(characters: Character[]): [string, string][] {
  return [...SPEAKERS, ...characters.map((c): [string, string] => [c.character_id, c.name])];
}

/** Several values in one cell: separated by "|" or by line breaks. */
export function splitList(cell: string): string[] {
  return cell
    .split(/\s*\|\s*|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const LIST_SEPARATOR = " | ";

export const HELP: string[] = [
  "Как заполнять таблицу контента Moonbridge",
  "",
  "Каждый лист отвечает за своё: Юниты (порядок юнитов в курсе — порядок строк), Понятия, Задания, Эпизоды, Места. Лист «Справочник» подсказывает допустимые слова, этот лист — памятка. Порядок колонок можно менять, названия колонок — нет.",
  "",
  "Задания. Id задания пишется коротко латиницей (hello, are_you); платформа сама добавит к нему id юнита. Не меняйте id у задания, которое ученики уже делали: по нему хранится их прогресс.",
  "Несколько значений в одной ячейке разделяйте знаком | или переносом строки: I'm tired | I am tired.",
  "Выбор и перевод EN→RU: варианты в колонках «вариант a…d», верный ответ и ошибки — буквой (a, b, c).",
  "Порядок слов: колонку «слова» можно не заполнять, слова возьмутся из первого верного ответа и перемешаются.",
  "Найди ошибку: в «слова» — фраза через пробел (точка отдельным словом), верный ответ — неверное слово или его номер, в «исправление» — как правильно.",
  "Пропуск: в тексте задания должно быть ___ (три подчёркивания).",
  "Ошибки: в «ошибка 1» — неверные ответы через |, в «тип ошибки 1» — тип из справочника, в «пояснение 1» — что увидит ученик. Если нужно больше трёх ошибок, добавьте колонки «ошибка 5», «тип ошибки 5», «пояснение 5».",
  "",
  "Эпизоды. Одна строка — один шаг: реплика, задание или конец. Если «эпизод» пустой, строка относится к эпизоду выше. Юнит, место и название достаточно указать в первой строке эпизода.",
  "Смена места: в «что» напишите «смена места», в «куда» — место, в «переход» — затемнение, лифт или сразу. В репликах можно писать {player}: подставится имя ученика.",
  "Время суток эпизода (ночь или день) и «побочный» (да — дополнительный эпизод, без него юнит считается пройденным) достаточно указать в первой строке.",
  "Шаги идут по порядку. Чтобы сделать ветку, дайте шагу имя в колонке «шаг» и укажите его в «если неверно», «если верно» или «дальше».",
  "",
  "Как опубликовать: в Google Таблицах «Настройки доступа → Все, у кого есть ссылка (читатель)», затем в кабинете преподавателя «Контент курса» вставьте ссылку и нажмите «Проверить». Если ошибок нет, нажмите «Опубликовать» — ученики увидят новое при следующем открытии.",
  "Можно и без ссылки: «Файл → Скачать → Microsoft Excel (.xlsx)» и загрузить файл там же.",
];
