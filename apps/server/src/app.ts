import formbody from "@fastify/formbody";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { validateContent, type ContentBundle, type ContentSource } from "@moonbridge/content";
import { buildBundle } from "@moonbridge/content/node";
import { attemptOf, episodeResultOf, XapiProfile, Outbox, validateStatement, type Attempt, type EpisodeResult, type Statement } from "@moonbridge/xapi";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { ServerConfig } from "./config.js";
import { LiveContent } from "./content/live.js";
import { contextKey, type GradeOutcome, type GradeSync } from "./grades.js";
import type { IdentityStore } from "./lti/identity.js";
import type { ToolKeys } from "./lti/keys.js";
import { buildAuthRedirect, LtiError, verifyLaunch, type LoginRequest, type LoginStates } from "./lti/launch.js";
import type { PlatformRegistry } from "./lti/platforms.js";
import type { ProgressStore } from "./progress.js";
import type { ScoreStore } from "./scores.js";
import type { FileStore } from "./school/files.js";
import type { MailDeps } from "./school/email-routes.js";
import type { LessonBilling } from "./school/lessons.js";
import { schoolRoutes } from "./school/routes.js";
import { settleUnitHomework } from "./school/units.js";
import type { SchoolStore } from "./school/store.js";
import type { Session, SessionTokens } from "./session.js";

export interface AppDeps {
  config: ServerConfig;
  bundle: ContentBundle;
  /** The live content, when teachers may publish from the content sheet; otherwise `bundle` is served as is. */
  content?: LiveContent;
  /** How the gateway reaches Google Sheets (tests pass a fake). */
  fetchSheet?: typeof fetch;
  outbox: Outbox;
  tokens: SessionTokens;
  platforms: PlatformRegistry;
  loginStates: LoginStates;
  identities: IdentityStore;
  grades: GradeSync;
  scores: ScoreStore;
  progress: ProgressStore;
  toolKeys: ToolKeys;
  /** Accounts, groups, homework and hand-in files. Without it the gateway serves guests and LMS launches only. */
  school?: { store: SchoolStore; files: FileStore; mail?: MailDeps; now?: () => Date; billing?: LessonBilling };
}

declare module "fastify" {
  interface FastifyRequest {
    session?: Session;
  }
}

const MAX_STATEMENTS_PER_POST = 200;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
/** A client clock this far ahead is wrong; its saves would block every honest save after it. */
const MAX_CLOCK_SKEW_MS = 24 * 3600 * 1000;
const GUEST_ID = /^guest_[0-9a-f]{8}$/;
const MEDIA_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
};

export async function buildApp(d: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test", bodyLimit: 5 * 1024 * 1024, trustProxy: d.config.trustProxy });
  await app.register(formbody);
  const profile = new XapiProfile(d.config.xapiBaseIri);
  const live = d.content ?? new LiveContent(d.bundle);

  const requireSession = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const session = header?.startsWith("Bearer ") ? await d.tokens.verify(header.slice(7)) : undefined;
    if (!session) return reply.code(401).send({ error: "session required" });
    req.session = session;
  };

  app.get("/health", async () => ({ ok: true, content_hash: live.bundle.content_hash }));

  // ---------- Content API
  app.get("/content/bundle", async (req, reply) => {
    const etag = `"${live.bundle.content_hash}"`;
    reply.header("ETag", etag).header("Cache-Control", "no-cache");
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    return live.bundle;
  });

  app.get("/content/manifest", async () => ({ content_hash: live.bundle.content_hash, built_at: live.bundle.built_at }));

  /** Art and recordings referenced by the content (portraits, backgrounds, listen_type audio), from content/media. */
  const mediaRoot = resolve(d.config.contentDir, "media");
  app.get<{ Params: { "*": string } }>("/content/media/*", async (req, reply) => {
    const rel = req.params["*"];
    const type = MEDIA_TYPES[extname(rel).toLowerCase()];
    const file = resolve(mediaRoot, rel);
    if (!type || !file.startsWith(mediaRoot + sep)) return reply.code(404).send({ error: "not found" });
    try {
      const body = await readFile(file);
      return reply.type(type).header("Cache-Control", "public, max-age=3600").send(body);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  });

  /** Replaces the live content with a validated source tree. Invalid content never replaces a working bundle. */
  app.put<{ Body: ContentSource }>("/content/source", async (req, reply) => {
    if (!d.config.adminToken || req.headers.authorization !== `Bearer ${d.config.adminToken}`) {
      return reply.code(d.config.adminToken ? 401 : 403).send({ error: "content uploads are disabled or unauthorized" });
    }
    const result = validateContent(req.body);
    if (!result.ok || !result.content) return reply.code(422).send({ error: "content invalid", issues: result.issues });
    live.bundle = buildBundle(result.content);
    return { content_hash: live.bundle.content_hash, warnings: result.issues };
  });

  // ---------- Sessions
  // A returning guest passes its old player_id, so statements queued offline under that id stay valid.
  app.post<{ Body: { player_id?: string } | undefined }>("/session/guest", async (req, reply) => {
    if (!d.config.allowGuest) return reply.code(403).send({ error: "guest sessions are disabled" });
    const previous = req.body?.player_id;
    const playerId = typeof previous === "string" && GUEST_ID.test(previous) ? previous : `guest_${crypto.randomUUID().slice(0, 8)}`;
    const session: Session = { playerId, registration: crypto.randomUUID() };
    return { token: await d.tokens.issue(session), player_id: session.playerId, registration: session.registration };
  });

  /** What the client needs to build statements the intake accepts: its actor and the xAPI base IRI. */
  app.get("/session/me", { preHandler: requireSession }, async (req) => {
    const s = req.session!;
    return {
      player_id: s.playerId,
      registration: s.registration,
      xapi_base_iri: profile.baseIri,
      lti: s.lti ? { module_id: s.lti.moduleId ?? null, grades: Boolean(s.lti.ags) } : null,
      account: s.account ?? null,
    };
  });

  if (d.school) {
    await schoolRoutes(app, {
      config: d.config,
      tokens: d.tokens,
      school: d.school.store,
      files: d.school.files,
      errorLabel: (id) => live.bundle.taxonomy.error_types.find((t) => t.id === id)?.label.ru,
      content: { live, ...(d.fetchSheet ? { fetch: d.fetchSheet } : {}) },
      ...(d.school.mail ? { mail: d.school.mail } : {}),
      ...(d.school.now ? { now: d.school.now } : {}),
      ...(d.school.billing ? { billing: d.school.billing } : {}),
    });
  }

  // ---------- xAPI intake: the client's offline queue drains here, the server outbox delivers to the LRS.
  app.post<{ Body: unknown }>("/xapi/statements", { preHandler: requireSession }, async (req, reply) => {
    const body = Array.isArray(req.body) ? req.body : [req.body];
    if (body.length > MAX_STATEMENTS_PER_POST) return reply.code(413).send({ error: `at most ${MAX_STATEMENTS_PER_POST} statements per request` });
    const accepted: Statement[] = [];
    const rejected: { index: number; errors: string[] }[] = [];
    body.forEach((raw, index) => {
      const v = validateStatement(raw);
      if (!v.ok) return rejected.push({ index, errors: v.errors });
      const { account } = v.statement.actor;
      // The client may only write statements about its own session's player.
      if (account.homePage !== profile.accountHomePage || account.name !== req.session!.playerId) {
        return rejected.push({ index, errors: ["actor does not match the session"] });
      }
      accepted.push(v.statement);
    });
    if (rejected.length) return reply.code(400).send({ error: "invalid statements", rejected });
    const added = await d.outbox.enqueue(accepted);
    // The teacher's cabinet reads the answers from the gateway's own table, not from the LRS.
    if (d.school) {
      const attempts = accepted.map((s) => attemptOf(s, profile)).filter((a): a is Attempt => a !== undefined);
      await d.school.store.recordAttempts(attempts).catch((e) => req.log.error({ err: e }, "attempts not recorded"));
      // Finished episodes count towards a unit given as homework. The unit comes from the live
      // content, not from the statement, and an episode the content does not know is skipped.
      const episodes = new Map(live.bundle.moonbridge?.episodes.map((e) => [e.episode_id, e.module_id]) ?? []);
      const finished = accepted
        .map((s) => episodeResultOf(s, profile))
        .filter((r): r is EpisodeResult => r !== undefined && episodes.has(r.episodeId))
        .map((r) => ({ ...r, moduleId: episodes.get(r.episodeId)! }));
      if (finished.length) {
        await d.school.store
          .recordEpisodeResults(finished)
          .then(() => settleUnitHomework(d.school!.store, live.bundle, finished, d.school!.now?.() ?? new Date()))
          .catch((e) => req.log.error({ err: e }, "episode results not recorded"));
      }
    }
    void d.outbox.flush().catch((e) => app.log.error(e, "xAPI flush failed"));
    return reply.code(202).send({ accepted: accepted.length, new: added, ids: accepted.map((s) => s.id) });
  });

  // ---------- Module result → best score → LTI AGS.
  // The client records the matching xAPI passed/failed statement itself (LearningEngine.moduleResult),
  // so the LRS has one statement per boss fight; this endpoint only feeds the LMS gradebook.
  app.post<{ Body: { module_id: string; correct: number; total: number } }>(
    "/progress/module-result",
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: "object",
          required: ["module_id", "correct", "total"],
          properties: {
            module_id: { type: "string" },
            correct: { type: "integer", minimum: 0 },
            total: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const s = req.session!;
      const module = live.bundle.modules.find((m) => m.module_id === req.body.module_id);
      if (!module) return reply.code(404).send({ error: "unknown module" });
      if (req.body.correct > req.body.total) return reply.code(400).send({ error: "correct > total" });
      const scaled = req.body.correct / req.body.total;
      const passed = scaled >= module.mastery.pass_score;
      const { best, improved } = await d.scores.record(s.playerId, module.module_id, scaled);

      // The grade goes into the AGS queue first, so an LMS outage delays it but never loses it.
      let lms: GradeOutcome | "not_lti" = "not_lti";
      if (s.lti?.ags) {
        lms = await d.grades.submit({
          playerId: s.playerId,
          moduleId: module.module_id,
          contextKey: contextKey(s.lti.iss, s.lti.clientId, s.lti.contextId, s.lti.ags),
          label: module.title.en,
          scoreGiven: Math.round(best * 100),
          iss: s.lti.iss,
          clientId: s.lti.clientId,
          sub: s.lti.sub,
          ags: s.lti.ags,
          ...(s.lti.moduleId ? { launchModuleId: s.lti.moduleId } : {}),
        });
      }
      return { passed, scaled, best, lms };
    },
  );

  // ---------- Progress backup: the browser's game state, so a player keeps their city on another device.
  app.get("/progress/snapshot", { preHandler: requireSession }, async (req, reply) => {
    const stored = await d.progress.get(req.session!.playerId);
    if (!stored) return reply.code(404).send({ error: "no snapshot" });
    return { saved_at: stored.savedAt.toISOString(), snapshot: stored.snapshot };
  });

  app.put<{ Body: { saved_at: string; snapshot: Record<string, unknown> } }>(
    "/progress/snapshot",
    {
      preHandler: requireSession,
      bodyLimit: MAX_SNAPSHOT_BYTES,
      schema: {
        body: {
          type: "object",
          required: ["saved_at", "snapshot"],
          properties: { saved_at: { type: "string", format: "date-time" }, snapshot: { type: "object" } },
        },
      },
    },
    async (req, reply) => {
      const savedAt = new Date(req.body.saved_at);
      if (Number.isNaN(savedAt.getTime()) || savedAt.getTime() > Date.now() + MAX_CLOCK_SKEW_MS) {
        return reply.code(400).send({ error: "saved_at is not a plausible time" });
      }
      const r = await d.progress.put(req.session!.playerId, req.body.snapshot, savedAt);
      // 409 tells the client a newer save from another device is stored.
      return reply.code(r.accepted ? 200 : 409).send({ accepted: r.accepted, saved_at: r.savedAt.toISOString() });
    },
  );

  // ---------- LTI 1.3 tool endpoints
  const launchUrl = `${d.config.publicUrl}/lti/launch`;

  const login = async (req: FastifyRequest<{ Querystring: LoginRequest; Body: LoginRequest }>, reply: FastifyReply) => {
    const params = { ...(req.query ?? {}), ...((req.body as LoginRequest | undefined) ?? {}) };
    try {
      return reply.redirect(await buildAuthRedirect(params, d.platforms, d.loginStates, launchUrl), 302);
    } catch (e) {
      return ltiFailure(reply, e);
    }
  };
  app.get("/lti/login", login);
  app.post("/lti/login", login);

  app.post<{ Body: { id_token?: string; state?: string } }>("/lti/launch", async (req, reply) => {
    try {
      const launch = await verifyLaunch(req.body ?? {}, d.platforms, d.loginStates);
      const playerId = await d.identities.playerFor(launch.iss, launch.sub);
      const session: Session = {
        playerId,
        registration: crypto.randomUUID(),
        lti: {
          iss: launch.iss,
          clientId: launch.clientId,
          deploymentId: launch.deploymentId,
          sub: launch.sub,
          ...(launch.contextId ? { contextId: launch.contextId } : {}),
          ...(launch.ags ? { ags: launch.ags } : {}),
          ...(launch.custom.module_id ? { moduleId: launch.custom.module_id } : {}),
        },
      };
      const token = await d.tokens.issue(session);
      const target = new URL(d.config.clientUrl);
      // In the fragment, so the token never reaches server logs or Referer headers.
      target.hash = new URLSearchParams({ session: token, ...(session.lti?.moduleId ? { module: session.lti.moduleId } : {}) }).toString();
      return reply.type("text/html").send(redirectPage(target.toString()));
    } catch (e) {
      return ltiFailure(reply, e);
    }
  });

  app.get("/.well-known/jwks.json", async () => ({ keys: [d.toolKeys.publicJwk] }));

  return app;
}

function ltiFailure(reply: FastifyReply, e: unknown) {
  if (e instanceof LtiError) return reply.code(e.status).send({ error: e.code, message: e.message });
  throw e;
}

function redirectPage(url: string): string {
  const safe = url.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safe}"><title>Moonbridge</title></head><body><a href="${safe}">Continue</a></body></html>`;
}
