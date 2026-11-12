// End-to-end check of the school around Moonbridge, on phone screens (390 × 844):
//
//   the admin creates a teacher → the teacher signs in, creates a group with its schedule
//   and call link, makes an invitation link and sets homework handed in as a file →
//   a student opens the link on phone 1, creates an account, sees the next lesson and the
//   homework on Today and on the board in the Moonbridge lobby, uploads a voice memo
//   (a file over 50 MB is refused first) and plays the unit 1 episode →
//   on phone 2 the student signs in with the same login: the episode is still done and the
//   homework still handed in → the teacher sees the hand-in and downloads the file →
//   the teacher grades it from the review queue, sees the student's week and their weekly
//   report, and sets a new password; the teacher adds a lesson, posts its materials and
//   recording and marks attendance, and the student finds them on Today and in their lessons → the student signs in with it and finds the grade →
//   the teacher downloads the course as a sheet, uploads it with a mistake (the check names
//   the row), fixes it and publishes: the platform serves the new task text.
//
// Run: pnpm e2e:school        (HEADED=1 to watch it)
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readXlsx, SHEETS, writeXlsx, type Workbook } from "@moonbridge/content/sheet";
import { chromium, type Page } from "playwright";
import { ARTIFACTS, check, finishEpisode, GATEWAY, hotelMap, logOf, noSideScroll, PHONE, startServers, step, stopServers, WEB } from "./lib.js";

const EPISODE = "A1_NiceToMeetYou_01_check_in";
const ADMIN = "e2e-admin-token";
const STUDENT = { name: "Анна", login: "anna.k", password: "moon-123", email: "anna.k@example.com" };

/** A Moscow date-time for an <input type="datetime-local">, `days` from now at 18:00. */
function moscowInput(days: number): string {
  const d = new Date(Date.now() + 3 * 3600_000 + days * 24 * 3600_000);
  return `${d.toISOString().slice(0, 10)}T18:00`;
}

async function main(): Promise<void> {
  await mkdir(ARTIFACTS, { recursive: true });
  const uploads = await mkdtemp(join(tmpdir(), "moonbridge-e2e-uploads-"));
  step("Gateway and the built platform");
  // Without Postbox the confirmation is off by default; here it is on, and the links come from the log.
  const bundle = await startServers({ ADMIN_TOKEN: ADMIN, UPLOAD_DIR: uploads, EMAIL_VERIFICATION: "required" });
  /** The latest confirmation link the gateway printed for this address. */
  const verifyLink = async (to: string): Promise<string> => {
    for (let i = 0; i < 50; i++) {
      const log = logOf("gateway");
      const at = log.lastIndexOf(`e-mail to ${to}:`);
      const link = at >= 0 ? /http:\/\/localhost:8787\/email\/verify\?t=[\w-]+/.exec(log.slice(at))?.[0] : undefined;
      if (link) return link;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no confirmation link for ${to} in the gateway log`);
  };
  const episode = bundle.moonbridge!.episodes.find((e) => e.episode_id === EPISODE)!;

  const created = await fetch(`${GATEWAY}/admin/teachers`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Ксения", login: "ksenia", password: "teach-123", email: "ksenia@example.com" }),
  });
  check(created.status === 201, "the admin creates the teacher's account");
  const confirmed = await fetch(await verifyLink("ksenia@example.com"), { redirect: "manual" });
  check(confirmed.status === 302, "the teacher confirms her address by the link in the e-mail");

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
    step("The teacher: group, invitation, homework");
    const teacher = page;
    await teacher.goto(WEB);
    const signInForm = teacher.locator('[data-form="sign-in"]');
    await signInForm.getByLabel("Логин").fill("ksenia");
    await signInForm.getByLabel("Пароль").fill("teach-123");
    await signInForm.getByRole("button", { name: "Войти" }).click();
    await teacher.locator('[data-section="teacher"]').click();
    const groupForm = teacher.locator('[data-form="group"]');
    await groupForm.getByLabel("Название").fill("A1 вечер");
    await groupForm.getByLabel("Ссылка на звонок").fill("https://telemost.yandex.ru/j/12345");
    await groupForm.getByLabel("Вт").check();
    await groupForm.getByLabel("Чт").check();
    await groupForm.getByLabel("Время").fill("18:30");
    await groupForm.getByRole("button", { name: "Создать группу" }).click();
    const group = teacher.locator(".group").first();
    await group.waitFor();
    check(/вт и чт в 18:30/.test(await group.innerText()), "the group shows its schedule");
    check((await group.getByLabel("Юниты Moonbridge").inputValue()) === "assigned", "units open when the teacher gives them, by default");
    await group.getByLabel("Юниты Moonbridge").selectOption("course");
    await group.getByText("Сохранено").waitFor();
    check(true, "the teacher lets this group's units open in course order");
    await group.getByRole("button", { name: "Пригласить ученика" }).click();
    const inviteUrl = await group.locator(".invite-url").inputValue();
    check(inviteUrl.startsWith(`${WEB}/join/`), `the invitation link is ${inviteUrl}`);
    await group.locator("summary", { hasText: "Новая домашка" }).click();
    const hwForm = group.locator('[data-form="homework"]');
    await hwForm.getByLabel("Название").fill("Расскажи о себе");
    await hwForm.getByLabel("Что сделать").fill("Запиши на диктофон 30 секунд: как тебя зовут и откуда ты.");
    await hwForm.getByLabel("Срок").fill(moscowInput(3));
    await hwForm.getByRole("button", { name: "Задать" }).click();
    await teacher.locator(".hw-item").first().waitFor();
    check(/сдали 0 из 0/.test(await teacher.locator(".hw-item").first().innerText()), "the homework waits for hand-ins");
    check(await noSideScroll(teacher), "the teacher's cabinet fits a 390 px screen");
    await teacher.screenshot({ path: `${ARTIFACTS}teacher.png`, fullPage: true });

    step("Phone 1: the student joins by the link");
    page = await open();
    await page.goto(inviteUrl);
    const joinForm = page.locator('[data-form="join"]');
    check(/A1 вечер/.test(await joinForm.innerText()) && /Ксения/.test(await joinForm.innerText()), "the link names the group and the teacher");
    await page.screenshot({ path: `${ARTIFACTS}join.png` });
    await joinForm.getByLabel("Имя").fill(STUDENT.name);
    await joinForm.getByLabel("Логин").fill(STUDENT.login);
    await joinForm.getByLabel("Пароль").fill(STUDENT.password);
    await joinForm.getByLabel("E-mail", { exact: true }).fill(STUDENT.email);
    await joinForm.getByRole("button", { name: "Вступить в группу" }).click();
    await page.locator('[data-gate="email"]').waitFor();
    check((await page.locator('[data-card="email"]').innerText()).includes(STUDENT.email), "until she confirms her address, the platform shows only «Подтвердите почту»");
    check(await noSideScroll(page), "the confirmation screen fits a 390 px screen");
    await page.screenshot({ path: `${ARTIFACTS}confirm-email.png`, fullPage: true });
    await page.goto(await verifyLink(STUDENT.email));
    await page.getByRole("heading", { name: /Анна/ }).waitFor();
    await page.locator('[data-card="lesson"]').waitFor();
    check(page.url() === `${WEB}/`, "the link in the e-mail confirms it and the student lands on Today");
    const lesson = page.locator('[data-card="lesson"]');
    check(/A1 вечер/.test(await lesson.innerText()), "Today shows the next lesson");
    check((await lesson.locator("a.call").getAttribute("href")) === "https://telemost.yandex.ru/j/12345", "with the call link");
    check(/Расскажи о себе/.test(await page.locator('[data-card="homework"]').innerText()), "and the homework");
    check((await page.locator('[data-card="email"]').innerText()).includes(STUDENT.email), "and the address reminders go to");
    check(await noSideScroll(page), "Today fits a 390 px screen");
    await page.screenshot({ path: `${ARTIFACTS}student-today.png`, fullPage: true });

    step("The board in the Moonbridge lobby");
    await page.locator("[data-section=moonbridge]").click();
    await hotelMap(page);
    const board = page.locator("[data-board]");
    await board.waitFor();
    check(/Урок/.test(await board.locator("[data-board-lesson]").innerText()), "the board shows the next lesson");
    check(await board.locator("[data-board-homework]").count() === 1, "and the homework still to hand in");
    await page.screenshot({ path: `${ARTIFACTS}lobby-board.png` });
    await board.locator("[data-board-homework]").click();

    step("Handing in a file from the phone");
    const hwPage = page.locator("[data-homework-page]");
    await hwPage.waitFor();
    const big = join(uploads, "big.m4a");
    await writeFile(big, "");
    await truncate(big, 51 * 1024 * 1024);
    await hwPage.getByLabel("Файл").setInputFiles(big);
    check(/больше 50 МБ/.test(await hwPage.locator(".form-error").innerText()), "a file over 50 MB is refused on the phone");
    check(await hwPage.getByRole("button", { name: "Сдать" }).isDisabled(), "and cannot be sent");
    const memo = Buffer.alloc(2 * 1024 * 1024, 1);
    await hwPage.getByLabel("Файл").setInputFiles({ name: "Запись 1.m4a", mimeType: "audio/mp4", buffer: memo });
    await hwPage.getByRole("button", { name: "Сдать" }).click();
    await hwPage.locator('[data-status="submitted"]').waitFor();
    check(/Сдано: Запись 1\.m4a, 2,0 МБ/.test(await hwPage.locator(".hw-status").innerText()), "the voice memo is handed in");
    check(await noSideScroll(page), "the homework page fits a 390 px screen");
    await page.screenshot({ path: `${ARTIFACTS}homework.png` });

    step("Phone 1: the unit 1 episode");
    await page.goto(`${WEB}/moonbridge`);
    await hotelMap(page);
    check(/Вся домашка сдана/.test(await page.locator("[data-board]").innerText()), "the board knows the homework is in");
    await page.locator(".play-next").click();
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/progress/snapshot") && r.request().method() === "PUT" && r.ok(), { timeout: 30_000 });
    await finishEpisode(page, bundle, episode);
    await saved;
    check(true, "the episode is done and the progress is backed up");

    step("Phone 2: the same student signs in");
    page = await open();
    await page.goto(WEB);
    const again = page.locator('[data-form="sign-in"]');
    await again.getByLabel("Логин").fill(STUDENT.login.toUpperCase());
    await again.getByLabel("Пароль").fill(STUDENT.password);
    await again.getByRole("button", { name: "Войти" }).click();
    await page.getByRole("heading", { name: /Анна/ }).waitFor();
    check(/Сдано: Запись 1\.m4a/.test(await page.locator('[data-card="homework"]').innerText()), "the hand-in is there");
    await page.locator("[data-section=moonbridge]").click();
    await page.locator(".hotel-map").waitFor();
    check(await page.locator(`.episode.done[data-episode="${EPISODE}"]`).isVisible(), "the episode is still done on the new phone");

    step("The teacher sees the hand-in");
    await teacher.reload();
    const item = teacher.locator(".hw-item").first();
    await item.waitFor();
    check(/сдали 1 из 1/.test(await item.innerText()), "one of one handed in");
    const download = teacher.waitForEvent("download");
    const served = teacher.waitForResponse((r) => r.url().includes("/file?t="));
    await item.locator("[data-submission]").click();
    const file = await download;
    // Headless Chromium ignores non-ASCII file names in Content-Disposition, so the name is
    // checked in the header that real browsers read, and the bytes in the downloaded file.
    const disposition = (await served).headers()["content-disposition"] ?? "";
    check(disposition.includes(`filename*=UTF-8''${encodeURIComponent("Запись 1.m4a")}`), "the file goes out under the student's name");
    check((await readFile((await file.path())!)).equals(memo), "the teacher downloads exactly the student's recording");
    await teacher.screenshot({ path: `${ARTIFACTS}teacher-hand-in.png`, fullPage: true });

    step("The teacher grades the file from the review queue");
    const queue = teacher.locator('[data-queue="1"]');
    await queue.waitFor();
    const review = queue.locator(".review-item").first();
    check(/Анна/.test(await review.innerText()) && /Расскажи о себе/.test(await review.innerText()), "the queue shows the student's file for the homework");
    await review.getByRole("button", { name: "Открыть файл" }).click();
    await review.locator(".preview audio").waitFor();
    check(true, "the recording opens in a player right in the cabinet");
    await review.locator('[data-grade="5"]').click();
    await review.getByLabel("Комментарий").fill("Отлично! Только «I am from», а не «I from».");
    await review.getByRole("button", { name: "Сохранить оценку" }).click();
    await teacher.locator('[data-queue="0"]').waitFor();
    check(true, "the queue is empty after the grade");
    await teacher.screenshot({ path: `${ARTIFACTS}review-queue.png` });

    step("Lessons: materials, the recording and attendance");
    await teacher.locator("[data-lessons-link]").first().click();
    await teacher.locator('[data-lessons="coming"]').waitFor();
    check((await teacher.locator('[data-lessons="coming"] .lesson-item').count()) >= 8, "the weekly schedule has become four weeks of lessons");
    await teacher.locator("summary", { hasText: "Дополнительный урок" }).click();
    const lessonForm = teacher.locator('[data-form="lesson"]');
    await lessonForm.getByLabel("Начало").fill(new Date(Date.now() + 3 * 3600_000 - 2 * 3600_000).toISOString().slice(0, 16));
    await lessonForm.getByLabel("Тема").fill("Знакомство");
    await lessonForm.getByRole("button", { name: "Добавить урок" }).click();
    const extra = () => teacher.locator('[data-lessons="to-mark"] .lesson-item').filter({ hasText: "Знакомство" });
    await extra().waitFor();
    check(true, "a lesson that has ended waits for attendance");
    await extra().locator("summary").click();
    await extra().getByLabel("Материалы").fill("Рабочий лист https://example.com/sheet");
    await extra().getByLabel("Запись урока").fill("https://example.com/recording");
    await extra().getByRole("button", { name: "Сохранить" }).click();
    await extra().locator("[data-recording]").waitFor();
    const worksheet = Buffer.from("%PDF-1.4 worksheet for the lesson");
    await extra().getByLabel("Файл к уроку").setInputFiles({ name: "Рабочий лист.pdf", mimeType: "application/pdf", buffer: worksheet });
    await extra().locator(".lesson-links [data-lesson-file]").waitFor();
    check(true, "the teacher attaches a PDF to the lesson");
    check(await extra().getByLabel("Анна").isChecked(), "every student is ticked as present by default");
    await extra().locator("[data-mark]").click();
    const held = teacher.locator('[data-lessons="past"] .lesson-item[data-status="held"]').filter({ hasText: "Знакомство" });
    await held.waitFor();
    check(/были 1 из 1/.test(await held.innerText()), "the lesson is held with Анна present");
    check(await noSideScroll(teacher), "the lessons page fits a 390 px screen");
    await teacher.screenshot({ path: `${ARTIFACTS}teacher-lessons.png`, fullPage: true });
    await page.goto(WEB);
    const pastCard = page.locator('[data-card="past-lessons"]');
    await pastCard.waitFor();
    check((await pastCard.locator("[data-recording]").getAttribute("href")) === "https://example.com/recording", "Today links the recording of the last lesson");
    await page.locator("[data-all-lessons]").click();
    const pastList = page.locator('[data-lessons="past"]');
    await pastList.waitFor();
    check((await pastList.locator('[data-attendance="present"]').count()) === 1 && /Рабочий лист/.test(await pastList.innerText()), "the student's lessons show the mark and the materials");
    const [lessonFile] = await Promise.all([page.waitForEvent("download"), pastList.locator("[data-lesson-file]").first().click()]);
    check((await readFile((await lessonFile.path())!)).equals(worksheet), "the student downloads the lesson's file");
    check(await noSideScroll(page), "the student's lessons fit a 390 px screen");
    await page.screenshot({ path: `${ARTIFACTS}student-lessons.png`, fullPage: true });
    await teacher.goto(`${WEB}/teacher`);

    step("The students' week and the weekly report");
    const row = teacher.locator(".students [data-student]").first();
    const days = Number(await row.locator(".week-dots").getAttribute("data-days"));
    check(days >= 1, `the group shows Анна practised on ${days} day(s) this week`);
    check(/% с первого раза/.test(await row.innerText()), "with her first-try accuracy");
    await teacher.screenshot({ path: `${ARTIFACTS}teacher-week.png`, fullPage: true });
    await row.click();
    const report = teacher.locator("[data-report]");
    await report.waitFor();
    check(/Ответов: \d+/.test(await report.innerText()), "the weekly report counts her answers");
    check(/оценка 5/.test(await report.locator(".report-homework").first().innerText()), "and lists the week's homework with its grade");
    check(/^1\/\d+$/.test((await report.locator("[data-report-lessons]").getAttribute("data-report-lessons")) ?? ""), "and the week's attendance");
    check(await noSideScroll(teacher), "the report fits a 390 px screen");
    await teacher.screenshot({ path: `${ARTIFACTS}report.png`, fullPage: true });

    step("A forgotten password");
    teacher.once("dialog", (dialog) => void dialog.accept());
    await teacher.locator("[data-reset-password]").click();
    const fresh = (await teacher.locator("[data-new-password]").innerText()).trim();
    check(/^[a-z2-9]{10}$/.test(fresh), "the teacher gets a new one-off password");
    await page.goto(WEB);
    await page.getByRole("button", { name: "Выйти" }).click();
    const back = page.locator('[data-form="sign-in"]');
    await back.getByLabel("Логин").fill(STUDENT.login);
    await back.getByLabel("Пароль").fill(STUDENT.password);
    await back.getByRole("button", { name: "Войти" }).click();
    await back.locator(".form-error").filter({ hasText: /Неверный/ }).waitFor();
    check(true, "the old password no longer works");
    await back.getByLabel("Пароль").fill(fresh);
    await back.getByRole("button", { name: "Войти" }).click();
    await page.getByRole("heading", { name: /Анна/ }).waitFor();
    check(await page.locator('[data-card="my-week"]').isVisible(), "the student signs in with it and sees her week on Today");
    await page.screenshot({ path: `${ARTIFACTS}student-week.png`, fullPage: true });
    await page.locator('[data-card="homework"] a').first().click();
    const graded = page.locator('.review-note[data-grade="5"]');
    await graded.waitFor();
    check(/I am from/.test(await graded.innerText()), "and the grade with the teacher's comment in the homework");
    await page.screenshot({ path: `${ARTIFACTS}graded.png` });

    step("A forgotten password, by e-mail");
    await page.goto(WEB);
    await page.getByRole("button", { name: "Выйти" }).click();
    await page.locator('[data-form="sign-in"]').getByRole("button", { name: "Забыли пароль?" }).click();
    const forgot = page.locator('[data-form="forgot"]');
    await forgot.getByLabel("Логин или e-mail").fill(STUDENT.email);
    await forgot.getByRole("button", { name: "Прислать ссылку" }).click();
    await page.locator('[data-form="forgot-sent"]').waitFor();
    let link: string | undefined;
    for (let i = 0; i < 50 && !link; i++) {
      link = /http:\/\/localhost:4173\/reset\/[\w-]+/.exec(logOf("gateway"))?.[0];
      if (!link) await page.waitForTimeout(100);
    }
    check(link, "the gateway sends the reset link to her address (printed to the log without Postbox)");
    await page.screenshot({ path: `${ARTIFACTS}forgot-sent.png` });
    await page.goto(link!);
    const reset = page.locator('[data-form="reset"]');
    await reset.getByLabel("Новый пароль").fill("moon-456");
    await reset.getByRole("button", { name: "Сохранить и войти" }).click();
    await page.getByRole("heading", { name: /Анна/ }).waitFor();
    check(page.url() === `${WEB}/`, "the link sets a new password and opens Today");
    await page.goto(link!);
    await page.locator('[data-form="reset-failed"]').waitFor();
    check(true, "the link works only once");
    await page.goto(WEB);

    step("The teacher updates the course from the sheet");
    await teacher.goto(`${WEB}/teacher`);
    await teacher.locator(".content-link a[href=\"/teacher/content\"]").click();
    await teacher.locator("[data-content-hash]").waitFor();
    const before = await teacher.locator("[data-content-hash]").getAttribute("data-content-hash");
    check(/4 юнита, 45 заданий, 4 эпизода/.test(await teacher.locator("[data-content-hash]").innerText()), "the content page counts units 1–4");
    const [sheetDownload] = await Promise.all([teacher.waitForEvent("download"), teacher.locator("[data-download-sheet]").click()]);
    check(sheetDownload.suggestedFilename() === "moonbridge-content.xlsx", "the teacher downloads the course as a sheet");
    const book = readXlsx(await readFile((await sheetDownload.path())!));
    const edit = (b: Workbook, task: string, col: string, value: string) => {
      const [header, ...rows] = b[SHEETS.tasks]!;
      rows.find((r) => r[header!.indexOf("задание")] === task)![header!.indexOf(col)] = value;
    };
    const sheetFile = async (name: string, b: Workbook) => {
      const path = join(uploads, name);
      await writeFile(path, writeXlsx(b));
      return path;
    };
    const newPrompt = "Good evening! Welcome to Moonbridge. I'm Rocco, the night porter.";
    edit(book, "hello", "текст задания", newPrompt);
    const broken = structuredClone(book);
    edit(broken, "too", "тип", "пропускк");
    const form = teacher.locator(".sheet-form");
    await form.locator('input[type="file"]').setInputFiles(await sheetFile("broken.xlsx", broken));
    await form.locator("[data-check-sheet]").click();
    const sheetErrors = form.locator(".sheet-errors li");
    await sheetErrors.first().waitFor();
    check(/^Задания, строка 3: тип «пропускк» не знаком/.test(await sheetErrors.first().innerText()), "a mistake in the sheet is named with its sheet and row");
    check(await form.locator("[data-publish-sheet]").isHidden(), "and the sheet cannot be published");
    check(await noSideScroll(teacher), "the content page fits a 390 px screen");
    await teacher.screenshot({ path: `${ARTIFACTS}content-errors.png`, fullPage: true });
    await form.locator('input[type="file"]').setInputFiles(await sheetFile("fixed.xlsx", book));
    await form.locator("[data-check-sheet]").click();
    await form.locator('[data-sheet-ok="true"]').waitFor();
    check(/изменены: «Приятно познакомиться»/.test(await form.innerText()), "the fixed sheet passes, and the check says which unit changes");
    await form.locator("[data-publish-sheet]").click();
    await form.locator("[data-published]").waitFor();
    const after = await teacher.locator("[data-content-hash]").getAttribute("data-content-hash");
    check(after !== before && /Ксения, из файла fixed\.xlsx/.test(await teacher.locator("[data-content-hash]").innerText()), "publishing makes it live and says who published it");
    await teacher.screenshot({ path: `${ARTIFACTS}content-published.png`, fullPage: true });
    const live = (await (await fetch(`${GATEWAY}/content/bundle`)).json()) as typeof bundle;
    check(live.content_hash === after && live.tasks["A1_NiceToMeetYou_01_hello"]!.presentation.prompt === newPrompt, "students get the new task text from the platform");
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  } catch (e) {
    await page.screenshot({ path: `${ARTIFACTS}school-failure.png` }).catch(() => undefined);
    throw e;
  } finally {
    await browser.close();
    await rm(uploads, { recursive: true, force: true });
  }
  console.log("\nAll good.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(stopServers);
