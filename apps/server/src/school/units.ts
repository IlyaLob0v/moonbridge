import type { ContentBundle, Episode, Module } from "@moonbridge/content";
import type { EpisodeResult } from "@moonbridge/xapi";
import type { Homework, SchoolStore } from "./store.js";

// A Moonbridge unit given as homework: the lesson catalog the teacher picks it from, and how
// the student's finished episodes turn into the homework's result.

/** A unit as the lesson catalog shows it. */
export interface CatalogUnit {
  module_id: string;
  cefr_level: string;
  title: { en: string; ru: string };
  description: string | null;
  skill: Module["skill"];
  /** The episodes to play, in content order; a unit without any cannot be given as homework. */
  episodes: { episode_id: string; title: string; place: string; tasks: number }[];
  tasks: number;
}

const taskSteps = (e: Episode) => e.steps.filter((s) => s.kind === "task").length;

/** The episodes of a unit that the student plays for it. */
export function unitEpisodes(bundle: ContentBundle, moduleId: string): Episode[] {
  return bundle.moonbridge?.episodes.filter((e) => e.module_id === moduleId) ?? [];
}

/** Every unit in course order (then the units no course lists), with its episodes. */
export function catalog(bundle: ContentBundle): CatalogUnit[] {
  const order = [...new Set(bundle.courses.flatMap((c) => c.units))];
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  const places = new Map(bundle.moonbridge?.places.map((p) => [p.place_id, p.name.ru]) ?? []);
  return [...bundle.modules]
    .sort((a, b) => rank(a.module_id) - rank(b.module_id))
    .map((m) => {
      const episodes = unitEpisodes(bundle, m.module_id).map((e) => ({ episode_id: e.episode_id, title: e.title.ru, place: places.get(e.place_id) ?? e.place_id, tasks: taskSteps(e) }));
      return {
        module_id: m.module_id,
        cefr_level: m.cefr_level,
        title: { en: m.title.en, ru: m.title.ru },
        description: m.description?.ru ?? null,
        skill: m.skill,
        episodes,
        tasks: episodes.reduce((n, e) => n + e.tasks, 0),
      };
    });
}

/**
 * The grade a unit's score suggests: 5 from 90% right on the first try, 4 from 75%, 3 from 50%,
 * 2 below. The teacher sees it pre-selected in the review queue and may change it.
 */
export function suggestedGrade(right: number, total: number): number {
  const share = total > 0 ? right / total : 1;
  return share >= 0.9 ? 5 : share >= 0.75 ? 4 : share >= 0.5 ? 3 : 2;
}

/** How far a student is with a unit homework: the episodes played since it was given. */
export async function unitProgress(store: SchoolStore, bundle: ContentBundle, playerId: string, h: Homework) {
  const episodes = unitEpisodes(bundle, h.moduleId!);
  const best = new Map((await store.bestEpisodeResults(playerId, h.moduleId!, h.createdAt)).map((r) => [r.episodeId, r]));
  return episodes.map((e) => ({ episode: e, result: best.get(e.episode_id) }));
}

export const AUTO_GRADE_COMMENT = "Оценка выставлена автоматически по результату в Moonbridge.";

/**
 * Called when finished episodes come in: every unit homework of these players whose episodes
 * are now all played since it was given gets its result, as a hand-in with a score. A result
 * already graded is never touched; an ungraded one is replaced by a better play.
 */
export async function settleUnitHomework(store: SchoolStore, bundle: ContentBundle, results: EpisodeResult[], now: Date): Promise<void> {
  for (const playerId of new Set(results.map((r) => r.playerId))) {
    const account = await store.accountByPlayer(playerId);
    if (!account || account.role !== "student") continue;
    const modules = new Set(results.filter((r) => r.playerId === playerId).map((r) => r.moduleId));
    const groups = await store.groupsOf(account);
    const homework = (await store.homeworkOf(groups.map((g) => g.groupId), account.accountId)).filter((h) => h.moduleId && modules.has(h.moduleId));
    if (!homework.length) continue;
    const handedIn = await store.submissionsFor(homework.map((h) => h.homeworkId), account.accountId);
    for (const h of homework) {
      const before = handedIn.find((s) => s.homeworkId === h.homeworkId);
      if (before?.review) continue;
      const progress = await unitProgress(store, bundle, playerId, h);
      if (!progress.length || progress.some((p) => !p.result)) continue;
      const right = progress.reduce((n, p) => n + p.result!.right, 0);
      const total = progress.reduce((n, p) => n + p.result!.tasks, 0);
      if (before?.score && before.score.right >= right && before.score.total === total) continue;
      const at = new Date(Math.max(...progress.map((p) => p.result!.finishedAt.getTime())));
      const s = await store.submitUnit({ homeworkId: h.homeworkId, accountId: account.accountId, right, total, at });
      if (s && h.autoGrade) await store.review(s.submissionId, suggestedGrade(right, total), AUTO_GRADE_COMMENT, now);
    }
  }
}
