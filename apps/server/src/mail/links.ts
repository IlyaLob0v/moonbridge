import { jwtVerify, SignJWT } from "jose";

/**
 * The links in e-mails. They point at the gateway (PUBLIC_URL), which notes the click or the
 * unsubscribe and sends the browser on to the platform (CLIENT_URL).
 */
export class MailLinks {
  private readonly key: Uint8Array;
  private readonly publicUrl: string;
  readonly clientUrl: string;

  constructor(c: { publicUrl: string; clientUrl: string; sessionSecret: string }) {
    this.key = new TextEncoder().encode(`unsubscribe:${c.sessionSecret}`);
    this.publicUrl = c.publicUrl.replace(/\/$/, "");
    this.clientUrl = c.clientUrl.replace(/\/$/, "");
  }

  /** The e-mail's button: counts the return, then opens `target` on the platform. */
  go(emailId: string): string {
    return `${this.publicUrl}/email/go/${emailId}`;
  }

  /** Never expires: an unsubscribe link in an old e-mail must still work. */
  async unsubscribe(accountId: string): Promise<string> {
    const t = await new SignJWT({ p: "unsubscribe" }).setProtectedHeader({ alg: "HS256" }).setSubject(accountId).sign(this.key);
    return `${this.publicUrl}/email/unsubscribe?t=${t}`;
  }

  async unsubscribeAccount(token: string): Promise<string | undefined> {
    const claims = await jwtVerify(token, this.key, { algorithms: ["HS256"] }).catch(() => undefined);
    return claims?.payload.p === "unsubscribe" ? claims.payload.sub : undefined;
  }

  reset(token: string): string {
    return `${this.clientUrl}/reset/${token}`;
  }
}
