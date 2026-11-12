import type { GuestTemplate, TimeOfDay } from "@moonbridge/content";
import { el } from "../ui/dom.js";
import type { ShiftPlan } from "./daily.js";
import { residentSpeaker, Stage, type PlayerDeps, type Speaker } from "./player.js";

export interface ShiftResult {
  returned: number;
  items: number;
  guestRight: number;
  guestTotal: number;
}

function guestSpeaker(g: GuestTemplate): Speaker {
  return { id: `guest:${g.guest_id}`, name: g.name, speciesRu: g.species.ru, portraits: g.portrait ? { neutral: g.portrait } : {} };
}

/**
 * The daily shift at the reception: the lost-and-found first (each thing goes back to its
 * owner when the student answers right; a wrong answer keeps it until the error's next day),
 * then the guest of the day. Lines come from content; the narration here is interface text.
 */
export async function playShift(root: HTMLElement, plan: ShiftPlan, d: PlayerDeps & { time?: TimeOfDay }): Promise<ShiftResult> {
  const time = d.time ?? "night";
  const place = d.content.places.find((p) => p.unlocked_by === null) ?? d.content.places[0]!;
  const residents = new Map(d.content.characters.map((c) => [c.character_id, residentSpeaker(c, time)]));
  const host = residents.get(plan.guest?.template.host ?? place.characters[0] ?? "") ?? residents.get(place.characters[0] ?? "");
  d.learner.resetAttempts();
  const stage = new Stage(root, place, time === "day" ? "Дневная смена" : "Ночная смена", { "data-shift": String(plan.day) }, d, time);
  const result: ShiftResult = { returned: 0, items: plan.lostAndFound.length, guestRight: 0, guestTotal: 0 };

  stage.scene.dataset.step = "welcome";
  stage.show(undefined);
  if (plan.returning) await stage.line("Welcome back! Your things are safe with us.", "С возвращением! Всё, что вы оставили, в целости.");

  if (plan.lostAndFound.length) {
    stage.scene.dataset.step = "lost_and_found";
    await stage.line(
      `The lost-and-found has ${plan.lostAndFound.length} ${plan.lostAndFound.length === 1 ? "thing" : "things"} waiting for their owners.`,
      `В бюро находок ${plan.lostAndFound.length} ${ruThings(plan.lostAndFound.length)}. Верный ответ возвращает вещь хозяину.`,
    );
    for (const [n, x] of plan.lostAndFound.entries()) {
      stage.scene.dataset.step = `item_${n}`;
      stage.scene.dataset.item = x.item.item_id;
      stage.show(host);
      const r = await stage.task(x.task, { mode: "lost_and_found", item_id: x.item.item_id, repeat_step: x.repeat.step, day: plan.day });
      if (r.outcome.correct) result.returned++;
      stage.show(host, r.outcome.correct ? "happy" : "upset");
      await stage.line(
        r.outcome.correct ? `${capital(x.item.name.en)} is back with its owner.` : `${capital(x.item.name.en)} stays here for now.`,
        r.outcome.correct ? `${capital(x.item.name.ru)}: вернули хозяину.` : `${capital(x.item.name.ru)}: пока остаётся в бюро, вернётся к вам снова.`,
      );
    }
    delete stage.scene.dataset.item;
  }

  if (plan.guest) {
    const g = plan.guest.template;
    const guest = guestSpeaker(g);
    stage.scene.dataset.step = "guest";
    stage.scene.dataset.guest = g.guest_id;
    d.sound?.play("bell");
    stage.show(guest);
    await stage.line(g.arrival.en, g.arrival.ru);
    for (const [n, task] of plan.guest.tasks.entries()) {
      stage.scene.dataset.step = `guest_${n}`;
      stage.show(guest);
      const r = await stage.task(task, { mode: "guest_of_the_day", guest_id: g.guest_id, day: plan.day });
      result.guestTotal++;
      if (r.outcome.correct) result.guestRight++;
    }
    const pleased = result.guestRight * 2 >= result.guestTotal;
    stage.scene.dataset.step = "guest_bye";
    stage.show(guest, pleased ? "happy" : "upset");
    await stage.line(pleased ? g.thanks.en : g.disappointed.en, pleased ? g.thanks.ru : g.disappointed.ru);
  }
  void d.learner.sync();
  return result;
}

/** The end of the shift: what was done, the streak, and who comes tomorrow. */
export function shiftFinale(plan: ShiftPlan, r: ShiftResult, streakDays: number, onDone: () => void): HTMLElement {
  const lines: HTMLElement[] = [el("h1", {}, "Смена окончена")];
  if (r.items) lines.push(el("p", {}, `Бюро находок: вернули ${r.returned} из ${r.items}.`));
  if (plan.guest) lines.push(el("p", {}, `Гость дня ${plan.guest.template.name}: ${r.guestRight * 2 >= r.guestTotal ? "всё получилось" : "не всё получилось, но без обид"} (${r.guestRight} из ${r.guestTotal}).`));
  lines.push(el("p", { class: "streak", "data-streak": String(streakDays) }, `Дней практики подряд: ${streakDays}. Один пропущенный день серию не прерывает.`));
  if (plan.teaser) {
    lines.push(
      el("div", { class: "teaser", "data-teaser": plan.teaser.guest_id }, el("p", { class: "muted" }, "Завтра"), el("p", { lang: "en" }, plan.teaser.teaser.en), ...(plan.teaser.teaser.ru ? [el("p", { class: "muted", lang: "ru" }, plan.teaser.teaser.ru)] : [])),
    );
  }
  lines.push(el("button", { class: "primary", onclick: onDone }, "В отель"));
  return el("div", { class: "card shift-end", "data-shift-end": String(plan.day) }, ...lines);
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ruThings(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "вещь ждёт хозяина";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "вещи ждут хозяев";
  return "вещей ждут хозяев";
}
