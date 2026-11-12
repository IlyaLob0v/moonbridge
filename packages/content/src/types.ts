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
  tasks: string[];
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

/** Moonbridge lives in two times of day: the hotel by night (the default) and by day. */
export type TimeOfDay = "night" | "day";

/** How the stage moves to another place inside an episode. */
export type SceneTransition = "fade" | "lift" | "cut";

/** A short line said in a character's voice, with an optional translation. */
export interface Say {
  en: string;
  ru?: string;
}

export type Portraits = { neutral: string } & Partial<Record<Exclude<Emotion, "neutral">, string>>;

export interface Place {
  place_id: string;
  name: Localized;
  /** The place by night. */
  background: string;
  /** The place by day; without it the night art is shown, lit brighter. */
  background_day?: string;
  /** The place's building on the town map; without it a drawn house stands there. */
  building?: string;
  /** module_id of the unit that opens the place; null = open from the start. */
  unlocked_by: string | null;
  characters: string[];
}

export interface Character {
  character_id: string;
  name: string;
  species: Localized;
  role?: Localized;
  portraits: Portraits;
  /** Who the character is by day (Rocco is a werewolf at night and a man by day); without it, the same as at night. */
  day?: { species: Localized; role?: Localized; portraits: Portraits };
  /** What the character says after an answer; the player picks one at random. */
  reactions?: { right?: Say[]; typo?: Say[]; wrong?: Say[] };
}

export type EpisodeStep =
  | { id: string; kind: "line"; speaker: string; emotion?: Emotion; text: { en: string; ru?: string }; next?: string }
  | { id: string; kind: "task"; task_id: string; speaker?: string; emotion?: Emotion; on_correct?: string; on_wrong?: string }
  | { id: string; kind: "scene"; place_id: string; transition?: SceneTransition; next?: string }
  | { id: string; kind: "end" };

export interface Episode {
  schema_version: "2.0";
  episode_id: string;
  module_id: string;
  /** Where the episode starts; a "scene" step moves it elsewhere. */
  place_id: string;
  title: Localized;
  /** When it happens. Default night. */
  time_of_day?: TimeOfDay;
  /** A side quest: extra practice that the unit does not wait for. */
  side?: boolean;
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

/** The Moonbridge section's content. The platform works without it. */
export interface MoonbridgeContent {
  places: Place[];
  characters: Character[];
  episodes: Episode[];
  daily?: DailyContent;
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
