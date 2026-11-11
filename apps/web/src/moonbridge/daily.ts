import type { ContentBundle, Course, GuestTemplate, LostItem, Task } from "@moonbridge/content";
import { pickTask, tasksByConcept, type RepeatItem } from "@moonbridge/learning";
import type { Learner } from "../core/learner.js";
import { hotelView, studentCourse, type MoonbridgeState } from "./progress.js";

/** The whole daily shift should fit into this, by the student's own answer times. */
export const SHIFT_BUDGET_MS = 15 * 60_000;
/** Lost-and-found items per shift; the rest stay overdue and come first tomorrow. */
export const MAX_ITEMS = 6;
const MIN_GUEST_TASKS = 2;
/** Reading the task, the feedback and the line around it. */
const OVERHEAD_PER_TASK_MS = 12_000;
/** Arrival, goodbye and finale lines. */
const FIXED_OVERHEAD_MS = 45_000;
const DEFAULT_ANSWER_MS = 40_000;

export interface StreakView {
  /** Practice days in the current run. One missed day does not break it, two in a row do. */
  days: number;
  practicedToday: boolean;
  /** Days since the last practice; undefined before the first one. */
  daysAway: number | undefined;
}

/**
 * The soft streak: it counts days with practice, forgives a single missed day and never
 * goes below zero into blame. Practice days are school days (RepeatSchedule.day).
 */
export function streakOf(practiceDays: number[], today: number): StreakView {
  const days = [...new Set(practiceDays)].filter((d) => d <= today).sort((a, b) => b - a);
  const last = days[0];
  if (last === undefined) return { days: 0, practicedToday: false, daysAway: undefined };
  const daysAway = today - last;
  if (daysAway > 2) return { days: 0, practicedToday: false, daysAway };
  let run = 1;
  for (let i = 1; i < days.length && days[i - 1]! - days[i]! <= 2; i++) run++;
  return { days: run, practicedToday: daysAway === 0, daysAway };
}

export interface ShiftInput {
  bundle: ContentBundle;
  course: Course;
  /** Units the student has passed: the guest's tasks come only from these. */
  studiedUnits: string[];
  /** RepeatSchedule.due(now): errors coming back today, the longest overdue first. */
  due: RepeatItem[];
  day: number;
  practiceDays: number[];
  /** When each task was last shown, epoch ms (from the journal). */
  lastSeen: Map<string, number>;
  /** The student's median answer time per concept (from the journal). */
  medians: Map<string, number>;
  now: number;
}

export interface ShiftPlan {
  day: number;
  lostAndFound: { item: LostItem; repeat: RepeatItem; task: Task }[];
  guest?: { template: GuestTemplate; tasks: Task[] };
  /** Tomorrow's guest, announced at the end of today's shift. */
  teaser?: GuestTemplate;
  estimatedMs: number;
  streak: StreakView;
  /** Back after two or more days away: a warmer welcome, no reproach. */
  returning: boolean;
}

/** The guest of a given day: guests take turns, so tomorrow's is always known today. */
export function guestOfDay(guests: GuestTemplate[], day: number): GuestTemplate | undefined {
  return guests.length ? guests[((day % guests.length) + guests.length) % guests.length] : undefined;
}

/** The thing that stands for an error in the lost-and-found; the same concept always loses the same thing. */
export function itemFor(items: LostItem[], conceptId: string): LostItem {
  return items[hash(conceptId) % items.length]!;
}

/**
 * Plans one daily shift: the lost-and-found brings back today's 1/3/7 errors as things
 * their owners left behind, then the guest of the day asks for help with tasks from units
 * the student has already passed. The plan is trimmed to fit 15 minutes at the student's
 * own pace: guest tasks go first (down to two), then lost-and-found items wait for tomorrow.
 */
export function planShift(i: ShiftInput): ShiftPlan | undefined {
  const daily = i.bundle.moonbridge?.daily;
  if (!daily) return undefined;
  const random = seeded(i.day);
  const pools = tasksByConcept(i.bundle);
  const used = new Set<string>();

  const lostAndFound: ShiftPlan["lostAndFound"] = [];
  for (const repeat of i.due) {
    if (lostAndFound.length >= MAX_ITEMS) break;
    const task = pickTask(pools.get(repeat.concept_id) ?? [], { lastSeen: i.lastSeen, now: i.now, exclude: used, random });
    if (!task) continue;
    used.add(task.task_id);
    lostAndFound.push({ item: itemFor(daily.lost_items, repeat.concept_id), repeat, task });
  }

  const template = guestOfDay(daily.guests, i.day);
  let guestTasks: Task[] = [];
  if (template) {
    const studied = new Set(i.studiedUnits);
    const pool = i.bundle.modules
      .filter((m) => studied.has(m.module_id))
      .flatMap((m) => m.tasks)
      .map((id) => i.bundle.tasks[id])
      .filter((t): t is NonNullable<typeof t> => t !== undefined && !used.has(t.task_id));
    // Never-seen and long-unseen tasks first, ties broken by the day's shuffle.
    guestTasks = shuffle(pool, random)
      .sort((a, b) => (i.lastSeen.get(a.task_id) ?? 0) - (i.lastSeen.get(b.task_id) ?? 0))
      .slice(0, template.task_count ?? 4);
  }

  const answerMs = (t: Task) => (i.medians.get(t.concept_id) ?? DEFAULT_ANSWER_MS) + OVERHEAD_PER_TASK_MS;
  const estimate = () =>
    FIXED_OVERHEAD_MS + lostAndFound.reduce((s, x) => s + answerMs(x.task), 0) + guestTasks.reduce((s, t) => s + answerMs(t), 0);
  while (estimate() > SHIFT_BUDGET_MS && guestTasks.length > MIN_GUEST_TASKS) guestTasks.pop();
  while (estimate() > SHIFT_BUDGET_MS && lostAndFound.length > 0) lostAndFound.pop();
  if (estimate() > SHIFT_BUDGET_MS) guestTasks = [];
  if (guestTasks.length < MIN_GUEST_TASKS) guestTasks = [];

  const streak = streakOf(i.practiceDays, i.day);
  const teaser = guestOfDay(daily.guests, i.day + 1);
  return {
    day: i.day,
    lostAndFound,
    ...(template && guestTasks.length ? { guest: { template, tasks: guestTasks } } : {}),
    ...(teaser ? { teaser } : {}),
    estimatedMs: estimate(),
    streak,
    returning: (streak.daysAway ?? 0) >= 3,
  };
}

/** Today's shift for this student, or undefined when the content has no daily loop. */
export async function todaysShift(learner: Learner, state: MoonbridgeState, opened?: Set<string>): Promise<ShiftPlan | undefined> {
  const bundle = learner.bundle;
  const course = studentCourse(bundle);
  if (!bundle.moonbridge || !course) return undefined;
  const now = learner.now();
  return planShift({
    bundle,
    course,
    studiedUnits: hotelView(bundle.moonbridge, course, state, opened).studiedUnits,
    due: learner.repeats.due(now),
    day: learner.day(now),
    practiceDays: state.practice_days,
    ...(await learner.pace()),
    now: now.getTime(),
  });
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A small seeded generator, so the same day plans the same shift on every reload. */
function seeded(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(list: T[], random: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
