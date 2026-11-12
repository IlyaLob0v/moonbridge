// The gateway as the stand starts it: the settings it refuses, and the real main.ts coming up,
// answering and shutting down. A mistake in the server's environment should stop it at start
// with a clear message, not show up later as a broken lesson.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const SECRET = "a-session-secret-that-is-long-enough-0123";
const PROD = { NODE_ENV: "production", SESSION_SECRET: SECRET, DATABASE_URL: "postgres://moonbridge@db/moonbridge" };

describe("settings", () => {
  it("needs a long session secret and a database in production", () => {
    expect(() => loadConfig({ ...PROD, SESSION_SECRET: undefined })).toThrow("missing env SESSION_SECRET");
    expect(() => loadConfig({ ...PROD, SESSION_SECRET: "" })).toThrow("missing env SESSION_SECRET");
    expect(() => loadConfig({ ...PROD, SESSION_SECRET: "short" })).toThrow("at least 32 characters");
    expect(() => loadConfig({ ...PROD, DATABASE_URL: undefined })).toThrow("DATABASE_URL is required");
    expect(loadConfig(PROD).databaseUrl).toBe(PROD.DATABASE_URL);
  });

  it("never lets guests in on production, and does in development unless told not to", () => {
    expect(loadConfig(PROD).allowGuest).toBe(false);
    expect(loadConfig({ ...PROD, ALLOW_GUEST: "true" }).allowGuest).toBe(false);
    expect(loadConfig({}).allowGuest).toBe(true);
    expect(loadConfig({ ALLOW_GUEST: "false" }).allowGuest).toBe(false);
  });

  it("refuses half-configured services instead of starting without them", () => {
    expect(() => loadConfig({ ...PROD, S3_BUCKET: "homework" })).toThrow("missing env S3_ACCESS_KEY_ID");
    expect(() => loadConfig({ ...PROD, S3_BUCKET: "homework", S3_ACCESS_KEY_ID: "id" })).toThrow("missing env S3_SECRET_ACCESS_KEY");
    expect(() => loadConfig({ ...PROD, POSTBOX_ACCESS_KEY_ID: "id" })).toThrow("missing env POSTBOX_SECRET_ACCESS_KEY");
    expect(() => loadConfig({ ...PROD, POSTBOX_ACCESS_KEY_ID: "id", POSTBOX_SECRET_ACCESS_KEY: "s" })).toThrow("missing env MAIL_FROM");
    expect(() => loadConfig({ ...PROD, LRS_ENDPOINT: "https://lrs.test/xapi" })).toThrow("missing env LRS_KEY");
  });

  it("fills the services in when they are configured", () => {
    const c = loadConfig({
      ...PROD,
      S3_BUCKET: "homework",
      S3_ACCESS_KEY_ID: "id",
      S3_SECRET_ACCESS_KEY: "secret",
      POSTBOX_ACCESS_KEY_ID: "pid",
      POSTBOX_SECRET_ACCESS_KEY: "psecret",
      MAIL_FROM: "Moonbridge <school@moonbridge.test>",
      PUBLIC_URL: "https://moonbridge.test/api/",
    });
    expect(c.s3).toEqual({ endpoint: "https://storage.yandexcloud.net", region: "ru-central1", bucket: "homework", accessKeyId: "id", secretAccessKey: "secret" });
    expect(c.postbox).toMatchObject({ endpoint: "https://postbox.cloud.yandex.net", from: "Moonbridge <school@moonbridge.test>" });
    expect(c.publicUrl).toBe("https://moonbridge.test/api");
  });

  it("asks for e-mail confirmation exactly when e-mails are delivered, unless told otherwise", () => {
    const postbox = { POSTBOX_ACCESS_KEY_ID: "pid", POSTBOX_SECRET_ACCESS_KEY: "psecret", MAIL_FROM: "school@moonbridge.test" };
    expect(loadConfig(PROD).emailVerification).toBe(false);
    expect(loadConfig({ ...PROD, ...postbox }).emailVerification).toBe(true);
    expect(loadConfig({ ...PROD, ...postbox, EMAIL_VERIFICATION: "off" }).emailVerification).toBe(false);
    expect(loadConfig({ ...PROD, EMAIL_VERIFICATION: "required" }).emailVerification).toBe(true);
  });

  it("reads secrets from files (Docker secrets)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "moonbridge-config-"));
    try {
      const platforms = [{ issuer: "https://moodle.test", clientId: "c", deploymentIds: ["d"], authLoginUrl: "https://moodle.test/a", authTokenUrl: "https://moodle.test/t", jwksUrl: "https://moodle.test/j" }];
      await writeFile(join(dir, "platforms.json"), JSON.stringify(platforms));
      await writeFile(join(dir, "key.pem"), "-----BEGIN PRIVATE KEY-----\n...");
      const c = loadConfig({ ...PROD, LTI_PLATFORMS_FILE: join(dir, "platforms.json"), LTI_PRIVATE_KEY_FILE: join(dir, "key.pem") });
      expect(c.lti.platforms).toEqual(platforms);
      expect(c.lti.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------- main.ts, as a process

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
let child: ChildProcess | undefined;

afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
});

/** Starts main.ts; resolves with the address once it listens, or with the exit code and output if it stops first. */
function start(env: Record<string, string>): Promise<{ url?: string; code?: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    const p = spawn(process.execPath, ["--import", "tsx", MAIN], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", HOST: "127.0.0.1", PORT: "0", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = p;
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      const m = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (m) resolve({ url: m[1]!, output });
    };
    p.stdout.on("data", read);
    p.stderr.on("data", read);
    p.on("exit", (code) => resolve({ code, output }));
  });
}

const exited = (p: ChildProcess) => new Promise<number | null>((resolve) => (p.exitCode !== null ? resolve(p.exitCode) : p.once("exit", resolve)));

describe("main.ts", () => {
  it("starts with the repository's content and an in-process database, answers, and stops on SIGTERM", async () => {
    const { url, output } = await start({ NODE_ENV: "development" });
    expect(url, output).toBeDefined();
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, content_hash: expect.any(String) });
    expect((await fetch(`${url}/content/manifest`)).status).toBe(200);
    expect(await (await fetch(`${url}/auth/options`)).json()).toEqual({ guest: true, password_reset: true });
    expect((await fetch(`${url}/school/dashboard`)).status).toBe(401);
    const p = child!;
    p.kill("SIGTERM");
    expect(await exited(p)).toBe(0);
  }, 60_000);

  it("refuses to start on production without a database", async () => {
    const { url, code, output } = await start({ NODE_ENV: "production", SESSION_SECRET: SECRET });
    expect(url).toBeUndefined();
    expect(code).not.toBe(0);
    expect(output).toContain("DATABASE_URL is required");
  }, 60_000);

  it("refuses to start with broken content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "moonbridge-content-"));
    try {
      await writeFile(join(dir, "broken.json"), "{ not json");
      const { url, code, output } = await start({ NODE_ENV: "development", CONTENT_DIR: dir });
      expect(url).toBeUndefined();
      expect(code).toBe(1);
      expect(output).toContain("Content is invalid");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
