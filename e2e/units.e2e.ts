// End-to-end check of a Moonbridge unit given as homework, on phone screens (390 × 844):
//
//   the teacher creates a group with two students → opens the lesson catalog, finds unit 2
//   (a unit the students have not reached in the hotel yet) and gives it to the whole group
//   with a deadline; gives unit 1 to Boris alone, graded automatically →
//   Anna sees the unit on Today, opens it, plays its episode straight from the homework and
//   comes back: the homework says it is played and waits for a grade →
//   the teacher finds Anna's score in the review queue with the suggested grade already
//   chosen, confirms it → Anna sees the grade → Boris plays unit 1: his grade is there at once,
//   and the teacher's queue stays empty.
//
// Run: pnpm e2e:units        (HEADED=1 to watch it)
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { ARTIFACTS, check, finishEpisode, GATEWAY, hotelMap, noSideScroll, PHONE, startServers, step, stopServers, WEB } from "./lib.js";

const ADMIN = "e2e-admin-token";
const GROUP_UNIT = "A1_WhereAreYouFrom_02";
const BORIS_UNIT = "A1_NiceToMeetYou_01";

/** A Moscow date-time for an <input type="datetime-local">, `days` from now at 18:00. */
function moscowInput(days: number): string {
  const d = new Date(Date.now() + 3 * 3600_000 + days * 24 * 3600_000);
  return `${d.toISOString().slice(0, 10)}T18:00`;
}

async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const res = await fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function signIn(page: Page, login: string, password: string): Promise<void> {
  await page.goto(WEB);
  const form = page.locator('[data-form="sign-in"]');
  await form.getByLabel("Логин").fill(login);
  await form.getByLabel("Пароль").fill(password);
  await form.getByRole("button", { name: "Войти" }).click();
  await page.getByRole("heading", { name: /Ксения|Анна|Борис/ }).first().waitFor();
}

async function main(): Promise<void> {
  await mkdir(ARTIFACTS, { recursive: true });
  step("Gateway and the built platform");
  const bundle = await startServers({ ADMIN_TOKEN: ADMIN });
  const episodeOf = (unit: string) => bundle.moonbridge!.episodes.find((e) => e.module_id === unit)!;
  const unitTitle = bundle.modules.find((m) => m.module_id === GROUP_UNIT)!.title.ru;

  await api("/admin/teachers", { method: "POST", body: JSON.stringify({ name: "Ксения", login: "ksenia", password: "teach-123", email: "ksenia@example.com" }), headers: { authorization: `Bearer ${ADMIN}` } });
  const { token: t } = await api<{ token: string }>("/auth/login", { method: "POST", body: JSON.stringify({ login: "ksenia", password: "teach-123" }) });
  const { group } = await api<{ group: { group_id: string } }>("/school/groups", { method: "POST", body: JSON.stringify({ name: "A1 вечер", schedule: [{ weekday: 2, time: "18:30", minutes: 60 }] }) }, t);
  const { code } = await api<{ code: string }>(`/school/groups/${group.group_id}/invites`, { method: "POST" }, t);
  for (const s of [{ name: "Анна", login: "anna" }, { name: "Борис", login: "boris" }]) {
    await api(`/invites/${code}/join`, { method: "POST", body: JSON.stringify({ ...s, password: "moon-123", email: `${s.login}@example.com`, accept_terms: true }) });
  }
  check(true, "a group with Anna and Boris");

  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const errors: string[] = [];
  const open = async (): Promise<Page> => {
    const context = await browser.newContext(PHONE);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    return page;
  };
  let page = await open();

  try {
    step("The teacher: the lesson catalog");
    const teacher = page;
    await signIn(teacher, "ksenia", "teach-123");
    await teacher.locator('[data-section="teacher"]').click();
    await teacher.locator("[data-catalog-link]").click();
    const units = teacher.locator("[data-catalog-unit]");
    await units.first().waitFor();
    check((await units.count()) === bundle.modules.length, `the catalog lists all ${bundle.modules.length} units`);
    await teacher.getByLabel("Поиск по каталогу").fill("откуда");
    check((await units.count()) >= 1 && (await units.first().getAttribute("data-catalog-unit")) === GROUP_UNIT, "the search finds unit 2");
    check(await noSideScroll(teacher), "the catalog fits a 390 px screen");
    await teacher.screenshot({ path: `${ARTIFACTS}catalog.png`, fullPage: true });

    const unit = teacher.locator(`[data-catalog-unit="${GROUP_UNIT}"]`);
    await unit.locator("summary", { hasText: "Задать как домашку" }).click();
    const form = unit.locator('[data-form="assign-unit"]');
    await form.getByLabel("Срок").fill(moscowInput(3));
    await form.getByLabel("Комментарий для ученика").fill("Пройдите до четверга.");
    await form.getByRole("button", { name: "Задать" }).click();
    await form.locator(".sheet-ok:not([hidden])").waitFor();
    check(/вся группа «A1 вечер»/.test(await form.innerText()), "unit 2 is given to the whole group");
    await teacher.screenshot({ path: `${ARTIFACTS}catalog-assigned.png`, fullPage: true });

    await teacher.getByLabel("Поиск по каталогу").fill("");
    const first = teacher.locator(`[data-catalog-unit="${BORIS_UNIT}"]`);
    await first.locator("summary", { hasText: "Задать как домашку" }).click();
    const bForm = first.locator('[data-form="assign-unit"]');
    await bForm.getByLabel("Кому").selectOption({ label: "Борис" });
    await bForm.getByLabel("Ставить оценку автоматически").check();
    await bForm.getByRole("button", { name: "Задать" }).click();
    await bForm.locator(".sheet-ok:not([hidden])").waitFor();
    check(/Задано: Борис/.test(await bForm.innerText()), "unit 1 is given to Boris alone, graded automatically");

    step("Anna: the unit on Today, played from the homework");
    page = await open();
    await signIn(page, "anna", "moon-123");
    const card = page.locator('[data-card="homework"]');
    check(/Домашка: 1 ждёт/.test(await card.innerText()) && /Пройти в Moonbridge/.test(await card.innerText()), "Today shows the unit to play");
    check(!/Moonbridge: Приятно/.test(await card.innerText()), "and not Boris's unit");
    await page.screenshot({ path: `${ARTIFACTS}unit-today.png`, fullPage: true });
    await card.getByText(`Moonbridge: ${unitTitle}`).click();
    const hwPage = page.locator("[data-homework-page]");
    await hwPage.waitFor();
    check(/Пройдите до четверга/.test(await hwPage.innerText()) && (await hwPage.locator(".unit-episodes li").count()) === 1, "the homework page lists the unit's episode");
    check(await noSideScroll(page), "the homework page fits a 390 px screen");
    await page.screenshot({ path: `${ARTIFACTS}unit-homework.png`, fullPage: true });
    await hwPage.getByRole("button", { name: "Играть в Moonbridge" }).click();
    await finishEpisode(page, bundle, episodeOf(GROUP_UNIT));
    check(true, "the unit 2 episode plays although the hotel has not reached it");
    await page.getByRole("button", { name: "К домашке" }).click();
    await hwPage.waitFor();
    const status = hwPage.locator(".hw-status");
    check(/Пройдено: \d+ из \d+ с первого раза, ждёт оценки/.test(await status.innerText()), `the homework is played: ${await status.innerText()}`);
    await page.screenshot({ path: `${ARTIFACTS}unit-played.png`, fullPage: true });

    step("The teacher: the score in the review queue");
    await teacher.goto(`${WEB}/teacher`);
    const item = teacher.locator(".review-item.unit-result");
    await item.waitFor();
    check(/Анна/.test(await item.innerText()) && /Moonbridge: 3 из 3 с первого раза \(100%\)/.test(await item.innerText()), "Anna's score waits for the teacher");
    check((await item.locator('[data-grade="5"]').getAttribute("aria-checked")) === "true", "with 5 already chosen");
    check(/прошли 1 из 2/.test(await teacher.locator(`.hw-item[data-unit="${GROUP_UNIT}"]`).innerText()), "the group's homework counts who has played it");
    check(/только Борис/.test(await teacher.locator(`.hw-item[data-unit="${BORIS_UNIT}"]`).innerText()), "Boris's unit says it is his alone");
    await teacher.screenshot({ path: `${ARTIFACTS}unit-review.png`, fullPage: true });
    await item.getByLabel("Комментарий").fill("Отлично, все с первого раза!");
    await item.getByRole("button", { name: "Подтвердить оценку" }).click();
    await teacher.locator('[data-queue="0"]').waitFor();
    check(true, "one tap confirms the grade");

    await page.reload();
    await page.locator("[data-homework-page] [data-grade='5']").waitFor();
    check(/Отлично, все с первого раза/.test(await page.locator("[data-homework-page]").innerText()), "Anna sees the grade and the comment");

    step("Boris: graded at once");
    const boris = await open();
    await signIn(boris, "boris", "moon-123");
    await boris.locator("[data-section=moonbridge]").click();
    await hotelMap(boris);
    await boris.locator("[data-board-homework]").first().waitFor();
    check((await boris.locator("[data-board-homework]").count()) === 2, "the lobby board shows both units Boris has to play");
    await boris.locator("[data-board-homework]", { hasText: "Приятно познакомиться" }).click();
    await boris.locator("[data-homework-page]").getByRole("button", { name: "Играть в Moonbridge" }).click();
    await finishEpisode(boris, bundle, episodeOf(BORIS_UNIT));
    await boris.getByRole("button", { name: "К домашке" }).click();
    await boris.locator("[data-homework-page] [data-grade]").waitFor();
    check(/автоматически/.test(await boris.locator("[data-homework-page]").innerText()), "Boris's grade is set from the score without the teacher");
    await boris.screenshot({ path: `${ARTIFACTS}unit-auto-graded.png`, fullPage: true });
    await teacher.reload();
    await teacher.locator('[data-queue="0"]').waitFor();
    check(true, "and the teacher's queue stays empty");
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  } catch (e) {
    await page.screenshot({ path: `${ARTIFACTS}units-failure.png` }).catch(() => undefined);
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
