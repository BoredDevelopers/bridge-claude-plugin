/** stale-watcher.ts (RFC-017 D7): the "this copy's files are about to be deleted" watch, in isolation. */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readOrphanedAt,
  decideStaleNotice,
  staleNoticeText,
  findInstalledVersion,
  INITIAL_STALE_WATCH_STATE,
  __io,
  type StaleWatchState,
} from "../stale-watcher";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "stale-watcher-"));
}

const cleanups: (() => void)[] = [];
const savedReadFileSync = __io.readFileSync;
const savedStatSync = __io.statSync;
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  __io.readFileSync = savedReadFileSync;
  __io.statSync = savedStatSync;
});

describe("readOrphanedAt", () => {
  test("no marker at all: null", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(readOrphanedAt(dir)).toBeNull();
  });

  test("a well-formed marker: its own epoch-ms content", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, ".orphaned_at"), "1700000000000");
    expect(readOrphanedAt(dir)).toBe(1700000000000);
  });

  test("an unreadable/corrupt content: falls back to the marker's own mtime", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, ".orphaned_at"), "not a number");
    const at = readOrphanedAt(dir);
    expect(at).not.toBeNull();
    expect(Math.abs(Date.now() - (at as number))).toBeLessThan(10_000);
  });

  test("stat itself fails too: null, never throws", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, ".orphaned_at"), "garbage");
    __io.statSync = () => {
      throw new Error("boom");
    };
    expect(readOrphanedAt(dir)).toBeNull();
  });
});

// `decideStaleNotice` always takes a real `orphanedAt` — "no marker at all" is
// `readOrphanedAt` returning `null`, which the caller (server.ts's watch) gates on
// BEFORE ever calling this; that silence is covered by readOrphanedAt's own test above.
describe("decideStaleNotice (C9)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  test("first detection: one notice, immediately", () => {
    const t0 = 1_000_000;
    const r = decideStaleNotice(t0, t0, INITIAL_STALE_WATCH_STATE);
    expect(r.notice).toBe("first");
    expect(r.state.lastNoticeAt).toBe(t0);
  });

  test("checking again moments later (same tick): silent — already notified", () => {
    const t0 = 1_000_000;
    const first = decideStaleNotice(t0, t0, INITIAL_STALE_WATCH_STATE);
    const again = decideStaleNotice(t0 + 60_000, t0, first.state);
    expect(again.notice).toBeNull();
  });

  test("+1 day: a second (daily) notice", () => {
    const t0 = 1_000_000;
    const first = decideStaleNotice(t0, t0, INITIAL_STALE_WATCH_STATE);
    const next = decideStaleNotice(t0 + DAY_MS, t0, first.state);
    expect(next.notice).toBe("daily");
    expect(next.state.lastNoticeAt).toBe(t0 + DAY_MS);
  });

  test("+10 days (from the ORPHAN timestamp, not the last notice): the one-time escalation", () => {
    const t0 = 1_000_000;
    let state: StaleWatchState = INITIAL_STALE_WATCH_STATE;
    let notice = decideStaleNotice(t0, t0, state);
    state = notice.state;
    for (let day = 1; day <= 10; day++) {
      notice = decideStaleNotice(t0 + day * DAY_MS, t0, state);
      state = notice.state;
    }
    expect(notice.notice).toBe("escalation");
    expect(state.escalated).toBe(true);
    // It fires exactly once — day 11 is back to the ordinary daily cadence.
    const day11 = decideStaleNotice(t0 + 11 * DAY_MS, t0, state);
    expect(day11.notice).toBe("daily");
  });

  test("mutation proof: without the escalation branch, day 10 would just read as another daily notice", () => {
    const buggyDecide = (now: number, orphanedAt: number, state: StaleWatchState) => {
      if (state.lastNoticeAt === null) return "first";
      return now - state.lastNoticeAt >= DAY_MS ? "daily" : null;
    };
    const t0 = 1_000_000;
    let state: StaleWatchState = INITIAL_STALE_WATCH_STATE;
    let real = decideStaleNotice(t0, t0, state);
    state = real.state;
    for (let day = 1; day <= 10; day++) {
      real = decideStaleNotice(t0 + day * DAY_MS, t0, state);
      state = real.state;
    }
    expect(real.notice).toBe("escalation");
    expect(buggyDecide(t0 + 10 * DAY_MS, t0, INITIAL_STALE_WATCH_STATE)).not.toBe(real.notice);
  });

  test("finding 11c: first-ever detection already ≥10 days stale is a SINGLE escalation notice, never 'first' then a separate escalation", () => {
    const t0 = 1_000_000;
    // The watcher's very first tick after the orphan marker already crossed 10 days —
    // e.g. the plugin process itself only just started, long after the update happened.
    const first = decideStaleNotice(t0 + 11 * DAY_MS, t0, INITIAL_STALE_WATCH_STATE);
    expect(first.notice).toBe("escalation");
    expect(first.state.escalated).toBe(true);
    // It must not ALSO queue up a "first" notice for the very next tick.
    const again = decideStaleNotice(t0 + 11 * DAY_MS + 60_000, t0, first.state);
    expect(again.notice).toBeNull();
  });
});

describe("staleNoticeText", () => {
  test("first/daily: names both versions when known", () => {
    const text = staleNoticeText("first", "0.25.0", "0.26.0", 1_000_000, 1_000_000);
    expect(text).toContain("this window runs Bridge plugin 0.25.0");
    expect(text).toContain("Bridge plugin 0.26.0 is installed");
    expect(text).toContain("/reload-plugins to switch");
  });

  test("first/daily: an unknown installed version never claims a newer one is installed (finding 11c)", () => {
    const text = staleNoticeText("first", "0.25.0", undefined, 1_000_000, 1_000_000);
    expect(text).toContain("this copy of the Bridge plugin was replaced or uninstalled");
    expect(text).not.toContain("a newer Bridge plugin is installed");
    expect(text).not.toMatch(/undefined/);
  });

  test("escalation: counts down from the 14-day deletion horizon", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const t0 = 1_000_000;
    const text = staleNoticeText("escalation", "0.25.0", "0.26.0", t0 + 10 * DAY_MS, t0);
    expect(text).toContain("~4 days");
    expect(text).toContain("/reload-plugins now");
  });
});

describe("findInstalledVersion", () => {
  test("no env location resolves at all (no file): undefined, never throws", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(findInstalledVersion({ CLAUDE_CODE_PLUGIN_CACHE_DIR: dir })).toBeUndefined();
  });

  test("the highest semver among every bridge@* entry, across scopes", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(
      join(dir, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "bridge@bored-marketplace": [
            { scope: "user", installPath: "/a", version: "0.25.0" },
            { scope: "project", installPath: "/b", version: "0.26.0" },
          ],
          "some-other-plugin@marketplace": [{ scope: "user", installPath: "/c", version: "99.0.0" }],
        },
      })
    );
    expect(findInstalledVersion({ CLAUDE_CODE_PLUGIN_CACHE_DIR: dir })).toBe("0.26.0");
  });

  test("corrupt installed_plugins.json: undefined, never throws (C9)", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "installed_plugins.json"), "{ not json");
    expect(() => findInstalledVersion({ CLAUDE_CODE_PLUGIN_CACHE_DIR: dir })).not.toThrow();
    expect(findInstalledVersion({ CLAUDE_CODE_PLUGIN_CACHE_DIR: dir })).toBeUndefined();
  });

  test("a bridge@ entry with an unparseable version is skipped, not fatal", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(
      join(dir, "installed_plugins.json"),
      JSON.stringify({ plugins: { "bridge@bored-marketplace": [{ version: "not-a-version" }] } })
    );
    expect(findInstalledVersion({ CLAUDE_CODE_PLUGIN_CACHE_DIR: dir })).toBeUndefined();
  });

  test("env relocation is honoured: CLAUDE_CODE_PLUGIN_CACHE_DIR wins over CLAUDE_CONFIG_DIR/plugins", () => {
    const cacheDir = tmp();
    const configDir = tmp();
    cleanups.push(() => rmSync(cacheDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));
    mkdirSync(join(configDir, "plugins"), { recursive: true });
    writeFileSync(
      join(configDir, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "bridge@bored-marketplace": [{ version: "0.20.0" }] } })
    );
    writeFileSync(
      join(cacheDir, "installed_plugins.json"),
      JSON.stringify({ plugins: { "bridge@bored-marketplace": [{ version: "0.30.0" }] } })
    );
    expect(
      findInstalledVersion({ CLAUDE_CODE_PLUGIN_CACHE_DIR: cacheDir, CLAUDE_CONFIG_DIR: configDir })
    ).toBe("0.30.0");
  });

  test("falls back to CLAUDE_CONFIG_DIR/plugins when the cache dir is unset", () => {
    const configDir = tmp();
    cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));
    mkdirSync(join(configDir, "plugins"), { recursive: true });
    writeFileSync(
      join(configDir, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "bridge@bored-marketplace": [{ version: "0.20.0" }] } })
    );
    expect(findInstalledVersion({ CLAUDE_CONFIG_DIR: configDir })).toBe("0.20.0");
  });
});
