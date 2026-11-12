// End-to-end check on a phone screen (390 × 844), with the browser clock under control:
//
//   day 0: guest entry → Today → Moonbridge (a separate chunk, no second sign-in) → the hotel
//   map → the unit 1 episode at the reception, a wrong answer into its funny branch and
//   back, to the end → the episode marked done after a reload.
//   day 1, offline: the platform opens from the service worker's cache, the day-0 error is
//   waiting in the lost-and-found, the guest of the day brings unit 1 tasks, the finale
//   shows the streak and tomorrow's guest; back online, every answer reaches the gateway.
//
// Starts its own gateway (in memory, live content) and the built platform (vite preview).
// Run: pnpm e2e        (HEADED=1 to watch it)
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { answerRight, ARTIFACTS, check, PHONE, startServers, step, stopServers, WEB } from "./lib.js";

const EPISODE = "A1_NiceToMeetYou_01_check_in";
const DAY0 = Date.parse("2026-11-09T09:00:00Z"); // 12:00 in Moscow
const DAY_MS = 24 * 3600_000;

async function main(): Promise<void> {
  await mkdir(ARTIFACTS, { recursive: true });
  step("Gateway and the built platform");
  const bundle = await startServers();
  const episode = bundle.moonbridge!.episodes.find((e) => e.episode_id === EPISODE)!;
  check(episode, `the live content has the episode ${EPISODE}`);

  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const context = await browser.newContext(PHONE);
  let page = await context.newPage();
  await page.clock.install({ time: DAY0 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const chunks: string[] = [];
  page.on("request", (r) => r.url().includes("/assets/") && chunks.push(new URL(r.url()).pathname));
  let accepted = 0;
  context.on("response", async (r) => {
    if (!r.url().endsWith("/api/xapi/statements") || r.status() !== 202) return;
    const n = ((await r.json()) as { accepted: number }).accepted;
    accepted += n;
  });
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  try {
    step("Guest entry and Today");
    await page.goto(WEB);
    await page.getByRole("button", { name: "Попробовать без аккаунта" }).click();
    await page.getByLabel("Имя").fill("Анна");
    await page.getByRole("button", { name: "Войти" }).click();
    await page.getByRole("heading", { name: /Анна/ }).waitFor();
    check(await page.locator("[data-section=moonbridge]").isVisible(), "Today shows the Moonbridge card");
    check(await page.locator("[data-first-visit]").isVisible(), "a new student is told to start in the hotel");
    check((await page.locator(".today .card").first().getAttribute("data-section")) === "moonbridge", "the hotel card comes first for a new student");
    check(!chunks.some((c) => c.includes("section-")), "the platform has not downloaded the Moonbridge chunk");
    check(await noSideScroll(), "Today fits a 390 px screen");
    await page.screenshot({ path: `${ARTIFACTS}today.png` });

    step("Into Moonbridge without signing in again");
    await page.locator("[data-section=moonbridge]").click();
    await page.waitForURL(`${WEB}/moonbridge`);

    step("The welcome scene of the first visit");
    const welcome = page.locator(".scene[data-welcome]");
    await welcome.waitFor();
    check(chunks.some((c) => c.includes("section-")), "the Moonbridge chunk loads on demand");
    let lines = 0;
    let named = false;
    let bothLanguages = true;
    while (await welcome.isVisible()) {
      const text = await welcome.locator(".dialog").innerText();
      named ||= /Анна/.test(text) && !/\{name\}/.test(text);
      bothLanguages &&= (await welcome.locator(".dialog .line-ru:not([hidden])").count()) === 1;
      if (lines === 1) await page.screenshot({ path: `${ARTIFACTS}welcome.png` });
      check(await noSideScroll(), `welcome line ${lines + 1} fits a 390 px screen`);
      const before = await welcome.getAttribute("data-step");
      await welcome.locator(".dialog .next").click();
      await page.waitForFunction((prev) => {
        const step = document.querySelector(".scene[data-welcome]")?.getAttribute("data-step");
        return step === undefined || (step !== prev && step !== "end");
      }, before);
      lines += 1;
      if (lines > 20) throw new Error("the welcome does not end");
    }
    check(named, "Rocco greets the student by name");
    check(bothLanguages, "every welcome line shows its translation at once");
    const welcomeEnd = page.locator("[data-welcome-end]");
    check(await welcomeEnd.locator(`[data-start="${EPISODE}"]`).isVisible(), "the welcome ends with the first episode");
    await page.screenshot({ path: `${ARTIFACTS}welcome-end.png` });
    await welcomeEnd.getByRole("button", { name: "Осмотреть отель" }).click();
    await page.locator(".hotel-map").waitFor();
    await page.reload();
    await page.locator(".hotel-map").waitFor();
    check(true, "the second visit opens on the map");
    check(/после первого эпизода/.test(await page.locator("[data-words-card]").innerText()), "Мои слова are empty before the first episode");
    check(await page.getByLabel("Имя").count() === 0, "no second sign-in");
    check(await page.locator('.room.open[data-place="reception"]').isVisible(), "the reception is open");
    check(await noSideScroll(), "the map fits a 390 px screen");
    await page.screenshot({ path: `${ARTIFACTS}map.png` });
    await page.locator(".play-next").click();

    step("The episode, with a wrong answer first");
    const scene = page.locator(`.scene[data-episode="${EPISODE}"]`);
    await scene.waitFor();
    const at = async (id: string) => (await scene.getAttribute("data-step")) === id;
    const next = () => scene.locator(".dialog .next").click();
    await next(); // narration
    const greet = bundle.tasks["A1_NiceToMeetYou_01_hello"]!;
    await scene.locator(".task").waitFor();
    await page.screenshot({ path: `${ARTIFACTS}task.png` });
    await scene.getByRole("button", { name: greet.presentation.options!.find((o) => o.id === "b")!.text }).click();
    await scene.locator('.feedback[data-outcome="wrong"]').waitFor();
    check(await scene.locator(".feedback-note").isVisible(), "the wrong answer shows the author's feedback");
    await scene.getByRole("button", { name: "Дальше" }).click();
    check(await at("greet_wrong"), "the wrong answer leads into its branch");
    check(await scene.locator('.portrait-frame[data-emotion="upset"]').isVisible(), "Rocco is upset in that branch");
    await page.screenshot({ path: `${ARTIFACTS}wrong-branch.png` });
    await next();
    check(await at("greet"), "the branch returns to the task");

    const answered = new Set<string>();
    while (!(await page.locator("[data-episode-end]").isVisible())) {
      const stepId = await scene.getAttribute("data-step");
      const s = episode.steps.find((x) => x.id === stepId)!;
      if (s.kind === "task") {
        await answerRight(page, bundle.tasks[s.task_id]!);
        answered.add(s.id);
        // A typo or other near-miss shows feedback before the story goes on.
        if (await scene.locator(".feedback").isVisible().catch(() => false)) await scene.getByRole("button", { name: "Дальше" }).click();
      } else {
        await next();
      }
      await page.waitForFunction(
        ([sel, prev]) => document.querySelector("[data-episode-end]") || document.querySelector(sel)?.getAttribute("data-step") !== prev,
        [`.scene[data-episode="${EPISODE}"]`, stepId] as const,
      );
      check(await noSideScroll(), `step "${stepId}" fits a 390 px screen`);
    }
    check(answered.size === episode.steps.filter((x) => x.kind === "task").length, "every task of the episode was answered");
    check(await page.locator("[data-episode-end]").getByText(/Эпизод пройден/).isVisible(), "the episode ends");
    await page.screenshot({ path: `${ARTIFACTS}end.png` });

    step("After a reload");
    await page.locator("[data-episode-end] button").click();
    await page.reload();
    await page.locator(".hotel-map").waitFor();
    check(await page.locator(`.episode.done[data-episode="${EPISODE}"]`).isVisible(), "the episode stays done");
    await new Promise((r) => setTimeout(r, 1500));
    check(accepted >= answered.size + 1, `the gateway accepted ${accepted} answer statements`);
    check(await page.locator('[data-shift-card="ready"]').isVisible(), "day 0 already offers a shift with the guest of the day");

    step("Мои слова after the first episode");
    const wordsCard = page.locator("[data-words-card]");
    const waiting = Number(await wordsCard.getAttribute("data-words-card"));
    check(waiting > 0, `the episode's words wait for review: ${waiting}`);
    await wordsCard.click();
    await page.locator(".words").waitFor();
    check((await page.locator(".word[data-status=new]").count()) === Number(await page.locator(".words").getAttribute("data-words")), "every word starts as new");
    check(await noSideScroll(), "the word list fits a 390 px screen");
    await page.screenshot({ path: `${ARTIFACTS}words.png`, fullPage: true });
    await page.locator("[data-review]").click();
    const review = page.locator(".word-review");
    await review.waitFor();
    let cardNo = 0;
    while (await review.isVisible()) {
      await review.locator(".show-answer").click();
      if (cardNo === 0) await page.screenshot({ path: `${ARTIFACTS}word-review.png` });
      check(await noSideScroll(), `word card ${cardNo + 1} fits a 390 px screen`);
      await review.locator(`[data-recall="${cardNo === 0 ? "forgot" : "remembered"}"]`).click();
      await page.locator(".show-answer").or(page.locator("[data-review-end]")).first().waitFor();
      cardNo += 1;
      if (cardNo > 30) throw new Error("the review does not end");
    }
    check(cardNo === Math.min(waiting, 10) + 1, `the forgotten word came back once in the same review (${cardNo} cards)`);
    await page.locator("[data-review-end]").waitFor();
    await page.screenshot({ path: `${ARTIFACTS}review-end.png` });
    await page.locator("[data-review-end]").getByRole("button", { name: "К словам" }).click();
    await page.locator(".words").waitFor();
    check((await page.locator(".word[data-status=learning]").count()) === Math.min(waiting, 10), "reviewed words are now being learned");
    await page.goto(`${WEB}/moonbridge`);
    await page.locator(".hotel-map").waitFor();

    step("Day 1, offline");
    await page.close();
    await context.setOffline(true);
    page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.clock.install({ time: DAY0 + DAY_MS });
    await page.goto(`${WEB}/moonbridge`);
    await page.locator(".hotel-map").waitFor();
    check(true, "the platform and Moonbridge open without a network");
    const card = page.locator('[data-shift-card="ready"]');
    check(/в бюро находок 1 шт/.test(await card.innerText()), "yesterday's error waits in the lost-and-found");
    await page.screenshot({ path: `${ARTIFACTS}shift-card.png` });
    await card.locator(".start-shift").click();
    const shift = page.locator(".scene[data-shift]");
    await shift.waitFor();
    const steps: string[] = [];
    const guestTasks: string[] = [];
    let shot = false;
    while (!(await page.locator("[data-shift-end]").isVisible())) {
      const stepId = (await shift.getAttribute("data-step")) ?? "";
      if (!steps.includes(stepId)) steps.push(stepId);
      const task = shift.locator(".task");
      if (await task.isVisible()) {
        const taskId = (await task.getAttribute("data-task"))!;
        if (stepId.startsWith("guest_")) guestTasks.push(taskId);
        if (!shot && stepId.startsWith("item_")) {
          await page.screenshot({ path: `${ARTIFACTS}lost-and-found.png` });
          shot = true;
        }
        await answerRight(page, bundle.tasks[taskId]!);
        if (await shift.locator(".feedback").isVisible().catch(() => false)) await shift.getByRole("button", { name: "Дальше" }).click();
      } else {
        if (stepId === "guest") await page.screenshot({ path: `${ARTIFACTS}guest.png` }).catch(() => undefined);
        await shift.locator(".dialog .next").click();
      }
      await page.waitForTimeout(50);
      check(await noSideScroll(), `shift step "${stepId}" fits a 390 px screen`);
    }
    check(steps.includes("item_0") && !steps.includes("item_1"), "the lost-and-found brings back exactly yesterday's one error");
    check(guestTasks.length >= 2 && guestTasks.every((id) => bundle.tasks[id]!.module_id === "A1_NiceToMeetYou_01"), `the guest brings ${guestTasks.length} tasks, all from the passed unit`);
    const end = page.locator("[data-shift-end]");
    check(/вернули 1 из 1/.test(await end.innerText()), "the item went back to its owner");
    check((await end.locator("[data-streak]").getAttribute("data-streak")) === "2", "the streak counts day 0 and day 1");
    check(await end.locator("[data-teaser]").isVisible(), "the finale announces tomorrow's guest");
    await page.screenshot({ path: `${ARTIFACTS}shift-end.png` });

    step("Back online");
    const before = accepted;
    await context.setOffline(false);
    for (let i = 0; i < 30 && accepted < before + guestTasks.length + 1; i++) {
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await new Promise((r) => setTimeout(r, 1000));
    }
    check(accepted >= before + guestTasks.length + 1, `the answers given offline reached the gateway (${accepted - before})`);
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  } catch (e) {
    await page.screenshot({ path: `${ARTIFACTS}failure.png` }).catch(() => undefined);
    throw e;
  } finally {
    await browser.close();
  }
  console.log("\nAll good.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(stopServers);
