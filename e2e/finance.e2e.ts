// End-to-end check of the finances, on phone screens (390 × 844):
//
//   a teacher and a group with two students exist (made through the gateway) → the teacher
//   opens "Оплаты" from the cabinet, sets Анна's price per lesson, records her payment (the
//   form shows how many lessons it pays for) and adds a free trial lesson by hand → a lesson
//   is held and Анна marked present: it costs her price by itself → Борис gets a payment by
//   mistake, which is voided → the totals on top: held, paid, left; the month's total →
//   Анна signs in on her phone and sees the same totals, her held lessons and her payments;
//   Борис, with nothing paid, is asked to pay.
//
// Run: pnpm e2e:finance        (HEADED=1 to watch it)
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { ARTIFACTS, check, GATEWAY, noSideScroll, PHONE, startServers, step, stopServers, WEB } from "./lib.js";

const ADMIN = "e2e-admin-token";

async function api<T = unknown>(path: string, init: { token?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${GATEWAY}${path}`, {
    method: init.body === undefined ? "GET" : "POST",
    headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
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
}

async function main(): Promise<void> {
  await mkdir(ARTIFACTS, { recursive: true });
  step("Gateway, the built platform, a teacher with two students");
  await startServers({ ADMIN_TOKEN: ADMIN });
  await api("/admin/teachers", { token: ADMIN, body: { name: "Ксения", login: "ksenia", password: "teach-123" } });
  const t = (await api<{ token: string }>("/auth/login", { body: { login: "ksenia", password: "teach-123" } })).token;
  const groupId = (await api<{ group: { group_id: string } }>("/school/groups", { token: t, body: { name: "A1 вечер" } })).group.group_id;
  const code = (await api<{ code: string }>(`/school/groups/${groupId}/invites`, { token: t, body: {} })).code;
  await api(`/invites/${code}/join`, { body: { name: "Анна", login: "anna", password: "moon-123" } });
  await api(`/invites/${code}/join`, { body: { name: "Борис", login: "boris", password: "moon-123" } });

  const anna = (await api<{ students: { id: string; name: string }[] }>("/school/finance", { token: t })).students.find((x) => x.name === "Анна")!;
  /** A lesson that started an hour ago, held, with Анна present: the lessons' attendance charges it. */
  const holdLesson = async () => {
    const lesson = (await api<{ lesson: { lesson_id: string } }>(`/school/groups/${groupId}/lessons`, { token: t, body: { starts_at: new Date(Date.now() - 3600_000).toISOString(), minutes: 45 } })).lesson;
    const res = await fetch(`${GATEWAY}/school/lessons/${lesson.lesson_id}/attendance`, {
      method: "PUT",
      headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
      body: JSON.stringify({ marks: [{ account_id: anna.id, status: "present" }] }),
    });
    if (!res.ok) throw new Error(`attendance: HTTP ${res.status}`);
  };

  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const errors: string[] = [];
  const open = async (): Promise<Page> => {
    const page = await (await browser.newContext(PHONE)).newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => void d.accept("ошиблась учеником"));
    return page;
  };

  try {
    step("The teacher sets a price and records payments");
    const teacher = await open();
    await signIn(teacher, "ksenia", "teach-123");
    await teacher.locator('[data-section="teacher"]').click();
    await teacher.locator("[data-finance]").click();
    const annaRow = teacher.locator(".finance-student", { hasText: "Анна" });
    const boris = teacher.locator(".finance-student", { hasText: "Борис" });
    await annaRow.waitFor();
    check((await annaRow.locator("[data-badge]").innerText()) === "—" && /цена не задана/.test(await annaRow.locator("summary").innerText()), "a new student has no price yet");

    await annaRow.locator("summary").click();
    const priceForm = annaRow.locator('[data-form="price"]');
    await priceForm.getByLabel("Цена урока, ₽").fill("1500");
    await priceForm.getByRole("button", { name: "Задать" }).click();
    await annaRow.locator('[data-badge="0"]').waitFor();

    const pay = annaRow.locator('[data-form="payment"]');
    await pay.getByLabel("Сумма, ₽").fill("12000");
    check(/= 8 уроков по 1\s500\s₽/.test(await pay.locator("[data-hint]").innerText()), "the form shows the payment is 8 lessons at her price");
    await pay.getByLabel("Как").selectOption("transfer");
    await pay.getByLabel("Комментарий").fill("абонемент на декабрь");
    await pay.getByRole("button", { name: "Записать оплату" }).click();
    await annaRow.locator('[data-badge="8"]').waitFor();
    check(true, "after the payment Анна has 8 lessons");

    await annaRow.locator(".correction summary").click();
    const fix = annaRow.locator('[data-form="correction"]');
    await fix.getByLabel("Сколько, + или −").fill("1");
    await fix.getByLabel("За что").fill("пробный урок бесплатно");
    await fix.getByRole("button", { name: "Исправить баланс" }).click();
    await annaRow.locator('[data-badge="9"]').waitFor();
    check(true, "a free trial lesson added by hand makes 9");

    await holdLesson();
    await teacher.reload();
    await annaRow.locator('[data-badge="8"]').waitFor();
    await annaRow.locator("summary").click();
    await annaRow.locator('[data-list="lessons"]').waitFor();
    check((await annaRow.locator("[data-held]").innerText()).match(/1 урок · 1\s500\s₽/) !== null, "the held lesson cost her price by itself");
    check((await annaRow.locator("[data-left]").innerText()).match(/12\s000\s₽ · 8 уроков/) !== null, "on top: 13 500 ₽ in, 1 500 ₽ held, 12 000 ₽ = 8 lessons left");
    await teacher.screenshot({ path: `${ARTIFACTS}finance-teacher.png`, fullPage: true });
    check(await noSideScroll(teacher), "the finance page fits the phone");

    await boris.locator("summary").click();
    const payB = boris.locator('[data-form="payment"]');
    await payB.getByLabel("Сумма, ₽").fill("6000");
    await payB.getByRole("button", { name: "Записать оплату" }).click();
    await boris.locator('[data-list="payments"] [data-void]').waitFor();
    await boris.locator("[data-void]").click();
    await boris.locator('[data-entry="void"]').waitFor();
    check(/Оплата отменена[\s\S]*ошиблась учеником/.test(await boris.locator('[data-list="payments"]').innerText()), "a payment entered by mistake is voided, with the reason in the history");
    check((await boris.locator("[data-left]").innerText()).startsWith("0"), "Борис is back to zero");

    const month = await teacher.locator("[data-month]").innerText();
    check(/12\s000\s₽ · оплат 1/.test(month) && /1 урок · 1\s500\s₽/.test(month), "the month: Анна's payment received, one lesson held");

    step("Анна sees her account");
    const phone = await open();
    await signIn(phone, "anna", "moon-123");
    const card = phone.locator('[data-card="balance"]');
    await card.waitFor();
    check(/Осталось 8 уроков/.test(await card.innerText()), "Today shows 8 lessons left");
    await phone.screenshot({ path: `${ARTIFACTS}finance-student-today.png`, fullPage: true });
    await card.click();
    await phone.locator('[data-list="lessons"]').waitFor();
    check(/Урок [\s\S]*−1\s500\s₽/.test(await phone.locator('[data-list="lessons"]').innerText()), "her held lessons, each with its price");
    const history = await phone.locator('[data-list="payments"]').innerText();
    check(/пробный урок бесплатно/.test(history) && /абонемент на декабрь/.test(history) && !/Ксения/.test(history), "her payments and the trial lesson, not who entered them");
    check(/12\s000\s₽ · 8 уроков/.test(await phone.locator("[data-left]").innerText()), "and the same totals on top");
    await phone.screenshot({ path: `${ARTIFACTS}finance-student-history.png`, fullPage: true });
    check(await noSideScroll(phone), "the page fits the phone");

    step("Борис has nothing paid");
    const phoneB = await open();
    await signIn(phoneB, "boris", "moon-123");
    const cardB = phoneB.locator('[data-card="balance"]');
    await cardB.waitFor();
    check(/Оплаченных уроков нет/.test(await cardB.innerText()) && /оплатите/.test(await cardB.innerText()), "Today asks Борис to pay");

    check(errors.length === 0, `no script errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  } finally {
    await browser.close();
    stopServers();
  }
}

main().then(
  () => console.log("\nfinance e2e passed"),
  (e) => {
    console.error(e);
    stopServers();
    process.exit(1);
  },
);
