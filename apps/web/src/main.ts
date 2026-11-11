import type { ContentBundle } from "@moonbridge/content";
import { Learner } from "./core/learner.js";
import { Api, ApiError, GatewaySink, localSessionStorage, renewGuest, SignedOutError, startSession, type Dashboard, type SessionInfo } from "./net/api.js";
import { ProgressBackup } from "./net/backup.js";
import { askProfile, joinGroup, loadProfile, saveProfile, signIn, signOut } from "./platform/login.js";
import { loadDashboard, renderHomework } from "./platform/school.js";
import { renderStudentReport } from "./platform/report.js";
import { renderCatalog } from "./platform/catalog.js";
import { renderContent } from "./platform/content.js";
import { feedbackBox } from "./platform/feedback.js";
import { openLessonFile, renderGroupLessons, renderStudentLessons } from "./platform/lessons.js";
import { renderMetrics } from "./platform/metrics.js";
import { renderTeacher } from "./platform/teacher.js";
import { renderToday } from "./platform/today.js";
import { IdbJournal, IdbKeyValue, IdbOutboxStore, openPlayerDb, type KeyValue } from "./storage/idb.js";
import { el } from "./ui/dom.js";
import "./style.css";

const root = document.getElementById("app")!;
/** Must match CACHE in public/sw.js. */
const SHELL_CACHE = "shell-v1";

/**
 * Puts the page and every built file loaded so far into the service worker's cache, so the
 * next start works offline. Called after each screen: the Moonbridge chunk is cached once the
 * student has opened the section online, and never downloaded ahead of that.
 */
function cacheLoadedAssets(): void {
  if (!import.meta.env.PROD || !("caches" in window)) return;
  const urls = performance
    .getEntriesByType("resource")
    .map((e) => new URL(e.name))
    .filter((u) => u.origin === location.origin && u.pathname.startsWith("/assets/"))
    .map((u) => u.pathname);
  void caches
    .open(SHELL_CACHE)
    .then((c) => c.addAll(["/", ...new Set(urls)]))
    .catch((e) => console.warn("offline cache", e));
}

function fatal(message: string, detail?: unknown): void {
  console.error(message, detail);
  root.replaceChildren(el("div", { class: "card" }, el("h1", {}, "Не получилось открыть платформу"), el("p", {}, message)));
}

/** Fresh bundle from the gateway when it is reachable, the cached one otherwise. */
async function loadBundle(api: Api, kv: KeyValue): Promise<ContentBundle | undefined> {
  const cached = await kv.get<ContentBundle>("content-bundle");
  try {
    const fresh = await api.bundle(cached?.content_hash);
    if (fresh === "not-modified") return cached;
    await kv.set("content-bundle", fresh);
    return fresh;
  } catch (e) {
    console.warn("content bundle: using the cached copy", e);
    return cached;
  }
}

async function boot(): Promise<void> {
  const apiBase = import.meta.env.VITE_API_BASE ?? "/api";
  const api = new Api(apiBase);

  // An invitation link first: the student creates an account (or joins with theirs) and lands on Today.
  const invite = /^\/join\/([A-Za-z0-9]+)$/.exec(location.pathname)?.[1];
  if (invite) {
    await joinGroup(root, api, localSessionStorage, invite);
    history.replaceState(null, "", "/");
  }
  if (!localSessionStorage.load() && !location.hash.includes("session=")) {
    if ((await signIn(root, api, localSessionStorage)) === "guest") saveProfile(await askProfile(root));
  }
  root.replaceChildren(el("div", { class: "card" }, el("p", {}, "Загрузка…")));

  let session: SessionInfo;
  try {
    ({ session } = await startSession(api, localSessionStorage, location.hash));
  } catch (e) {
    if (!(e instanceof SignedOutError)) throw e;
    await signIn(root, api, localSessionStorage, "Сессия закончилась, войдите ещё раз.");
    ({ session } = await startSession(api, localSessionStorage, ""));
  }
  if (location.hash.includes("session=")) history.replaceState(null, "", location.pathname);
  const profile = session.account ? { name: session.account.name } : (loadProfile() ?? (await askProfile(root)));
  saveProfile(profile);
  const db = await openPlayerDb(session.playerId);
  const local = new IdbKeyValue(db);
  const bundle = await loadBundle(api, local);
  if (!bundle) return fatal("Нет связи с сервером, а сохранённого курса на этом устройстве ещё нет.");

  const kv = new ProgressBackup(local, api, () => session.token);
  await kv.restore();
  if (!(await kv.get("profile"))) await kv.set("profile", profile);

  let renewing: Promise<unknown> | undefined;
  const sink = new GatewaySink(
    api,
    () => session.token,
    () => {
      if (session.kind !== "guest" || renewing) return;
      renewing = renewGuest(api, session.playerId)
        .then((s) => (Object.assign(session, s), localSessionStorage.save(session)))
        .catch(() => undefined)
        .finally(() => (renewing = undefined));
    },
  );
  const learner = await Learner.load({
    bundle,
    playerId: session.playerId,
    registration: session.registration,
    xapiBaseIri: session.xapiBaseIri,
    kv,
    journal: new IdbJournal(db),
    outboxStore: new IdbOutboxStore(db),
    sink,
  });
  const sync = () => void learner.sync().then(() => kv.push());
  sync();
  window.addEventListener("online", sync);
  setInterval(sync, 30_000);

  const mediaBase = `${apiBase.replace(/\/$/, "")}/content/media`;
  const onSignOut = () => {
    signOut();
    location.assign("/");
  };
  /** The school's dashboard, from the gateway or, offline, from the last visit. */
  const dashboard = async (): Promise<Dashboard | undefined> => {
    if (session.kind !== "account") return undefined;
    try {
      return await loadDashboard(api, session.token, local);
    } catch (e) {
      // The account session expired while the platform was open.
      if (e instanceof ApiError && e.status === 401) onSignOut();
      return undefined;
    }
  };
  // The page a tester reports from, and the one before it: a report sent from Today is often about the game.
  let previousPath = "";
  let currentPath = location.pathname;
  const feedback = () =>
    feedbackBox({ api, token: () => (session.kind === "account" ? session.token : undefined), page: () => (previousPath && previousPath !== currentPath ? `${currentPath} (до этого ${previousPath})` : currentPath) });
  const navigate = (path: string) => {
    if (path !== location.pathname) history.pushState(null, "", path);
    void route();
  };
  const route = async () => {
    const path = location.pathname;
    if (path !== currentPath) [previousPath, currentPath] = [currentPath, path];
    document.body.dataset.section = path.startsWith("/moonbridge") ? "moonbridge" : "platform";
    if (path === "/moonbridge" || path.startsWith("/moonbridge/")) {
      // A separate chunk: the platform never downloads the game unless the student opens it.
      const { mountMoonbridge } = await import("./moonbridge/section.js");
      cacheLoadedAssets();
      const board = await dashboard();
      return mountMoonbridge(root, path, { learner, kv, mediaBase, navigate, ...(board ? { board } : {}), ...(session.kind === "account" ? { feedback } : {}) });
    }
    const homeworkId = /^\/homework\/([A-Za-z0-9_]+)$/.exec(path)?.[1];
    if (homeworkId && session.kind === "account") return renderHomework(root, homeworkId, { api, token: session.token, kv: local, navigate });
    if (path === "/lessons" && session.kind === "account") return renderStudentLessons(root, { api, token: session.token, kv: local });
    const lessonsGroup = /^\/teacher\/lessons\/([A-Za-z0-9_]+)$/.exec(path)?.[1];
    if (lessonsGroup && session.account?.role === "teacher") return renderGroupLessons(root, lessonsGroup, { api, token: session.token });
    if (path === "/teacher" && session.account?.role === "teacher") return renderTeacher(root, { api, token: session.token, kv: local });
    if (path === "/teacher/content" && session.account?.role === "teacher") return renderContent(root, { api, token: session.token, kv: local });
    if (path === "/teacher/catalog" && session.account?.role === "teacher") return renderCatalog(root, { api, token: session.token, kv: local, navigate });
    const metricsGroup = /^\/teacher\/metrics\/([A-Za-z0-9_]+)$/.exec(path)?.[1];
    if (metricsGroup && session.account?.role === "teacher") return renderMetrics(root, metricsGroup, { api, token: session.token });
    const studentId = /^\/teacher\/student\/([A-Za-z0-9_]+)$/.exec(path)?.[1];
    if (studentId && session.account?.role === "teacher") {
      return renderStudentReport(root, studentId, new URLSearchParams(location.search).get("week") ?? undefined, { api, token: session.token, navigate });
    }
    if (path !== "/") history.replaceState(null, "", "/");
    const board = await dashboard();
    // The student's own week; online only, Today simply goes without it offline.
    const week =
      session.account?.role === "student" && session.token ? await api.studentReport(session.token, session.account.id).catch(() => undefined) : undefined;
    await renderToday(root, {
      profile,
      learner,
      kv,
      ...(session.account ? { school: { dashboard: board, role: session.account.role, onSignOut, feedback: feedback(), ...(week ? { week } : {}) } } : {}),
    });
    cacheLoadedAssets();
  };
  document.addEventListener("click", (e) => {
    const file = (e.target as Element | null)?.closest?.("a[data-lesson-file]") as HTMLAnchorElement | null;
    if (file) {
      e.preventDefault();
      void openLessonFile(api, session.kind === "account" ? session.token : undefined, file.dataset.lessonFile!, file);
      return;
    }
    const a = (e.target as Element | null)?.closest?.("a[data-link]") as HTMLAnchorElement | null;
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    navigate(new URL(a.href).pathname);
  });
  window.addEventListener("popstate", () => void route());
  await route();
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("service worker", e)));
}

boot().catch((e) => fatal(e instanceof Error ? e.message : String(e), e));
