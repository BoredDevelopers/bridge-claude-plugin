/**
 * One Bridge socket per session key per box.
 *
 * WHY THIS EXISTS — the same footgun fired twice in two days.
 *
 * Two copies of this plugin can load into ONE Claude Code session: the
 * marketplace plugin from `enabledPlugins`, plus either a user-scope `bridge`
 * entry in `~/.claude.json` or `--dangerously-load-development-channels`. Both
 * resolve the SAME session key, both open a socket, the server hands the key to
 * the first and renames the second to a connection id. On 2026-07-29 that cost
 * an hour of misdiagnosis; on 2026-07-30 it produced two `claude-code` contexts
 * acking one message at the same instant and a second round of confusion. Every
 * inbound message was also handled twice.
 *
 * THE INVARIANT THAT OUTRANKS THE FEATURE: never lock a session OUT of Bridge.
 * A plugin that refuses to connect because of a lock file left by a process that
 * died is a worse bug than the duplicate it prevents — it is silent, it survives
 * restarts, and it looks exactly like "Bridge is down". So the stale-lock tests
 * below are not edge cases; they are the reason the mechanism is allowed to
 * exist, and `holderIsLive` fails toward CONNECTING on every uncertainty.
 *
 * WHY O_EXCL AND NOT A UNIX SOCKET. The textbook primitive is a unix-domain
 * socket, whose liveness the kernel guarantees. Measured against Bun 1.3.5 it
 * does neither thing needed here: `Bun.listen({unix})` on an already-bound path
 * SUCCEEDS (Bun unlinks and steals it), and connecting to a stale path also
 * succeeds. `writeFileSync(..., {flag:"wx"})` was measured instead — 40
 * concurrent processes racing one path produced exactly one winner — and that is
 * what the implementation uses. Reputation lost to measurement.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SERVER = join(import.meta.dir, "..", "server.ts");
const SESSION_ID = "aaaaaaaa-1111-2222-3333-444444444444";

let dir = "";
const lockFile = () => join(dir, "locks", `${SESSION_ID}.lock`);

function procStart(pid: number): string {
  const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
  return r.success ? new TextDecoder().decode(r.stdout).trim() : "";
}

function writeLock(rec: Record<string, unknown>) {
  mkdirSync(join(dir, "locks"), { recursive: true });
  writeFileSync(lockFile(), JSON.stringify(rec));
}

/**
 * Boot a plugin and read its stderr until it says what it decided.
 *
 * API_URL points at a CLOSED port on purpose: this is about whether the process
 * takes the lock, and a real server would add a second reason for a socket to
 * appear or not.
 *
 * The signal is the ACQUISITION line, not a connection error. The plugin prints
 * nothing at all when a connect attempt fails against a closed port — the first
 * version of this file fished for "ECONNREFUSED" and scored every instance as
 * not-connected, which made the race test read `connected: 0` and look like a
 * total lockout. The fix was to make the plugin SAY it took the lock, which an
 * operator needs anyway: the duplicate was expensive precisely because the
 * symptom was visible on the server while the cause was invisible locally.
 */
async function boot(waitMs = 9000): Promise<{ err: string; declined: boolean; connected: boolean; lock: any }> {
  const p = Bun.spawn(["bun", SERVER], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dir,
      BRIDGE_STATE_DIR: dir,
      BRIDGE_API_URL: "http://127.0.0.1:1",
      BRIDGE_TOKEN: "test-token",
      BRIDGE_SESSION_KEY: SESSION_ID,
      CLAUDE_CODE_SSE_PORT: "",
    } as Record<string, string>,
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let err = "";
  (async () => { const d = new TextDecoder(); for await (const c of p.stderr as any) err += d.decode(c, { stream: true }); })();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && !/DUPLICATE INSTANCE|session lock acquired/.test(err)) {
    await Bun.sleep(100);
  }
  // Snapshot the lock BEFORE killing. Shutdown releases it — correctly — so
  // reading the file afterwards is a post-mortem, not a measurement of what the
  // running process held. Two tests asserted on the corpse and failed for a
  // reason that had nothing to do with what they were testing.
  let lock: any = null;
  try { lock = JSON.parse(readFileSync(lockFile(), "utf8")); } catch {}
  p.kill();
  await Bun.sleep(200);
  return {
    err,
    lock,
    declined: /DUPLICATE INSTANCE/.test(err),
    connected: /session lock acquired/.test(err),
  };
}

describe("single instance per session key", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lock-")); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("a lone instance connects and holds the lock", async () => {
    const r = await boot();
    expect(r.declined, "nothing else holds it").toBe(false);
    expect(r.connected).toBe(true);
    expect(r.lock, "the lock should have been written while running").not.toBeNull();
    expect(r.lock.sessionKey).toBe(SESSION_ID);
    expect(r.lock.procStart, "must record a start time or the pid-reuse guard cannot work").toBeTruthy();
  }, 30_000);

  test("a second instance DECLINES while a live holder exists", async () => {
    // THIS test process stands in for the sibling plugin: a real, live pid whose
    // recorded start time genuinely matches.
    writeLock({
      pid: process.pid,
      procStart: procStart(process.pid),
      sessionKey: SESSION_ID,
      at: new Date().toISOString(),
    });
    const r = await boot();
    expect(r.declined, "must not compete for a key a live process holds").toBe(true);
    expect(r.connected, "must not open a socket").toBe(false);
    expect(r.err).toContain("standing by");
  }, 30_000);

  test("A DEAD HOLDER MUST NOT LOCK THE SESSION OUT", async () => {
    // The failure mode that is worse than the bug. A process that died without
    // cleanup leaves this file behind; if it were honoured, Bridge would be
    // silently and permanently down for that session across every restart.
    const dead = Bun.spawn(["bun", "-e", "process.exit(0)"]);
    await dead.exited;
    writeLock({ pid: dead.pid, procStart: "Wed Jan  1 00:00:00 2020", sessionKey: SESSION_ID, at: new Date().toISOString() });
    const r = await boot();
    expect(r.declined, "a dead holder must be cleared, not obeyed").toBe(false);
    expect(r.connected).toBe(true);
    expect(r.lock.pid, "the dead holder's record must have been replaced").not.toBe(dead.pid);
  }, 30_000);

  test("PID REUSE: a live pid with a different start time is not the holder", async () => {
    // The number is alive; it is simply somebody else. Without comparing start
    // times, any recycled pid would lock a session out — and pids recycle fast
    // on a busy box. Found to matter in 0.11.3 for the session map; same guard.
    writeLock({
      pid: process.pid, // alive...
      procStart: "Wed Jan  1 00:00:00 2020", // ...but not this process
      sessionKey: SESSION_ID,
      at: new Date().toISOString(),
    });
    const r = await boot();
    expect(r.declined, "start-time mismatch means the holder is gone").toBe(false);
    expect(r.connected).toBe(true);
  }, 30_000);

  test("an unverifiable holder (no recorded start time) fails OPEN", async () => {
    // Written by some older or partial build. It cannot pin anything, so
    // honouring it would be a lockout justified by nothing.
    writeLock({ pid: process.pid, procStart: "", sessionKey: SESSION_ID, at: new Date().toISOString() });
    const r = await boot();
    expect(r.declined).toBe(false);
    expect(r.connected).toBe(true);
  }, 30_000);

  test("WITHOUT `ps`, an unverifiable holder still fails OPEN", async () => {
    // FOUND BY MUTATION: deleting `if (!rec.procStart) return false` changed
    // nothing, because the comparison below it already rejects an empty recorded
    // value against a real one. There is exactly one input where only that guard
    // runs — when `procStartOf` ALSO returns "" — and it is reachable: `ps` off
    // PATH. Then "" === "" matches, every holder reads as live, and the box
    // locks every session out of Bridge. `pidAlive` uses process.kill(pid, 0)
    // and does not need `ps`, so the pid genuinely is alive here.
    // A `ps` that fails, shadowing the real one. PATH cannot simply be emptied —
    // `bun` is resolved through it too, and the spawn would fail for an unrelated
    // reason and score as "declined".
    const shimBin = join(dir, "shim");
    mkdirSync(shimBin, { recursive: true });
    writeFileSync(join(shimBin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeLock({ pid: process.pid, procStart: "", sessionKey: SESSION_ID, at: new Date().toISOString() });
    const p = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        PATH: `${shimBin}:${process.env.PATH}`, // `ps` resolves to the failing shim
        CLAUDE_PLUGIN_DATA: dir, BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: "http://127.0.0.1:1", BRIDGE_TOKEN: "t",
        BRIDGE_SESSION_KEY: SESSION_ID, CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    let err = "";
    (async () => { const d = new TextDecoder(); for await (const c of p.stderr as any) err += d.decode(c, { stream: true }); })();
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline && !/DUPLICATE INSTANCE|session lock acquired/.test(err)) await Bun.sleep(100);
    p.kill();
    expect(/DUPLICATE INSTANCE/.test(err), "no `ps` must not mean no Bridge").toBe(false);
    expect(/session lock acquired/.test(err)).toBe(true);
  }, 30_000);

  test("a corrupt lock file fails OPEN rather than stranding the session", async () => {
    mkdirSync(join(dir, "locks"), { recursive: true });
    writeFileSync(lockFile(), "{ this is not json");
    const r = await boot();
    expect(r.declined).toBe(false);
    expect(r.connected).toBe(true);
  }, 30_000);

  test("a WEDGED holder loses the lock once its lease goes stale", async () => {
    // Alive, matching start time, but has not renewed in far longer than the
    // 5-minute window — so it is not running this code, or it is stuck. A live
    // holder renews every 30s and keeps the lock through reconnect backoff.
    writeLock({
      pid: process.pid,
      procStart: procStart(process.pid),
      sessionKey: SESSION_ID,
      at: new Date().toISOString(),
    });
    const old = Date.now() - 10 * 60_000;
    Bun.spawnSync(["touch", "-t", new Date(old).toISOString().slice(0, 16).replace(/[-T:]/g, "").slice(0, 12), lockFile()]);
    const r = await boot();
    expect(r.declined, "a lease this old must not hold the session").toBe(false);
    expect(r.connected).toBe(true);
  }, 30_000);

  test("the lock is released on shutdown so the next start is clean", async () => {
    const p = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir, BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: "http://127.0.0.1:1", BRIDGE_TOKEN: "t",
        BRIDGE_SESSION_KEY: SESSION_ID, CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    let err = "";
    (async () => { const d = new TextDecoder(); for await (const c of p.stderr as any) err += d.decode(c, { stream: true }); })();
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline && !existsSync(lockFile())) await Bun.sleep(100);
    expect(existsSync(lockFile()), "lock taken").toBe(true);
    p.kill("SIGTERM");
    await p.exited;
    await Bun.sleep(500);
    expect(existsSync(lockFile()), "SIGTERM must release the lock").toBe(false);
  }, 30_000);

  test("THE RACE: many simultaneous instances yield exactly ONE connection", async () => {
    // The real trigger is two copies starting together from one CLI, so the
    // concurrent case is the case — not an edge. Eight at once is well past what
    // any real load does, and the assertion is exact: one connects, the rest
    // stand by. Anything other than exactly 1 is a bug in either direction — 2+
    // is the duplicate returning, 0 is the lockout.
    const kids = Array.from({ length: 8 }, () =>
      Bun.spawn(["bun", SERVER], {
        env: {
          ...process.env,
          CLAUDE_PLUGIN_DATA: dir, BRIDGE_STATE_DIR: dir,
          BRIDGE_API_URL: "http://127.0.0.1:1", BRIDGE_TOKEN: "t",
          BRIDGE_SESSION_KEY: SESSION_ID, CLAUDE_CODE_SSE_PORT: "",
        } as Record<string, string>,
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      })
    );
    const errs = kids.map(() => "");
    kids.forEach((k, i) => {
      (async () => { const d = new TextDecoder(); for await (const c of k.stderr as any) errs[i] += d.decode(c, { stream: true }); })();
    });
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && errs.filter((e) => /DUPLICATE INSTANCE|session lock acquired/.test(e)).length < kids.length) {
      await Bun.sleep(150);
    }
    kids.forEach((k) => k.kill());
    const connected = errs.filter((e) => /session lock acquired/.test(e)).length;
    const declined = errs.filter((e) => /DUPLICATE INSTANCE/.test(e)).length;
    expect({ connected, declined }).toEqual({ connected: 1, declined: 7 });
  }, 60_000);

  test("DIFFERENT session keys never block each other", async () => {
    // The lock is per KEY, not per box. Two genuine sessions on one machine is
    // the normal case — several run here right now — and a lock that serialised
    // them would take Bridge away from every session but one.
    writeLock({ pid: process.pid, procStart: procStart(process.pid), sessionKey: "some-other-session", at: new Date().toISOString() });
    const other = join(dir, "locks", "some-other-session.lock");
    mkdirSync(join(dir, "locks"), { recursive: true });
    writeFileSync(other, JSON.stringify({ pid: process.pid, procStart: procStart(process.pid), sessionKey: "some-other-session", at: new Date().toISOString() }));
    rmSync(lockFile(), { force: true });
    const r = await boot();
    expect(r.declined, "another key's lock is not ours").toBe(false);
    expect(r.connected).toBe(true);
  }, 30_000);
});
