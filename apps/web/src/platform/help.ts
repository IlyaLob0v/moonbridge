import { renderMarkdown, type ContentBundle, type Page } from "@moonbridge/content";
import type { Api } from "../net/api.js";
import { el } from "../ui/dom.js";

// Help: how to study, the FAQ, the teacher's guide and the school's documents. The texts are
// content (content/school/pages/*.md); this file only lays them out. The documents open for
// anyone, signed in or not: the sign-up form links to them.

export interface HelpDeps {
  api: Api;
  /** The content on this device, for help offline. */
  bundle?: ContentBundle;
  /** Who reads: a teacher sees the teacher's guide, a student the student's. */
  role?: "student" | "teacher" | "admin";
  /** Where "←" leads, and what it says. */
  back: { href: string; label: string };
}

type PageInfo = Pick<Page, "page_id" | "title" | "audience" | "version">;

const LEGAL = new Set(["privacy", "terms", "consent", "parent-consent"]);

function head(d: HelpDeps, title: string): HTMLElement {
  return el("header", { class: "section-head" }, el("a", { href: d.back.href, "data-link": "", class: "back" }, d.back.label), el("h1", {}, title));
}

const seen = (role: HelpDeps["role"]) => (p: PageInfo) => p.audience === "all" || p.audience === (role === "teacher" ? "teacher" : "student");

/** /help: the pages for this reader, the documents last. */
export async function renderHelp(root: HTMLElement, d: HelpDeps): Promise<void> {
  const pages: PageInfo[] | undefined = await d.api.pages().then(
    (r) => r.pages,
    () => d.bundle?.school?.pages,
  );
  const mine = (pages ?? []).filter(seen(d.role));
  const link = (p: PageInfo) => el("li", {}, el("a", { href: `/help/${p.page_id}`, "data-link": "", "data-help-page": p.page_id }, p.title));
  const help = mine.filter((p) => !LEGAL.has(p.page_id));
  const docs = mine.filter((p) => LEGAL.has(p.page_id));
  root.replaceChildren(
    el(
      "div",
      { class: "card help", "data-help": "" },
      head(d, "Помощь"),
      ...(pages ? [] : [el("p", { class: "form-error" }, "Нет связи с сервером, а справки на этом устройстве ещё нет.")]),
      ...(help.length ? [el("ul", { class: "help-list" }, ...help.map(link))] : []),
      ...(docs.length ? [el("h2", {}, "Документы школы"), el("ul", { class: "help-list docs" }, ...docs.map(link))] : []),
      el("p", { class: "muted" }, "Не нашли ответ? Нажмите «Сообщить о проблеме» на экране «Сегодня»."),
    ),
  );
}

/** /help/<id>: one page. */
export async function renderHelpPage(root: HTMLElement, id: string, d: HelpDeps): Promise<void> {
  const page: Page | undefined = await d.api.page(id).then(
    (r) => r.page,
    () => d.bundle?.school?.pages.find((p) => p.page_id === id),
  );
  if (!page) {
    root.replaceChildren(el("div", { class: "card help" }, head(d, "Помощь"), el("p", {}, "Такой страницы нет, или нет связи с сервером.")));
    return;
  }
  const body = el("div", { class: "page-body" });
  // Escaped and limited to a few tags by renderMarkdown: content can carry no script.
  body.innerHTML = renderMarkdown(page.body);
  root.replaceChildren(
    el(
      "article",
      { class: "card help help-page", "data-page": page.page_id },
      head(d, page.title),
      ...(page.version ? [el("p", { class: "muted" }, `Редакция от ${new Date(`${page.version}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}`)] : []),
      body,
      el("p", {}, el("a", { href: "/help", "data-link": "" }, "Вся помощь")),
    ),
  );
}

/** "Помощь" at the foot of a screen. */
export function helpLink(): HTMLElement {
  return el("a", { href: "/help", "data-link": "", class: "link help-link", "data-help-link": "" }, "Помощь и документы");
}
