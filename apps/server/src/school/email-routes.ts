import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { MailLinks } from "../mail/links.js";
import type { Mailer } from "../mail/mailer.js";
import { resetMail } from "../mail/messages.js";
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
}

/** Simple on purpose: a typo is caught by the person reading their address back, not by a regex. */
export const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
export const normalizeEmail = (s: string) => s.trim().toLowerCase();

/** A reset link works this long. */
export const RESET_MINUTES = 60;
/** At most this many reset e-mails per account in an hour: the form must not become a way to flood someone's inbox. */
const RESETS_PER_HOUR = 3;

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
      await mail.store.setEmail(req.account!.accountId, raw || null);
      // A new address is a fresh start: whoever gives it wants the reminders.
      if (raw) await mail.store.setReminders(req.account!.accountId, true);
      return { account: h.accountView((await school.accountById(req.account!.accountId))!) };
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
