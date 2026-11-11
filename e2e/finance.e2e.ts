// End-to-end check of the finances, on phone screens (390 × 844):
//
//   a teacher and a group with two students exist (made through the gateway) → the teacher
//   opens "Оплаты" from the cabinet, records Анна's payment for 8 lessons, adds a free trial
//   lesson by hand, records a payment for Борис by mistake and voids it → the month's total
//   counts only Анна's payment → Анна signs in on her phone and finds her balance on Today
//   and its history on its own page; Борис, with nothing paid, is asked to pay.
//
// Held lessons take a lesson off by themselves (the lessons' attendance); that part is
// covered by the gateway's tests.
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

  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const errors: string[] = [];
  const open = async (): Promise<Page> => {
    const page = await (await browser.newContext(PHONE)).newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => void d.accept("ошиблась учеником"));
    return page;
  };

  try {
    step("The teacher records payments");
    const teacher = await open();
    await signIn(teacher, "ksenia", "teach-123");
    await teacher.locator('[data-section="teacher"]').click();
    await teacher.locator("[data-finance]").click();
    const anna = teacher.locator(".finance-student", { hasText: "Анна" });
    const boris = teacher.locator(".finance-student", { hasText: "Борис" });
    await anna.waitFor();
    check((await anna.locator("[data-badge]").innerText()) === "0", "a new student has no paid lessons");

    await anna.locator("summary").click();
    const pay = anna.locator('[data-form="payment"]');
    await pay.getByLabel("Уроков").fill("8");
    await pay.getByLabel("Сумма, ₽").fill("12000");
    await pay.getByLabel("Как").selectOption("transfer");
    await pay.getByLabel("Комментарий").fill("абонемент на декабрь");
    await pay.getByRole("button", { name: "Записать оплату" }).click();
    await anna.locator('[data-badge="8"]').waitFor();
    check(/Оплата .*12\s000\s₽, перевод/.test(await anna.locator(".ledger").innerText()), "Анна's payment is in her history: 8 lessons");

    await anna.locator(".correction summary").click();
    const fix = anna.locator('[data-form="correction"]');
    await fix.getByLabel("Уроков, + или −").fill("1");
    await fix.getByLabel("За что").fill("пробный урок бесплатно");
    await fix.getByRole("button", { name: "Исправить баланс" }).click();
    await anna.locator('[data-badge="9"]').waitFor();
    check(true, "a free trial lesson added by hand makes 9");
    await teacher.screenshot({ path: `${ARTIFACTS}finance-teacher.png`, fullPage: true });
    check(await noSideScroll(teacher), "the finance page fits the phone");

    await boris.locator("summary").click();
    const payB = boris.locator('[data-form="payment"]');
    await payB.getByLabel("Уроков").fill("4");
    await payB.getByLabel("Сумма, ₽").fill("6000");
    await payB.getByRole("button", { name: "Записать оплату" }).click();
    await boris.locator('[data-badge="4"]').waitFor();
    await boris.locator("[data-void]").click();
    await boris.locator('[data-badge="0"]').waitFor();
    check(/Оплата отменена[\s\S]*ошиблась учеником/.test(await boris.locator(".ledger").innerText()), "a payment entered by mistake is voided, with the reason in the history");

    await teacher.reload();
    const month = await teacher.locator("[data-month]").innerText();
    check(/12\s000\s₽/.test(month) && /Оплат: 1/.test(month), "the month's total counts Анна's payment only");

    step("Анна sees her balance");
    const phone = await open();
    await signIn(phone, "anna", "moon-123");
    const card = phone.locator('[data-card="balance"]');
    await card.waitFor();
    check(/Осталось 9 уроков/.test(await card.innerText()), "Today shows 9 paid lessons");
    await phone.screenshot({ path: `${ARTIFACTS}finance-student-today.png`, fullPage: true });
    await card.click();
    await phone.locator(".ledger").waitFor();
    const history = await phone.locator(".ledger").innerText();
    check(/пробный урок бесплатно/.test(history) && /абонемент на декабрь/.test(history) && !/ksenia|Ксения/.test(history), "her history shows the payment and the trial lesson, not who entered them");
    await phone.screenshot({ path: `${ARTIFACTS}finance-student-history.png`, fullPage: true });
    check(await noSideScroll(phone), "the balance page fits the phone");

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
