import { renderMarkdown, type ContentBundle, type Page } from "@moonbridge/content";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parentConsentMail } from "../mail/messages.js";
import { EMAIL, normalizeEmail, type MailDeps } from "./email-routes.js";
import type { Versions } from "./consent-store.js";
import type { Account, SchoolStore } from "./store.js";

// The school's legal texts and help pages, and the consents a student gives: the offer, the
// privacy policy and the consent to processing (one tick at sign-up, again for a new edition),
// and for a student under 18 the parent's consent, by the link in an e-mail to the parent or on
// paper as the teacher records it. Until then a student sees only the consent card.

/** The pages a student accepts by ticking one box. */
export const TERMS_PAGES = ["terms", "privacy", "consent"] as const;
export const PARENT_PAGE = "parent-consent";
/** A parent's link works this long: a parent may open the e-mail at the weekend. */
export const PARENT_LINK_DAYS = 7;
const PARENT_LINKS_PER_HOUR = 3;

export type ParentState = "not_needed" | "needed" | "pending" | "ok";

/** What the platform shows about consents; `required` = only the consent card until it is false. */
export interface ConsentView {
  required: boolean;
  terms: "ok" | "needed";
  /** The editions to accept, with the pages' titles. */
  documents: { page_id: string; title: string; version: string }[];
  minor: boolean;
  parent: ParentState;
  parent_email: string | null;
  parent_method: "email" | "paper" | null;
  /** Parents can be asked by e-mail here (the gateway sends e-mail); otherwise only on paper. */
  parent_by_email: boolean;
}

export interface ConsentDeps {
  school: SchoolStore;
  mail?: MailDeps;
  bundle: () => ContentBundle | undefined;
  /** CONSENT=off turns the whole thing off. */
  enabled: boolean;
  now: () => Date;
  requireAccount: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  requireTeacher: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

const pagesOf = (b: ContentBundle | undefined): Page[] => b?.school?.pages ?? [];

/** The editions of the legal pages a student accepts now, or undefined when the content has none (no consent asked). */
export function currentTerms(b: ContentBundle | undefined): { versions: Versions; documents: ConsentView["documents"] } | undefined {
  const pages = pagesOf(b).filter((p) => (TERMS_PAGES as readonly string[]).includes(p.page_id) && p.version);
  if (!pages.some((p) => p.page_id === "terms" || p.page_id === "consent")) return undefined;
  return {
    versions: Object.fromEntries(pages.map((p) => [p.page_id, p.version!])),
    documents: pages.map((p) => ({ page_id: p.page_id, title: p.title, version: p.version! })),
  };
}

const sameVersions = (a: Versions, b: Versions) => Object.keys(b).every((k) => a[k] === b[k]);

export class Consents {
  constructor(private readonly d: ConsentDeps) {}

  /** Whether the platform asks for consents at all. */
  get active(): boolean {
    return this.d.enabled && !!currentTerms(this.d.bundle());
  }

  async view(a: Account): Promise<ConsentView | undefined> {
    const terms = currentTerms(this.d.bundle());
    if (!this.d.enabled || !terms || a.role !== "student") return undefined;
    const latest = (await this.d.school.consents.latest([a.accountId])).get(a.accountId) ?? {};
    const minor = await this.d.school.consents.isMinor(a.accountId);
    const termsOk = !!latest.terms && sameVersions(latest.terms.versions, terms.versions);
    let parent: ParentState = "not_needed";
    let parentEmail: string | null = null;
    if (minor) {
      const request = await this.d.school.consents.lastRequest(a.accountId);
      parent = latest.parent ? "ok" : request ? "pending" : "needed";
      parentEmail = latest.parent?.parentEmail ?? request?.parentEmail ?? null;
    }
    return {
      required: !termsOk || (minor && parent !== "ok"),
      terms: termsOk ? "ok" : "needed",
      documents: terms.documents,
      minor,
      parent,
      parent_email: parentEmail,
      parent_method: latest.parent ? (latest.parent.method === "paper" ? "paper" : "email") : null,
      parent_by_email: !!this.d.mail,
    };
  }

  /** True when the student may not use the platform yet. */
  async blocks(a: Account): Promise<boolean> {
    if (a.role !== "student" || !this.active) return false;
    return (await this.view(a))?.required ?? false;
  }

  /** The tick at sign-up or on the consent card: the current editions, from this phone. */
  async acceptTerms(a: Account, req: FastifyRequest): Promise<void> {
    const terms = currentTerms(this.d.bundle());
    if (!terms) return;
    await this.d.school.consents.record({
      accountId: a.accountId,
      kind: "terms",
      versions: terms.versions,
      method: "click",
      ip: req.ip,
      userAgent: String(req.headers["user-agent"] ?? ""),
      at: this.d.now(),
    });
  }

  /** Marks the student as a minor and e-mails the parent a link. Returns an error message for the student, if any. */
  async askParent(a: Account, parent: { name?: unknown; email?: unknown }, log: { error: (o: unknown, m: string) => void }): Promise<string | undefined> {
    const name = typeof parent.name === "string" ? parent.name.trim().slice(0, 80) : "";
    const email = typeof parent.email === "string" ? normalizeEmail(parent.email) : "";
    if (!name) return "Укажите, как зовут родителя";
    if (!EMAIL.test(email) || email.length > 254) return "Проверьте почту родителя. Пример: mama@mail.ru";
    if (email === a.email) return "Почта родителя должна отличаться от вашей";
    await this.d.school.consents.setMinor(a.accountId, true);
    if (!this.d.mail) return undefined;
    const now = this.d.now();
    if ((await this.d.school.consents.requestsSince(a.accountId, new Date(now.getTime() - 3600_000))) >= PARENT_LINKS_PER_HOUR) {
      return "Письмо родителю уже отправлено несколько раз. Попробуйте через час.";
    }
    const token = await this.d.school.consents.createParentRequest({ accountId: a.accountId, parentName: name, parentEmail: email, now, expiresAt: new Date(now.getTime() + PARENT_LINK_DAYS * 86400_000) });
    await this.d.mail.mailer
      .send(parentConsentMail({ name, email }, { name: a.name }, this.d.mail.links.parentConsent(token), PARENT_LINK_DAYS))
      .catch((e) => log.error({ err: e }, "parent consent e-mail not sent"));
    return undefined;
  }
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const htmlPage = (title: string, body: string) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>body{margin:0;padding:24px 16px;background:#f4f1ea;font-family:system-ui,Arial,sans-serif;color:#1f2430;line-height:1.5}main{max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:24px}button{background:#2f5d8a;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:16px;cursor:pointer}blockquote{margin:0 0 16px;padding:8px 12px;background:#fff7e0;border-radius:8px}.doc{border-top:1px solid #e5e1d8;margin-top:16px;padding-top:8px}label{display:block;margin:16px 0}</style>
</head><body><main>${body}</main></body></html>`;

/** GET /pages, /pages/:id (public: sign-up links to them), the consent card's actions, the parent's page, a teacher's paper consent. */
export async function consentRoutes(app: FastifyInstance, c: Consents, d: ConsentDeps): Promise<void> {
  app.get("/pages", async () => ({
    pages: pagesOf(d.bundle()).map((p) => ({ page_id: p.page_id, title: p.title, audience: p.audience, ...(p.version ? { version: p.version } : {}) })),
  }));

  app.get<{ Params: { id: string } }>("/pages/:id", async (req, reply) => {
    const page = pagesOf(d.bundle()).find((p) => p.page_id === req.params.id);
    if (!page) return reply.code(404).send({ error: "page", message: "Такой страницы нет" });
    return { page };
  });

  app.get("/account/consent", { preHandler: d.requireAccount }, async (req) => ({ consent: (await c.view(req.account!)) ?? null }));

  /**
   * The consent card: the tick for the current editions, and for a minor the parent's name and
   * address (a new address sends a new link). `minor: false` is the student saying they are 18.
   */
  app.post<{ Body: { accept?: boolean; minor?: boolean; parent_name?: string; parent_email?: string } }>(
    "/account/consent",
    {
      preHandler: d.requireAccount,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { accept: { type: "boolean" }, minor: { type: "boolean" }, parent_name: { type: "string", maxLength: 80 }, parent_email: { type: "string", maxLength: 254 } },
        },
      },
    },
    async (req, reply) => {
      const a = req.account!;
      if (a.role !== "student") return reply.code(409).send({ error: "role", message: "Согласие даёт ученик" });
      const before = await c.view(a);
      if (!before) return { consent: null };
      if (req.body.accept) await c.acceptTerms(a, req);
      else if (before.terms !== "ok") return reply.code(400).send({ error: "accept", message: "Отметьте, что согласны с документами" });
      // Once a parent has consented, the age is settled: nothing to change here.
      if (req.body.minor !== undefined && before.parent !== "ok") {
        if (req.body.minor) {
          const problem = await c.askParent(a, { name: req.body.parent_name, email: req.body.parent_email }, req.log);
          if (problem) return reply.code(400).send({ error: "parent", message: problem });
        } else await d.school.consents.setMinor(a.accountId, false);
      }
      return { consent: (await c.view(a)) ?? null };
    },
  );

  /** The link in the parent's e-mail: the texts and one button. GET shows (mail scanners open links), POST consents. */
  app.get<{ Querystring: { t?: string } }>("/consent/parent", async (req, reply) => {
    reply.type("text/html; charset=utf-8");
    const r = req.query.t && req.query.t.length <= 100 ? await d.school.consents.parentRequest(req.query.t, d.now()) : undefined;
    if (!r) return reply.code(404).send(htmlPage("Ссылка не работает", "<h1>Ссылка не работает</h1><p>Она устарела или согласие уже дано. Ученик может отправить новое письмо со своего экрана на платформе.</p>"));
    const student = await d.school.accountById(r.accountId);
    const pages = pagesOf(d.bundle());
    const docs = [PARENT_PAGE, "terms", "privacy"].map((id) => pages.find((p) => p.page_id === id)).filter((p): p is Page => !!p);
    return htmlPage(
      "Согласие родителя",
      `<h1>Согласие родителя</h1><p>${escape(r.parentName)}, вас указали родителем ученика <b>${escape(student?.name ?? "")}</b>.</p>
${docs.map((p) => `<section class="doc"><h2>${escape(p.title)}</h2>${renderMarkdown(p.body)}</section>`).join("\n")}
<form method="post"><label><input type="checkbox" name="agree" value="yes" required> Я родитель (законный представитель) ученика, прочитал(а) тексты выше и даю согласие</label><button type="submit">Дать согласие</button></form>`,
    );
  });

  app.post<{ Querystring: { t?: string }; Body: { agree?: string } | undefined }>("/consent/parent", async (req, reply) => {
    reply.type("text/html; charset=utf-8");
    if (req.body?.agree !== "yes") return reply.code(400).send(htmlPage("Согласие", "<h1>Отметьте согласие</h1><p>Вернитесь назад и поставьте галочку.</p>"));
    const r = req.query.t && req.query.t.length <= 100 ? await d.school.consents.useParentRequest(req.query.t, d.now()) : undefined;
    if (!r) return reply.code(404).send(htmlPage("Ссылка не работает", "<h1>Ссылка не работает</h1><p>Она устарела или согласие уже дано.</p>"));
    const parentPage = pagesOf(d.bundle()).find((p) => p.page_id === PARENT_PAGE);
    await d.school.consents.record({
      accountId: r.accountId,
      kind: "parent",
      versions: { ...currentTerms(d.bundle())?.versions, ...(parentPage?.version ? { [PARENT_PAGE]: parentPage.version } : {}) },
      method: "email",
      parentName: r.parentName,
      parentEmail: r.parentEmail,
      ip: req.ip,
      userAgent: String(req.headers["user-agent"] ?? ""),
      at: d.now(),
    });
    return htmlPage("Спасибо", "<h1>Спасибо!</h1><p>Согласие получено. Ученик может заниматься на платформе.</p>");
  });

  /** A parent signed the consent on paper: the teacher of the student records it. */
  app.post<{ Params: { id: string }; Body: { parent_name?: string } }>(
    "/school/students/:id/parent-consent",
    { preHandler: d.requireTeacher, schema: { body: { type: "object", additionalProperties: false, properties: { parent_name: { type: "string", maxLength: 80 } } } } },
    async (req, reply) => {
      const student = await d.school.accountById(req.params.id);
      if (!student || student.role !== "student" || !(await d.school.teaches(req.account!.accountId, student.accountId))) return reply.code(404).send({ error: "no such student" });
      const parentPage = pagesOf(d.bundle()).find((p) => p.page_id === PARENT_PAGE);
      await d.school.consents.setMinor(student.accountId, true);
      await d.school.consents.record({
        accountId: student.accountId,
        kind: "parent",
        versions: parentPage?.version ? { [PARENT_PAGE]: parentPage.version } : {},
        method: "paper",
        parentName: req.body?.parent_name?.trim() || null,
        recordedBy: req.account!.accountId,
        at: d.now(),
      });
      return { consent: (await c.view(student)) ?? null };
    },
  );
}
