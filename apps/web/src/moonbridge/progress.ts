import type { ContentBundle, Course, Episode, MoonbridgeContent, Place, TimeOfDay } from "@moonbridge/content";

/** What Moonbridge keeps for a student. Answers and errors live in the shared journal, not here. */
export interface MoonbridgeState {
  version: 1;
  completed_episodes: string[];
  /** School days (RepeatSchedule.day) with an episode or a shift finished: the streak is made of these. */
  practice_days: number[];
  /** School days whose daily shift is finished. */
  shift_days: number[];
  /** Places whose opening the student has seen on the map; undefined until the map first shows. */
  seen_places?: string[];
  /** Day or night chosen on the map; undefined = by the clock. */
  time?: TimeOfDay;
}

export function emptyState(): MoonbridgeState {
  return { version: 1, completed_episodes: [], practice_days: [], shift_days: [] };
}

/** The hotel's time of day: what the student chose on the map, or the clock (day from 7:00 to 19:00). */
export function hotelTime(state: MoonbridgeState, now: Date): TimeOfDay {
  if (state.time) return state.time;
  const h = now.getHours();
  return h >= 7 && h < 19 ? "day" : "night";
}

const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : []);

/** Accepts a stored state of any age; unknown shapes start fresh rather than break the section. */
export function migrateState(raw: unknown): MoonbridgeState {
  const r = raw as Partial<MoonbridgeState> | undefined;
  if (r?.version !== 1 || !Array.isArray(r.completed_episodes)) return emptyState();
  return {
    version: 1,
    completed_episodes: r.completed_episodes.filter((e) => typeof e === "string"),
    practice_days: numbers(r.practice_days),
    shift_days: numbers(r.shift_days),
    ...(Array.isArray(r.seen_places) ? { seen_places: r.seen_places.filter((p) => typeof p === "string") } : {}),
    ...(r.time === "day" || r.time === "night" ? { time: r.time } : {}),
  };
}

/** Keeps the last 60 days: enough for any streak and the week view, small enough to back up. */
function addDay(days: number[], day: number): number[] {
  return days.includes(day) ? days : [...days, day].sort((a, b) => a - b).slice(-60);
}

export function markPractice(state: MoonbridgeState, day: number): MoonbridgeState {
  return { ...state, practice_days: addDay(state.practice_days, day) };
}

export function markShift(state: MoonbridgeState, day: number): MoonbridgeState {
  return { ...markPractice(state, day), shift_days: addDay(state.shift_days, day) };
}

export function completeEpisode(state: MoonbridgeState, episodeId: string): MoonbridgeState {
  if (state.completed_episodes.includes(episodeId)) return state;
  return { ...state, completed_episodes: [...state.completed_episodes, episodeId] };
}

export interface EpisodeView {
  episode: Episode;
  done: boolean;
  /** The episode's unit has been reached in the course. */
  available: boolean;
}

export interface PlaceView {
  place: Place;
  open: boolean;
  episodes: EpisodeView[];
}

export interface HotelView {
  course: Course;
  /** The unit the student is on: the first one in course order with an episode not yet played. Undefined when all are done. */
  currentUnit: string | undefined;
  /** Units behind the student, in course order: the guest of the day only brings tasks from these. */
  studiedUnits: string[];
  places: PlaceView[];
  /** What the "Play" button on the map starts: the first available episode not yet played. */
  next: Episode | undefined;
  /** Units open when the teacher gives them, not by themselves. */
  byTeacher: boolean;
}

/**
 * The hotel as the student sees it. Until the platform tracks lessons (week 5), the course
 * advances through Moonbridge itself: a unit is behind the student once all its episodes are
 * played, and units without episodes do not hold anyone back. A place opens when the student
 * reaches the unit that unlocks it; the validator guarantees that is never later than its episodes.
 */
export function hotelView(content: MoonbridgeContent, course: Course, state: MoonbridgeState, opened?: Set<string>): HotelView {
  const done = new Set(state.completed_episodes);
  const position = new Map(course.units.map((u, i) => [u, i]));
  const listed = content.episodes.filter((e) => position.has(e.module_id));
  // Side quests show on the map but nothing waits for them.
  const inCourse = listed.filter((e) => !e.side);
  const pending = inCourse.filter((e) => !done.has(e.episode_id)).map((e) => position.get(e.module_id)!);
  const currentPos = pending.length ? Math.min(...pending) : course.units.length;
  const unitPlayed = (unit: string) => inCourse.some((e) => e.module_id === unit) && inCourse.every((e) => e.module_id !== unit || done.has(e.episode_id));
  // With `opened` (the group's teacher opens units by giving them as homework), a unit is
  // reached once it is given or already played; otherwise the course order decides.
  const reached = opened
    ? (unit: string | null) => unit === null || opened.has(unit) || unitPlayed(unit)
    : (unit: string | null) => unit === null || (position.get(unit) ?? Infinity) <= currentPos;

  // Map order: open-from-the-start places first, then in the order the course opens them.
  const opensAt = (p: Place) => (p.unlocked_by === null ? -1 : (position.get(p.unlocked_by) ?? Number.MAX_SAFE_INTEGER));
  const places = [...content.places].sort((a, b) => opensAt(a) - opensAt(b)).map((place) => {
    const episodes = listed
      .filter((e) => e.place_id === place.place_id)
      .sort((a, b) => position.get(a.module_id)! - position.get(b.module_id)!)
      .map((episode) => ({ episode, done: done.has(episode.episode_id), available: reached(episode.module_id) }));
    return { place, open: reached(place.unlocked_by) || (!!opened && episodes.some((e) => e.available)), episodes };
  });
  const next = places
    .filter((p) => p.open)
    .flatMap((p) => p.episodes)
    .filter((e) => e.available && !e.done && !e.episode.side)
    .sort((a, b) => position.get(a.episode.module_id)! - position.get(b.episode.module_id)!)[0]?.episode;
  if (opened) {
    const current = course.units.find((u) => reached(u) && inCourse.some((e) => e.module_id === u && !done.has(e.episode_id)));
    return { course, currentUnit: current, studiedUnits: course.units.filter(unitPlayed), places, next, byTeacher: true };
  }
  return { course, currentUnit: course.units[currentPos], studiedUnits: course.units.slice(0, currentPos), places, next, byTeacher: false };
}

/**
 * The units the teacher has opened for the student: every unit given as homework in their groups.
 * Undefined (course order) for a student outside a group, or when any of their groups lets units
 * open by themselves.
 */
export function openedUnits(board: { groups: { unit_access?: string }[]; homework: { module_id?: string | null }[] } | undefined): Set<string> | undefined {
  if (!board?.groups.length || board.groups.some((g) => g.unit_access !== "assigned")) return undefined;
  return new Set(board.homework.flatMap((h) => (h.module_id ? [h.module_id] : [])));
}

/** The course the student is on. One course until groups arrive (week 5). */
export function studentCourse(bundle: ContentBundle, courseId?: string): Course | undefined {
  return courseId ? bundle.courses.find((c) => c.course_id === courseId) : bundle.courses[0];
}
