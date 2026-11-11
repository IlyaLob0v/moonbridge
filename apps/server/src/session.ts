import { jwtVerify, SignJWT } from "jose";
import type { AgsEndpoint } from "./lti/claims.js";

/** What a session carries. LTI fields are present only for sessions started from an LMS, account fields only after a sign-in. */
export interface Session {
  playerId: string;
  /** Doubles as xAPI context.registration. */
  registration: string;
  account?: { id: string; role: "student" | "teacher" | "admin" };
  lti?: {
    iss: string;
    clientId: string;
    deploymentId: string;
    sub: string;
    contextId?: string;
    ags?: AgsEndpoint;
    /** custom.module_id of the LMS link, if the link is bound to one module. */
    moduleId?: string;
  };
}

/**
 * Stateless session tokens, sent as a Bearer header rather than a cookie so the
 * game keeps working inside an LMS iframe where third-party cookies are blocked.
 */
export class SessionTokens {
  private readonly key: Uint8Array;
  constructor(secret: string, private readonly ttlSeconds: number, private readonly issuer = "moonbridge") {
    this.key = new TextEncoder().encode(secret);
  }

  /** `ttlSeconds` overrides the default: account sessions live for weeks, guest and LMS ones for hours. */
  issue(s: Session, ttlSeconds = this.ttlSeconds): Promise<string> {
    return new SignJWT({ reg: s.registration, ...(s.lti ? { lti: s.lti } : {}), ...(s.account ? { acc: s.account } : {}) })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(this.issuer)
      .setSubject(s.playerId)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.key);
  }

  async verify(token: string): Promise<Session | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: this.issuer, algorithms: ["HS256"] });
      if (!payload.sub || typeof payload.reg !== "string") return undefined;
      return {
        playerId: payload.sub,
        registration: payload.reg,
        ...(payload.lti ? { lti: payload.lti as Session["lti"] } : {}),
        ...(payload.acc ? { account: payload.acc as Session["account"] } : {}),
      };
    } catch {
      return undefined;
    }
  }
}
