/**
 * RFC-017 D7 — this process notices it is a superseded COPY of its own files, not a
 * superseded SESSION (that is lock-decision.ts / `superseded` in server.ts — a different
 * mechanism for a different problem: that one is about who holds the socket, this one is
 * about whether the files this process is running from are about to be deleted out from
 * under it).
 *
 * Claude Code writes `.orphaned_at` into the PREVIOUS version's plugin directory on
 * update or uninstall, and deletes that directory 14 days later — documented behaviour,
 * not a guaranteed shape, so the epoch-ms CONTENT is read best-effort and falls back to
 * the marker file's own mtime (D7: "if it is unreadable, use the file mtime").
 *
 * This module only DECIDES — pure, no timers, no notification call — so the three-tier
 * schedule (first / daily repeat / one-time 10-day escalation) is unit-testable with a
 * fake clock and no process running at all. server.ts owns the 60s unref'd timer and the
 * actual `notifications/claude/channel` call. fs is one object, injected — same idiom as
 * proc-registry.ts's `__io`: ESM namespace imports cannot be spied on, and production
 * never replaces it.
 */
import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Injected for tests; production calls the real fs. */
export const __io = { readFileSync, statSync };

const DAY_MS = 24 * 60 * 60 * 1000;
const REPEAT_MS = DAY_MS;
const ESCALATE_AFTER_MS = 10 * DAY_MS;
/** Claude Code's documented deletion horizon (D7) — only used to phrase "~N days left". */
const DELETE_AFTER_MS = 14 * DAY_MS;

/**
 * `.orphaned_at`'s own epoch-ms content if it parses, else the marker file's mtime, else
 * `null` — the caller's cue that this process is not (or no longer) running from an
 * orphaned directory. A missing or unreadable file is `null`, same as "no marker".
 */
export function readOrphanedAt(pluginRoot: string): number | null {
  const path = join(pluginRoot, ".orphaned_at");
  let raw: string;
  try {
    raw = __io.readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const n = Number(raw.trim());
  if (Number.isFinite(n) && n > 0) return n;
  try {
    return __io.statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export type StaleNoticeKind = "first" | "daily" | "escalation";

export interface StaleWatchState {
  /** Clock time of the last notice sent (any kind); `null` = never sent one. */
  lastNoticeAt: number | null;
  /** Whether the one-time 10-day escalation has already fired. */
  escalated: boolean;
}

export const INITIAL_STALE_WATCH_STATE: StaleWatchState = { lastNoticeAt: null, escalated: false };

/**
 * Which notice (if any) is due right now, and the state to carry into the next check.
 * The escalation is checked FIRST — before both the daily repeat AND "never notified
 * yet" — so it never fires twice for the same crossing and a process that starts up (or
 * first notices staleness) already ≥10 days in gets the escalation as its very first
 * notice, not the softer "first" wording followed by an escalation next tick.
 */
export function decideStaleNotice(
  now: number,
  orphanedAt: number,
  state: StaleWatchState
): { notice: StaleNoticeKind | null; state: StaleWatchState } {
  if (!state.escalated && now - orphanedAt >= ESCALATE_AFTER_MS) {
    return { notice: "escalation", state: { lastNoticeAt: now, escalated: true } };
  }
  if (state.lastNoticeAt === null) {
    return { notice: "first", state: { lastNoticeAt: now, escalated: false } };
  }
  if (now - state.lastNoticeAt >= REPEAT_MS) {
    return { notice: "daily", state: { ...state, lastNoticeAt: now } };
  }
  return { notice: null, state };
}

/** D7's exact wording — "first" and "daily" share it; only the escalation differs. */
export function staleNoticeText(
  kind: StaleNoticeKind,
  runningVersion: string,
  installedVersion: string | undefined,
  now: number,
  orphanedAt: number
): string {
  if (kind === "escalation") {
    const daysLeft = Math.max(0, Math.ceil((DELETE_AFTER_MS - (now - orphanedAt)) / DAY_MS));
    return `this copy's files are deleted by Claude Code in ~${daysLeft} days — /reload-plugins now`;
  }
  const installedPart = installedVersion
    ? `Bridge plugin ${installedVersion} is installed`
    : "this copy of the Bridge plugin was replaced or uninstalled";
  return `this window runs Bridge plugin ${runningVersion}; ${installedPart} — /reload-plugins to switch (it restarts Bridge in this window only)`;
}

/** Where Claude Code keeps `installed_plugins.json` (D7's fallback chain). */
function installedPluginsDir(env: NodeJS.ProcessEnv): string {
  if (env.CLAUDE_CODE_PLUGIN_CACHE_DIR) return env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  if (env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR, "plugins");
  return join(homedir(), ".claude", "plugins");
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function parseSemver(v: string): [number, number, number] | null {
  const m = SEMVER_RE.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Best-effort — ANY failure (missing/corrupt `installed_plugins.json`, no `plugins` key,
 * no `bridge@*` entry, a version that doesn't parse) drops the version from the message
 * rather than throwing (D7: "a read or parse failure only drops the number"). Picks the
 * HIGHEST semver among every `bridge@*` entry's `version` — a plugin can be installed at
 * more than one scope (user + project) at once.
 */
export function findInstalledVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const dir = installedPluginsDir(env);
    const raw = __io.readFileSync(join(dir, "installed_plugins.json"), "utf8");
    const data = JSON.parse(raw) as { plugins?: Record<string, unknown> };
    const plugins = data.plugins;
    if (!plugins || typeof plugins !== "object") return undefined;
    let best: string | undefined;
    let bestParsed: [number, number, number] | null = null;
    for (const [key, entries] of Object.entries(plugins)) {
      if (!key.startsWith("bridge@") || !Array.isArray(entries)) continue;
      for (const entry of entries) {
        const v =
          entry && typeof entry === "object" ? (entry as Record<string, unknown>).version : undefined;
        if (typeof v !== "string") continue;
        const parsed = parseSemver(v);
        if (!parsed) continue;
        if (!bestParsed || compareSemver(parsed, bestParsed) > 0) {
          best = v;
          bestParsed = parsed;
        }
      }
    }
    return best;
  } catch {
    return undefined;
  }
}
