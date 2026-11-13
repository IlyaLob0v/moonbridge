// End-to-end check of the school's texts and forms, on phone screens (390 × 844):
//
//   help and the documents open without an account → a student under 18 joins by the link,
//   ticks the documents and gives a parent's address → the platform shows only "Нужно
//   согласие родителя" → the parent opens the link from the e-mail and consents → the student
//   gets in, finds the entry test on Today and takes it (no hints, no answers shown) → the
//   building of a unit shows its rules, and a wrong answer in an episode folds the rule under the
//   verdict → the teacher gives a unit's voice homework from the catalog, the student hands in a
//   file, the teacher grades it by criteria (the grade fills in by itself) and the student sees
//   the points → the teacher sees the entry test's score on the metrics page, the consents in the
//   student's report, and the teacher's guide.
//
// Run: pnpm e2e:texts        (HEADED=1 to watch it)
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assessment } from "@moonbridge/content";
import { chromium, type Page } from "playwright";
import { answerRight, ARTIFACTS, check, GATEWAY, hotelMap, logOf, noSideScroll, PHONE, ROOT, startServers, step, stopServers, WEB } from "./lib.js";

const ADMIN = "e2e-admin-token";
const STUDENT = { name: "Маша", login: "masha", password: "moon-123", email: "masha@example.com" };
const PARENT = { name: "Ольга", email: "olga.parent@example.com" };
const EPISODE = "A1_NiceToMeetYou_01_check_in";

async function api<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const res = await fetch(`${GATEWAY}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** The latest link to `pattern` the gateway printed in an e-mail to `to`. */
async function mailLink(to: string, pattern: RegExp): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const log = logOf("gateway");
    const at = log.lastIndexOf(`e-mail to ${to}:`);
    const link = at >= 0 ? pattern.exec(log.slice(at))?.[0] : undefined;
    if (link) return link;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no link for ${to} in the gateway log`);
}

async function main(): Promise<void> {
  await mkdir(ARTIFACTS, { recursive: true });
  const shots = `${ARTIFACTS}texts/`;
  await mkdir(shots, { recursive: true });
  const uploads = await mkdtemp(join(tmpdir(), "moonbridge-e2e-uploads-"));
  step("Gateway and the built platform");
  const bundle = await startServers({ ADMIN_TOKEN: ADMIN, UPLOAD_DIR: uploads });
  check(bundle.school?.pages.some((p) => p.page_id === "terms"), "the content has the school's documents");
  check(bundle.school?.assessments.length === 0, "the bundle carries no test answers");
  // The tests as the content has them, answers included: the e2e answers like a student who knows.
  const tests = (JSON.parse(await readFile(`${ROOT}content/school/assessments.json`, "utf8")) as { assessments: Assessment[] }).assessments;
  const entry = tests.find((a) => a.assessment_id === "entry")!;
  if (entry.kind !== "test") throw new Error("entry is a test");

  await api("/admin/teachers", { token: ADMIN, body: { name: "Ксения", login: "ksenia", password: "teach-123", email: "ksenia@example.com" } });
  const t = (await api<{ token: string }>("/auth/login", { body: { login: "ksenia", password: "teach-123" } })).token;
  const groupId = (await api<{ group: { group_id: string } }>("/school/groups", { token: t, body: { name: "Подростки A1", unit_access: "course", schedule: [{ weekday: 3, time: "17:00", minutes: 60 }] } })).group.group_id;
  const invite = (await api<{ url: string }>(`/school/groups/${groupId}/invites`, { token: t, body: {} })).url;
  await api(`/school/groups/${groupId}/assessments/entry/open`, { token: t, body: {} });

  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const errors: string[] = [];
  const open = async (): Promise<Page> => {
    const page = await (await browser.newContext(PHONE)).newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    return page;
  };

  try {
    step("Help and the documents, without an account");
    const visitor = await open();
    await visitor.goto(`${WEB}/help`);
    await visitor.locator("[data-help]").waitFor();
    check(await visitor.locator('[data-help-page="faq"]').isVisible(), "help lists the FAQ");
    check(!(await visitor.locator('[data-help-page="teacher-guide"]').count()), "the teacher's guide is not in a student's help");
    await visitor.screenshot({ path: `${shots}01-pomosch.png`, fullPage: true });
    await visitor.locator('[data-help-page="terms"]').click();
    await visitor.locator('[data-page="terms"]').waitFor();
    check(/Редакция от/.test(await visitor.locator('[data-page="terms"]').innerText()), "a document shows its edition");
    await visitor.screenshot({ path: `${shots}02-oferta.png`, fullPage: true });
    await visitor.close();

    step("A student under 18 joins: the documents and the parent's address");
    const page = await open();
    await page.goto(invite);
    const form = page.locator('[data-form="join"]');
    await form.getByLabel("Имя", { exact: true }).fill(STUDENT.name);
    await form.getByLabel("Логин").fill(STUDENT.login);
    await form.getByLabel("Пароль").fill(STUDENT.password);
    await form.getByLabel("E-mail", { exact: true }).fill(STUDENT.email);
    await form.locator('[data-age="minor"]').check();
    check(await form.locator("[data-parent-fields]").isVisible(), "under 18 asks for the parent");
    await form.getByLabel("Имя родителя").fill(PARENT.name);
    await form.getByLabel("Почта родителя").fill(PARENT.email);
    await form.getByRole("button", { name: "Вступить в группу" }).click();
    check(/согласны с документами/.test(await form.locator(".form-error").innerText()), "without the tick the form does not go");
    await form.locator("[data-accept]").check();
    check(await noSideScroll(page), "the sign-up fits a 390 px screen");
    await page.screenshot({ path: `${shots}03-registraciya-podrostok.png`, fullPage: true });
    await form.getByRole("button", { name: "Вступить в группу" }).click();
    await page.locator('[data-consent-gate="parent"]').waitFor();
    check(/olga\.parent@example\.com/.test(await page.locator("[data-consent-gate]").innerText()), "the student waits for the parent, the address named");
    await page.screenshot({ path: `${shots}04-zhdem-roditelya.png`, fullPage: true });

    step("The parent consents by the link in the e-mail");
    const link = await mailLink(PARENT.email, /http:\/\/localhost:8787\/consent\/parent\?t=[\w-]+/);
    const parent = await open();
    await parent.goto(link);
    check(/Маша/.test(await parent.locator("main").innerText()), "the parent's page names the student");
    await parent.screenshot({ path: `${shots}05-roditel-soglasie.png`, fullPage: true });
    await parent.locator('input[name="agree"]').check();
    await parent.getByRole("button", { name: "Дать согласие" }).click();
    await parent.getByText("Согласие получено").waitFor();
    check(true, "the parent's consent is recorded");
    await parent.close();

    step("The student gets in and takes the entry test");
    await page.locator("[data-refresh]").click();
    const card = page.locator('[data-assessment="entry"]');
    await card.waitFor();
    check(true, "Today shows the entry test");
    await page.screenshot({ path: `${shots}06-segodnya-test.png` });
    await card.click();
    await page.locator("[data-start-test]").click();
    for (const task of entry.tasks) {
      const panel = page.locator(`.task[data-task="${task.task_id}"]`);
      await panel.waitFor();
      check(!(await panel.getByRole("button", { name: "Подсказка" }).count()), `no hint on ${task.task_id}`);
      if (task === entry.tasks[2]) await page.screenshot({ path: `${shots}07-test-zadanie.png` });
      await answerRight(page, task);
    }
    await page.locator("[data-test-done]").waitFor();
    check(!(await page.locator(".feedback").count()), "the test shows no right or wrong");
    await page.screenshot({ path: `${shots}08-test-gotovo.png` });

    step("The rules: in the building of a unit, and under a wrong answer");
    await page.goto(`${WEB}/moonbridge`);
    await hotelMap(page);
    const rules = page.locator(".building-panel [data-unit-rules]");
    await rules.waitFor();
    await rules.locator("summary").first().click();
    await rules.scrollIntoViewIfNeeded();
    check((await rules.locator(".rule-card").count()) >= 2, "the building lists the unit's rules");
    await page.screenshot({ path: `${shots}09-pravila-yunita.png` });
    await page.goto(`${WEB}/moonbridge/episode/${EPISODE}`);
    const scene = page.locator(`.scene[data-episode="${EPISODE}"]`);
    await scene.waitFor();
    // On to the first task whose topic has a rule; the ones before are answered right.
    const hasRule = (id: string) => bundle.modules.some((m) => m.concepts.some((c) => c.concept_id === bundle.tasks[id]?.concept_id && c.explanation_ru));
    let taskId: string | null = null;
    for (;;) {
      if (await scene.locator(".task").isVisible()) {
        taskId = await scene.locator(".task").getAttribute("data-task");
        if (hasRule(taskId!)) break;
        await answerRight(page, bundle.tasks[taskId!]!);
        await page.waitForTimeout(300);
        if (await scene.locator(".feedback").isVisible().catch(() => false)) await scene.getByRole("button", { name: "Дальше" }).click();
        continue;
      }
      await scene.locator(".dialog .next").click();
      await page.waitForTimeout(150);
    }
    const task = bundle.tasks[taskId!]!;
    const wrong = task.presentation.options?.find((o) => !task.answer.accepted.includes(o.id));
    if (wrong) await scene.locator(".task").getByRole("button", { name: wrong.text, exact: true }).click();
    else {
      await scene.getByLabel("Ответ").fill("zzz");
      await scene.getByRole("button", { name: "Ответить" }).click();
    }
    const rule = scene.locator(".feedback .rule-card");
    await rule.waitFor();
    await rule.locator("summary").click();
    check(true, "a wrong answer folds the rule under the verdict");
    await page.screenshot({ path: `${shots}10-pravilo-posle-oshibki.png` });

    step("A unit's voice homework, graded by criteria");
    const teacher = await open();
    await teacher.goto(WEB);
    const signIn = teacher.locator('[data-form="sign-in"]');
    await signIn.getByLabel("Логин").fill("ksenia");
    await signIn.getByLabel("Пароль").fill("teach-123");
    await signIn.getByRole("button", { name: "Войти" }).click();
    await teacher.locator('[data-section="teacher"]').waitFor();
    await teacher.goto(`${WEB}/teacher/catalog`);
    const prompt = teacher.locator('[data-prompt="nicetomeetyou_voice"]');
    await prompt.locator("summary").click();
    await prompt.getByRole("button", { name: "Задать" }).click();
    await prompt.locator(".sheet-ok").waitFor();
    check(/Задано/.test(await prompt.locator(".sheet-ok").innerText()), "the teacher gives the unit's voice homework from the catalog");
    await teacher.screenshot({ path: `${shots}11-katalog-domashka-golosom.png` });

    const st = (await api<{ token: string }>("/auth/login", { body: { login: STUDENT.login, password: STUDENT.password } })).token;
    const hw = (await api<{ homework: { homework_id: string; title: string }[] }>("/school/dashboard", { token: st })).homework.find((h) => h.title.startsWith("Голосом"))!;
    const memo = join(uploads, "memo.m4a");
    await writeFile(memo, Buffer.alloc(2048, 7));
    await page.goto(`${WEB}/homework/${hw.homework_id}`);
    await page.locator("[data-rubric]").waitFor();
    check(/Как оценивается/.test(await page.locator("[data-rubric]").innerText()), "the homework page shows how it is graded");
    await page.locator(".file-input").setInputFiles(memo);
    await page.getByRole("button", { name: "Сдать" }).click();
    await page.locator('[data-status="submitted"]').waitFor();

    await teacher.goto(`${WEB}/teacher`);
    const item = teacher.locator(".review-item").first();
    await item.waitFor();
    const criteria = item.locator(".criterion");
    const n = await criteria.count();
    check(n >= 3, `the review shows ${n} criteria`);
    for (let i = 0; i < n; i++) {
      const buttons = criteria.nth(i).locator(".point");
      await buttons.nth(i === 0 ? (await buttons.count()) - 2 : (await buttons.count()) - 1).click();
    }
    const chosen = await item.locator('.grade[aria-checked="true"]').getAttribute("data-grade");
    check(chosen === "5" || chosen === "4", `the points fill in the grade (${chosen})`);
    await item.scrollIntoViewIfNeeded();
    await teacher.screenshot({ path: `${shots}12-proverka-po-kriteriyam.png` });
    await item.getByRole("button", { name: /Сохранить оценку|Подтвердить оценку/ }).click();
    await teacher.locator('[data-queue="0"]').waitFor();

    await page.reload();
    await page.locator(".review-note").waitFor();
    check(/из 2/.test(await page.locator("[data-rubric]").innerText()), "the student sees the points per criterion");
    await page.screenshot({ path: `${shots}13-uchenik-bally.png`, fullPage: true });

    step("The teacher: the test's score, the consents, the guide");
    await teacher.goto(`${WEB}/teacher/metrics/${groupId}`);
    const section = teacher.locator("[data-assessments]");
    await section.waitFor();
    check(new RegExp(`${entry.tasks.length} из ${entry.tasks.length}`).test(await section.innerText()), "the metrics page shows the entry test's score");
    await section.scrollIntoViewIfNeeded();
    await teacher.screenshot({ path: `${shots}14-metriki-testy.png` });
    const id = (await api<{ account: { id: string } }>("/school/dashboard", { token: st })).account.id;
    await teacher.goto(`${WEB}/teacher/student/${id}`);
    const consent = teacher.locator(".consent-status");
    await consent.waitFor();
    check(/по ссылке из письма/.test(await consent.innerText()), "the report shows the parent's consent and how it came");
    await consent.scrollIntoViewIfNeeded();
    await teacher.screenshot({ path: `${shots}15-otchet-soglasiya.png` });
    await teacher.goto(`${WEB}/help/teacher-guide`);
    await teacher.locator('[data-page="teacher-guide"]').waitFor();
    await teacher.screenshot({ path: `${shots}16-instrukciya-prepodavatelya.png` });

    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
    console.log("\nAll text and form checks passed.");
  } finally {
    await browser.close();
    stopServers();
  }
}

main().catch((e) => {
  console.error(e);
  stopServers();
  process.exit(1);
});
