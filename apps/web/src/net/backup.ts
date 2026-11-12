import type { KeyValue } from "../storage/idb.js";
import type { Api } from "./api.js";

/** The keys whose values make up a player's game state on the server. */
export const BACKED_UP_KEYS = ["profile", "moonbridge", "fsrs-cards", "repeats", "moonbridge-words"] as const;
const SAVED_AT = "backup-saved-at";
const PUSHED_AT = "backup-pushed-at";

export interface Snapshot {
  saved_at: string;
  snapshot: Partial<Record<(typeof BACKED_UP_KEYS)[number], unknown>>;
}

/**
 * Keeps a copy of the student's state on the gateway, so a student who signs in on
 * another phone finds their hotel and their repetition schedule. The browser stays the
 * source of truth and the app never waits for the network: saves go to IndexedDB at once
 * and to the server shortly after. Between devices the newest save wins.
 */
export class ProgressBackup implements KeyValue {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pushing: Promise<void> | undefined;

  constructor(
    private readonly kv: KeyValue,
    private readonly api: Api,
    private readonly token: () => string | undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly delayMs = 3000,
  ) {}

  get<T>(key: string): Promise<T | undefined> {
    return this.kv.get<T>(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.kv.set(key, value);
    if (!(BACKED_UP_KEYS as readonly string[]).includes(key)) return;
    await this.kv.set(SAVED_AT, this.now().toISOString());
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.push(), this.delayMs);
  }

  /**
   * Before the platform opens: takes the server's copy when it is newer than the local
   * state (or there is no local state), pushes the local one when it is newer.
   */
  async restore(): Promise<"restored" | "pushed" | "unchanged" | "offline"> {
    const token = this.token();
    if (!token) return "offline";
    let remote: Snapshot | undefined;
    try {
      remote = await this.api.getSnapshot(token);
    } catch {
      return "offline";
    }
    const localAt = await this.kv.get<string>(SAVED_AT);
    let hasLocal = false;
    for (const key of BACKED_UP_KEYS) if ((await this.kv.get(key)) !== undefined) hasLocal = true;
    if (remote && (!hasLocal || !localAt || remote.saved_at > localAt)) {
      for (const key of BACKED_UP_KEYS) if (key in remote.snapshot) await this.kv.set(key, remote.snapshot[key]);
      await this.kv.set(SAVED_AT, remote.saved_at);
      await this.kv.set(PUSHED_AT, remote.saved_at);
      return "restored";
    }
    if (hasLocal && (!remote || (localAt && localAt > remote.saved_at))) {
      await this.push();
      return "pushed";
    }
    return "unchanged";
  }

  /** Sends the local state if it changed since the last push. Failures wait for the next save or sync. */
  push(): Promise<void> {
    this.pushing ??= this.doPush().finally(() => (this.pushing = undefined));
    return this.pushing;
  }

  private async doPush(): Promise<void> {
    const token = this.token();
    const savedAt = await this.kv.get<string>(SAVED_AT);
    if (!token || !savedAt || savedAt === (await this.kv.get<string>(PUSHED_AT))) return;
    const snapshot: Snapshot["snapshot"] = {};
    for (const key of BACKED_UP_KEYS) {
      const v = await this.kv.get(key);
      if (v !== undefined) snapshot[key] = v;
    }
    try {
      // A refused push means another device saved later; its state comes back with the next restore.
      await this.api.putSnapshot(token, { saved_at: savedAt, snapshot });
      await this.kv.set(PUSHED_AT, savedAt);
    } catch (e) {
      console.warn("progress backup: will retry", e);
    }
  }
}
