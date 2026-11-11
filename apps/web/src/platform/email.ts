import { ApiError, type AccountInfo, type Api } from "../net/api.js";
import { el } from "../ui/dom.js";

// The account's e-mail on Today. Students who joined before e-mail existed are asked for an
// address once; afterwards the card shows it with the reminders switch.

export interface EmailCardDeps {
  api: Api;
  token: string;
  account: AccountInfo;
  /** After a change, with the account as the gateway now has it. */
  onChange?: (account: AccountInfo) => void;
}

function messageOf(e: unknown): string {
  return e instanceof ApiError && e.userMessage ? e.userMessage : "Не получилось сохранить. Проверьте интернет и попробуйте ещё раз.";
}

export function emailCard(d: EmailCardDeps): HTMLElement {
  const card = el("section", { class: "card", "data-card": "email" });
  let account = d.account;
  const changed = (a: AccountInfo) => {
    account = a;
    d.onChange?.(a);
    draw();
  };

  const form = (asking: boolean) => {
    const input = el("input", {
      class: "answer",
      type: "email",
      name: "email",
      autocomplete: "email",
      autocapitalize: "none",
      spellcheck: "false",
      maxlength: "254",
      value: account.email ?? "",
      "aria-label": "E-mail",
      placeholder: "anna@mail.ru",
    }) as HTMLInputElement;
    const error = el("p", { class: "form-error", role: "alert" });
    const save = el("button", { class: asking ? "primary" : "", type: "submit" }, "Сохранить") as HTMLButtonElement;
    const f = el(
      "form",
      {
        "data-form": "email",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          if (!input.value.trim()) return;
          save.disabled = true;
          error.textContent = "";
          try {
            changed((await d.api.setEmail(d.token, input.value.trim())).account);
          } catch (err) {
            error.textContent = messageOf(err);
            save.disabled = false;
          }
        },
      },
      input,
      error,
      el("div", { class: "actions" }, save, ...(asking ? [] : [el("button", { class: "link", type: "button", onclick: () => draw() }, "Отмена")])),
    );
    return { f, input };
  };

  const draw = () => {
    const student = account.role === "student";
    if (!account.email) {
      const { f } = form(true);
      card.dataset.state = "missing";
      card.replaceChildren(
        el("h2", {}, "Укажите почту"),
        el("p", {}, student ? "Пришлём напоминание о смене, о сроке домашки и об оценке, а ещё ссылку, если забудете пароль." : "На неё придёт ссылка, если забудете пароль."),
        f,
      );
      return;
    }
    card.dataset.state = account.reminders === false ? "off" : "on";
    const toggle = el("button", { class: "link", type: "button", "data-reminders": "" }, account.reminders === false ? "Включить напоминания" : "Не присылать напоминания") as HTMLButtonElement;
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      try {
        changed((await d.api.setReminders(d.token, account.reminders === false)).account);
      } catch {
        toggle.disabled = false;
      }
    });
    const edit = el("button", { class: "link", type: "button", "data-edit-email": "" }, "Изменить");
    edit.addEventListener("click", () => {
      const { f, input } = form(false);
      card.replaceChildren(el("h2", {}, "Почта"), f);
      input.focus();
    });
    card.replaceChildren(
      el("h2", {}, "Почта"),
      el("p", {}, account.email),
      ...(student ? [el("p", { class: "muted" }, account.reminders === false ? "Напоминания выключены." : "Напоминания: вечером, если не было смены, за сутки до срока домашки и когда пришла оценка.")] : []),
      el("div", { class: "actions" }, edit, ...(student ? [toggle] : [])),
    );
  };
  draw();
  return card;
}
