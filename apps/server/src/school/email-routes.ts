import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { MailLinks } from "../mail/links.js";
import type { Mailer } from "../mail/mailer.js";
import { resetMail, verifyMail } from "../mail/messages.js";
import type { EmailStore } from "../mail/store.js";
import { FailureLimiter } from "./limits.js";
import { hashPassword } from "./passwords.js";
import type { Account, SchoolStore } from "./store.js";

export interface MailDeps {
  store: EmailStore;
  mailer: Mailer;
  links: MailLinks;
  /** False when e-mails only go to the log (no Postbox configured). */
  delivers: boolean;
  /**
   * Accounts without a confirmed address see only "Подтвердите почту". On by default once
   * e-mails are delivered: without Postbox nobody could confirm, and the platform would close.
   */
  verification: boolean;
}

/** Simple on purpose: a typo is caught by the person reading their address back, not by a regex. */
export const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
export const normalizeEmail = (s: string) => s.trim().toLowerCase();

/** A reset link works this long. */
export const RESET_MINUTES = 60;
/** At most this many reset e-mails per account in an hour: the form must not become a way to flood someone's inbox. */
const RESETS_PER_HOUR = 3;
/** A confirmation link works this long. */
export const VERIFY_HOURS = 48;
/** Confirmation e-mails per account in an hour. */
const VERIFICATIONS_PER_HOUR = 3;
/** Accounts on one address: a family may share one, a single inbox must not open endless accounts. */
export const ACCOUNTS_PER_EMAIL = 3;
export const EMAIL_TAKEN = `На этот адрес уже зарегистрировано ${ACCOUNTS_PER_EMAIL} аккаунта. Укажите другую почту.`;

/** Sends a link that confirms `email` for the account. Failures are logged, not thrown: "Отправить ещё раз" tries again. */
export async function sendVerification(
  mail: MailDeps,
  now: Date,
  a: { accountId: string; name: string },
  email: string,
  log: { error: (o: unknown, msg: string) => void },
): Promise<void> {
  const token = await mail.store.createVerification(a.accountId, email, now, new Date(now.getTime() + VERIFY_HOURS * 3600_000));
  await mail.mailer.send(verifyMail({ name: a.name, email }, mail.links.verify(token), VERIFY_HOURS)).catch((e) => log.error({ err: e }, "verification e-mail not sent"));
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;padding:24px 16px;background:#f4f1ea;font-family:system-ui,Arial,sans-serif;color:#1f2430}main{max-width:420px;margin:0 auto;background:#fff;border-radius:12px;padding:24px}button,a.button{display:inline-block;background:#2f5d8a;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:16px;text-decoration:none;cursor:pointer}</style>
</head><body><main>${body}</main></body></html>`;

interface Helpers {
  school: SchoolStore;
  mail: MailDeps;
  now: () => Date;
  requireAccount: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  signIn: (a: Account) => Promise<unknown>;
  accountView: (a: Account) => unknown;
}

/**
 * E-mail: the address on the account, the unsubscribe link, the e-mail's button (which counts
 * returns for the pilot) and the password reset a student does without the teacher.
 */
export async function emailRoutes(app: FastifyInstance, h: Helpers): Promise<void> {
  const { mail, school } = h;

  app.put<{ Body: { email: string | null } }>(
    "/account/email",
    {
      preHandler: h.requireAccount,
      schema: { body: { type: "object", required: ["email"], additionalProperties: false, properties: { email: { anyOf: [{ type: "string", maxLength: 254 }, { type: "null" }] } } } },
    },
    async (req, reply) => {
      const raw = req.body.email === null ? "" : normalizeEmail(req.body.email);
      if (raw && !EMAIL.test(raw)) return reply.code(400).send({ error: "email", message: "Похоже, в адресе опечатка. Пример: anna@mail.ru" });
      const me = req.account!;
      if (raw && raw !== me.email && (await mail.store.accountsWith(raw, me.accountId)) >= ACCOUNTS_PER_EMAIL) return reply.code(409).send({ error: "email_taken", message: EMAIL_TAKEN });
      await mail.store.setEmail(me.accountId, raw || null);
      // A new address is a fresh start: whoever gives it wants the reminders.
      if (raw) await mail.store.setReminders(me.accountId, true);
      const a = (await school.accountById(me.accountId))!;
      if (raw && !a.emailVerified && raw !== me.email) await sendVerification(mail, h.now(), a, raw, req.log);
      return { account: h.accountView(a) };
    },
  );

  app.put<{ Body: { on: boolean } }>(
    "/account/reminders",
    { preHandler: h.requireAccount, schema: { body: { type: "object", required: ["on"], additionalProperties: false, properties: { on: { type: "boolean" } } } } },
    async (req) => {
      await mail.store.setReminders(req.account!.accountId, req.body.on);
      return { account: h.accountView((await school.accountById(req.account!.accountId))!) };
    },
  );

  /** "Отправить ещё раз": a new confirmation link to the account's address. */
  app.post("/account/email/resend", { preHandler: h.requireAccount }, async (req, reply) => {
    const a = req.account!;
    if (!a.email) return reply.code(400).send({ error: "email", message: "Сначала укажите почту." });
    if (a.emailVerified) return { ok: true, account: h.accountView(a) };
    const now = h.now();
    if ((await mail.store.verificationsSince(a.accountId, new Date(now.getTime() - 3600_000))) >= VERIFICATIONS_PER_HOUR) {
      return reply.code(429).send({ error: "too_many", message: "Письмо уже отправлено несколько раз. Проверьте папку «Спам» или попробуйте через час." });
    }
    await sendVerification(mail, now, a, a.email, req.log);
    return { ok: true, account: h.accountView(a) };
  });

  /** The link in the confirmation e-mail. Opening it confirms (no form: there is nothing to undo), then on to the platform. */
  app.get<{ Querystring: { t?: string } }>("/email/verify", async (req, reply) => {
    const t = req.query.t;
    const accountId = t && t.length <= 100 ? await mail.store.verify(t, h.now()) : undefined;
    if (accountId) return reply.redirect(`${mail.links.clientUrl}/?email=confirmed`, 302);
    return reply
      .code(404)
      .type("text/html; charset=utf-8")
      .send(
        page(
          "Ссылка не работает",
          `<h1>Ссылка не работает</h1><p>Она устарела или почта в аккаунте уже другая. Новое письмо можно отправить на платформе, на экране «Сегодня».</p><p><a class="button" href="${mail.links.clientUrl}/">На платформу</a></p>`,
        ),
      );
  });

  // ---------- Unsubscribe. GET shows a button (mail scanners open links), POST unsubscribes:
  // the button, and mail clients' own one-click "Отписаться" (List-Unsubscribe-Post).
  app.get<{ Querystring: { t?: string } }>("/email/unsubscribe", async (req, reply) => {
    const accountId = req.query.t && (await mail.links.unsubscribeAccount(req.query.t));
    reply.type("text/html; charset=utf-8");
    if (!accountId) return page("Ссылка не работает", "<h1>Ссылка не работает</h1><p>Отключить напоминания можно на платформе, на экране «Сегодня».</p>");
    return page(
      "Напоминания",
      `<h1>Не присылать напоминания?</h1><p>Письма о смене, сроках домашки и оценках перестанут приходить. Включить их снова можно на экране «Сегодня».</p>
<form method="post"><button type="submit">Да, не присылать</button></form>`,
    );
  });

  app.post<{ Querystring: { t?: string } }>("/email/unsubscribe", async (req, reply) => {
    const accountId = req.query.t && (await mail.links.unsubscribeAccount(req.query.t));
    if (!accountId) return reply.code(404).type("text/html; charset=utf-8").send(page("Ссылка не работает", "<h1>Ссылка не работает</h1>"));
    await mail.store.setReminders(accountId, false);
    return reply
      .type("text/html; charset=utf-8")
      .send(page("Готово", `<h1>Готово</h1><p>Напоминаний больше не будет. Включить их снова можно на экране «Сегодня».</p><p><a class="button" href="${mail.links.clientUrl}/">На платформу</a></p>`));
  });

  /** The e-mail's button: the click is noted once, then the browser goes on to the platform. */
  app.get<{ Params: { id: string } }>("/email/go/:id", async (req, reply) => {
    const target = /^em_[0-9a-f]{24}$/.test(req.params.id) ? await mail.store.click(req.params.id, h.now()) : undefined;
    const path = target && target.startsWith("/") && !target.startsWith("//") ? target : "/";
    return reply.redirect(`${mail.links.clientUrl}${path}`, 302);
  });

  // ---------- "Забыли пароль?"
  const clock = () => h.now().getTime();
  const addressRequests = new FailureLimiter(10, 60 * 60_000, clock);

  /** Same answer whether or not the login exists: the form must not tell who studies here. */
  app.post<{ Body: { login: string } }>(
    "/auth/forgot",
    { schema: { body: { type: "object", required: ["login"], additionalProperties: false, properties: { login: { type: "string", minLength: 1, maxLength: 254 } } } } },
    async (req, reply) => {
      const wait = addressRequests.retryAfter(req.ip);
      if (wait) return reply.code(429).header("Retry-After", String(wait)).send({ error: "too_many", message: `Слишком много запросов. Попробуйте через ${Math.ceil(wait / 60)} мин.` });
      addressRequests.fail(req.ip);
      const now = h.now();
      for (const a of await mail.store.byLoginOrEmail(normalizeEmail(req.body.login))) {
        if ((await mail.store.resetsSince(a.accountId, new Date(now.getTime() - 3600_000))) >= RESETS_PER_HOUR) continue;
        const token = await mail.store.createReset(a.accountId, now, new Date(now.getTime() + RESET_MINUTES * 60_000));
        await mail.mailer.send(resetMail(a, mail.links.reset(token), RESET_MINUTES)).catch((e) => req.log.error({ err: e }, "reset e-mail not sent"));
      }
      return { ok: true, message: "Если такой логин или адрес есть, мы отправили письмо со ссылкой. Проверьте почту, и папку «Спам» тоже." };
    },
  );

  app.get<{ Params: { token: string } }>("/auth/reset/:token", async (req, reply) => {
    if (!(await mail.store.resetValid(req.params.token, h.now()))) return reply.code(404).send({ error: "reset", message: "Ссылка устарела или уже использована. Запросите новую." });
    return { ok: true };
  });

  /** Sets the new password and signs in, so the student lands on Today straight from the e-mail. */
  app.post<{ Body: { token: string; password: string } }>(
    "/auth/reset",
    {
      schema: {
        body: {
          type: "object",
          required: ["token", "password"],
          additionalProperties: false,
          properties: { token: { type: "string", minLength: 10, maxLength: 100 }, password: { type: "string", minLength: 6, maxLength: 128 } },
        },
      },
    },
    async (req, reply) => {
      const accountId = await mail.store.useReset(req.body.token, h.now());
      const a = accountId && (await school.accountById(accountId));
      if (!a) return reply.code(404).send({ error: "reset", message: "Ссылка устарела или уже использована. Запросите новую." });
      await school.setPassword(a.accountId, await hashPassword(req.body.password));
      return h.signIn(a);
    },
  );
}
