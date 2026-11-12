// A rehearsal of the friends' run on phone screens (390 × 844): three students practise for
// five days, each on their own phone with the browser clock moved day by day, and the
// teacher reads the result on the pilot's metrics page.
//
//   Анна comes every day: the shift at 18:00 and the next episode at 21:00 (a voluntary session).
//   Борис comes every day and plays both at once; on day 3 he reports a problem from the hotel map.
//   Вера comes on days 1, 2 and 4 and gets her day-2 lost-and-found item wrong.
//   Everyone gets the first task of the first episode wrong, so the lost-and-found fills up.
//
// Nothing may break: no page errors, every answer reaches the gateway, every screen fits.
// Then the metrics page shows the days, sessions, lost-and-found and the report.
//
// Run: pnpm e2e:pilot        (HEADED=1 to watch it)
import { mkdir } from "node:fs/promises";
import type { ContentBundle, Task } from "@moonbridge/content";
import { chromium, type BrowserContext, type Page } from "playwright";
import { answerRight, ARTIFACTS, check, GATEWAY, noSideScroll, PHONE, startServers, step, stopServers, WEB } from "./lib.js";

const ADMIN = "e2e-admin-token";
const DAY_MS = 24 * 3600_000;
const MSK_MS = 3 * 3600_000;

/** 18:00 Moscow, `daysAgo` days before today: the five days end in the past, so the gateway counts them all. */
function eveningMoscow(daysAgo: number): number {
  const today = new Date(Date.now() + MSK_MS).toISOString().slice(0, 10);
  return Date.parse(`${today}T18:00:00+03:00`) - daysAgo * DAY_MS;
}
const DAY1 = eveningMoscow(6);

interface Student {
  name: string;
  login: string;
  days: number[];
  /** Anna plays the episode three hours after the shift. */
  eveningEpisode?: boolean;
  wrongItemOnDay?: number;
  reportOnDay?: number;
  context?: BrowserContext;
  answered: number;
}

const students: Student[] = [
  { name: "Анна", login: "anna", days: [1, 2, 3, 4, 5], eveningEpisode: true, answered: 0 },
  { name: "Борис", login: "boris", days: [1, 2, 3, 4, 5], reportOnDay: 3, answered: 0 },
  { name: "Вера", login: "vera", days: [1, 2, 4], wrongItemOnDay: 2, answered: 0 },
];

async function api<T>(path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<{ status: number; json: T }> {
  const res = await fetch(`${GATEWAY}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => undefined)) as T };
}

/** A wrong answer of the task's own type. */
async function answerWrong(page: Page, task: Task): Promise<void> {
  const panel = page.locator(`.task[data-task="${task.task_id}"]`);
  await panel.waitFor();
  const accepted = new Set(task.answer.accepted);
  switch (task.type) {
    case "choice":
    case "translate_en_ru":
      return panel.getByRole("button", { name: task.presentation.options!.find((o) => !accepted.has(o.id))!.text, exact: true }).click();
    case "find_error": {
      const i = task.presentation.tokens!.findIndex((_, n) => !accepted.has(String(n)));
      return panel.locator(".find-line button").nth(i).click();
    }
    case "order_words":
      for (const word of [...task.answer.accepted[0]!.split(" ")].reverse()) await panel.locator(".order-bank button").filter({ hasText: new RegExp(`^${word.replace(/[?.]/g, "\\$&")}$`) }).first().click();
      return panel.getByRole("button", { name: "Ответить" }).click();
    default:
      await panel.getByLabel("Ответ").fill("qqq");
      return panel.getByRole("button", { name: "Ответить" }).click();
  }
}

/**
 * Plays the scene on screen (an episode or the shift) to its end. `wrong` picks the tasks to
 * get wrong, by the scene's step. Returns the number of answers given.
 */
async function playScene(page: Page, bundle: ContentBundle, scene: string, end: string, wrong: (stepId: string, taskId: string) => boolean): Promise<number> {
  const s = page.locator(scene);
  await s.waitFor();
  let answers = 0;
  const done = new Set<string>();
  for (let guard = 0; !(await page.locator(end).isVisible()); guard++) {
    if (guard > 200) throw new Error(`${scene} does not end`);
    const stepId = (await s.getAttribute("data-step")) ?? "";
    const task = s.locator(".task");
    if (await task.isVisible()) {
      const taskId = (await task.getAttribute("data-task"))!;
      const key = `${stepId}/${taskId}`;
      if (wrong(stepId, taskId) && !done.has(key)) await answerWrong(page, bundle.tasks[taskId]!);
      else await answerRight(page, bundle.tasks[taskId]!);
      done.add(key);
      answers++;
      // Either feedback comes up or the scene moves on.
      await page.waitForFunction(
        ([sel, endSel, prev]) =>
          document.querySelector(`${sel} .feedback`) ||
          document.querySelector(endSel) ||
          document.querySelector(sel)?.getAttribute("data-step") !== prev ||
          (!document.querySelector(`${sel} .task`) && document.querySelector(`${sel} .dialog .next`)),
        [scene, end, stepId] as const,
      );
      if (await s.locator(".feedback").isVisible()) await s.getByRole("button", { name: "Дальше" }).click();
    } else {
      await s.locator(".dialog .next").click();
    }
    await page.waitForTimeout(60);
    if (!(await noSideScroll(page))) throw new Error(`${scene} step ${stepId} is wider than the screen`);
  }
  return answers;
}

async function main(): Promise<void> {
  await mkdir(ARTIFACTS, { recursive: true });
  step("Gateway, the teacher, the group and three students");
  const bundle = await startServers({ ADMIN_TOKEN: ADMIN });
  const teacherCreated = await api("/admin/teachers", { token: ADMIN, body: { name: "Ксения", login: "ksenia", password: "teach-123", email: "ksenia@example.com" } });
  check(teacherCreated.status === 201, "the admin creates the teacher");
  const teacherToken = (await api<{ token: string }>("/auth/login", { body: { login: "ksenia", password: "teach-123" } })).json.token;
  const group = (await api<{ group: { group_id: string } }>("/school/groups", { token: teacherToken, body: { name: "Друзья", schedule: [], unit_access: "course" } })).json.group;
  const invite = (await api<{ code: string }>(`/school/groups/${group.group_id}/invites`, { token: teacherToken, body: {} })).json;
  for (const s of students) {
    const joined = await api(`/invites/${invite.code}/join`, { body: { name: s.name, login: s.login, password: "moon-123", email: `${s.login}@example.com` } });
    check(joined.status === 201 || joined.status === 200, `${s.name} has an account`);
  }

  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const errors: string[] = [];
  let lastPage: Page | undefined;
  const dayPage = async (s: Student, at: number): Promise<Page> => {
    s.context ??= await browser.newContext(PHONE);
    const page = await s.context.newPage();
    page.on("pageerror", (e) => errors.push(`${s.name}: ${e.message}`));
    await page.clock.install({ time: at });
    lastPage = page;
    return page;
  };

  try {
    for (let day = 1; day <= 5; day++) {
      step(`Day ${day}`);
      for (const s of students.filter((x) => x.days.includes(day))) {
        const at = DAY1 + (day - 1) * DAY_MS + students.indexOf(s) * 10 * 60_000;
        let page = await dayPage(s, at);
        if (day === 1) {
          await page.goto(WEB);
          const form = page.locator('[data-form="sign-in"]');
          await form.getByLabel("Логин").fill(s.login);
          await form.getByLabel("Пароль").fill("moon-123");
          await form.getByRole("button", { name: "Войти" }).click();
          await page.getByRole("heading", { name: new RegExp(s.name) }).waitFor();
        }
        await page.goto(`${WEB}/moonbridge`);
        await page.locator(".hotel-map").waitFor();

        const shiftCard = page.locator('[data-shift-card="ready"]');
        if (await shiftCard.isVisible()) {
          await shiftCard.locator(".start-shift").click();
          const n = await playScene(page, bundle, ".scene[data-shift]", "[data-shift-end]", (stepId) => s.wrongItemOnDay === day && stepId === "item_0");
          s.answered += n;
          check(true, `${s.name}: the shift, ${n} answers`);
          await page.goto(`${WEB}/moonbridge`);
          await page.locator(".hotel-map").waitFor();
        }

        if (s.reportOnDay === day) {
          await page.locator("[data-feedback-open]").click();
          await page.getByLabel("Что случилось").fill("На карте отеля не понял, куда нажимать после смены");
          await page.locator("[data-feedback-send]").click();
          await page.locator("[data-feedback-open][data-sent]").waitFor();
          check(true, `${s.name} reports a problem from the hotel map`);
        }

        if (s.eveningEpisode && (await page.locator(".play-next").isVisible())) {
          // Three hours later: the second session of the day.
          await page.close();
          page = await dayPage(s, at + 3 * 3600_000);
          await page.goto(`${WEB}/moonbridge`);
          await page.locator(".hotel-map").waitFor();
        }
        const play = page.locator(".play-next");
        if (await play.isVisible()) {
          const episodeTitle = await play.innerText();
          await play.click();
          let first = true;
          const n = await playScene(page, bundle, ".scene[data-episode]", "[data-episode-end]", () => {
            const w = day === 1 && first;
            first = false;
            return w;
          });
          s.answered += n;
          check(true, `${s.name}: ${episodeTitle.replace("Играть: ", "")}, ${n} answers${day === 1 ? " (the first one wrong)" : ""}`);
        }
        // Answers go out on the next sync; give them a moment before the phone is put away.
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await page.waitForTimeout(800);
        await page.close();
      }
    }

    // The next morning everyone opens the platform once: whatever was still queued on a phone goes out.
    for (const s of students) {
      const page = await dayPage(s, DAY1 + 5 * DAY_MS - 9 * 3600_000);
      await page.goto(WEB);
      await page.getByRole("heading", { name: new RegExp(s.name) }).waitFor();
      await page.waitForTimeout(1500);
      await page.close();
    }
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);

    step("The teacher reads the pilot's metrics");
    type Metrics = { weeks: { from: string }[]; students: { id: string; name: string; days: number[]; voluntary: number }[]; summary: { lostReturned: { offered: number; returned: number } } };
    const metrics = (await api<{ metrics: Metrics }>(`/school/groups/${group.group_id}/metrics`, { token: teacherToken })).json.metrics;
    // Every answer reached the gateway: the weekly reports count them.
    for (const s of students) {
      const id = metrics.students.find((x) => x.name === s.name)!.id;
      let kept = 0;
      for (const w of metrics.weeks) kept += (await api<{ practice: { answers: number } }>(`/school/students/${id}/report?week=${w.from}`, { token: teacherToken })).json.practice.answers;
      check(kept === s.answered, `${s.name}: all ${s.answered} answers reached the gateway${kept === s.answered ? "" : ` (only ${kept})`}`);
    }
    const days = (name: string) => metrics.students.find((x) => x.name === name)!.days.reduce((a, b) => a + b, 0);
    check(days("Анна") === 5 && days("Борис") === 5 && days("Вера") === 3, `days with practice: Анна ${days("Анна")}, Борис ${days("Борис")}, Вера ${days("Вера")}`);
    // Days 2–4: the shift, then the episode in the evening. Day 1 has no shift yet, day 5 no new episode.
    check(metrics.students.find((x) => x.name === "Анна")!.voluntary === 3, "Анна's three evening episodes after a shift count as voluntary sessions");
    check(metrics.students.find((x) => x.name === "Борис")!.voluntary === 0, "Борис's shift and episode in one go are one session a day");
    const lost = metrics.summary.lostReturned;
    check(lost.offered >= 6 && lost.returned < lost.offered, `the lost-and-found: ${lost.returned} of ${lost.offered} things went back`);

    const teacherContext = await browser.newContext(PHONE);
    const page = await teacherContext.newPage();
    page.on("pageerror", (e) => errors.push(`teacher: ${e.message}`));
    lastPage = page;
    await page.goto(WEB);
    const form = page.locator('[data-form="sign-in"]');
    await form.getByLabel("Логин").fill("ksenia");
    await form.getByLabel("Пароль").fill("teach-123");
    await form.getByRole("button", { name: "Войти" }).click();
    await page.locator('[data-section="teacher"]').click();
    await page.locator(`[data-metrics="${group.group_id}"]`).click();
    await page.locator("[data-targets]").waitFor();
    check(await page.locator('[data-metric="practice-days"]').isVisible(), "the page shows the plan's targets");
    check((await page.locator('[data-metric="lost"]').innerText()).includes(`${lost.returned} из ${lost.offered}`), "with the lost-and-found count");
    check((await page.locator(".metric-students li").count()) === 3, "and each of the three students");
    check((await page.locator("[data-feedback-count]").getAttribute("data-feedback-count")) === "1", "Борис's report is on the page");
    check(/куда нажимать/.test(await page.locator(".feedback-list").innerText()), "with the tester's words and the page it came from");
    check(await noSideScroll(page), "the metrics page fits a 390 px screen");
    await page.screenshot({ path: `${ARTIFACTS}metrics.png`, fullPage: true });

    await page.locator('input[name="pilot-from"]').fill(new Date(DAY1 + MSK_MS).toISOString().slice(0, 10));
    await page.locator("[data-save-pilot]").click();
    await page.getByText("Начало пилота", { exact: true }).waitFor();
    check(true, "the teacher fixes the pilot's first day");
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  } catch (e) {
    await lastPage?.screenshot({ path: `${ARTIFACTS}pilot-failure.png` }).catch(() => undefined);
    throw e;
  } finally {
    await browser.close();
    stopServers();
  }
  console.log("\nAll good.");
}

main().catch((e) => {
  console.error(e);
  stopServers();
  process.exit(1);
});
