/**
 * RFC-027 §5 / D7 — the one-time move of the credential profile from
 * `~/.claude/channels/bridge` to `~/.einweave`: only the profile and `.env`
 * travel, `.env` keys are renamed, nothing is overwritten, and the old directory
 * is never touched.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, chmodSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyState, resolveStateDir, placeNew, sweepMigrationTemps, MIGRATION_MARKER, PROFILE_JOURNAL } from "../state-dir";

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) rmSync(cleanups.pop()!, { recursive: true, force: true });
});

function root() {
  const r = mkdtempSync(join(tmpdir(), "ew-mig-"));
  cleanups.push(r);
  return { legacy: join(r, "old"), fresh: join(r, "home", ".einweave") };
}

function seedLegacy(dir: string) {
  mkdirSync(join(dir, "profiles", "work"), { recursive: true });
  mkdirSync(join(dir, "locks"), { recursive: true });
  for (const f of ["key.json", "state", "attempt", "installation.json", "logged-out"]) writeFileSync(join(dir, f), `root ${f}`, { mode: 0o600 });
  writeFileSync(join(dir, "profiles", "work", "key.json"), "work key", { mode: 0o600 });
  writeFileSync(join(dir, "profiles", "work", "installation.json"), "work inst", { mode: 0o600 });
  mkdirSync(join(dir, "profiles", "Bad Name"), { recursive: true });
  writeFileSync(join(dir, "profiles", "Bad Name", "key.json"), "x");
  writeFileSync(join(dir, ".env"), "BRIDGE_API_URL=https://api.example\nBRIDGE_CHANNELS=general\nOTHER=1\n");
  writeFileSync(join(dir, ".last_seen-abc"), "2026-10-10T00:00:00Z");
  writeFileSync(join(dir, "locks", "abc.lock"), "{}");
  writeFileSync(join(dir, ".session-label-abc"), "label");
}

describe("migrateLegacyState", () => {
  test("carries the profiles and a renamed .env — and nothing else", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    expect(migrateLegacyState(fresh, legacy)).toEqual({ kind: "migrated", profiles: 2, env: true });
    expect(readdirSync(fresh).sort()).toEqual(
      [".env", MIGRATION_MARKER, "attempt", "installation.json", "key.json", "logged-out", "profiles", "state"].sort(),
    );
    expect(readdirSync(join(fresh, "profiles"))).toEqual(["work"]);
    expect(readFileSync(join(fresh, "profiles", "work", "key.json"), "utf8")).toBe("work key");
    expect(readFileSync(join(fresh, ".env"), "utf8")).toBe("EINWEAVE_API_URL=https://api.example\nEINWEAVE_CHANNELS=general\nOTHER=1\n");
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    expect(statSync(join(fresh, "key.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(fresh, ".env")).mode & 0o777).toBe(0o600);
  });

  test("the old directory is left exactly as it was", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    const before = readdirSync(legacy).sort();
    migrateLegacyState(fresh, legacy);
    expect(readdirSync(legacy).sort()).toEqual(before);
    expect(readFileSync(join(legacy, ".env"), "utf8")).toContain("BRIDGE_API_URL=");
  });

  test("there is nothing to move when the old directory does not exist", () => {
    const other = root();
    expect(migrateLegacyState(other.fresh, other.legacy)).toEqual({ kind: "not-needed" });
    expect(existsSync(other.fresh)).toBe(false);
  });

  test("S3: an EXISTING new directory without credential state (the hooks' sessions/) is still migrated into, and kept", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    mkdirSync(join(fresh, "sessions"), { recursive: true });
    writeFileSync(join(fresh, "sessions", "pid-1.json"), "{}");
    mkdirSync(join(fresh, "ctl"), { recursive: true });
    expect(migrateLegacyState(fresh, legacy)).toEqual({ kind: "migrated", profiles: 2, env: true });
    expect(readFileSync(join(fresh, "key.json"), "utf8")).toBe("root key.json");
    expect(readFileSync(join(fresh, "profiles", "work", "installation.json"), "utf8")).toBe("work inst");
    expect(readFileSync(join(fresh, "sessions", "pid-1.json"), "utf8")).toBe("{}");
    expect(existsSync(join(fresh, "ctl"))).toBe(true);
  });

  test("the marker alone means done — and it is written last", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, MIGRATION_MARKER), "done");
    expect(migrateLegacyState(fresh, legacy)).toEqual({ kind: "not-needed" });
    expect(existsSync(join(fresh, "key.json"))).toBe(false);
    expect(existsSync(join(fresh, ".env"))).toBe(false);
  });

  test("credentials in the new dir do NOT make the move 'done' globally: other profiles still move, the settled one is untouched", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, "installation.json"), "mine");
    writeFileSync(join(fresh, "key.json"), "my key");
    expect(migrateLegacyState(fresh, legacy)).toEqual({ kind: "migrated", profiles: 1, env: true });
    expect(readFileSync(join(fresh, "installation.json"), "utf8")).toBe("mine");
    expect(readFileSync(join(fresh, "key.json"), "utf8")).toBe("my key");
    expect(existsSync(join(fresh, "state"))).toBe(false); // the default profile was not merged into
    expect(readFileSync(join(fresh, "profiles", "work", "key.json"), "utf8")).toBe("work key");
    expect(existsSync(join(fresh, MIGRATION_MARKER))).toBe(true);
  });

  test("a signed-out profile (logged-out) is never signed back in from the old directory", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    mkdirSync(join(fresh, "profiles", "work"), { recursive: true });
    writeFileSync(join(fresh, "profiles", "work", "logged-out"), "x");
    migrateLegacyState(fresh, legacy);
    expect(readdirSync(join(fresh, "profiles", "work"))).toEqual(["logged-out"]);
  });

  test("a profile holding credential files and no journal of ours is somebody else's: left alone", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, "key.json"), "an enrolment in progress"); // no installation.json yet
    migrateLegacyState(fresh, legacy);
    expect(readFileSync(join(fresh, "key.json"), "utf8")).toBe("an enrolment in progress");
    expect(existsSync(join(fresh, "installation.json"))).toBe(false);
  });

  test("a move cut short (journal left, key without installation) is FINISHED by the next start", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, PROFILE_JOURNAL), "x");
    writeFileSync(join(fresh, "key.json"), "root key.json");
    expect(migrateLegacyState(fresh, legacy).kind).toBe("migrated");
    expect(readFileSync(join(fresh, "installation.json"), "utf8")).toBe("root installation.json");
    expect(existsSync(join(fresh, PROFILE_JOURNAL))).toBe(false);
  });

  test("a profile that has installation.json is finished even if a journal is still there: nothing more is placed", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, PROFILE_JOURNAL), "x");
    writeFileSync(join(fresh, "installation.json"), "mine");
    migrateLegacyState(fresh, legacy);
    expect(existsSync(join(fresh, "state"))).toBe(false);
    expect(readFileSync(join(fresh, "installation.json"), "utf8")).toBe("mine");
    expect(existsSync(join(fresh, PROFILE_JOURNAL))).toBe(false); // the stale journal is cleaned up
  });

  test("crash after the last file, then a LOGOUT: the old credential is never re-imported, and the journal is cleaned up", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    mkdirSync(fresh, { recursive: true });
    // What a logout leaves behind a journal the crashed move never removed: no installation.json, a logged-out marker.
    writeFileSync(join(fresh, PROFILE_JOURNAL), "x");
    writeFileSync(join(fresh, "logged-out"), "2026-10-11T00:00:00Z\n");
    migrateLegacyState(fresh, legacy);
    expect(existsSync(join(fresh, "key.json"))).toBe(false);
    expect(existsSync(join(fresh, "installation.json"))).toBe(false);
    expect(existsSync(join(fresh, PROFILE_JOURNAL))).toBe(false);
    expect(readFileSync(join(fresh, "logged-out"), "utf8")).toBe("2026-10-11T00:00:00Z\n");
  });

  test("PARTIAL FAILURE (EACCES on one profile): the others move, no marker is written, the next start retries just that one", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    mkdirSync(join(fresh, "profiles"), { recursive: true });
    chmodSync(join(fresh, "profiles"), 0o500); // `work` cannot be created
    const first = migrateLegacyState(fresh, legacy);
    chmodSync(join(fresh, "profiles"), 0o700);
    expect(first.kind).toBe("failed");
    expect(first.kind === "failed" && first.error).toContain("profile work");
    expect(readFileSync(join(fresh, "installation.json"), "utf8")).toBe("root installation.json");
    expect(existsSync(join(fresh, MIGRATION_MARKER))).toBe(false);
    expect(existsSync(join(fresh, "profiles", "work"))).toBe(false);
    const second = migrateLegacyState(fresh, legacy);
    expect(second).toEqual({ kind: "migrated", profiles: 1, env: false });
    expect(readFileSync(join(fresh, "profiles", "work", "installation.json"), "utf8")).toBe("work inst");
    expect(existsSync(join(fresh, MIGRATION_MARKER))).toBe(true);
  });

  test("an existing .env or stray profile file is not overwritten when merging", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    mkdirSync(join(fresh, "profiles", "work"), { recursive: true });
    writeFileSync(join(fresh, "profiles", "work", "stray.txt"), "mine"); // not a credential file: still a merge target
    writeFileSync(join(fresh, ".env"), "EINWEAVE_API_URL=https://mine\n");
    expect(migrateLegacyState(fresh, legacy)).toMatchObject({ kind: "migrated", profiles: 2 });
    expect(readFileSync(join(fresh, ".env"), "utf8")).toBe("EINWEAVE_API_URL=https://mine\n");
    expect(readFileSync(join(fresh, "profiles", "work", "stray.txt"), "utf8")).toBe("mine");
    expect(readFileSync(join(fresh, "profiles", "work", "key.json"), "utf8")).toBe("work key");
  });

  test("placeNew never overwrites, and falls back to an exclusive create where hard links are unavailable", () => {
    const { fresh } = root();
    mkdirSync(fresh, { recursive: true });
    const dst = join(fresh, "f");
    const noLinks = (_a: string, _b: string) => {
      throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
    };
    expect(placeNew(dst, "one", noLinks)).toBe(true);
    expect(readFileSync(dst, "utf8")).toBe("one");
    expect(placeNew(dst, "two", noLinks)).toBe(false); // the exclusive create refuses an existing file
    expect(readFileSync(dst, "utf8")).toBe("one");
    expect(statSync(dst).mode & 0o777).toBe(0o600);
    expect(readdirSync(fresh)).toEqual(["f"]);
    // Any other link failure is an error, not a silent fallback.
    expect(() => placeNew(join(fresh, "g"), "x", () => { throw Object.assign(new Error("disk"), { code: "EIO" }); })).toThrow("disk");
  });

  test("the no-hard-link fallback is atomic across racing windows: one wins, and every loser finds the file COMPLETE", async () => {
    const { fresh } = root();
    mkdirSync(fresh, { recursive: true });
    const dst = join(fresh, "key.json");
    const barrier = join(fresh, "..", "go");
    const SIZE = 48 * 1024 * 1024; // long enough that a non-atomic write is observably partial
    const N = 5;
    const script = `import { existsSync, writeFileSync, statSync } from "node:fs";
      import { placeNew } from ${JSON.stringify(join(import.meta.dir, "..", "state-dir.ts"))};
      const noLinks = () => { throw Object.assign(new Error("no links"), { code: "ENOTSUP" }); };
      writeFileSync(${JSON.stringify(join(fresh, ".."))} + "/ready-" + process.pid, "");
      while (!existsSync(${JSON.stringify(barrier)})) Bun.sleepSync(1);
      const placed = placeNew(${JSON.stringify(dst)}, "x".repeat(${SIZE}), noLinks);
      console.log(JSON.stringify({ placed, size: statSync(${JSON.stringify(dst)}).size }));`;
    const procs = Array.from({ length: N }, () => Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" }));
    const parent = join(fresh, "..");
    const end = Date.now() + 20_000;
    while (Date.now() < end && readdirSync(parent).filter((n) => n.startsWith("ready-")).length < N) await Bun.sleep(10);
    writeFileSync(barrier, "");
    // An observer watches the destination the whole time: it must never be there half-written.
    const seen = new Set<number>();
    let running = true;
    const watcher = (async () => {
      while (running) {
        try {
          seen.add(statSync(dst).size);
        } catch {}
        await Bun.sleep(0);
      }
    })();
    const results = (await Promise.all(procs.map(async (p) => (await new Response(p.stdout).text()).trim()))).map((r) => JSON.parse(r));
    running = false;
    await watcher;
    expect(results.filter((r) => r.placed)).toHaveLength(1);
    for (const r of results) expect(r.size).toBe(SIZE); // a loser never saw a half-written file
    expect([...seen]).toEqual([SIZE]); // …and neither did anyone else, ever
    expect(readdirSync(fresh).sort()).toEqual(["key.json"]); // no temp, no lock left
  }, 60_000);

  test("a STALE placement lock is broken by exactly one waiter: racing windows never both enter", async () => {
    const { fresh } = root();
    mkdirSync(fresh, { recursive: true });
    const lock = join(fresh, ".place.lock");
    mkdirSync(lock);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const dst = join(fresh, "key.json");
    const barrier = join(fresh, "..", "go");
    const N = 8;
    const script = `import { existsSync, writeFileSync } from "node:fs";
      import { placeNew } from ${JSON.stringify(join(import.meta.dir, "..", "state-dir.ts"))};
      const noLinks = () => { throw Object.assign(new Error("no links"), { code: "ENOTSUP" }); };
      writeFileSync(${JSON.stringify(join(fresh, ".."))} + "/ready-" + process.pid, "");
      while (!existsSync(${JSON.stringify(barrier)})) Bun.sleepSync(1);
      console.log(JSON.stringify({ placed: placeNew(${JSON.stringify(dst)}, "mine-" + process.pid, noLinks) }));`;
    const procs = Array.from({ length: N }, () => Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" }));
    const parent = join(fresh, "..");
    const end = Date.now() + 20_000;
    while (Date.now() < end && readdirSync(parent).filter((n) => n.startsWith("ready-")).length < N) await Bun.sleep(10);
    writeFileSync(barrier, "");
    const outs = await Promise.all(procs.map(async (p) => [(await new Response(p.stdout).text()).trim(), (await new Response(p.stderr).text()).trim()] as const));
    const results = outs.map(([o, e]) => { try { return JSON.parse(o); } catch { throw new Error("child failed: " + e); } });
    expect(results.filter((r) => r.placed)).toHaveLength(1);
    expect(readdirSync(fresh).sort()).toEqual(["key.json"]); // no lock, no broken-lock leftovers
  }, 60_000);

  test("sweepMigrationTemps removes temps of dead processes (they hold credential bytes), in the state dir and in profiles", () => {
    const { fresh } = root();
    mkdirSync(join(fresh, "profiles", "work"), { recursive: true });
    const files: Array<[string, boolean]> = [
      [join(fresh, "key.json.migrating-7-abc123"), true],
      [join(fresh, "profiles", "work", "installation.json.migrating-7-zz9"), true],
      [join(fresh, "key.json.migrating-2-abc123"), false], // pid 2 is alive: mid-move
      [join(fresh, "key.json"), false],
      [join(fresh, PROFILE_JOURNAL), false],
    ];
    for (const [f] of files) writeFileSync(f, "secret");
    expect(sweepMigrationTemps(fresh, (pid) => pid === 2)).toBe(2);
    expect(files.map(([f]) => !existsSync(f))).toEqual(files.map(([, gone]) => gone));
  });

  test("several windows starting at the SAME instant (a file barrier) leave exactly one intact copy", async () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    mkdirSync(join(fresh, "sessions"), { recursive: true });
    const barrier = join(fresh, "..", "go");
    const N = 6;
    const script = `import { existsSync, writeFileSync } from "node:fs";
      import { migrateLegacyState } from ${JSON.stringify(join(import.meta.dir, "..", "state-dir.ts"))};
      writeFileSync(${JSON.stringify(join(fresh, ".."))} + "/ready-" + process.pid, "");
      while (!existsSync(${JSON.stringify(barrier)})) Bun.sleepSync(1);
      console.log(JSON.stringify(migrateLegacyState(${JSON.stringify(fresh)}, ${JSON.stringify(legacy)})));`;
    const procs = Array.from({ length: N }, () => Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" }));
    const parent = join(fresh, "..");
    const end = Date.now() + 20_000;
    while (Date.now() < end && readdirSync(parent).filter((n) => n.startsWith("ready-")).length < N) await Bun.sleep(10);
    expect(readdirSync(parent).filter((n) => n.startsWith("ready-"))).toHaveLength(N); // every child is parked at the barrier
    writeFileSync(barrier, "");
    const results = await Promise.all(procs.map(async (p) => (await new Response(p.stdout).text()).trim()));
    for (const r of results) expect(JSON.parse(r).kind).not.toBe("failed");
    expect(readFileSync(join(fresh, "key.json"), "utf8")).toBe("root key.json");
    expect(readFileSync(join(fresh, "installation.json"), "utf8")).toBe("root installation.json");
    expect(readFileSync(join(fresh, "profiles", "work", "key.json"), "utf8")).toBe("work key");
    expect(readFileSync(join(fresh, ".env"), "utf8")).toContain("EINWEAVE_API_URL=");
    expect(readdirSync(fresh).filter((n) => n.includes("migrating"))).toEqual([]);
    expect(readdirSync(join(fresh, "profiles", "work")).sort()).toEqual(["installation.json", "key.json"]);
    expect(existsSync(join(fresh, MIGRATION_MARKER))).toBe(true);
  }, 40_000);

  test("a second run is a no-op; the first result stands", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    migrateLegacyState(fresh, legacy);
    writeFileSync(join(legacy, "key.json"), "rotated later in the old dir");
    expect(migrateLegacyState(fresh, legacy)).toEqual({ kind: "not-needed" });
    expect(readFileSync(join(fresh, "key.json"), "utf8")).toBe("root key.json");
  });

  test("a legacy dir with no profile and no .env still yields an (empty) new dir, no crash", () => {
    const { legacy, fresh } = root();
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, ".last_seen"), "x");
    expect(migrateLegacyState(fresh, legacy)).toEqual({ kind: "not-needed" });
    expect(readdirSync(fresh)).toEqual([MIGRATION_MARKER]);
    // Later credentials in the old dir are NOT pulled in: the move happened once.
    writeFileSync(join(legacy, "key.json"), "appeared later");
    expect(migrateLegacyState(fresh, legacy)).toEqual({ kind: "not-needed" });
    expect(existsSync(join(fresh, "key.json"))).toBe(false);
  });

  test("no leftover temp directories", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    migrateLegacyState(fresh, legacy);
    const all = [fresh, join(fresh, "profiles", "work")].flatMap((d) => readdirSync(d));
    expect(all.filter((n) => n.includes("migrating"))).toEqual([]);
  });
});

describe("server.ts boot", () => {
  const SERVER = join(import.meta.dir, "..", "server.ts");
  async function boot(env: Record<string, string>) {
    const base = { ...(process.env as Record<string, string>) };
    for (const k of Object.keys(base)) if (k.startsWith("EINWEAVE_") || k.startsWith("BRIDGE_")) delete base[k];
    const proc = Bun.spawn(["bun", SERVER], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...base, ...env } });
    await Bun.sleep(1500);
    proc.stdin.end();
    proc.kill();
    await proc.exited;
  }

  test("moves the old profile into the DEFAULT ~/.einweave (HOME redirected)", async () => {
    const home = mkdtempSync(join(tmpdir(), "ew-home-"));
    cleanups.push(home);
    seedLegacy(join(home, ".claude", "channels", "bridge"));
    await boot({ HOME: home, CLAUDE_PLUGIN_DATA: join(home, "pd") });
    expect(readFileSync(join(home, ".einweave", "key.json"), "utf8")).toBe("root key.json");
  });

  test("NEVER fills an explicit EINWEAVE_STATE_DIR from the user's old profile", async () => {
    const home = mkdtempSync(join(tmpdir(), "ew-home-"));
    cleanups.push(home);
    seedLegacy(join(home, ".claude", "channels", "bridge"));
    const explicit = join(home, "elsewhere");
    await boot({ HOME: home, EINWEAVE_STATE_DIR: explicit, CLAUDE_PLUGIN_DATA: join(home, "pd") });
    expect(existsSync(join(explicit, "key.json"))).toBe(false);
    expect(existsSync(join(home, ".einweave"))).toBe(false);
  });
});

describe("resolveStateDir", () => {
  test("EINWEAVE_STATE_DIR wins; BRIDGE_STATE_DIR is ignored; default ~/.einweave", () => {
    expect(resolveStateDir({ EINWEAVE_STATE_DIR: "/x" })).toBe("/x");
    expect(resolveStateDir({ BRIDGE_STATE_DIR: "/y" }).endsWith("/.einweave")).toBe(true);
  });
});
