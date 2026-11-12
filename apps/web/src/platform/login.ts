import { accountSession, ApiError, DEFAULT_XAPI_BASE_IRI, type Api, type SessionStorage } from "../net/api.js";
import { el } from "../ui/dom.js";
import type { Profile } from "./today.js";

const KEY = "moonbridge.profile";

export function loadProfile(): Profile | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    const p = raw ? (JSON.parse(raw) as Partial<Profile>) : undefined;
    return typeof p?.name === "string" && p.name.trim() ? { name: p.name.trim() } : undefined;
  } catch {
    return undefined;
  }
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Private mode: the name lives for this page only.
  }
}

/** Forgets the account on this device. The progress stays on the server and comes back with the next sign-in. */
export function signOut(): void {
  try {
    localStorage.removeItem("moonbridge.session");
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}

function field(label: string, attrs: Record<string, string>): { label: HTMLElement; input: HTMLInputElement } {
  const input = el("input", { class: "answer", ...attrs }) as HTMLInputElement;
  return { label: el("label", {}, label, input), input };
}

function messageOf(e: unknown): string {
  if (e instanceof ApiError && e.userMessage) return e.userMessage;
  if (e instanceof ApiError && e.status === 0) return "Нет связи с сервером.";
  if (e instanceof TypeError) return "Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.";
  return "Не получилось. Попробуйте ещё раз.";
}

async function xapiBase(api: Api, token: string): Promise<string> {
  return (await api.me(token).catch(() => undefined))?.xapi_base_iri ?? DEFAULT_XAPI_BASE_IRI;
}

/** The name-only entry of a guest, for trying the platform without an account (development and demos). */
export function askProfile(root: HTMLElement): Promise<Profile> {
  return new Promise((resolve) => {
    const name = field("Как вас зовут?", { type: "text", name: "name", autocomplete: "given-name", maxlength: "40", "aria-label": "Имя" });
    const form = el(
      "form",
      {
        class: "card login",
        onsubmit: (e: Event) => {
          e.preventDefault();
          const value = name.input.value.trim();
          if (value) resolve({ name: value });
        },
      },
      el("div", { class: "brand" }, "Школа английского"),
      el("h1", {}, "Без аккаунта"),
      name.label,
      el("button", { class: "primary", type: "submit" }, "Войти"),
    );
    root.replaceChildren(form);
    name.input.focus();
  });
}

/**
 * Sign-in with the login and password a student chose when joining by the teacher's link.
 * Resolves with "account" once the session is stored, or "guest" when the student picks
 * the guest entry (offered only where the gateway allows guests).
 */
export async function signIn(root: HTMLElement, api: Api, store: SessionStorage, note?: string): Promise<"account" | "guest"> {
  const options = await api.authOptions().catch(() => ({ guest: false, password_reset: false }));
  return new Promise((resolve) => {
    const login = field("Логин", { type: "text", name: "login", autocomplete: "username", autocapitalize: "none", spellcheck: "false", maxlength: "64" });
    const password = field("Пароль", { type: "password", name: "password", autocomplete: "current-password", maxlength: "128" });
    const error = el("p", { class: "form-error", role: "alert" });
    const submit = el("button", { class: "primary", type: "submit" }, "Войти") as HTMLButtonElement;
    const form = el(
      "form",
      {
        class: "card login",
        "data-form": "sign-in",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          submit.disabled = true;
          error.textContent = "";
          try {
            const s = await api.login(login.input.value, password.input.value);
            store.save(accountSession(s, await xapiBase(api, s.token)));
            resolve("account");
          } catch (err) {
            error.textContent = messageOf(err);
            submit.disabled = false;
          }
        },
      },
      el("div", { class: "brand" }, "Школа английского"),
      el("h1", {}, "Вход"),
      ...(note ? [el("p", { class: "muted" }, note)] : []),
      login.label,
      password.label,
      error,
      submit,
      ...(options.password_reset
        ? [
            el(
              "button",
              {
                class: "link",
                type: "button",
                "data-forgot": "",
                onclick: async () => {
                  await forgotPassword(root, api, login.input.value);
                  resolve(await signIn(root, api, store, note));
                },
              },
              "Забыли пароль?",
            ),
          ]
        : []),
      el("p", { class: "muted" }, "Впервые здесь? Откройте ссылку-приглашение от преподавателя."),
      ...(options.guest ? [el("button", { class: "link", type: "button", "data-guest": "", onclick: () => resolve("guest") }, "Попробовать без аккаунта")] : []),
    );
    root.replaceChildren(form);
    login.input.focus();
  });
}

/**
 * The invitation link /join/<code>: a new student creates an account and lands in the
 * group; a student already signed in on this phone just joins. A guest who has been
 * playing on this phone keeps their hotel: the gateway moves it into the new account.
 */
export async function joinGroup(root: HTMLElement, api: Api, store: SessionStorage, code: string): Promise<void> {
  const stored = store.load();
  let invite: Awaited<ReturnType<Api["invite"]>>;
  try {
    invite = await api.invite(code);
  } catch (e) {
    await new Promise<void>((resolve) =>
      root.replaceChildren(
        el(
          "div",
          { class: "card login", "data-form": "join-failed" },
          el("h1", {}, "Приглашение"),
          el("p", {}, messageOf(e)),
          el("p", { class: "muted" }, "Попросите преподавателя прислать новую ссылку."),
          el("button", { class: "primary", onclick: () => resolve() }, "На главную"),
        ),
      ),
    );
    return;
  }
  const head = [
    el("div", { class: "brand" }, "Школа английского"),
    el("h1", {}, `Группа «${invite.group.name}»`),
    el("p", { class: "muted" }, `Преподаватель: ${invite.group.teacher_name}`),
  ];

  await new Promise<void>((resolve) => {
    const error = el("p", { class: "form-error", role: "alert" });
    if (stored?.kind === "account" && stored.token) {
      const go = el("button", { class: "primary" }, `Вступить как ${stored.account?.name ?? "я"}`) as HTMLButtonElement;
      go.addEventListener("click", async () => {
        go.disabled = true;
        try {
          const s = await api.join(code, undefined, stored.token);
          store.save(accountSession(s, stored.xapiBaseIri));
          resolve();
        } catch (e) {
          error.textContent = messageOf(e);
          go.disabled = false;
        }
      });
      root.replaceChildren(el("div", { class: "card login", "data-form": "join" }, ...head, error, go));
      return;
    }
    const name = field("Имя", { type: "text", name: "name", autocomplete: "given-name", maxlength: "60", value: loadProfile()?.name ?? "" });
    const login = field("Логин (латиница или e-mail)", { type: "text", name: "login", autocomplete: "username", autocapitalize: "none", spellcheck: "false", maxlength: "64" });
    const password = field("Пароль (не короче 6 символов)", { type: "password", name: "password", autocomplete: "new-password", minlength: "6", maxlength: "128" });
    const email = field("E-mail", { type: "email", name: "email", autocomplete: "email", autocapitalize: "none", spellcheck: "false", maxlength: "254", required: "" });
    // A login that is an address is the address too.
    login.input.addEventListener("change", () => {
      if (!email.input.value && /@/.test(login.input.value)) email.input.value = login.input.value.trim();
    });
    const submit = el("button", { class: "primary", type: "submit" }, "Вступить в группу") as HTMLButtonElement;
    const form = el(
      "form",
      {
        class: "card login",
        "data-form": "join",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          submit.disabled = true;
          error.textContent = "";
          try {
            // A guest session on this phone goes along, so the gateway can move its progress.
            // Guest tokens expire within hours; a fresh one keeps the same player id.
            const guestToken = stored?.kind === "guest" ? ((await api.guest(stored.playerId).catch(() => undefined))?.token ?? stored.token) : undefined;
            const s = await api.join(code, { name: name.input.value.trim(), login: login.input.value, password: password.input.value, email: email.input.value.trim() }, guestToken);
            store.save(accountSession(s, await xapiBase(api, s.token)));
            resolve();
          } catch (err) {
            error.textContent = messageOf(err);
            submit.disabled = false;
          }
        },
      },
      ...head,
      name.label,
      login.label,
      password.label,
      email.label,
      el("p", { class: "muted" }, "С этим логином и паролем вы войдёте с любого телефона, и прогресс будет на месте. На почту придут напоминания и ссылка, если забудете пароль."),
      error,
      submit,
    );
    root.replaceChildren(form);
    (name.input.value ? login.input : name.input).focus();
  });
}

/** "Забыли пароль?": asks for the login or the address and sends the reset link. Resolves when the student goes back to sign-in. */
export function forgotPassword(root: HTMLElement, api: Api, typed = ""): Promise<void> {
  return new Promise((resolve) => {
    const login = field("Логин или e-mail", { type: "text", name: "login", autocomplete: "username", autocapitalize: "none", spellcheck: "false", maxlength: "254", value: typed });
    const error = el("p", { class: "form-error", role: "alert" });
    const submit = el("button", { class: "primary", type: "submit" }, "Прислать ссылку") as HTMLButtonElement;
    const back = el("button", { class: "link", type: "button", onclick: () => resolve() }, "← Ко входу");
    const form = el(
      "form",
      {
        class: "card login",
        "data-form": "forgot",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          if (!login.input.value.trim()) return;
          submit.disabled = true;
          error.textContent = "";
          try {
            const r = await api.forgotPassword(login.input.value.trim());
            root.replaceChildren(
              el(
                "div",
                { class: "card login", "data-form": "forgot-sent" },
                el("h1", {}, "Проверьте почту"),
                el("p", {}, r.message),
                el("p", { class: "muted" }, "Если письма нет или почта не указана, попросите преподавателя сбросить пароль."),
                el("button", { class: "primary", onclick: () => resolve() }, "Ко входу"),
              ),
            );
          } catch (err) {
            error.textContent = messageOf(err);
            submit.disabled = false;
          }
        },
      },
      el("div", { class: "brand" }, "Школа английского"),
      el("h1", {}, "Новый пароль"),
      el("p", { class: "muted" }, "Пришлём ссылку на почту, которую вы указали при вступлении в группу."),
      login.label,
      error,
      submit,
      back,
    );
    root.replaceChildren(form);
    login.input.focus();
  });
}

/** The link from the reset e-mail, /reset/<token>: a new password, then the student is signed in. */
export async function resetPassword(root: HTMLElement, api: Api, store: SessionStorage, token: string): Promise<void> {
  const valid = await api.checkReset(token).then(
    () => true,
    (e) => e,
  );
  await new Promise<void>((resolve) => {
    if (valid !== true) {
      root.replaceChildren(
        el(
          "div",
          { class: "card login", "data-form": "reset-failed" },
          el("h1", {}, "Новый пароль"),
          el("p", {}, messageOf(valid)),
          el("button", { class: "primary", onclick: () => resolve() }, "Ко входу"),
        ),
      );
      return;
    }
    const password = field("Новый пароль (не короче 6 символов)", { type: "password", name: "password", autocomplete: "new-password", minlength: "6", maxlength: "128" });
    const error = el("p", { class: "form-error", role: "alert" });
    const submit = el("button", { class: "primary", type: "submit" }, "Сохранить и войти") as HTMLButtonElement;
    root.replaceChildren(
      el(
        "form",
        {
          class: "card login",
          "data-form": "reset",
          onsubmit: async (e: Event) => {
            e.preventDefault();
            if (password.input.value.length < 6) {
              error.textContent = "Пароль должен быть не короче 6 символов.";
              return;
            }
            submit.disabled = true;
            error.textContent = "";
            try {
              const s = await api.resetByLink(token, password.input.value);
              store.save(accountSession(s, await xapiBase(api, s.token)));
              resolve();
            } catch (err) {
              error.textContent = messageOf(err);
              submit.disabled = false;
            }
          },
        },
        el("div", { class: "brand" }, "Школа английского"),
        el("h1", {}, "Новый пароль"),
        password.label,
        error,
        submit,
      ),
    );
    password.input.focus();
  });
}
