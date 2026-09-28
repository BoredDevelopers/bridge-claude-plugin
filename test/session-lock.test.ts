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
import { procStartOf } from "../proc-start";
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeInstallation } from "../auth/node/store";
import { createAgentAuthRoutes } from "./agent-auth-routes";
import { mintAgentToken } from "./agent-auth-stub";
import pkg from "../package.json" with { type: "json" };

/** The REAL running version — RFC-017 D3's tests compare a written lock record's
 * `version` against whatever this build actually is, never a hardcoded string. */
const MY_VERSION: string = pkg.version;

const SERVER = join(import.meta.dir, "..", "server.ts");
const SESSION_ID = "aaaaaaaa-1111-2222-3333-444444444444";
// Every test here points at a closed port — the lock mechanism is what's under
// test, not a real connection. `configError()` just needs a credential ON DISK
// (source() only reads it, never dials out) to let `connectUnlessDuplicate()`
// past the startup gate at all — no live agent-auth server needed.
const CLOSED_PORT_API_URL = "http://127.0.0.1:1";

let dir = "";
const lockFile = () => join(dir, "locks", `${SESSION_ID}.lock`);
function seedCredentials(d: string): void {
  writeInstallation(d, { apiUrl: CLOSED_PORT_API_URL, installationId: crypto.randomUUID(), jkt: "test-jkt", keyStorage: "software" });
}

// What a 0.26.1+ writer records (normalized TZ/locale — proc-start.ts).
const procStart = (pid: number): string => procStartOf(pid);

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
// RFC-017 D3: a WON lock is reported either way ("acquired", no contest, or "TAKEN
// OVER", a live holder lost) — both count as `connected` for these tests, which are
// about who ends up holding the key, not which of the two lines got there.
const WON_RE = /session lock acquired|session lock TAKEN OVER/;

async function boot(waitMs = 9000): Promise<{ err: string; declined: boolean; connected: boolean; tookOver: boolean; lock: any; lockMode: number | null }> {
  const p = Bun.spawn(["bun", SERVER], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dir,
      BRIDGE_STATE_DIR: dir,
      BRIDGE_API_URL: CLOSED_PORT_API_URL,
      BRIDGE_AUTOCONNECT: "1",
      BRIDGE_SESSION_KEY: SESSION_ID,
      CLAUDE_CODE_SSE_PORT: "",
    } as Record<string, string>,
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let err = "";
  (async () => { const d = new TextDecoder(); for await (const c of p.stderr as any) err += d.decode(c, { stream: true }); })();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && !/DUPLICATE INSTANCE/.test(err) && !WON_RE.test(err)) {
    await Bun.sleep(100);
  }
  // Snapshot the lock BEFORE killing. Shutdown releases it — correctly — so
  // reading the file afterwards is a post-mortem, not a measurement of what the
  // running process held. Two tests asserted on the corpse and failed for a
  // reason that had nothing to do with what they were testing.
  let lock: any = null;
  let lockMode: number | null = null;
  try { lock = JSON.parse(readFileSync(lockFile(), "utf8")); } catch {}
  try { lockMode = statSync(lockFile()).mode & 0o777; } catch {}
  p.kill();
  await Bun.sleep(200);
  return {
    err,
    lock,
    lockMode,
    declined: /DUPLICATE INSTANCE/.test(err),
    connected: WON_RE.test(err),
    tookOver: /session lock TAKEN OVER/.test(err),
  };
}

describe("single instance per session key", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lock-")); seedCredentials(dir); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("a lone instance connects and holds the lock", async () => {
    const r = await boot();
    expect(r.declined, "nothing else holds it").toBe(false);
    expect(r.connected).toBe(true);
    expect(r.lock, "the lock should have been written while running").not.toBeNull();
    expect(r.lock.sessionKey).toBe(SESSION_ID);
    expect(r.lock.procStart, "must record a start time or the pid-reuse guard cannot work").toBeTruthy();
  }, 30_000);

  test("finding 10: the lock file is 0600 and locks/ is 0700", async () => {
    const p = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir, BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: CLOSED_PORT_API_URL, BRIDGE_AUTOCONNECT: "1",
        BRIDGE_SESSION_KEY: SESSION_ID, CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline && !existsSync(lockFile())) await Bun.sleep(50);
    try {
      expect(existsSync(lockFile())).toBe(true);
      expect(statSync(lockFile()).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "locks")).mode & 0o777).toBe(0o700);
    } finally {
      p.kill();
    }
  }, 30_000);

  test("a second instance DECLINES while a live holder exists", async () => {
    // THIS test process stands in for the sibling plugin: a real, live pid whose
    // recorded start time genuinely matches, on the SAME version as the booting
    // instance — RFC-017 D3 only stands a contender down against an equal-or-newer
    // holder; an older one is a takeover (see the "version-aware takeover" describe
    // block below), which is a different scenario from the one this test pins.
    writeLock({
      pid: process.pid,
      procStart: procStart(process.pid),
      sessionKey: SESSION_ID,
      at: new Date().toISOString(),
      version: MY_VERSION,
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
        BRIDGE_API_URL: CLOSED_PORT_API_URL, BRIDGE_AUTOCONNECT: "1",
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
        BRIDGE_API_URL: CLOSED_PORT_API_URL, BRIDGE_AUTOCONNECT: "1",
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
          BRIDGE_API_URL: CLOSED_PORT_API_URL, BRIDGE_AUTOCONNECT: "1",
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

describe("RFC-017 D3: version-aware takeover", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lock-")); seedCredentials(dir); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("C1: a newer contender TAKES OVER a live holder on an older version — never just stands by", async () => {
    // This test process stands in for the older sibling: a real, live pid, whose
    // lock record declares a version below whatever this build actually is.
    writeLock({ pid: process.pid, procStart: procStart(process.pid), sessionKey: SESSION_ID, at: new Date().toISOString(), version: "0.1.0" });
    const r = await boot();
    expect(r.declined, "a newer contender must not stand by against an older live holder").toBe(false);
    expect(r.connected).toBe(true);
    expect(r.tookOver, "this must be a TAKEOVER line, not a plain first acquisition").toBe(true);
    expect(r.lock.pid, "the record now names the new (winning) process").not.toBe(process.pid);
    expect(r.lock.version).toBe(MY_VERSION);
    expect(r.lock.software).toBe("bridge-claude-plugin");
    // finding 5/10: the TAKEOVER write path (tmp + rename), not just the first-ever
    // O_EXCL acquire, must also land at 0600.
    expect(r.lockMode).toBe(0o600);
  }, 30_000);

  test("a missing holder version (a 0.25-shaped record, no `version` field at all) counts as 0.25 — older than this build, so it is TAKEN OVER", async () => {
    // Byte-for-byte the v025 lock shape (test/fixtures/v025/locks): pid, procStart,
    // sessionKey, at — nothing else. D3: "a missing version counts as 0.25 or older."
    // This build is 0.26.0 (P9's bump), so omitting the field reads as strictly
    // OLDER, not equal — the auto path takes over, same as C1's explicit "0.1.0"
    // above. This one pins that OMITTING the field entirely is read the same way
    // as an explicit old version, not as "unknown" or "newest".
    writeLock({ pid: process.pid, procStart: procStart(process.pid), sessionKey: SESSION_ID, at: new Date().toISOString() });
    const r = await boot();
    expect(r.declined).toBe(false);
    expect(r.connected).toBe(true);
    expect(r.tookOver, "a missing version must read as OLD, not as a reason to stand by").toBe(true);
  }, 30_000);

  test("the auto path never downgrades: an older contender stands by against a newer live holder", async () => {
    writeLock({ pid: process.pid, procStart: procStart(process.pid), sessionKey: SESSION_ID, at: new Date().toISOString(), version: "99.0.0" });
    const r = await boot();
    expect(r.declined, "an older (or equal) contender must never take over automatically").toBe(true);
    expect(r.connected).toBe(false);
  }, 30_000);

  test("D3/D4: a takeover's auth frame carries supersede: true", async () => {
    // A REAL agent-auth stub this time (not the closed port every other test here
    // uses) — headless enrolment needs a working token endpoint before there is a
    // socket at all, and the point of this test is what that socket then SENDS. The
    // beforeEach's closed-port credential must go: a fresh headless enrolment (below)
    // needs `this.installation()` to read null first.
    rmSync(join(dir, "installation.json"), { force: true });
    let authFrame: any = null;
    const agentAuth = createAgentAuthRoutes();
    const enrolmentKey = mintAgentToken("ek");
    agentAuth.addEnrolmentKey(enrolmentKey);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, srv) {
        const auth = await agentAuth.handle(req);
        if (auth) return auth;
        if (srv.upgrade(req)) return;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          let frame: any = {};
          try { frame = JSON.parse(String(raw)); } catch { return; }
          if (frame.type === "auth") {
            authFrame = frame;
            ws.send(JSON.stringify({ type: "authenticated", data: { agentId: "a", agentName: "A", contextId: "ctx" } }));
          }
        },
      },
    });
    try {
      writeLock({ pid: process.pid, procStart: procStart(process.pid), sessionKey: SESSION_ID, at: new Date().toISOString(), version: "0.1.0" });
      const p = Bun.spawn(["bun", SERVER], {
        env: {
          ...process.env,
          CLAUDE_PLUGIN_DATA: dir, BRIDGE_STATE_DIR: dir,
          BRIDGE_API_URL: `http://127.0.0.1:${server.port}`, BRIDGE_AUTOCONNECT: "1",
          BRIDGE_ENROLMENT_KEY: enrolmentKey,
          BRIDGE_SESSION_KEY: SESSION_ID, CLAUDE_CODE_SSE_PORT: "",
        } as Record<string, string>,
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      try {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && !authFrame) await Bun.sleep(50);
        expect(authFrame?.type).toBe("auth");
        expect(authFrame?.supersede).toBe(true);
      } finally {
        p.kill();
      }
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("F1: a transient failure right after a takeover — the RETRY's auth frame still carries supersede:true", async () => {
    // Findings 1-2 replaced the one-shot `opts.supersede` (sent on exactly the ONE auth
    // frame right after a takeover) with reading `lockHeld` at send time on EVERY
    // attempt. This is the regression the old design was prone to: refuse auth #1 with a
    // TRANSIENT close (so the plugin retries fast, on its own, via scheduleReconnect) and
    // check that auth #2 — the automatic retry, not a fresh takeover — ALSO carries
    // `supersede: true`. Under the old one-shot design this would have been lost: the
    // reconnect timer called `connectWs()` with no opts at all.
    rmSync(join(dir, "installation.json"), { force: true });
    const authFrames: any[] = [];
    const agentAuth = createAgentAuthRoutes();
    const enrolmentKey = mintAgentToken("ek");
    agentAuth.addEnrolmentKey(enrolmentKey);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, srv) {
        const auth = await agentAuth.handle(req);
        if (auth) return auth;
        if (srv.upgrade(req)) return;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          let frame: any = {};
          try { frame = JSON.parse(String(raw)); } catch { return; }
          if (frame.type !== "auth") return;
          authFrames.push(frame);
          if (authFrames.length === 1) {
            ws.close(4006, "Authentication timeout"); // transient — retries fast, on its own
            return;
          }
          ws.send(JSON.stringify({ type: "authenticated", data: { agentId: "a", agentName: "A", contextId: SESSION_ID } }));
        },
      },
    });
    try {
      writeLock({ pid: process.pid, procStart: procStart(process.pid), sessionKey: SESSION_ID, at: new Date().toISOString(), version: "0.1.0" });
      const p = Bun.spawn(["bun", SERVER], {
        env: {
          ...process.env,
          CLAUDE_PLUGIN_DATA: dir, BRIDGE_STATE_DIR: dir,
          BRIDGE_API_URL: `http://127.0.0.1:${server.port}`, BRIDGE_AUTOCONNECT: "1",
          BRIDGE_ENROLMENT_KEY: enrolmentKey,
          BRIDGE_SESSION_KEY: SESSION_ID, CLAUDE_CODE_SSE_PORT: "",
        } as Record<string, string>,
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      try {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && authFrames.length < 2) await Bun.sleep(50);
        expect(authFrames.length, "must have retried on its own after the transient close").toBeGreaterThanOrEqual(2);
        expect(authFrames[0]?.supersede, "the ORIGINAL takeover attempt").toBe(true);
        expect(authFrames[1]?.supersede, "the RETRY must still carry it — this is F1's regression").toBe(true);
      } finally {
        p.kill();
      }
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("F1b: supersede sent but the server's `authenticated` frame names a DIFFERENT context — one model notice, and status shows it", async () => {
    // The takeover locally succeeded (we hold the lock, we sent supersede:true), but the
    // SERVER did not actually hand us SESSION_KEY as our context id (an ineligible
    // grant, a pre-017 server that ignores `supersede`, or a lost race) — the plugin must
    // notice and say so, once.
    rmSync(join(dir, "installation.json"), { force: true });
    const agentAuth = createAgentAuthRoutes();
    const enrolmentKey = mintAgentToken("ek");
    agentAuth.addEnrolmentKey(enrolmentKey);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, srv) {
        const auth = await agentAuth.handle(req);
        if (auth) return auth;
        if (srv.upgrade(req)) return;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          let frame: any = {};
          try { frame = JSON.parse(String(raw)); } catch { return; }
          if (frame.type !== "auth") return;
          // Deliberately NOT SESSION_ID — the server renamed us despite `supersede`.
          ws.send(JSON.stringify({ type: "authenticated", data: { agentId: "a", agentName: "A", contextId: "some-connection-id" } }));
        },
      },
    });
    try {
      writeLock({ pid: process.pid, procStart: procStart(process.pid), sessionKey: SESSION_ID, at: new Date().toISOString(), version: "0.1.0" });
      const transport = new StdioClientTransport({
        command: "bun",
        args: [SERVER],
        env: {
          ...process.env,
          CLAUDE_PLUGIN_DATA: dir, BRIDGE_STATE_DIR: dir,
          BRIDGE_API_URL: `http://127.0.0.1:${server.port}`, BRIDGE_AUTOCONNECT: "1",
          BRIDGE_ENROLMENT_KEY: enrolmentKey,
          BRIDGE_SESSION_KEY: SESSION_ID, CLAUDE_CODE_SSE_PORT: "",
        } as Record<string, string>,
      });
      const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
      const notices: string[] = [];
      client.fallbackNotificationHandler = async (n: any) => {
        if (typeof n?.params?.content === "string") notices.push(n.params.content);
      };
      try {
        await client.connect(transport);
        const sawNotice = await (async () => {
          const end = Date.now() + 9000;
          while (Date.now() < end) {
            if (notices.some((c) => c.includes("another window still holds this session's id"))) return true;
            await Bun.sleep(50);
          }
          return false;
        })();
        expect(sawNotice).toBe(true);
        const matching = notices.filter((c) => c.includes("another window still holds this session's id"));
        expect(matching, "once, not once per reconnect").toHaveLength(1);
        const status: any = await client.callTool({ name: "status", arguments: {} });
        const s = JSON.parse(status.content[0].text);
        expect(s.supersede_ineffective).toBe(true);
      } finally {
        await client.close().catch(() => {});
      }
    } finally {
      server.stop(true);
    }
  }, 30_000);
});

describe("F2: a holder in reconnect backoff re-validates the lock before its OWN timer fires", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lock-")); seedCredentials(dir); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("A is mid-backoff (transient close, no live socket) when B (newer) takes over the LOCAL lock — A's timer must go through the gate and go SUPERSEDED, never re-auth", async () => {
    // A and B are two windows of the SAME session (RFC-017's own framing): one shared
    // real agent-auth+WS stub, one shared installation (B reuses whatever A enrols —
    // enrolFromKeyIfNeeded no-ops once `installation.json` exists), and the SAME
    // on-disk session lock, which is what this test is actually about. A is
    // deliberately reported as an OLDER version (BRIDGE_TEST_PLUGIN_VERSION) so B's
    // real, unoverridden version wins the lock automatically once it starts. Auth
    // frames are told apart by ORDER (A connects first, at boot; B only after A is
    // already up), not by identity — the server treats every socket the same.
    // beforeEach's closed-port credential must go — A headlessly enrols below.
    rmSync(join(dir, "installation.json"), { force: true });
    let auths = 0;
    let onFirstAuthenticated: (() => void) | null = null;
    let liveFirstSocket: any = null;
    const bAuthFrames: any[] = [];
    const agentAuth = createAgentAuthRoutes();
    const enrolmentKey = mintAgentToken("ek");
    agentAuth.addEnrolmentKey(enrolmentKey);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, srv) {
        const auth = await agentAuth.handle(req);
        if (auth) return auth;
        if (srv.upgrade(req)) return;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          let frame: any = {};
          try { frame = JSON.parse(String(raw)); } catch { return; }
          if (frame.type !== "auth") return;
          auths++;
          if (auths === 1) liveFirstSocket = ws;
          else bAuthFrames.push(frame);
          ws.send(JSON.stringify({ type: "authenticated", data: { agentId: "a", agentName: "A", contextId: SESSION_ID } }));
          if (auths === 1) onFirstAuthenticated?.();
        },
        close(ws) {
          if (liveFirstSocket === ws) liveFirstSocket = null;
        },
      },
    });

    const pA = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir, BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: `http://127.0.0.1:${server.port}`, BRIDGE_AUTOCONNECT: "1",
        BRIDGE_ENROLMENT_KEY: enrolmentKey,
        BRIDGE_SESSION_KEY: SESSION_ID, CLAUDE_CODE_SSE_PORT: "",
        // A comfortably wide, scaled-down "credential"-class backoff (unscaled 30-60s):
        // wide enough that B's real startup + auth reliably finishes well inside it,
        // narrow enough that the test does not need to wait long.
        BRIDGE_TEST: "1", BRIDGE_TEST_PLUGIN_VERSION: "0.1.0", BRIDGE_TEST_BACKOFF_SCALE: "0.15",
      } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    let errA = "";
    (async () => { const d = new TextDecoder(); for await (const c of pA.stderr as any) errA += d.decode(c, { stream: true }); })();
    let pB: ReturnType<typeof Bun.spawn> | null = null;
    try {
      const authedOnce = new Promise<void>((r) => (onFirstAuthenticated = r));
      const authDeadline = Date.now() + 15_000;
      await Promise.race([authedOnce, (async () => { while (Date.now() < authDeadline && auths < 1) await Bun.sleep(50); })()]);
      expect(auths).toBe(1);

      // Force A's live socket closed with a CREDENTIAL-class code — a slow, scaled-down
      // backoff (never evicted/expired/superseded, so this is a plain reconnect, not a
      // takeover reaction).
      liveFirstSocket?.close(4003, "deregistered");

      // Wait until A's OWN stderr shows a reconnect is armed (and parse the delay it
      // actually chose) BEFORE starting B — racing against "connected" would test
      // nothing.
      const armedDeadline = Date.now() + 5000;
      let plannedS: number | null = null;
      while (Date.now() < armedDeadline && plannedS === null) {
        const m = /reconnecting in ([\d.]+)s/.exec(errA);
        if (m) plannedS = parseFloat(m[1]);
        else await Bun.sleep(20);
      }
      expect(plannedS, "A must have armed a scheduled reconnect").not.toBeNull();
      const armedAt = Date.now();

      // B: same session key, same STATE_DIR, same installation, but a genuinely NEWER
      // (real, unoverridden) version — the auto path takes over A's still-held lock.
      pB = Bun.spawn(["bun", SERVER], {
        env: {
          ...process.env,
          CLAUDE_PLUGIN_DATA: dir, BRIDGE_STATE_DIR: dir,
          BRIDGE_API_URL: `http://127.0.0.1:${server.port}`, BRIDGE_AUTOCONNECT: "1",
          BRIDGE_SESSION_KEY: SESSION_ID, CLAUDE_CODE_SSE_PORT: "",
        } as Record<string, string>,
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      const bDeadline = Date.now() + 15_000;
      while (Date.now() < bDeadline && bAuthFrames.length < 1) await Bun.sleep(50);
      expect(bAuthFrames[0]?.type).toBe("auth");
      expect(bAuthFrames[0]?.supersede, "B genuinely took over the LOCAL lock").toBe(true);

      // Wait until PAST A's actual scheduled fire time (whatever the real random draw
      // was), with a comfortable safety margin — deterministic regardless of jitter.
      const remaining = armedAt + plannedS! * 1000 + 1500 - Date.now();
      if (remaining > 0) await Bun.sleep(remaining);

      // THE OWNERSHIP RULE (2026-09-27 re-review, finding 1): A held this lock — its
      // timer going through the gate and finding B (live, newer) at the path is NOT a
      // fresh contention to decide by version; A already LOST, and must say so, not
      // merely "stand by" as a first-time contender would. It must NOT have sent a
      // second auth frame either (auths would be 3+: A's original + B's + A's
      // illegitimate re-auth).
      expect(auths, "A must not re-authenticate once B holds the lock").toBe(2);
      expect(errA, "a holder that lost must report LOST, not a plain standby").toMatch(/session lock LOST/);
    } finally {
      pA.kill();
      pB?.kill();
      server.stop(true);
    }
  }, 40_000);
});

describe("finding 5: lock renewal never renews a record that no longer names this process", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lock-")); seedCredentials(dir); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("once someone else's (dead) pid sits at the path, the renewal loop stops touching it and the gate reclaims it as stale — never a blind renewal-in-place", async () => {
    // A acquires normally and STAYS connected (a real, permissive WS stub, never
    // refusing anything) so its OWN reconnect schedule never independently touches the
    // lock — the only thing that can reach it during the observation window is the
    // RENEWAL timer this test is about. Then — simulating a stale-path race or a
    // takeover this test does not need to reproduce exactly — the lock file is
    // overwritten out from under A with a DEAD pid (unfixed, a blind renewal would just
    // keep refreshing `at` on someone else's record forever; the fix stops and lets the
    // gate re-decide).
    const agentAuth = createAgentAuthRoutes();
    const enrolmentKey = mintAgentToken("ek");
    agentAuth.addEnrolmentKey(enrolmentKey);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, srv) {
        const auth = await agentAuth.handle(req);
        if (auth) return auth;
        if (srv.upgrade(req)) return;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          let frame: any = {};
          try { frame = JSON.parse(String(raw)); } catch { return; }
          if (frame.type !== "auth") return;
          ws.send(JSON.stringify({ type: "authenticated", data: { agentId: "a", agentName: "A", contextId: SESSION_ID } }));
        },
      },
    });
    rmSync(join(dir, "installation.json"), { force: true });
    const p = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir, BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: `http://127.0.0.1:${server.port}`, BRIDGE_AUTOCONNECT: "1",
        BRIDGE_ENROLMENT_KEY: enrolmentKey,
        BRIDGE_SESSION_KEY: SESSION_ID, CLAUDE_CODE_SSE_PORT: "",
        BRIDGE_TEST: "1", BRIDGE_TEST_LOCK_RETRY_MS: "300",
      } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    let err = "";
    (async () => { const d = new TextDecoder(); for await (const c of p.stderr as any) err += d.decode(c, { stream: true }); })();
    try {
      const authDeadline = Date.now() + 15_000;
      while (Date.now() < authDeadline && !/authenticated as A/.test(err)) await Bun.sleep(50);
      expect(/authenticated as A/.test(err), "A must be stably connected before the plant").toBe(true);
      // A DEAD pid (a fresh, never-reused pid this OS almost certainly never assigns in
      // this test's lifetime) with the SAME sessionKey but an unmistakable marker.
      const FAKE_PID = 999_999;
      writeFileSync(lockFile(), JSON.stringify({ pid: FAKE_PID, procStart: "Wed Jan 1 00:00:00 2020", sessionKey: SESSION_ID, at: new Date().toISOString(), marker: "planted-by-test" }));
      // Two renewal cycles' worth of time.
      await Bun.sleep(300 * 3);
      const rec = JSON.parse(readFileSync(lockFile(), "utf8"));
      expect(rec.pid, "the fix: A must reclaim it via the GATE (a fresh record, ITS pid) rather than blindly renewing the planted one in place").toBe(p.pid);
      expect(rec.marker, "the planted record must be GONE, not renewed-in-place").toBeUndefined();
    } finally {
      p.kill();
      server.stop(true);
    }
  }, 30_000);
});

describe("finding 11a: a superseded window invalidates its access token and stops minting", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lock-")); seedCredentials(dir); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("after supersede, the NEXT takeover reconnect mints a FRESH token rather than reusing the still-unexpired cached one", async () => {
    rmSync(join(dir, "installation.json"), { force: true });
    let posts = 0; // every agent-auth POST (enrol + every mint) this stub sees
    let auths = 0;
    const agentAuth = createAgentAuthRoutes();
    const enrolmentKey = mintAgentToken("ek");
    agentAuth.addEnrolmentKey(enrolmentKey);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, srv) {
        const auth = await agentAuth.handle(req);
        if (auth) {
          if (req.method === "POST") posts++;
          return auth;
        }
        if (srv.upgrade(req)) return;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          let frame: any = {};
          try { frame = JSON.parse(String(raw)); } catch { return; }
          if (frame.type !== "auth") return;
          if (auths === 0) {
            ws.close(4008, "session superseded: a newer Bridge plugin took over in another window of this session");
            auths++;
            return;
          }
          auths++;
          ws.send(JSON.stringify({ type: "authenticated", data: { agentId: "a", agentName: "A", contextId: SESSION_ID } }));
        },
      },
    });
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir, BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: `http://127.0.0.1:${server.port}`, BRIDGE_AUTOCONNECT: "1",
        BRIDGE_ENROLMENT_KEY: enrolmentKey,
        BRIDGE_SESSION_KEY: SESSION_ID, CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const deadline1 = Date.now() + 15_000;
      while (Date.now() < deadline1 && auths < 1) await Bun.sleep(30);
      expect(auths, "the first auth (immediately superseded)").toBe(1);
      const postsAfterEnrolAndFirstAuth = posts;
      // Enrolment is one POST; the very first mint (before the auth frame) is another —
      // both happened by now. Takeover: this is the ONE way this window resumes (D3).
      await client.callTool({ name: "connect", arguments: { takeover: true } });
      const deadline2 = Date.now() + 15_000;
      while (Date.now() < deadline2 && auths < 2) await Bun.sleep(30);
      expect(auths, "the takeover's own auth attempt").toBe(2);
      // The fix: invalidateAccess on supersede means THIS reconnect had to mint again —
      // one more POST than before. Without it, the still-unexpired cached token would
      // have been reused for the new auth frame with no new mint at all.
      expect(posts, "a fresh mint for the takeover reconnect").toBeGreaterThan(postsAfterEnrolAndFirstAuth);
    } finally {
      await client.close().catch(() => {});
      server.stop(true);
    }
  }, 30_000);
});

// ── 2026-09-27 re-review: THE OWNERSHIP RULE ────────────────────────────────
//
// `decideLock` (version comparison) runs ONLY for a process that does NOT currently
// hold the lock and wants it (initial connect, standby retry, an explicit
// connect/takeover, a superseded/disconnected window the person reconnects). A
// process that HOLDS the lock and finds the record naming a DIFFERENT, LIVE pid has
// LOST — whoever overwrote a live record already won the decision — and must never
// re-decide by version. Three describe blocks below pin the three points a holder
// re-reads the lock and can discover this: the reconnect gate (T1), a live socket's
// renewal tick (T2), and the pre-send check right before the auth frame goes out (T3).

describe("finding 1 (2026-09-27 re-review): the reconnect gate must not re-decide by version once it already held the lock", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lock-")); seedCredentials(dir); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("A (newer, no live socket, mid backoff) must go SUPERSEDED — never re-take — once B (older) explicitly takes over", async () => {
    // A and B are two windows of the SAME session, same shared agent-auth+WS stub and
    // installation, same on-disk lock — same shape as F2 above, but with A and B's
    // roles reversed: A is the (real, unoverridden) NEWER build, so only B's EXPLICIT
    // takeover can win this lock in the first place (the auto path would stand B down).
    // That is exactly what exposes finding 1: once A's OWN reconnect gate later runs,
    // it must recognise it already held this key and LOST it — not re-run decideLock,
    // which (being newer) it would win, undoing B's explicit takeover.
    rmSync(join(dir, "installation.json"), { force: true });
    let auths = 0;
    let onFirstAuthenticated: (() => void) | null = null;
    let liveFirstSocket: any = null;
    const bAuthFrames: any[] = [];
    const agentAuth = createAgentAuthRoutes();
    const enrolmentKey = mintAgentToken("ek");
    agentAuth.addEnrolmentKey(enrolmentKey);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, srv) {
        const auth = await agentAuth.handle(req);
        if (auth) return auth;
        if (srv.upgrade(req)) return;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          let frame: any = {};
          try { frame = JSON.parse(String(raw)); } catch { return; }
          if (frame.type !== "auth") return;
          auths++;
          if (auths === 1) liveFirstSocket = ws;
          else bAuthFrames.push(frame);
          ws.send(JSON.stringify({ type: "authenticated", data: { agentId: "a", agentName: "A", contextId: SESSION_ID } }));
          if (auths === 1) onFirstAuthenticated?.();
        },
        close(ws) {
          if (liveFirstSocket === ws) liveFirstSocket = null;
        },
      },
    });

    const transportA = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      stderr: "pipe",
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir, BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: `http://127.0.0.1:${server.port}`, BRIDGE_AUTOCONNECT: "1",
        BRIDGE_ENROLMENT_KEY: enrolmentKey,
        BRIDGE_SESSION_KEY: SESSION_ID, CLAUDE_CODE_SSE_PORT: "",
        // A comfortably wide, scaled-down "transient" backoff (unscaled 1-30s): wide
        // enough that B's real startup + explicit takeover reliably finish well inside
        // it, narrow enough that the test does not need to wait long.
        BRIDGE_TEST: "1", BRIDGE_TEST_BACKOFF_SCALE: "0.15",
      } as Record<string, string>,
    });
    let errA = "";
    transportA.stderr?.on("data", (c: Buffer) => { errA += c.toString(); });
    const clientA = new Client({ name: "test-client-a", version: "0.0.0" }, { capabilities: {} });
    const noticesA: string[] = [];
    clientA.fallbackNotificationHandler = async (n: any) => {
      if (typeof n?.params?.content === "string") noticesA.push(n.params.content);
    };

    let clientB: Client | null = null;
    try {
      await clientA.connect(transportA);
      const authedOnce = new Promise<void>((r) => (onFirstAuthenticated = r));
      const authDeadline = Date.now() + 15_000;
      await Promise.race([authedOnce, (async () => { while (Date.now() < authDeadline && auths < 1) await Bun.sleep(50); })()]);
      expect(auths).toBe(1);

      // Force A's live socket closed with a CREDENTIAL-class code — a slow,
      // scaled-down backoff (unscaled 60-300s; never evicted/expired/superseded, so
      // this is a plain reconnect, not a takeover reaction). A's own reconnect must
      // stay comfortably slower than B's real process boot + explicit takeover, or the
      // race is decided by which happens to finish first rather than by the fix —
      // same schedule F2 above uses for the same reason.
      liveFirstSocket?.close(4003, "deregistered");

      const armedDeadline = Date.now() + 5000;
      let plannedS: number | null = null;
      while (Date.now() < armedDeadline && plannedS === null) {
        const m = /reconnecting in ([\d.]+)s/.exec(errA);
        if (m) plannedS = parseFloat(m[1]);
        else await Bun.sleep(20);
      }
      expect(plannedS, "A must have armed a scheduled reconnect").not.toBeNull();
      const armedAt = Date.now();

      // B: same session key, same STATE_DIR, same installation, but OLDER — only an
      // EXPLICIT takeover wins this lock (the auto path would stand B down against A).
      const transportB = new StdioClientTransport({
        command: "bun",
        args: [SERVER],
        env: {
          ...process.env,
          CLAUDE_PLUGIN_DATA: dir, BRIDGE_STATE_DIR: dir,
          BRIDGE_API_URL: `http://127.0.0.1:${server.port}`, BRIDGE_AUTOCONNECT: "0",
          BRIDGE_SESSION_KEY: SESSION_ID, CLAUDE_CODE_SSE_PORT: "",
          BRIDGE_TEST: "1", BRIDGE_TEST_PLUGIN_VERSION: "0.1.0",
        } as Record<string, string>,
      });
      clientB = new Client({ name: "test-client-b", version: "0.0.0" }, { capabilities: {} });
      await clientB.connect(transportB);
      const takeoverResult: any = await clientB.callTool({ name: "connect", arguments: { takeover: true } });
      expect(takeoverResult.content?.[0]?.text, "B's explicit takeover starts connecting").toBe("connecting");

      const bDeadline = Date.now() + 15_000;
      while (Date.now() < bDeadline && bAuthFrames.length < 1) await Bun.sleep(50);
      expect(bAuthFrames[0]?.type).toBe("auth");
      expect(bAuthFrames[0]?.supersede, "B's EXPLICIT takeover").toBe(true);

      // Wait until PAST A's actual scheduled fire time (whatever the real random draw
      // was), with a comfortable safety margin — deterministic regardless of jitter.
      const remaining = armedAt + plannedS! * 1000 + 1500 - Date.now();
      if (remaining > 0) await Bun.sleep(remaining);

      // THE BUG this pins: without the fix, A's reconnect gate runs decideLock against
      // B's (older) record — and since A's own real version is newer, decideLock
      // returns "takeover", undoing B's explicit takeover. The fix: A already held
      // this lock, so it must recognise B's live record as having ALREADY WON, never
      // re-decide by version, and never send a second auth frame.
      expect(auths, "A must NEVER re-authenticate once B holds the lock").toBe(2);
      expect(errA, "A must report LOST, not TAKEN OVER").toMatch(/session lock LOST/);
      expect(errA, "A must never re-take by version").not.toMatch(/session lock TAKEN OVER/);
      const finalLock = JSON.parse(readFileSync(lockFile(), "utf8"));
      expect(finalLock.pid, "the lock must still name B, not A").not.toBe(transportA.pid);

      // B is OLDER, so this is a plain takeover notice, not the "/reload-plugins" one.
      const noticeDeadline = Date.now() + 5000;
      while (Date.now() < noticeDeadline && !noticesA.some((c) => c.includes("/bridge:connect takeover moves it back"))) {
        await Bun.sleep(30);
      }
      expect(
        noticesA.some((c) => c.includes("/bridge:connect takeover moves it back")),
        "equal/older holder — plain takeover wording, not /reload-plugins"
      ).toBe(true);
    } finally {
      await clientA.close().catch(() => {});
      await clientB?.close().catch(() => {});
      server.stop(true);
    }
  }, 40_000);
});

describe("finding 3 (2026-09-27 re-review): a live holder's renewal must go superseded immediately, without waiting for a 4008", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lock-")); seedCredentials(dir); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("A's renewal finds another LIVE pid at the path — A closes its OWN socket and goes superseded; the stub never sends a 4008", async () => {
    let liveSocket: any = null;
    let socketClosed = false;
    const agentAuth = createAgentAuthRoutes();
    const enrolmentKey = mintAgentToken("ek");
    agentAuth.addEnrolmentKey(enrolmentKey);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, srv) {
        const auth = await agentAuth.handle(req);
        if (auth) return auth;
        if (srv.upgrade(req)) return;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          let frame: any = {};
          try { frame = JSON.parse(String(raw)); } catch { return; }
          if (frame.type !== "auth") return;
          liveSocket = ws;
          // Deliberately never sends a 4008 — the fix must notice on its OWN, via the
          // lock file, rather than wait for a server-driven close this stub never sends.
          ws.send(JSON.stringify({ type: "authenticated", data: { agentId: "a", agentName: "A", contextId: SESSION_ID } }));
        },
        close(ws) {
          if (liveSocket === ws) socketClosed = true;
        },
      },
    });
    rmSync(join(dir, "installation.json"), { force: true });
    const p = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir, BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: `http://127.0.0.1:${server.port}`, BRIDGE_AUTOCONNECT: "1",
        BRIDGE_ENROLMENT_KEY: enrolmentKey,
        BRIDGE_SESSION_KEY: SESSION_ID, CLAUDE_CODE_SSE_PORT: "",
        BRIDGE_TEST: "1", BRIDGE_TEST_LOCK_RETRY_MS: "300",
      } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    let err = "";
    (async () => { const d = new TextDecoder(); for await (const c of p.stderr as any) err += d.decode(c, { stream: true }); })();
    try {
      const authDeadline = Date.now() + 15_000;
      while (Date.now() < authDeadline && !/authenticated as A/.test(err)) await Bun.sleep(50);
      expect(/authenticated as A/.test(err), "A must be stably connected before the plant").toBe(true);

      // A LIVE holder, deliberately OLDER than A's real version — proves the invariant
      // is "another live pid at the path", never "unless we could win by version".
      writeFileSync(
        lockFile(),
        JSON.stringify({ pid: process.pid, procStart: procStart(process.pid), sessionKey: SESSION_ID, at: new Date().toISOString(), version: "0.1.0" })
      );

      // A few renewal cycles' worth of time.
      await Bun.sleep(300 * 4);

      expect(socketClosed, "A must close its OWN socket once its renewal sees a live stranger at the path — no 4008 ever arrived").toBe(true);
      expect(err, "A must never re-decide by version and take the key back").not.toMatch(/session lock TAKEN OVER/);
      expect(err, "A must report LOST").toMatch(/session lock LOST/);
      const rec = JSON.parse(readFileSync(lockFile(), "utf8"));
      expect(rec.pid, "the planted holder's record must be untouched — A never rewrites it").toBe(process.pid);
    } finally {
      p.kill();
      server.stop(true);
    }
  }, 30_000);
});

describe("finding 2 (2026-09-27 re-review): the pre-send lock re-check", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lock-")); seedCredentials(dir); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("A's mint is held by the server while B takes over the LOCAL lock meanwhile — A's auth frame must never go out, with or without supersede", async () => {
    rmSync(join(dir, "installation.json"), { force: true });
    const authFrames: any[] = [];
    // mintDelayMs delays only the per-session access-token mint (client_credentials) —
    // NOT headless enrolment, which is a different grant type — so A enrols quickly and
    // then stalls exactly where this test needs it to: minting the WS auth token.
    const agentAuth = createAgentAuthRoutes({ mintDelayMs: 1500 });
    const enrolmentKey = mintAgentToken("ek");
    agentAuth.addEnrolmentKey(enrolmentKey);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, srv) {
        const auth = await agentAuth.handle(req);
        if (auth) return auth;
        if (srv.upgrade(req)) return;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          let frame: any = {};
          try { frame = JSON.parse(String(raw)); } catch { return; }
          if (frame.type !== "auth") return;
          authFrames.push(frame);
          ws.send(JSON.stringify({ type: "authenticated", data: { agentId: "a", agentName: "A", contextId: SESSION_ID } }));
        },
      },
    });
    const p = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir, BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: `http://127.0.0.1:${server.port}`, BRIDGE_AUTOCONNECT: "1",
        BRIDGE_ENROLMENT_KEY: enrolmentKey,
        BRIDGE_SESSION_KEY: SESSION_ID, CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    let err = "";
    (async () => { const d = new TextDecoder(); for await (const c of p.stderr as any) err += d.decode(c, { stream: true }); })();
    try {
      // A passes the gate (writes its OWN lock record) and opens its socket — wait for
      // that, which is right when it is about to await the (delayed) mint.
      const openDeadline = Date.now() + 15_000;
      while (Date.now() < openDeadline && !/WebSocket connected/.test(err)) await Bun.sleep(20);
      expect(/WebSocket connected/.test(err), "A must have passed the gate and opened its socket").toBe(true);
      expect(existsSync(lockFile()), "A must hold the local lock by now").toBe(true);

      // B "takes over" the LOCAL lock file directly — standing in for a separate live
      // process winning it — while A's mint is still held by the stub.
      writeFileSync(
        lockFile(),
        JSON.stringify({ pid: process.pid, procStart: procStart(process.pid), sessionKey: SESSION_ID, at: new Date().toISOString(), version: "99.0.0" })
      );

      // Past the mint delay + margin: A's `open` handler has resumed and reached the
      // pre-send check by now.
      await Bun.sleep(1500 + 1000);

      expect(authFrames, "A's auth must NOT go out at all once it notices it lost the lock").toHaveLength(0);
      expect(err, "A must never re-decide by version and take the key back").not.toMatch(/session lock TAKEN OVER/);
      expect(err, "A must report LOST from the pre-send check").toMatch(/session lock LOST/);
      const rec = JSON.parse(readFileSync(lockFile(), "utf8"));
      expect(rec.pid, "the planted holder's record must be untouched").toBe(process.pid);
    } finally {
      p.kill();
      server.stop(true);
    }
  }, 30_000);
});

describe("finding 4 (2026-09-27 re-review): the standby retry must not carry a sticky takeover", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lock-")); seedCredentials(dir); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("an explicit takeover whose WRITE fails (no permission) must not auto-take-over a genuinely NEWER holder on its own later retry", async () => {
    // An OLDER live holder — decideLock always honours an explicit takeover regardless
    // of version, so it is the WRITE that has to fail for this attempt to land in
    // "standby" WITH takeover:true still attached to it (the confirm-ownership re-read
    // right after the write is the one path an explicit takeover can still end in
    // "standby": the write itself did not land).
    writeLock({ pid: process.pid, procStart: procStart(process.pid), sessionKey: SESSION_ID, at: new Date().toISOString(), version: "0.1.0" });
    const locksDir = join(dir, "locks");
    chmodSync(locksDir, 0o500); // read + traverse only — the takeover's tmp-file create fails
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir, BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: CLOSED_PORT_API_URL,
        BRIDGE_SESSION_KEY: SESSION_ID, CLAUDE_CODE_SSE_PORT: "",
        BRIDGE_TEST: "1", BRIDGE_TEST_LOCK_RETRY_MS: "300",
      } as Record<string, string>,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const result: any = await client.callTool({ name: "connect", arguments: { takeover: true } });
      expect(result.content?.[0]?.text).toBe("connecting");

      // The takeover's write failed (permission denied) — the lock must still name the
      // OLDER holder; this process stands by, it did not connect.
      const afterFailedWrite = JSON.parse(readFileSync(lockFile(), "utf8"));
      expect(afterFailedWrite.pid, "the failed write must not have claimed the lock").toBe(process.pid);
      expect(afterFailedWrite.version, "still the older holder's own record").toBe("0.1.0");

      // Restore permissions, then plant a GENUINELY NEWER live holder — standing in for
      // whoever legitimately holds the key by the time the retry fires.
      chmodSync(locksDir, 0o700);
      writeLock({ pid: process.pid, procStart: procStart(process.pid), sessionKey: SESSION_ID, at: new Date().toISOString(), version: "99.0.0" });

      // Past several 300ms retry cycles.
      await Bun.sleep(300 * 4);

      // THE BUG this pins: a retry that still carried `takeover: true` would win this
      // unconditionally (decideLock always honours an explicit takeover) even against a
      // genuinely newer holder — exactly the auto-downgrade D3's first rule forbids.
      const finalRec = JSON.parse(readFileSync(lockFile(), "utf8"));
      expect(finalRec.pid, "the retry must NOT have taken over a newer holder").toBe(process.pid);
      expect(finalRec.version, "the newer holder's record must be untouched").toBe("99.0.0");
    } finally {
      chmodSync(locksDir, 0o700);
      await client.close().catch(() => {});
    }
  }, 20_000);
});

describe("finding 7 (2026-09-27 re-review): an explicit takeover against a still-ineffective claim must reopen the socket", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lock-")); seedCredentials(dir); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("connect {takeover:true} while connected but supersede_ineffective must send a NEW auth frame, not report \"connected\" and do nothing", async () => {
    // The server ALWAYS renames this session to a connection id, whatever the auth
    // frame carries — so the plugin's very first (uncontested, but still
    // supersede-carrying — see connectWs's own doc comment) connect already ends up
    // `wsConnected && authenticated` with `supersede_ineffective: true`.
    rmSync(join(dir, "installation.json"), { force: true });
    const authFrames: any[] = [];
    const agentAuth = createAgentAuthRoutes();
    const enrolmentKey = mintAgentToken("ek");
    agentAuth.addEnrolmentKey(enrolmentKey);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, srv) {
        const auth = await agentAuth.handle(req);
        if (auth) return auth;
        if (srv.upgrade(req)) return;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          let frame: any = {};
          try { frame = JSON.parse(String(raw)); } catch { return; }
          if (frame.type !== "auth") return;
          authFrames.push(frame);
          // Deliberately NEVER SESSION_ID — every attempt is renamed to a connection id.
          ws.send(JSON.stringify({ type: "authenticated", data: { agentId: "a", agentName: "A", contextId: "some-connection-id" } }));
        },
      },
    });
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir, BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: `http://127.0.0.1:${server.port}`, BRIDGE_AUTOCONNECT: "1",
        BRIDGE_ENROLMENT_KEY: enrolmentKey,
        BRIDGE_SESSION_KEY: SESSION_ID, CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const deadline1 = Date.now() + 15_000;
      while (Date.now() < deadline1 && authFrames.length < 1) await Bun.sleep(30);
      expect(authFrames, "the first (uncontested) connect").toHaveLength(1);
      const statusResult: any = await client.callTool({ name: "status", arguments: {} });
      const status1 = JSON.parse(statusResult.content[0].text);
      expect(status1.websocket).toBe("connected");
      expect(status1.supersede_ineffective, "renamed away from SESSION_KEY on every attempt").toBe(true);

      // THE BUG this pins: without the fix, this call sees `wsConnected && authenticated`
      // already true and returns "connected" as a no-op — no new auth frame is EVER
      // sent again, so a person's takeover can never actually retry the claim.
      const result: any = await client.callTool({ name: "connect", arguments: { takeover: true } });
      expect(result.content?.[0]?.text, "must reopen the socket, not report the stale 'connected'").toBe("connecting");

      const deadline2 = Date.now() + 15_000;
      while (Date.now() < deadline2 && authFrames.length < 2) await Bun.sleep(30);
      expect(authFrames, "a genuinely NEW auth frame must have gone out").toHaveLength(2);
      expect(authFrames[1]?.supersede, "still holds the local lock, so still claims it").toBe(true);
    } finally {
      await client.close().catch(() => {});
      server.stop(true);
    }
  }, 30_000);
});

