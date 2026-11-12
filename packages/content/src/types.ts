// Types mirror the JSON Schemas in ../schemas. The schemas are the source of truth;
// keep these in sync when a schema changes (and bump schema_version).

export type CefrLevel = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";
export type TaskType =
  | "choice"
  | "gap_fill"
  | "transform"
  | "order_words"
  | "listen_type"
  | "translate_ru_en"
  | "translate_en_ru"
  | "find_error";

export interface Localized {
  en: string;
  ru: string;
}

export interface Concept {
  concept_id: string;
  label: string;
  explanation_ru?: string;
}

export interface Module {
  schema_version: "2.0";
  module_id: string;
  version: number;
  cefr_level: CefrLevel;
  title: Localized;
  description?: Localized;
  skill: "grammar" | "vocabulary" | "reading" | "listening";
  grammar_topic?: string;
  vocabulary_set?: string;
  prerequisites: string[];
  concepts: Concept[];
  mastery: { check_task_count: number; pass_score: number };
  /** Words for the student's own dictionary («Мои слова»); they enter it once an episode of the unit is played. */
  words?: Word[];
  tasks: string[];
}

export interface Word {
  en: string;
  ru: string;
  example?: string;
}

export interface KnownError {
  match: string[];
  error_type: string;
  feedback?: string;
}

export interface Task {
  task_id: string;
  concept_id: string;
  type: TaskType;
  difficulty: number;
  presentation: {
    prompt: string;
    instruction_ru?: string;
    hint?: string;
    source?: string;
    audio?: string;
    options?: { id: string; text: string }[];
    tokens?: string[];
  };
  answer: {
    accepted: string[];
    case_sensitive?: boolean;
    ignore_articles?: boolean;
    correction?: string;
    known_errors?: KnownError[];
  };
  time_limit_s?: number;
  tags?: string[];
}

export interface TaskSet {
  schema_version: "2.0";
  module_id: string;
  tasks: Task[];
}

/** Unit order of a course. The platform shows units in this order; Moonbridge places follow it. */
export interface Course {
  schema_version: "2.0";
  course_id: string;
  title: Localized;
  cefr?: { from: CefrLevel; to: CefrLevel };
  units: string[];
}

export type Emotion = "neutral" | "happy" | "upset";

export interface Place {
  place_id: string;
  name: Localized;
  background: string;
  /** module_id of the unit that opens the place; null = open from the start. */
  unlocked_by: string | null;
  characters: string[];
}

export interface Character {
  character_id: string;
  name: string;
  species: Localized;
  role?: Localized;
  portraits: { neutral: string } & Partial<Record<Exclude<Emotion, "neutral">, string>>;
}

export type EpisodeStep =
  | { id: string; kind: "line"; speaker: string; emotion?: Emotion; text: { en: string; ru?: string }; next?: string }
  | { id: string; kind: "task"; task_id: string; speaker?: string; emotion?: Emotion; on_correct?: string; on_wrong?: string }
  | { id: string; kind: "end" };

export interface Episode {
  schema_version: "2.0";
  episode_id: string;
  module_id: string;
  place_id: string;
  title: Localized;
  steps: EpisodeStep[];
}

export interface GuestTemplate {
  guest_id: string;
  name: string;
  species: Localized;
  portrait?: string;
  /** character_id of the resident who meets the guest. */
  host?: string;
  /** Tasks the guest brings; they come from units the student has passed. Default 4. */
  task_count?: number;
  arrival: { en: string; ru?: string };
  thanks: { en: string; ru?: string };
  disappointed: { en: string; ru?: string };
  teaser: { en: string; ru?: string };
}

export interface LostItem {
  item_id: string;
  name: Localized;
}

/** The daily shift: guests of the day and lost-and-found items. Optional: without it Moonbridge has episodes only. */
export interface DailyContent {
  guests: GuestTemplate[];
  lost_items: LostItem[];
}

export type WelcomeStep =
  | { id: string; kind: "line"; speaker: string; emotion?: Emotion; text: Localized; next?: string }
  | { id: string; kind: "end" };

/** The scene of a student's first visit to the hotel: lines only, both languages shown, {name} = the student. */
export interface Welcome {
  schema_version: "2.0";
  place_id: string;
  title: Localized;
  steps: WelcomeStep[];
}

/** The Moonbridge section's content. The platform works without it. */
export interface MoonbridgeContent {
  places: Place[];
  characters: Character[];
  episodes: Episode[];
  daily?: DailyContent;
  welcome?: Welcome;
}

export interface ErrorType {
  id: string;
  label: Localized;
  deprecated?: boolean;
}

export interface ErrorTaxonomy {
  schema_version: "1.0";
  version: number;
  error_types: ErrorType[];
}

/** A parsed content file together with where it came from, for error messages. */
export interface SourceFile<T = unknown> {
  path: string;
  data: T;
}

/** Raw content as read from the /content directory, before validation. */
export interface ContentSource {
  taxonomy: SourceFile[];
  modules: SourceFile[];
  taskSets: SourceFile[];
  courses: SourceFile[];
  /** Moonbridge files are optional: without them the platform runs with no Moonbridge section. */
  places?: SourceFile[];
  characters?: SourceFile[];
  episodes?: SourceFile[];
  daily?: SourceFile[];
  welcome?: SourceFile[];
}

/** Validated content, flattened and indexed: this is what the platform, Moonbridge and the engine consume. */
export interface ContentBundle {
  bundle_schema_version: "2.0";
  /** Content hash: changes whenever any content changes, stable otherwise. */
  content_hash: string;
  built_at: string;
  taxonomy: ErrorTaxonomy;
  modules: Module[];
  tasks: Record<string, Task & { module_id: string }>;
  courses: Course[];
  moonbridge?: MoonbridgeContent;
}
