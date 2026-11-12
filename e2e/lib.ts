// Shared pieces of the end-to-end checks: the servers they start, logging, and answering
// any task type correctly from the content bundle.
import { spawn, type ChildProcess } from "node:child_process";
import type { ContentBundle, Episode, Task } from "@moonbridge/content";
import type { Page } from "playwright";

export const ROOT = new URL("..", import.meta.url).pathname;
export const ARTIFACTS = new URL(".artifacts/", import.meta.url).pathname;
export const GATEWAY = "http://localhost:8787";
export const WEB = "http://localhost:4173";
export const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ru-RU" } as const;

const children: ChildProcess[] = [];
const logs = new Map<string, string>();
/** Everything a server printed so far: the gateway without Postbox prints its e-mails there. */
export const logOf = (name: string) => logs.get(name) ?? "";
export function start(name: string, cmd: string, args: string[], env: Record<string, string> = {}): void {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  logs.set(name, "");
  child.stdout!.on("data", (b) => logs.set(name, logOf(name) + b));
  child.stderr!.on("data", (b) => logs.set(name, logOf(name) + b));
  child.on("exit", (code) => code && code !== 143 && console.error(`${name} exited with ${code}\n${logOf(name).slice(-2000)}`));
  children.push(child);
}

export async function waitFor(url: string, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await fetch(url).then((r) => r.ok, () => false)) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

export function step(message: string): void {
  console.log(`\n▶ ${message}`);
}

export function check(ok: unknown, message: string): void {
  if (!ok) throw new Error(`FAILED: ${message}`);
  console.log(`  ✓ ${message}`);
}

/** Answers the task on screen correctly, whatever its type, from the bundle the platform got. */
export async function answerRight(page: Page, task: Task): Promise<void> {
  const panel = page.locator(`.task[data-task="${task.task_id}"]`);
  await panel.waitFor();
  const first = task.answer.accepted[0]!;
  switch (task.type) {
    case "choice":
    case "translate_en_ru":
      return panel.getByRole("button", { name: task.presentation.options!.find((o) => o.id === first)!.text, exact: true }).click();
    case "find_error":
      return panel.locator(".find-line button").filter({ hasText: new RegExp(`^${task.presentation.tokens![Number(first)]}$`) }).first().click();
    case "order_words":
      for (const word of first.split(" ")) await panel.locator(".order-bank button").filter({ hasText: new RegExp(`^${word.replace(/[?.]/g, "\\$&")}$`) }).first().click();
      return panel.getByRole("button", { name: "Ответить" }).click();
    default:
      await panel.getByLabel("Ответ").fill(first);
      return panel.getByRole("button", { name: "Ответить" }).click();
  }
}


/** Starts the gateway (in memory, live content) and the built platform (vite preview). */
export async function startServers(gatewayEnv: Record<string, string> = {}): Promise<ContentBundle> {
  start("gateway", "pnpm", ["--filter", "@moonbridge/server", "start"], { PORT: "8787", NODE_ENV: "development", CLIENT_URL: WEB, ...gatewayEnv });
  start("web", "pnpm", ["--filter", "@moonbridge/web", "preview", "--strictPort"]);
  await waitFor(`${GATEWAY}/health`);
  await waitFor(WEB);
  return (await (await fetch(`${GATEWAY}/content/bundle`)).json()) as ContentBundle;
}

/** Stops every server: each runs in its own process group, so pnpm, tsx and vite all go. */
export function stopServers(): void {
  for (const c of children) if (c.pid) process.kill(-c.pid, "SIGTERM");
}

/** The hotel's map. A student's first visit opens on the welcome scene instead: skipped here. */
export async function hotelMap(page: Page): Promise<void> {
  const map = page.locator(".hotel-map");
  const welcome = page.locator(".scene[data-welcome]");
  await map.or(welcome).first().waitFor();
  if (await welcome.isVisible()) {
    await welcome.locator("[data-skip]").click();
    await page.locator("[data-welcome-end]").getByRole("button", { name: "Осмотреть отель" }).click();
    await map.waitFor();
  }
}

export const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** Plays an episode from wherever it stands to its end, answering every task right. Returns the task steps answered. */
export async function finishEpisode(page: Page, bundle: ContentBundle, episode: Episode, onStep?: (stepId: string) => Promise<void>): Promise<Set<string>> {
  const scene = page.locator(`.scene[data-episode="${episode.episode_id}"]`);
  await scene.waitFor();
  const answered = new Set<string>();
  while (!(await page.locator("[data-episode-end]").isVisible())) {
    const stepId = await scene.getAttribute("data-step");
    const s = episode.steps.find((x) => x.id === stepId)!;
    if (s.kind === "task") {
      await answerRight(page, bundle.tasks[s.task_id]!);
      answered.add(s.id);
      // A typo or other near-miss shows feedback before the story goes on.
      if (await scene.locator(".feedback").isVisible().catch(() => false)) await scene.getByRole("button", { name: "Дальше" }).click();
    } else {
      await scene.locator(".dialog .next").click();
    }
    await page.waitForFunction(
      ([sel, prev]) => document.querySelector("[data-episode-end]") || document.querySelector(sel)?.getAttribute("data-step") !== prev,
      [`.scene[data-episode="${episode.episode_id}"]`, stepId] as const,
    );
    await onStep?.(stepId ?? "");
  }
  return answered;
}
