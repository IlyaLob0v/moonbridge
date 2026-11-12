import { validateContent } from "@moonbridge/content";
import { buildBundle, loadContentDir } from "@moonbridge/content/node";
import { MemoryOutboxStore, Outbox, type OutboxStore, type Statement } from "@moonbridge/xapi";
import type { FastifyInstance } from "fastify";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { afterEach, beforeAll, expect } from "vitest";
import { buildApp, type AppDeps } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { GradeSync, MemoryGradeStore, type GradeStore } from "../src/grades.js";
import { AgsClient } from "../src/lti/ags.js";
import { AGS_SCOPE, CLAIM } from "../src/lti/claims.js";
import { MemoryIdentityStore, type IdentityStore } from "../src/lti/identity.js";
import { loadToolKeys } from "../src/lti/keys.js";
import { LoginStateStore, type LoginStates } from "../src/lti/launch.js";
import { PlatformRegistry, type PlatformConfig } from "../src/lti/platforms.js";
import { MemoryProgressStore, type ProgressStore } from "../src/progress.js";
import { MemoryScoreStore, type ScoreStore } from "../src/scores.js";
import { SessionTokens } from "../src/session.js";

export const CONTENT_DIR = new URL("../../../packages/content/test/fixtures/content", import.meta.url).pathname;

export const platform: PlatformConfig = {
  issuer: "https://moodle.test",
  clientId: "moonbridge-client",
  deploymentIds: ["dep-1"],
  authLoginUrl: "https://moodle.test/mod/lti/auth.php",
  authTokenUrl: "https://moodle.test/mod/lti/token.php",
  jwksUrl: "https://moodle.test/mod/lti/certs.php",
};

let platformKey: CryptoKey;
let platformJwk: JWK;
export let bundle: Awaited<ReturnType<typeof buildBundle>>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  platformKey = pair.privateKey;
  platformJwk = { ...(await exportJWK(pair.publicKey)), kid: "moodle-1", alg: "RS256" };
  const { source } = await loadContentDir(CONTENT_DIR);
  bundle = buildBundle(validateContent(source).content!);
});

interface Harness {
  app: FastifyInstance;
  sent: Statement[];
  agsCalls: { url: string; init: RequestInit }[];
  outbox: Outbox;
  grades: GradeSync;
  /** While true, the LMS answers every AGS call with 503. */
  lms: { down: boolean };
}

let current: FastifyInstance | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** Stores to test the app with; in-memory ones by default. */
export interface HarnessStores {
  loginStates?: LoginStates;
  identities?: IdentityStore;
  scores?: ScoreStore;
  progress?: ProgressStore;
  outboxStore?: OutboxStore;
  gradeStore?: GradeStore;
  school?: AppDeps["school"];
  content?: AppDeps["content"];
  fetchSheet?: AppDeps["fetchSheet"];
}

/** `keepOpen`: the app outlives a single test (one fixture for many tests); the caller closes it. */
export async function harness(stores: HarnessStores = {}, { keepOpen = false } = {}): Promise<Harness> {
  const config = loadConfig({ NODE_ENV: "test", CONTENT_DIR, ADMIN_TOKEN: "admin-secret", PUBLIC_URL: "https://moonbridge.test", CLIENT_URL: "https://app.moonbridge.test/" });
  const sent: Statement[] = [];
  const outbox = new Outbox(stores.outboxStore ?? new MemoryOutboxStore(), { send: async (b) => (sent.push(...b), { kind: "sent", ids: b.map((s) => s.id) }) });
  const agsCalls: Harness["agsCalls"] = [];
  const lms = { down: false };
  const agsFetch = (async (url: string, init: RequestInit) => {
    if (lms.down) return new Response("maintenance", { status: 503 });
    agsCalls.push({ url, init });
    if (url === platform.authTokenUrl) return Response.json({ access_token: "lms-token", expires_in: 3600 });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const toolKeys = await loadToolKeys("tool-1");
  const platforms = new PlatformRegistry([platform], () => createLocalJWKSet({ keys: [platformJwk] }));
  const grades = new GradeSync(stores.gradeStore ?? new MemoryGradeStore(), platforms, new AgsClient(toolKeys, agsFetch), { baseDelayMs: 0 });
  const app = await buildApp({
    config,
    bundle,
    outbox,
    tokens: new SessionTokens(config.sessionSecret, 3600),
    platforms,
    loginStates: stores.loginStates ?? new LoginStateStore(),
    identities: stores.identities ?? new MemoryIdentityStore(),
    grades,
    scores: stores.scores ?? new MemoryScoreStore(),
    progress: stores.progress ?? new MemoryProgressStore(),
    toolKeys,
    ...(stores.school ? { school: stores.school } : {}),
    ...(stores.content ? { content: stores.content } : {}),
    ...(stores.fetchSheet ? { fetchSheet: stores.fetchSheet } : {}),
  });
  if (!keepOpen) current = app;
  return { app, sent, agsCalls, outbox, grades, lms };
}

export async function idToken(nonce: string, overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    nonce,
    [CLAIM.messageType]: "LtiResourceLinkRequest",
    [CLAIM.version]: "1.3.0",
    [CLAIM.deploymentId]: "dep-1",
    [CLAIM.targetLinkUri]: "https://moonbridge.test/lti/launch",
    [CLAIM.resourceLink]: { id: "rl-42" },
    [CLAIM.roles]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
    [CLAIM.context]: { id: "course-7" },
    [CLAIM.custom]: { module_id: "A1_PastSimple_01" },
    [CLAIM.ags]: { scope: [AGS_SCOPE.score], lineitem: "https://moodle.test/mod/lti/services.php/2/lineitems/9/lineitem?type_id=1" },
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "moodle-1" })
    .setIssuer(platform.issuer)
    .setAudience(platform.clientId)
    .setSubject("moodle-user-17")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(platformKey);
}

export async function login(app: FastifyInstance) {
  const res = await app.inject({
    method: "POST",
    url: "/lti/login",
    payload: new URLSearchParams({ iss: platform.issuer, login_hint: "17", target_link_uri: "https://moonbridge.test/lti/launch", client_id: platform.clientId }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  expect(res.statusCode).toBe(302);
  const redirect = new URL(res.headers.location as string);
  return { redirect, state: redirect.searchParams.get("state")!, nonce: redirect.searchParams.get("nonce")! };
}

export async function launch(app: FastifyInstance, form: Record<string, string>) {
  return app.inject({ method: "POST", url: "/lti/launch", payload: new URLSearchParams(form).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
}

export function sessionFrom(html: string): string {
  const url = new URL(/url=([^"]+)"/.exec(html)![1]!.replaceAll("&amp;", "&"));
  return new URLSearchParams(url.hash.slice(1)).get("session")!;
}
