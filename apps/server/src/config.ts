import { readFileSync } from "node:fs";
import type { PlatformConfig } from "./lti/platforms.js";

export interface ServerConfig {
  port: number;
  host: string;
  /** Public URL of this server, used for LTI redirect_uri and JWKS. */
  publicUrl: string;
  /** Where the game client lives; LTI launches redirect there with a session token. */
  clientUrl: string;
  contentDir: string;
  /** xAPI base IRI; must be a domain you control and must never change once data exists. */
  xapiBaseIri: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  /** Signed-in students and teachers stay signed in this long on a device. */
  accountSessionTtlSeconds: number;
  /** Where homework files are stored. */
  uploadDir: string;
  /** Bearer token for content uploads. Unset = uploads disabled. */
  adminToken?: string;
  /** Behind a reverse proxy (the stand's Caddy): client addresses come from X-Forwarded-For. */
  trustProxy: boolean;
  /** Homework files in an S3-compatible bucket (Yandex Object Storage); unset = on disk in uploadDir. */
  s3?: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };
  /** E-mail through Yandex Cloud Postbox; unset = e-mails go to the log (development, pnpm demo). */
  postbox?: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; from: string };
  /** Moscow hour the "смена ждёт" evening reminder goes out from. */
  reminderEveningHour: number;
  /**
   * Accounts must confirm their e-mail before using the platform. EMAIL_VERIFICATION=required|off;
   * by default on exactly when Postbox delivers e-mails.
   */
  emailVerification: boolean;
  /** Allows POST /session/guest for local play without an LMS. Never in production. */
  allowGuest: boolean;
  lrs?: { endpoint: string; key: string; secret: string };
  /** Postgres for the gateway's state. Unset = in-memory stores (dev only: a restart forgets everything). */
  databaseUrl?: string;
  /** Without DATABASE_URL: an in-process Postgres (PGlite) that keeps its data in this folder. */
  pgliteDir?: string;
  lti: {
    platforms: PlatformConfig[];
    /** PEM (PKCS#8) RSA private key of the tool. Unset = an ephemeral key is generated (dev only). */
    privateKeyPem?: string;
    keyId: string;
  };
}

function required(env: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const v = env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing env ${name}`);
  return v;
}

/** A value from NAME, or from the file NAME_FILE points to (Docker secrets, generated dev files). */
function fromEnvOrFile(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name]) return env[name];
  const file = env[`${name}_FILE`];
  return file ? readFileSync(file, "utf8") : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === "production";
  const sessionSecret = required(env, "SESSION_SECRET", production ? undefined : "dev-only-session-secret-change-me-0123456789");
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const port = Number(env.PORT ?? 8787);
  if (production && !env.DATABASE_URL) throw new Error("DATABASE_URL is required when NODE_ENV=production");
  const platforms = fromEnvOrFile(env, "LTI_PLATFORMS");
  const privateKeyPem = fromEnvOrFile(env, "LTI_PRIVATE_KEY");
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    clientUrl: env.CLIENT_URL ?? "http://localhost:5173",
    contentDir: env.CONTENT_DIR ?? new URL("../../../content", import.meta.url).pathname,
    xapiBaseIri: env.XAPI_BASE_IRI ?? "https://moonbridge.example.com",
    sessionSecret,
    sessionTtlSeconds: Number(env.SESSION_TTL_SECONDS ?? 8 * 3600),
    accountSessionTtlSeconds: Number(env.ACCOUNT_SESSION_TTL_SECONDS ?? 30 * 24 * 3600),
    uploadDir: env.UPLOAD_DIR ?? new URL("../../../data/uploads", import.meta.url).pathname,
    ...(env.ADMIN_TOKEN ? { adminToken: env.ADMIN_TOKEN } : {}),
    trustProxy: env.TRUST_PROXY === "true",
    ...(env.S3_BUCKET
      ? {
          s3: {
            endpoint: (env.S3_ENDPOINT ?? "https://storage.yandexcloud.net").replace(/\/$/, ""),
            region: env.S3_REGION ?? "ru-central1",
            bucket: env.S3_BUCKET,
            accessKeyId: required(env, "S3_ACCESS_KEY_ID"),
            secretAccessKey: required(env, "S3_SECRET_ACCESS_KEY"),
          },
        }
      : {}),
    ...(env.POSTBOX_ACCESS_KEY_ID
      ? {
          postbox: {
            endpoint: (env.POSTBOX_ENDPOINT ?? "https://postbox.cloud.yandex.net").replace(/\/$/, ""),
            region: env.POSTBOX_REGION ?? "ru-central1",
            accessKeyId: env.POSTBOX_ACCESS_KEY_ID,
            secretAccessKey: required(env, "POSTBOX_SECRET_ACCESS_KEY"),
            from: required(env, "MAIL_FROM"),
          },
        }
      : {}),
    reminderEveningHour: Number(env.REMINDER_EVENING_HOUR ?? 19),
    emailVerification: env.EMAIL_VERIFICATION ? env.EMAIL_VERIFICATION === "required" : Boolean(env.POSTBOX_ACCESS_KEY_ID),
    allowGuest: !production && env.ALLOW_GUEST !== "false",
    ...(env.LRS_ENDPOINT
      ? { lrs: { endpoint: env.LRS_ENDPOINT, key: required(env, "LRS_KEY"), secret: required(env, "LRS_SECRET") } }
      : {}),
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
    ...(env.PGLITE_DIR ? { pgliteDir: env.PGLITE_DIR } : {}),
    lti: {
      platforms: platforms ? (JSON.parse(platforms) as PlatformConfig[]) : [],
      ...(privateKeyPem ? { privateKeyPem } : {}),
      keyId: env.LTI_KEY_ID ?? "moonbridge-tool-1",
    },
  };
}
