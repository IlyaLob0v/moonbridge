import { ApiError, type Api, type ConsentView } from "../net/api.js";
import { el } from "../ui/dom.js";

// The school's documents: the tick at sign-up, the consent card for a new edition, and for a
// student under 18 the parent's consent. While the gateway says `required`, the platform shows
// only this card (main.ts), the way it shows only "Подтвердите почту" before that.

function messageOf(e: unknown): string {
  return e instanceof ApiError && e.userMessage ? e.userMessage : "Не получилось. Проверьте интернет и попробуйте ещё раз.";
}

const docLink = (id: string, title: string) => el("a", { href: `/help/${id}`, target: "_blank", rel: "noopener", "data-doc": id }, title);

/** "договором-офертой, политикой обработки данных и согласием", with each one a link. */
function documentLinks(docs: { page_id: string; title: string }[]): (string | Node)[] {
  const names: Record<string, string> = { terms: "договором-офертой", privacy: "политикой обработки персональных данных", consent: "согласием на обработку данных" };
  const parts: (string | Node)[] = [];
  docs.forEach((d, i) => {
    if (i) parts.push(i === docs.length - 1 ? " и " : ", ");
    parts.push(docLink(d.page_id, names[d.page_id] ?? d.title));
  });
  return parts;
}

export interface ConsentFields {
  /** The tick; the form is valid only with it. */
  accept: HTMLInputElement;
  minor: () => boolean;
  parentName: HTMLInputElement;
  parentEmail: HTMLInputElement;
  /** The fields as one block for a form. */
  block: HTMLElement;
  /** An error for the student, or undefined when the fields are fine. */
  problem: () => string | undefined;
}

/**
 * The tick for the documents, the age question and the parent's fields: on the sign-up form
 * and on the consent card. `withTerms: false` leaves out the tick (already accepted).
 */
export function consentFields(docs: { page_id: string; title: string }[], o: { withTerms?: boolean; askAge?: boolean; minor?: boolean } = {}): ConsentFields {
  const accept = el("input", { type: "checkbox", name: "accept_terms", "data-accept": "" }) as HTMLInputElement;
  const adult = el("input", { type: "radio", name: "age", value: "adult", "data-age": "adult", ...(o.minor ? {} : { checked: "" }) }) as HTMLInputElement;
  const young = el("input", { type: "radio", name: "age", value: "minor", "data-age": "minor", ...(o.minor ? { checked: "" } : {}) }) as HTMLInputElement;
  const parentName = el("input", { class: "answer", type: "text", name: "parent_name", autocomplete: "off", maxlength: "80" }) as HTMLInputElement;
  const parentEmail = el("input", { class: "answer", type: "email", name: "parent_email", autocomplete: "off", autocapitalize: "none", spellcheck: "false", maxlength: "254" }) as HTMLInputElement;
  const parent = el(
    "div",
    { class: "parent-fields", "data-parent-fields": "", ...(o.minor ? {} : { hidden: "" }) },
    el("p", { class: "muted" }, "Родителю придёт письмо со ссылкой. Платформа откроется, когда он даст согласие."),
    el("label", {}, "Имя родителя", parentName),
    el("label", {}, "Почта родителя", parentEmail),
  );
  const toggle = () => (parent.hidden = !young.checked);
  adult.addEventListener("change", toggle);
  young.addEventListener("change", toggle);
  const withTerms = o.withTerms ?? true;
  const block = el(
    "div",
    { class: "consent-fields" },
    ...(o.askAge === false
      ? [parent]
      : [
          el(
            "fieldset",
            { class: "age" },
            el("legend", {}, "Возраст ученика"),
            el("label", { class: "check" }, adult, "Мне есть 18 лет"),
            el("label", { class: "check" }, young, "Мне меньше 18 лет"),
          ),
          parent,
        ]),
    ...(withTerms ? [el("label", { class: "check accept" }, accept, el("span", {}, "Я согласен(на) с ", ...documentLinks(docs)))] : []),
  );
  return {
    accept,
    minor: () => young.checked,
    parentName,
    parentEmail,
    block,
    problem: () => {
      if (withTerms && !accept.checked) return "Отметьте, что согласны с документами школы.";
      if (young.checked && (!parentName.value.trim() || !parentEmail.value.trim())) return "Укажите имя и почту родителя.";
      return undefined;
    },
  };
}

export interface ConsentGateDeps {
  api: Api;
  token: string;
  consent: ConsentView;
  /** The consents are in order: on to the platform. */
  onDone: () => void;
  onSignOut: () => void;
}

/** The only screen while consents are missing: accept the new edition, or wait for the parent. */
export function renderConsentGate(root: HTMLElement, d: ConsentGateDeps): void {
  const c = d.consent;
  const error = el("p", { class: "form-error", role: "alert" });
  const done = (next: ConsentView | null) => (!next || !next.required ? d.onDone() : renderConsentGate(root, { ...d, consent: next }));
  const parts: HTMLElement[] = [el("div", { class: "brand" }, "Школа английского")];

  if (c.terms === "needed") {
    // New student, or a new edition of the documents.
    const fields = consentFields(c.documents, { askAge: c.parent !== "ok", minor: c.minor });
    const save = el("button", { class: "primary", type: "submit" }, "Продолжить") as HTMLButtonElement;
    parts.push(
      el("h1", {}, "Документы школы"),
      el("p", {}, "Пожалуйста, прочитайте и примите документы школы. Без этого заниматься на платформе нельзя."),
      el(
        "form",
        {
          "data-form": "consent",
          onsubmit: async (e: Event) => {
            e.preventDefault();
            const problem = fields.problem();
            error.textContent = problem ?? "";
            if (problem) return;
            save.disabled = true;
            try {
              const r = await d.api.consent(d.token, {
                accept: true,
                ...(c.parent === "ok" ? {} : { minor: fields.minor() }),
                ...(fields.minor() && c.parent !== "ok" ? { parent_name: fields.parentName.value.trim(), parent_email: fields.parentEmail.value.trim() } : {}),
              });
              done(r.consent);
            } catch (err) {
              error.textContent = messageOf(err);
              save.disabled = false;
            }
          },
        },
        fields.block,
        error,
        save,
      ),
    );
  } else {
    // A minor: waiting for the parent, or the parent not asked yet.
    const fields = consentFields([], { withTerms: false, askAge: false, minor: true });
    fields.parentEmail.value = c.parent_email ?? "";
    const send = el("button", { class: c.parent === "needed" ? "primary" : "", type: "submit" }, c.parent === "pending" ? "Отправить письмо ещё раз" : "Отправить письмо родителю") as HTMLButtonElement;
    const refresh = el("button", { class: "primary", type: "button", "data-refresh": "" }, "Родитель согласился — обновить") as HTMLButtonElement;
    refresh.addEventListener("click", () => location.reload());
    parts.push(
      el("h1", {}, "Нужно согласие родителя"),
      c.parent === "pending"
        ? el("p", { "data-parent": "pending" }, `Мы отправили письмо родителю${c.parent_email ? ` на ${c.parent_email}` : ""}. Когда он нажмёт «Дать согласие», платформа откроется.`)
        : el("p", { "data-parent": "needed" }, "Ученику младше 18 лет нужно согласие родителя на обработку данных. Укажите его почту: ему придёт письмо."),
      ...(c.parent_by_email ? [] : [el("p", { class: "muted" }, "Письма пока не отправляются: попросите преподавателя, он отметит согласие, подписанное на бумаге.")]),
      ...(c.parent === "pending" ? [refresh] : []),
      el(
        c.parent === "pending" ? "details" : "div",
        { class: "parent-resend", ...(c.parent === "pending" ? {} : { open: "" }) },
        ...(c.parent === "pending" ? [el("summary", {}, "Письмо не пришло или почта другая")] : []),
        el(
        "form",
        {
          "data-form": "parent",
          onsubmit: async (e: Event) => {
            e.preventDefault();
            const problem = fields.problem();
            error.textContent = problem ?? "";
            if (problem) return;
            send.disabled = true;
            try {
              const r = await d.api.consent(d.token, { minor: true, parent_name: fields.parentName.value.trim(), parent_email: fields.parentEmail.value.trim() });
              done(r.consent);
            } catch (err) {
              error.textContent = messageOf(err);
              send.disabled = false;
            }
          },
        },
        fields.block,
        error,
        send,
      ),
      ),
      el("p", { class: "muted" }, "Родитель может подписать согласие и на бумаге: тогда его отметит преподаватель."),
    );
  }
  parts.push(
    el("div", { class: "gate-links" }, el("a", { href: "/help/faq", target: "_blank", rel: "noopener", class: "link" }, "Частые вопросы"), el("button", { class: "link", type: "button", onclick: d.onSignOut }, "Выйти")),
  );
  root.replaceChildren(el("div", { class: "card login consent-gate", "data-consent-gate": c.terms === "needed" ? "terms" : "parent" }, ...parts));
}
