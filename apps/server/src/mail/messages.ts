import type { Mail } from "./mailer.js";

// The platform's e-mails, in Russian. Short on purpose: one sentence of why, one button.
// Every reminder carries the unsubscribe link in its text and in List-Unsubscribe, so mail
// clients show their own "Отписаться" button too.

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

interface Layout {
  to: string;
  subject: string;
  /** Paragraphs of plain text. */
  lines: string[];
  button: { label: string; url: string };
  /** Reminders only: the password reset e-mail cannot be switched off. */
  unsubscribeUrl?: string;
  footer?: string;
}

function layout(l: Layout): Mail {
  const footer = l.footer ?? "Школа английского";
  const text = [
    ...l.lines,
    `${l.button.label}: ${l.button.url}`,
    "",
    "—",
    footer,
    ...(l.unsubscribeUrl ? [`Не присылать напоминания: ${l.unsubscribeUrl}`] : []),
  ].join("\n\n");
  const html = `<!doctype html><html lang="ru"><body style="margin:0;padding:24px;background:#f4f1ea;font-family:Arial,Helvetica,sans-serif;color:#1f2430">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">
${l.lines.map((p) => `<p style="font-size:16px;line-height:1.5;margin:0 0 16px">${escape(p)}</p>`).join("\n")}
<p style="margin:24px 0"><a href="${escape(l.button.url)}" style="display:inline-block;background:#2f5d8a;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:16px">${escape(l.button.label)}</a></p>
<p style="font-size:13px;color:#6b7280;margin:24px 0 0">${escape(footer)}${l.unsubscribeUrl ? `<br><a href="${escape(l.unsubscribeUrl)}" style="color:#6b7280">Не присылать напоминания</a>` : ""}</p>
</div></body></html>`;
  return {
    to: l.to,
    subject: l.subject,
    text,
    html,
    ...(l.unsubscribeUrl ? { headers: { "List-Unsubscribe": `<${l.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}),
  };
}

const MSK = { timeZone: "Europe/Moscow" } as const;
/** "4 декабря в 18:00" in Moscow time. */
export function moscowWhen(at: Date): string {
  const day = new Intl.DateTimeFormat("ru-RU", { ...MSK, day: "numeric", month: "long" }).format(at);
  const time = new Intl.DateTimeFormat("ru-RU", { ...MSK, hour: "2-digit", minute: "2-digit" }).format(at);
  return `${day} в ${time}`;
}

export interface Recipient {
  name: string;
  email: string;
}

interface Links {
  go: string;
  unsubscribe: string;
}

export function eveningMail(r: Recipient, links: Links): Mail {
  return layout({
    to: r.email,
    subject: "Смена в Hotel Hello ждёт",
    lines: [`${r.name}, сегодня вы ещё не заходили в отель.`, "Короткая смена занимает минут десять: гости, бюро находок и пара повторений."],
    button: { label: "Начать смену", url: links.go },
    unsubscribeUrl: links.unsubscribe,
  });
}

export function deadlineMail(r: Recipient, hw: { title: string; dueAt: Date }, links: Links): Mail {
  return layout({
    to: r.email,
    subject: `Домашка до ${moscowWhen(hw.dueAt)}: ${hw.title}`,
    lines: [`${r.name}, домашку «${hw.title}» нужно сдать до ${moscowWhen(hw.dueAt)} (по Москве).`, "Файл ещё не отправлен."],
    button: { label: "Сдать домашку", url: links.go },
    unsubscribeUrl: links.unsubscribe,
  });
}

export function gradeMail(r: Recipient, s: { title: string; grade: number; comment: string; teacherName: string }, links: Links): Mail {
  return layout({
    to: r.email,
    subject: `Оценка за «${s.title}»: ${s.grade}`,
    lines: [
      `${r.name}, ${s.teacherName} проверил(а) домашку «${s.title}».`,
      `Оценка: ${s.grade} из 5.`,
      ...(s.comment ? [`Комментарий: ${s.comment}`] : []),
    ],
    button: { label: "Посмотреть", url: links.go },
    unsubscribeUrl: links.unsubscribe,
  });
}

export function resetMail(r: Recipient & { login: string }, url: string, minutes: number): Mail {
  return layout({
    to: r.email,
    subject: "Новый пароль для школы английского",
    lines: [
      `${r.name}, кто-то (наверное, вы) попросил сменить пароль.`,
      `Ваш логин: ${r.login}. Ссылка работает ${minutes} минут и только один раз.`,
      "Если вы ничего не просили, просто удалите это письмо: пароль останется прежним.",
    ],
    button: { label: "Задать новый пароль", url },
  });
}
