// The platform on this computer for testing by hand: the gateway with its data in data/demo/
// (it survives a restart), the built platform for phones on the same Wi-Fi, and ready accounts:
// a teacher, a group with a homework and three students.
//
// Run: pnpm demo        (Ctrl+C stops it; delete data/demo/ to start from scratch)
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { networkInterfaces } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname;
const GATEWAY = "http://localhost:8787";
const ADMIN = "demo-admin-token";
const TEACHER = { name: "Ксения", login: "ksenia", password: "teach-123", email: "ksenia@example.com" };
/** Handles the money: prices and payments (Финансы школы). */
const ADMIN_ACCOUNT = { name: "Илья", login: "ilya", password: "admin-123", email: "ilya@example.com" };
const STUDENTS = [
  { name: "Анна", login: "anna", password: "moon-123", email: "anna@example.com" },
  { name: "Борис", login: "boris", password: "moon-123", email: "boris@example.com" },
  { name: "Вера", login: "vera", password: "moon-123", email: "vera@example.com" },
];
const GROUP = "Тестовая группа";

/** This computer's address on the local network, for phones on the same Wi-Fi. */
function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return undefined;
}

const children: ChildProcess[] = [];
function start(cmd: string, args: string[], env: Record<string, string>, label: string): void {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  child.stdout!.on("data", (b) => (log = (log + b).slice(-4000)));
  child.stderr!.on("data", (b) => (log = (log + b).slice(-4000)));
  child.on("exit", (code) => {
    if (code && code !== 143) {
      console.error(`\n${label} остановился с кодом ${code}:\n${log}`);
      stop(1);
    }
  });
  children.push(child);
}

function stop(code = 0): never {
  for (const c of children) if (c.pid) process.kill(-c.pid, "SIGTERM");
  process.exit(code);
}

async function waitFor(url: string, timeoutMs = 90_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await fetch(url).then((r) => r.ok, () => false))) {
    if (Date.now() > until) throw new Error(`не дождался ${url}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function api<T>(path: string, init: { token?: string; body?: unknown } = {}): Promise<{ status: number; json: T }> {
  const res = await fetch(`${GATEWAY}${path}`, {
    method: init.body ? "POST" : "GET",
    headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => undefined)) as T };
}

/** Accounts, a group and a homework; on a second run, whatever already exists is kept. */
async function seed(): Promise<string> {
  await api("/admin/teachers", { token: ADMIN, body: TEACHER }); // 409 when it exists
  await api("/admin/admins", { token: ADMIN, body: ADMIN_ACCOUNT }); // 409 when it exists
  const token = (await api<{ token: string }>("/auth/login", { body: { login: TEACHER.login, password: TEACHER.password } })).json.token;
  const dash = (await api<{ groups: { group_id: string; name: string }[] }>("/school/dashboard", { token })).json;
  let groupId = dash.groups.find((g) => g.name === GROUP)?.group_id;
  if (!groupId) {
    groupId = (
      await api<{ group: { group_id: string } }>("/school/groups", {
        token,
        body: { name: GROUP, call_url: "https://telemost.yandex.ru/", schedule: [{ weekday: 2, time: "18:30", minutes: 60 }, { weekday: 4, time: "18:30", minutes: 60 }] },
      })
    ).json.group.group_id;
    await api(`/school/groups/${groupId}/homework`, {
      token,
      body: { title: "Расскажи о себе", description: "Запишите на диктофон 30 секунд о себе по-английски и загрузите файл.", needs_file: true },
    });
  }
  const invite = (await api<{ code: string }>(`/school/groups/${groupId}/invites`, { token, body: {} })).json.code;
  for (const s of STUDENTS) await api(`/invites/${invite}/join`, { body: { ...s, accept_terms: true } }); // 409 when the login is taken
  return invite;
}

async function main(): Promise<void> {
  const lan = lanAddress();
  const web = `http://${lan ?? "localhost"}:4173`;
  await mkdir(`${ROOT}data/demo`, { recursive: true });
  start(
    "pnpm",
    ["--filter", "@moonbridge/server", "start"],
    { PORT: "8787", ADMIN_TOKEN: ADMIN, PGLITE_DIR: `${ROOT}data/demo/db`, UPLOAD_DIR: `${ROOT}data/demo/uploads`, CLIENT_URL: web },
    "Шлюз",
  );
  start("pnpm", ["--filter", "@moonbridge/web", "preview", "--strictPort", "--host", "0.0.0.0"], {}, "Платформа");
  await waitFor(`${GATEWAY}/health`);
  await waitFor("http://localhost:4173");
  const invite = await seed();

  console.log(`
Платформа запущена. Остановить: Ctrl+C. Данные лежат в data/demo/ (удалите папку, чтобы начать заново).

  На этом компьютере:  http://localhost:4173
  С телефона в той же Wi-Fi: ${lan ? web : "(адрес в сети не найден, откройте с этого компьютера)"}

  Преподаватель:  ${TEACHER.login} / ${TEACHER.password}
  Админ (финансы): ${ADMIN_ACCOUNT.login} / ${ADMIN_ACCOUNT.password}
  Ученики:        ${STUDENTS.map((s) => `${s.login} / ${s.password}`).join(",  ")}
  Новый ученик по приглашению: ${web}/join/${invite}
  Админ-токен (для curl): ${ADMIN}

Проверка без браузера: pnpm e2e (три сценария на экране телефона).
`);
}

process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
main().catch((e) => {
  console.error(e);
  stop(1);
});
