import { createHash } from "node:crypto";
import { signV4 } from "../school/s3.js";

/** One e-mail: a plain-text body for every client and an HTML one for those that show it. */
export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Extra headers, such as List-Unsubscribe. */
  headers?: Record<string, string>;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export interface PostboxConfig {
  /** https://postbox.cloud.yandex.net */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** "Школа английского <hello@example.ru>"; the address must be a verified Postbox address. */
  from: string;
}

/** A display name with letters outside ASCII goes as an RFC 2047 encoded word. */
export function encodeFrom(from: string): string {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (!m || !m[1]) return from.trim();
  const name = m[1].replace(/^"|"$/g, "");
  const ascii = /^[\x20-\x7e]*$/.test(name);
  return `${ascii ? `"${name.replace(/["\\]/g, "")}"` : `=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?=`} <${m[2]}>`;
}

/**
 * Yandex Cloud Postbox through its Amazon SES v2–compatible API, signed with a service account's
 * static access key (Signature V4, service "ses"). No SDK: one signed POST per e-mail.
 */
export class PostboxMailer implements Mailer {
  private readonly url: URL;

  constructor(
    private readonly c: PostboxConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.url = new URL("/v2/email/outbound-emails", c.endpoint);
  }

  async send(mail: Mail): Promise<void> {
    const body = JSON.stringify({
      FromEmailAddress: encodeFrom(this.c.from),
      Destination: { ToAddresses: [mail.to] },
      Content: {
        Simple: {
          Subject: { Data: mail.subject, Charset: "UTF-8" },
          Body: { Text: { Data: mail.text, Charset: "UTF-8" }, Html: { Data: mail.html, Charset: "UTF-8" } },
          ...(mail.headers ? { Headers: Object.entries(mail.headers).map(([Name, Value]) => ({ Name, Value })) } : {}),
        },
      },
    });
    const headers = signV4({
      method: "POST",
      host: this.url.host,
      path: this.url.pathname,
      headers: { "content-type": "application/json" },
      payloadHash: createHash("sha256").update(body).digest("hex"),
      date: this.now(),
      region: this.c.region,
      service: "ses",
      accessKeyId: this.c.accessKeyId,
      secretAccessKey: this.c.secretAccessKey,
    });
    delete headers.host;
    const res = await this.fetchImpl(this.url, { method: "POST", headers, body, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Postbox: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
}

/** Without Postbox (development, pnpm demo): the e-mail goes to the log, links included, so they can be opened by hand. */
export class LogMailer implements Mailer {
  constructor(private readonly log: (line: string) => void = (l) => console.info(l)) {}

  async send(mail: Mail): Promise<void> {
    this.log(`e-mail to ${mail.to}: ${mail.subject}\n${mail.text}\n`);
  }
}

/** Keeps every e-mail; for tests. */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  /** While set, every send fails with it. */
  failWith: Error | undefined;

  async send(mail: Mail): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push(mail);
  }
}
