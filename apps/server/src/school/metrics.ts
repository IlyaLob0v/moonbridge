// The pilot's metrics (plan "Moonbridge: план работ", «Метрики пилота»), counted from the
// answers the gateway keeps from the xAPI intake. Pure: the routes load the rows and the
// content, this file only counts, so every definition below is tested on its own.

const MSK_MS = 3 * 3600_000;
const DAY_MS = 24 * 3600_000;
const WEEK_MS = 7 * DAY_MS;

/** A pause longer than this starts a new session. */
export const SESSION_GAP_MS = 30 * 60_000;
/** Fewer first tries than this on an error type in a week is too little to compare. */
export const MIN_TRIES = 5;

export const TARGETS = {
  practiceDays: 4,
  activeShare: 0.75,
  sessionMinutes: 15,
  voluntaryShare: 0.5,
  lostReturned: 0.7,
} as const;

/** One answer, as `attempts` keeps it. */
export interface MetricAttempt {
  playerId: string;
  answeredAt: Date;
  taskId: string;
  success: boolean;
  errorType: string | null;
  attemptNo: number;
  durationMs: number;
  mode: string | null;
}

export interface MetricStudent {
  id: string;
  name: string;
  playerId: string;
}

export interface MetricsInput {
  students: MetricStudent[];
  attempts: MetricAttempt[];
  /** Monday 00:00 Moscow of the pilot's first week. */
  from: Date;
  now: Date;
  /** The error types a task's known errors can produce, from the live content. */
  taskErrorTypes: (taskId: string) => string[];
  errorLabel?: (errorType: string) => string | undefined;
}

export type Status = "ok" | "below" | "no_data";

export interface Session {
  playerId: string;
  day: string;
  start: Date;
  end: Date;
  minutes: number;
  /** The first session of a Moscow day is the required one; any later one that day is voluntary. */
  voluntary: boolean;
}

export interface WeekMetrics {
  from: string;
  to: string;
  /** False for the week still running. */
  complete: boolean;
  /** Students with at least one answer this week. */
  active: number;
  /** Days with practice per student, averaged over all students of the group. */
  avgDays: number;
  medianSessionMinutes: number | null;
  /** Students with at least one voluntary session this week. */
  voluntaryStudents: number;
  lostOffered: number;
  lostReturned: number;
}

export interface ErrorTrend {
  errorType: string;
  label: string;
  firstWeek: string;
  firstAccuracy: number;
  lastWeek: string;
  lastAccuracy: number;
  /** Percentage points, last minus first. */
  change: number;
}

export interface StudentMetrics {
  id: string;
  name: string;
  /** Days with practice in each week, in order. */
  days: number[];
  sessions: number;
  voluntary: number;
  medianSessionMinutes: number | null;
  lostOffered: number;
  lostReturned: number;
}

export interface Metric {
  value: number | null;
  target: number;
  status: Status;
}

export interface PilotMetrics {
  from: string;
  weeks: WeekMetrics[];
  students: StudentMetrics[];
  summary: {
    practiceDays: Metric;
    /** In the 4th week once it has ended; until then in the last complete week. */
    active: Metric & { week: number | null; students: number; of: number };
    sessionMinutes: Metric;
    voluntaryShare: Metric;
    lostReturned: Metric & { returned: number; offered: number };
    /** `compared` counts the error types with room to grow: below 100% in their first week. */
    errorTypes: { improved: number; compared: number; trends: ErrorTrend[] };
  };
}

export const moscowDay = (at: Date) => new Date(at.getTime() + MSK_MS).toISOString().slice(0, 10);

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * A student's answers cut into sessions: a pause over 30 minutes or a new Moscow day starts a
 * new one. A session lasts from the start of its first answer (the answer time minus the time
 * spent on it) to its last answer.
 */
export function sessionsOf(attempts: MetricAttempt[]): Session[] {
  const byPlayer = new Map<string, MetricAttempt[]>();
  for (const a of attempts) byPlayer.set(a.playerId, [...(byPlayer.get(a.playerId) ?? []), a]);
  const sessions: Session[] = [];
  for (const [playerId, list] of byPlayer) {
    list.sort((a, b) => a.answeredAt.getTime() - b.answeredAt.getTime());
    let current: Session | undefined;
    const days = new Set<string>();
    for (const a of list) {
      const day = moscowDay(a.answeredAt);
      const start = new Date(a.answeredAt.getTime() - Math.max(0, a.durationMs));
      if (current && current.day === day && start.getTime() - current.end.getTime() <= SESSION_GAP_MS) {
        current.end = a.answeredAt;
      } else {
        current = { playerId, day, start, end: a.answeredAt, minutes: 0, voluntary: days.has(day) };
        days.add(day);
        sessions.push(current);
      }
    }
  }
  for (const s of sessions) s.minutes = round1((s.end.getTime() - s.start.getTime()) / 60_000);
  return sessions;
}

/** Pilot metrics for one group, week by week from `from` up to the week holding `now`. */
export function pilotMetrics(input: MetricsInput): PilotMetrics {
  const { students, from, now } = input;
  const players = new Set(students.map((s) => s.playerId));
  const attempts = input.attempts.filter((a) => players.has(a.playerId) && a.answeredAt >= from && a.answeredAt < now);
  const weekCount = Math.max(1, Math.ceil((now.getTime() - from.getTime()) / WEEK_MS));
  const weekOf = (at: Date) => Math.floor((at.getTime() - from.getTime()) / WEEK_MS);
  const sessions = sessionsOf(attempts);
  const lost = attempts.filter((a) => a.mode === "lost_and_found" && a.attemptNo === 1);

  const weeks: WeekMetrics[] = Array.from({ length: weekCount }, (_, w) => {
    const start = new Date(from.getTime() + w * WEEK_MS);
    const end = new Date(start.getTime() + WEEK_MS);
    const inWeek = (at: Date) => at >= start && at < end;
    const days = new Map<string, Set<string>>();
    for (const a of attempts) if (inWeek(a.answeredAt)) days.set(a.playerId, (days.get(a.playerId) ?? new Set()).add(moscowDay(a.answeredAt)));
    const weekSessions = sessions.filter((s) => inWeek(s.start));
    const weekLost = lost.filter((a) => inWeek(a.answeredAt));
    const totalDays = [...days.values()].reduce((n, d) => n + d.size, 0);
    return {
      from: moscowDay(start),
      to: moscowDay(new Date(end.getTime() - DAY_MS)),
      complete: end <= now,
      active: days.size,
      avgDays: students.length ? round1(totalDays / students.length) : 0,
      medianSessionMinutes: median(weekSessions.filter((s) => !s.voluntary).map((s) => s.minutes)),
      voluntaryStudents: new Set(weekSessions.filter((s) => s.voluntary).map((s) => s.playerId)).size,
      lostOffered: weekLost.length,
      lostReturned: weekLost.filter((a) => a.success).length,
    };
  });

  const perStudent: StudentMetrics[] = students.map((s) => {
    const own = sessions.filter((x) => x.playerId === s.playerId);
    const ownLost = lost.filter((a) => a.playerId === s.playerId);
    const days = Array.from({ length: weekCount }, () => new Set<string>());
    for (const a of attempts) if (a.playerId === s.playerId) days[weekOf(a.answeredAt)]?.add(moscowDay(a.answeredAt));
    return {
      id: s.id,
      name: s.name,
      days: days.map((d) => d.size),
      sessions: own.length,
      voluntary: own.filter((x) => x.voluntary).length,
      medianSessionMinutes: median(own.filter((x) => !x.voluntary).map((x) => x.minutes)),
      lostOffered: ownLost.length,
      lostReturned: ownLost.filter((a) => a.success).length,
    };
  });

  // Averages over complete weeks; while the first week runs, over that week.
  const counted = weeks.some((w) => w.complete) ? weeks.filter((w) => w.complete) : weeks;
  const hasAnswers = attempts.length > 0;
  const status = (value: number | null, ok: boolean): Status => (value === null || !hasAnswers ? "no_data" : ok ? "ok" : "below");

  const practiceDays = hasAnswers ? round1(counted.reduce((n, w) => n + w.avgDays, 0) / counted.length) : null;
  const activeIndex = weeks[3]?.complete ? 3 : weeks.map((w) => w.complete).lastIndexOf(true);
  const activeWeek = activeIndex >= 0 ? weeks[activeIndex]! : undefined;
  const activeShare = activeWeek && students.length ? activeWeek.active / students.length : null;
  const sessionMinutes = median(sessions.filter((s) => !s.voluntary).map((s) => s.minutes));
  const voluntaryShare = students.length && hasAnswers ? counted.reduce((n, w) => n + w.voluntaryStudents / students.length, 0) / counted.length : null;
  const lostReturned = lost.length ? lost.filter((a) => a.success).length / lost.length : null;

  return {
    from: moscowDay(from),
    weeks,
    students: perStudent,
    summary: {
      practiceDays: { value: practiceDays, target: TARGETS.practiceDays, status: status(practiceDays, (practiceDays ?? 0) >= TARGETS.practiceDays) },
      active: {
        value: activeShare === null ? null : round1(activeShare * 100),
        target: TARGETS.activeShare * 100,
        status: activeShare === null ? "no_data" : status(activeShare, activeShare >= TARGETS.activeShare),
        week: activeWeek ? activeIndex + 1 : null,
        students: activeWeek?.active ?? 0,
        of: students.length,
      },
      sessionMinutes: { value: sessionMinutes, target: TARGETS.sessionMinutes, status: status(sessionMinutes, (sessionMinutes ?? 0) <= TARGETS.sessionMinutes) },
      voluntaryShare: {
        value: voluntaryShare === null ? null : round1(voluntaryShare * 100),
        target: TARGETS.voluntaryShare * 100,
        status: status(voluntaryShare, (voluntaryShare ?? 0) >= TARGETS.voluntaryShare),
      },
      lostReturned: {
        value: lostReturned === null ? null : round1(lostReturned * 100),
        target: TARGETS.lostReturned * 100,
        status: lostReturned === null ? "no_data" : lostReturned >= TARGETS.lostReturned ? "ok" : "below",
        returned: lost.filter((a) => a.success).length,
        offered: lost.length,
      },
      errorTypes: errorTrends(attempts, weeks, weekOf, input),
    },
  };
}

/**
 * Accuracy growth by error type: first tries at the tasks that can produce the error type,
 * in the first week with enough of them against the last such week.
 */
function errorTrends(attempts: MetricAttempt[], weeks: WeekMetrics[], weekOf: (at: Date) => number, input: MetricsInput): PilotMetrics["summary"]["errorTypes"] {
  const tally = new Map<string, { tries: number; right: number }[]>();
  for (const a of attempts) {
    if (a.attemptNo !== 1) continue;
    const w = weekOf(a.answeredAt);
    for (const type of new Set(input.taskErrorTypes(a.taskId))) {
      const perWeek = tally.get(type) ?? weeks.map(() => ({ tries: 0, right: 0 }));
      const cell = perWeek[w];
      if (!cell) continue;
      cell.tries++;
      if (a.success) cell.right++;
      tally.set(type, perWeek);
    }
  }
  const trends: ErrorTrend[] = [];
  for (const [type, perWeek] of tally) {
    const enough = perWeek.map((c, i) => ({ ...c, i })).filter((c) => c.tries >= MIN_TRIES);
    const first = enough[0];
    const last = enough[enough.length - 1];
    if (!first || !last || first.i === last.i) continue;
    const acc = (c: { tries: number; right: number }) => Math.round((c.right / c.tries) * 100);
    trends.push({
      errorType: type,
      label: input.errorLabel?.(type) ?? type,
      firstWeek: weeks[first.i]!.from,
      firstAccuracy: acc(first),
      lastWeek: weeks[last.i]!.from,
      lastAccuracy: acc(last),
      change: acc(last) - acc(first),
    });
  }
  trends.sort((a, b) => b.change - a.change || a.label.localeCompare(b.label));
  // A type already at 100% in its first week cannot grow, so it neither helps nor hurts.
  const room = trends.filter((t) => t.firstAccuracy < 100);
  return { improved: room.filter((t) => t.change > 0).length, compared: room.length, trends };
}

// ---------- Reminders by e-mail: how many brought the student back.

/** A click followed by an answer within this long counts as a return to practice. */
export const RETURN_WINDOW_MS = 2 * 3600_000;

export type ReminderKind = "evening" | "deadline" | "grade";

export interface EmailSent {
  playerId: string;
  kind: ReminderKind;
  sentAt: Date;
  clickedAt: Date | null;
}

export interface EmailCounts {
  sent: number;
  /** Opened the platform with the e-mail's button. */
  clicked: number;
  /** Clicked and answered at least one task within RETURN_WINDOW_MS after. */
  practiced: number;
}

export interface EmailMetrics extends EmailCounts {
  students: number;
  withEmail: number;
  unsubscribed: number;
  byKind: Record<ReminderKind, EmailCounts>;
  weeks: (EmailCounts & { from: string })[];
}

/**
 * Daily e-mails often land in "Промоакции", so the pilot checks whether they work at all:
 * sent, opened through the button, and followed by practice.
 */
export function emailMetrics(input: {
  emails: EmailSent[];
  attempts: MetricAttempt[];
  from: Date;
  now: Date;
  students: number;
  withEmail: number;
  unsubscribed: number;
}): EmailMetrics {
  const byPlayer = new Map<string, number[]>();
  for (const a of input.attempts) byPlayer.set(a.playerId, [...(byPlayer.get(a.playerId) ?? []), a.answeredAt.getTime()]);
  const practiced = (e: EmailSent) => {
    if (!e.clickedAt) return false;
    const at = e.clickedAt.getTime();
    return (byPlayer.get(e.playerId) ?? []).some((t) => t >= at && t <= at + RETURN_WINDOW_MS);
  };
  const count = (list: EmailSent[]): EmailCounts => ({ sent: list.length, clicked: list.filter((e) => e.clickedAt).length, practiced: list.filter(practiced).length });
  const weekCount = Math.max(1, Math.ceil((input.now.getTime() - input.from.getTime()) / WEEK_MS));
  return {
    ...count(input.emails),
    students: input.students,
    withEmail: input.withEmail,
    unsubscribed: input.unsubscribed,
    byKind: {
      evening: count(input.emails.filter((e) => e.kind === "evening")),
      deadline: count(input.emails.filter((e) => e.kind === "deadline")),
      grade: count(input.emails.filter((e) => e.kind === "grade")),
    },
    weeks: Array.from({ length: weekCount }, (_, w) => {
      const start = input.from.getTime() + w * WEEK_MS;
      return { from: moscowDay(new Date(start)), ...count(input.emails.filter((e) => e.sentAt.getTime() >= start && e.sentAt.getTime() < start + WEEK_MS)) };
    }),
  };
}
