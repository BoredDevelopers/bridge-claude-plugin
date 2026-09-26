/**
 * The credential manager (auth/manager.ts, RFC-016 §5) against the strict stub
 * (agent-auth-stub.ts: E6 chain with no grace, lock on any stale state). Several
 * managers on one profile directory stand in for several plugin processes on one
 * machine; a manager on a COPY of the directory stands in for a thief.
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync, cpSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnRacers } from "./fixtures/go-signal";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAuthStub, type StubOptions } from "./agent-auth-stub";
import { enrolledProfile } from "./key-fixtures";
import { parseJws, sha256b64u } from "./dpop-verify";
import { CredentialManager, CredentialError, LOCK_HOLD_BUDGET_MS, type ManagerDeps } from "../auth/manager";
import { resolveProfile } from "../auth/profile";
import { withInstallationLock, STALE_MS, LOCK_DIR_NAME } from "../auth/node/lock";
import * as realStore from "../auth/node/store";
import { readInstallation, readState, readAttempt, readKey } from "../auth/node/store";
import { joinStateSeq } from "../auth/core/join-state";

// A pass-through of the real store whose `writeStateIfNotOlder` / `writeInstallation` can be made
// to throw (a full disk, EACCES) — the only way to see the §3.3 "write state, THEN delete
// the attempt" order (a crash between the two is what it protects against), and what an
// enrolment does when its files cannot be written.
const real = { ...realStore };
let failStateWrites = 0;
let failInstallationWrites = 0;
mock.module("../auth/node/store", () => ({
  ...real,
  writeStateIfNotOlder: (dir: string, state: string) => {
    if (failStateWrites > 0) {
      failStateWrites--;
      throw new Error("ENOSPC: no space left on device (injected)");
    }
    return real.writeStateIfNotOlder(dir, state);
  },
  // The LAST write of an enrolment (key.json + state are already on disk when it fails).
  writeInstallation: (dir: string, inst: any) => {
    if (failInstallationWrites > 0) {
      failInstallationWrites--;
      throw new Error("ENOSPC: no space left on device (injected)");
    }
    return real.writeInstallation(dir, inst);
  },
}));

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(stubOpts: Parameters<typeof startAuthStub>[0] = {}) {
  const stub = startAuthStub(stubOpts);
  const dir = mkdtempSync(join(tmpdir(), "auth-mgr-"));
  cleanups.push(() => stub.stop(), () => rmSync(dir, { recursive: true, force: true }));
  return { stub, dir };
}

function manager(
  dir: string,
  apiUrl: string,
  { key, profile, ...over }: Omit<Partial<ManagerDeps>, "profile"> & { key?: string; profile?: string } = {}
) {
  const events = {
    rotated: [] as { token: string; dpop: string }[],
    notices: [] as string[],
    loggedIn: 0,
    loggedOut: 0,
  };
  const m = new CredentialManager({
    profile: resolveProfile(dir, profile),
    envApiUrl: apiUrl,
    staleStaticTokenPresent: false,
    enrolmentKey: "",
    sessionKey: () => key ?? "session-a",
    sessionKeyReady: () => Promise.resolve(),
    platform: "test-os",
    clientVersion: "9.9.9",
    env: { BRIDGE_BROWSER: "none" },
    onAccessRotated: (f) => events.rotated.push(f),
    onLoggedIn: () => events.loggedIn++,
    onLoggedOut: () => events.loggedOut++,
    notify: (t) => events.notices.push(t),
    log: () => {},
    prompt: { available: () => false, show: () => {}, confirm: async () => false },
    ...over,
  });
  cleanups.push(() => m.stop());
  return { m, events };
}

const seq = (dir: string) => joinStateSeq(readState(dir)!);

/** Poll a condition instead of guessing a delay; false if it never came true. */
async function until(pred: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await Bun.sleep(20);
  }
  return pred();
}

describe("mint (§3.3, §5.2)", () => {
  test("everything a lock holder sends shares ONE deadline, inside the 120 s stale break with ≥ 20 s to spare (§5.2)", () => {
    expect(LOCK_HOLD_BUDGET_MS).toBeLessThanOrEqual(STALE_MS - 20_000);
  });

  test("first use mints: state advanced on disk, attempt gone, 0600, metadata + session_key sent, token cached", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    const at = await m.accessToken();
    expect(at).toStartWith("brg_at_");
    expect(seq(dir)).toBe(1);
    expect(readAttempt(dir)).toBeNull();
    for (const f of ["key.json", "state", "installation.json"]) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    expect(stub.stats.mintBodies[0]).toMatchObject({ grant_type: "client_credentials", session_key: "session-a", platform: "test-os", client_version: "9.9.9" });
    expect(stub.stats.mintBodies[0]!.reconnect).toBeUndefined();
    expect(await m.accessToken()).toBe(at);
    expect(stub.stats.mints).toBe(1);
  });

  test("drain waits for a mint in flight to persist its new state (shutdown)", async () => {
    const { stub, dir } = setup({ mintDelayMs: 300 });
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    void m.accessToken();
    // Really in flight: the attempt is written before the POST leaves.
    expect(await until(() => readAttempt(dir) !== null)).toBe(true);
    expect(seq(dir)).toBe(0);
    await m.drain(5_000);
    expect(seq(dir)).toBe(1);
  });

  test("after invalidation the SAME session mints again (no new session)", async () => {
    const { stub, dir } = setup();
    const inst = await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    const a = await m.accessToken();
    m.invalidateAccess();
    expect(await m.accessToken()).not.toBe(a);
    expect(stub.sessionsFor(inst)).toHaveLength(1);
    expect(stub.stats).toMatchObject({ mints: 2, locks: 0 });
  });

  test("concurrent callers in one process share one mint", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    const all = await Promise.all([m.accessToken(), m.accessToken(), m.accessToken()]);
    expect(new Set(all).size).toBe(1);
    expect(stub.stats.mints).toBe(1);
  });

  test("many sessions on one machine mint at once: every one succeeds, zero locks", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const ms = Array.from({ length: 6 }, (_, i) => manager(dir, stub.url, { key: `s${i}` }).m);
    const tokens = await Promise.all(ms.map((m) => m.accessToken()));
    expect(new Set(tokens).size).toBe(6);
    expect(stub.stats).toMatchObject({ mints: 6, locks: 0 });
    expect(seq(dir)).toBe(6);
  });

  test("SEVERAL PROCESSES (separate sessions) mint on one profile at once, repeatedly: zero locks, every token proven on the API", async () => {
    // The field bug this guards: several Claude sessions on one machine locking their own
    // installation. Real processes, released together; each mints 3 times (forgetting the
    // token in between), so 12 mints interleave on one chain through the lock.
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const racer = fileURLToPath(new URL("./fixtures/mint-racer.ts", import.meta.url));
    const ps = await spawnRacers(4, ["bun", racer, dir, stub.url, "3"]);
    const outs = (await Promise.all(ps.map((p) => new Response(p.stdout).text()))).map(
      (t) => JSON.parse(t) as { tokens: string[]; statuses: number[]; errors: string[] }
    );
    expect(outs.flatMap((o) => o.errors)).toEqual([]);
    expect(outs.flatMap((o) => o.statuses)).toEqual(Array(12).fill(200));
    expect(new Set(outs.flatMap((o) => o.tokens)).size).toBe(12);
    expect(stub.stats).toMatchObject({ mints: 12, replays: 0, locks: 0 });
    expect(stub.stats.refusals).toEqual([]);
    expect(seq(dir)).toBe(12);
    expect(readAttempt(dir)).toBeNull();
    expect(existsSync(join(dir, LOCK_DIR_NAME))).toBe(false);
  }, 60_000);

  test("two processes of the SAME session read the state from disk, never memory: zero locks", async () => {
    const { stub, dir } = setup();
    const inst = await enrolledProfile(stub, dir);
    const p1 = manager(dir, stub.url).m;
    const p2 = manager(dir, stub.url).m;
    await p1.accessToken();
    for (let i = 0; i < 4; i++) {
      p1.invalidateAccess();
      p2.invalidateAccess();
      await Promise.all([p1.accessToken(), p2.accessToken()]);
    }
    expect(stub.stats.locks).toBe(0);
    expect(stub.sessionsFor(inst)).toHaveLength(1);
  });

  test("a LOST mint response keeps the attempt; the retry replays to the same successor (E6b), no lock", async () => {
    const { stub, dir } = setup({ loseMintResponses: 1 });
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    const e = await m.accessToken().catch((x) => x);
    expect(e).toBeInstanceOf(CredentialError);
    expect(e.kind).toBe("network");
    expect(seq(dir)).toBe(0);
    expect(readAttempt(dir)).not.toBeNull();
    expect(await m.accessToken()).toStartWith("brg_at_");
    expect(stub.stats).toMatchObject({ replays: 1, locks: 0 });
    expect(seq(dir)).toBe(1);
    expect(readAttempt(dir)).toBeNull();
  });

  test("§3.3 order: the new state is written BEFORE the attempt goes — a failed state write keeps the attempt, and the next mint REPLAYS (no lock)", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    failStateWrites = 1;
    const e = await m.accessToken().catch((x) => x);
    expect(e).toBeInstanceOf(CredentialError);
    expect(failStateWrites).toBe(0); // the injected failure really fired
    expect(seq(dir)).toBe(0); // the server advanced; this machine did not record it
    expect(readAttempt(dir)).not.toBeNull();
    expect(await m.accessToken()).toStartWith("brg_at_");
    expect(stub.stats).toMatchObject({ mints: 2, replays: 1, locks: 0 });
    expect(seq(dir)).toBe(1);
    expect(readAttempt(dir)).toBeNull();
  });

  test("lost response, THEN session revoked, THEN /bridge:connect: the attempt survived the refusal, so no false lock", async () => {
    const { stub, dir } = setup({ loseMintResponses: 1 });
    const inst = await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    await m.accessToken().catch(() => {});
    stub.revokeSession(stub.sessionsFor(inst)[0]!.id);
    const e = await m.accessToken().catch((x) => x);
    expect(e.kind).toBe("session_revoked");
    m.requestSessionReconnect();
    expect(await m.accessToken()).toStartWith("brg_at_");
    expect(stub.stats.locks).toBe(0);
    expect(stub.stats.mintBodies.at(-1)!.reconnect).toBe("true");
  });

  test("429: the attempt is kept, no mint before Retry-After, then the same attempt converges", async () => {
    const { stub, dir } = setup({ rateLimitMints: 1 });
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    const e = await m.accessToken().catch((x) => x);
    expect(e.message).toMatch(/rate-limited/);
    const attempt = readAttempt(dir);
    expect(attempt).not.toBeNull();
    expect((await m.accessToken().catch((x) => x)).message).toMatch(/retrying in/);
    expect(stub.stats.mintBodies).toHaveLength(1); // the gate, not the server, refused the second
    await Bun.sleep(1_100);
    expect(await m.accessToken()).toStartWith("brg_at_");
    expect(stub.stats.mintBodies.at(-1)!.attempt).toBe(attempt!);
  });

  test("a network failure keeps every file and is retryable", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    await m.accessToken();
    stub.stop();
    m.invalidateAccess();
    const e = await m.accessToken().catch((x) => x);
    expect(e).toBeInstanceOf(CredentialError);
    expect(e.kind).toBe("network");
    expect(readInstallation(dir)).not.toBeNull();
    expect(readKey(dir)).not.toBeNull();
    expect(readState(dir)).not.toBeNull();
  });

  test("a discovery 5xx (deploy in progress) is retryable, not a sign-out", async () => {
    const { stub, dir } = setup({ discoveryFail: 1 });
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    const e = await m.accessToken().catch((x) => x);
    expect(e.kind).toBe("network");
    expect(await m.accessToken()).toStartWith("brg_at_");
  });

  test("a server 10 minutes ahead: minting still works (offset learnt from Date)", async () => {
    const { stub, dir } = setup({ clockSkewS: 600 });
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    expect(await m.accessToken()).toStartWith("brg_at_");
    // …and the resource proof uses the same offset.
    const { headers } = await m.httpAuth("GET", "/api/channels");
    expect((await fetch(`${stub.url}/api/channels`, { headers })).status).toBe(200);
  });

  test("a 401-triggered re-mint hands the fresh token (+ a WS proof) to the live socket", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m, events } = manager(dir, stub.url);
    const old = await m.accessToken();
    m.invalidateAccess(old); // what apiFetch does on a 401
    const fresh = await m.accessToken();
    expect(events.rotated).toHaveLength(1);
    expect(events.rotated[0]!.token).toBe(fresh);
    expect(parseJws(events.rotated[0]!.dpop)!.claims).toMatchObject({ htm: "GET", htu: `${stub.url}/ws`, ath: sha256b64u(fresh) });
    // One-shot: a later mint after the token went away WITHOUT a 401 (a 4008 session
    // revoke closes the socket; /bridge:connect reconnects) hands the socket nothing.
    m.sessionRevoked(m.grant()!.sessionId);
    m.requestSessionReconnect();
    await m.accessToken();
    expect(events.rotated).toHaveLength(1);
  });

  test("logout and a new login forget the old installation's 429 gate and resource nonce", async () => {
    const { stub, dir } = setup({ rateLimitMints: 1 });
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    expect((await m.accessToken().catch((x) => x)).message).toMatch(/rate-limited/); // gate armed (1 s)
    m.noteResourceNonce("rn-old");
    await m.logout(true);
    await enrolledProfile(stub, dir);
    expect(await m.accessToken()).toStartWith("brg_at_"); // no "retrying in 1s"
    expect(parseJws((await m.httpAuth("GET", "/api/x")).headers.DPoP)!.claims.nonce).toBeUndefined();

    // The same through a login (no logout in between).
    const s2 = setup({ rateLimitMints: 1 });
    await enrolledProfile(s2.stub, s2.dir);
    const b = manager(s2.dir, s2.stub.url).m;
    await b.accessToken().catch(() => {});
    b.noteResourceNonce("rn-old");
    const url = (await b.login("browser")).match(/https?:\/\/\S+/)![0];
    await fetch((await fetch(url, { redirect: "manual" })).headers.get("location")!, { redirect: "manual" });
    expect(await b.accessToken()).toStartWith("brg_at_");
    expect(parseJws((await b.httpAuth("GET", "/api/x")).headers.DPoP)!.claims.nonce).toBeUndefined();
  });

  test("invalidating with a token that is no longer current keeps the current one", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    const old = await m.accessToken();
    m.invalidateAccess(old);
    const fresh = await m.accessToken();
    m.invalidateAccess(old); // a late 401 for a request sent with the old token
    expect(await m.accessToken()).toBe(fresh);
    expect(stub.stats.mints).toBe(2);
  });

  test("the ticker mints ahead of expiry and hands the live socket {token, dpop} for GET <origin>/ws", async () => {
    const { stub, dir } = setup({ accessTtlS: 6 });
    await enrolledProfile(stub, dir);
    const { m, events } = manager(dir, stub.url, { tickMs: 50, random: () => 0 });
    const first = await m.accessToken();
    expect(await until(() => events.rotated.length >= 1, 10_000)).toBe(true);
    const f = events.rotated[0]!;
    expect(f.token).not.toBe(first);
    const p = parseJws(f.dpop)!;
    expect(p.claims).toMatchObject({ htm: "GET", htu: `${stub.url}/ws`, ath: sha256b64u(f.token) });
  }, 15_000);

  test("HTTP proofs: DPoP scheme, htm + htu of the request, ath; a resource nonce rides the next proof", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    const { token, headers } = await m.httpAuth("POST", "/api/messages?x=1");
    expect(headers.Authorization).toBe(`DPoP ${token}`);
    expect(parseJws(headers.DPoP)!.claims).toMatchObject({ htm: "POST", htu: `${stub.url}/api/messages`, ath: sha256b64u(token) });
    m.noteResourceNonce("rn-1");
    expect(parseJws((await m.httpAuth("GET", "/api/x")).headers.DPoP)!.claims.nonce).toBe("rn-1");
  });
});

describe("stop-class refusals and the ticker", () => {
  test("a stop-class refusal (session_limit) on a SCHEDULED mint stops the ticker: no further mints until /bridge:connect", async () => {
    const opts: StubOptions = { accessTtlS: 6 };
    const { stub, dir } = setup(opts);
    const inst = await enrolledProfile(stub, dir);
    const logs: string[] = [];
    const { m } = manager(dir, stub.url, { tickMs: 50, random: () => 0, log: (t) => logs.push(t) });
    await m.accessToken();
    // The session is evicted and the cap is full: the ticker's next mint is refused session_limit.
    for (const s of stub.sessionsFor(inst)) s.revoked = "evicted";
    opts.sessionCap = 0;
    expect(await until(() => stub.stats.mintBodies.length >= 2)).toBe(true);
    expect(m.stopReason()?.kind).toBe("session_limit");
    const after = stub.stats.mintBodies.length;
    const logged = logs.length;
    await Bun.sleep(1_000); // 20 ticks, each of which would have minted
    expect(stub.stats.mintBodies.length).toBe(after);
    expect(logs.slice(logged)).toEqual([]); // the ticker does not even try (no log line per tick)
    // On demand too: fail fast, nothing sent.
    expect((await m.accessToken().catch((x) => x)).kind).toBe("session_limit");
    expect(stub.stats.mintBodies.length).toBe(after);
    // /bridge:connect is the person acting: it clears the stop.
    opts.sessionCap = 64;
    m.requestSessionReconnect();
    expect(m.stopReason()).toBeNull();
    expect(await m.accessToken()).toStartWith("brg_at_");
  }, 20_000);

  test("a stop is per INSTALLATION: a /bridge:login in ANOTHER session lets this one mint again, without /bridge:connect", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    // A damaged state file (its CRC is wrong): every session is refused corrupt_state.
    const st = readState(dir)!;
    writeFileSync(join(dir, "state"), st.slice(0, 20) + (st[20] === "A" ? "B" : "A") + st.slice(21) + "\n");
    const a = manager(dir, stub.url, { key: "a" }).m;
    const b = manager(dir, stub.url, { key: "b" }).m;
    for (const m of [a, b]) expect((await m.accessToken().catch((x) => x)).message).toMatch(/corrupt_state/);
    expect(b.stopReason()?.kind).toBe("refused");
    const url = (await a.login("browser")).match(/https?:\/\/\S+/)![0]; // session A re-enrols
    await fetch((await fetch(url, { redirect: "manual" })).headers.get("location")!, { redirect: "manual" });
    expect(await b.accessToken()).toStartWith("brg_at_"); // B follows the new installation
    expect(b.stopReason()).toBeNull();
  });

  test("a LATE tick (the laptop woke past the refresh point) mints ONCE, not once per tick while its random delay runs", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    let skew = 0;
    const { m } = manager(dir, stub.url, { tickMs: 50, random: () => 0.02, now: () => Date.now() + skew });
    await m.accessToken();
    skew = 2 * 3_600_000; // woke 2 h later: a 600 ms random delay (0.02 × 30 s) holds ~12 ticks
    expect(await until(() => stub.stats.mints >= 2, 5_000)).toBe(true);
    await Bun.sleep(1_500);
    expect(stub.stats.mints).toBe(2);
  }, 15_000);
});

describe("terminal answers (§3.3 table, §5.4)", () => {
  test("a COPIED credential: the thief mints first, the machine's next mint is LOCKED — key + state deleted, the person told", async () => {
    const { stub, dir } = setup();
    const inst = await enrolledProfile(stub, dir);
    const legit = manager(dir, stub.url).m;
    await legit.accessToken();
    const loot = mkdtempSync(join(tmpdir(), "thief-"));
    cleanups.push(() => rmSync(loot, { recursive: true, force: true }));
    cpSync(dir, loot, { recursive: true });
    const thief = manager(loot, stub.url, { key: "thief" }).m;
    expect(await thief.accessToken()).toStartWith("brg_at_");
    legit.invalidateAccess();
    const e = await legit.accessToken().catch((x) => x);
    expect(e.kind).toBe("logged_out");
    expect(e.message).toMatch(/credential copy detected/);
    expect(e.message).toMatch(/LOCKED/);
    expect(e.message).toMatch(/\/bridge:login/);
    expect(stub.isRevoked(inst)).toBe("installation_locked");
    expect(existsSync(join(dir, "key.json"))).toBe(false);
    expect(existsSync(join(dir, "state"))).toBe(false);
    expect(readInstallation(dir)).toBeNull();
    // The thief is dead too.
    thief.invalidateAccess();
    expect((await thief.accessToken().catch((x) => x)).message).toMatch(/LOCKED/);
  });

  test("a revoked installation deletes the profile's files and says to log in", async () => {
    const { stub, dir } = setup();
    const inst = await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    stub.revokeInstallation(inst);
    await expect(m.accessToken()).rejects.toThrow(/installation revoked.*run \/bridge:login/);
    expect(readInstallation(dir)).toBeNull();
    expect(readKey(dir)).toBeNull();
  });

  test("C12: agent_deactivated on a mint is terminal — key + state deleted, reactivation means re-enrol", async () => {
    const { stub, dir } = setup();
    const inst = await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    stub.deactivateAgent(inst);
    const e = await m.accessToken().catch((x) => x);
    expect(e.kind).toBe("logged_out");
    expect(e.message).toMatch(/deactivated.*\/bridge:login/);
    expect(readKey(dir)).toBeNull();
    expect(readState(dir)).toBeNull();
  });

  test("C13: assertion_invalid that survives the clock-corrected retry stops and KEEPS the files", async () => {
    const { stub, dir } = setup({ rejectAssertions: true });
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    const e = await m.accessToken().catch((x) => x);
    expect(e.kind).toBe("refused");
    expect(e.message).toMatch(/system clock/);
    expect(stub.stats.refusals.filter((r) => r.endsWith("assertion_forced"))).toHaveLength(2); // once + one retry
    expect(readInstallation(dir)).not.toBeNull();
    expect(readKey(dir)).not.toBeNull();
    expect(readState(dir)).not.toBeNull();
  });

  test("key or state missing on disk: refused, nothing sent", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    writeFileSync(join(dir, "state"), "not a join state\n");
    const { m } = manager(dir, stub.url);
    const e = await m.accessToken().catch((x) => x);
    expect(e.kind).toBe("refused");
    expect(e.message).toMatch(/incomplete/);
    expect(stub.stats.mintBodies).toHaveLength(0);
  });

  test("a key.json that is not installation.json's key: refused before anything is sent (it could only ever fail the proof)", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const other = mkdtempSync(join(tmpdir(), "other-key-"));
    cleanups.push(() => rmSync(other, { recursive: true, force: true }));
    await enrolledProfile(stub, other);
    cpSync(join(other, "key.json"), join(dir, "key.json"));
    const { m } = manager(dir, stub.url);
    const e = await m.accessToken().catch((x) => x);
    expect(e.kind).toBe("refused");
    expect(e.message).toMatch(/does not match/);
    expect(stub.stats.mintBodies).toHaveLength(0);
    expect(readAttempt(dir)).toBeNull();
  });

  test("a pre-RFC-016 server: refused with 'must be upgraded', nothing sent, files kept", async () => {
    const { stub, dir } = setup({ legacyServer: true });
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    const e = await m.accessToken().catch((x) => x);
    expect(e.kind).toBe("refused");
    expect(e.message).toMatch(/must be upgraded/);
    expect(stub.stats.mintBodies).toHaveLength(0);
    expect(readInstallation(dir)).not.toBeNull();
  });

  test("session_limit stops this session with a clear reason (and does not wait for files)", async () => {
    const { stub, dir } = setup({ sessionCap: 0 });
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    const e = await m.accessToken().catch((x) => x);
    expect(e.kind).toBe("session_limit");
    expect(e.message).toMatch(/too many live sessions/);
    expect(stub.stats.locks).toBe(0);
    expect(readInstallation(dir)).not.toBeNull();
  });

  test("at the session cap a socketless session is evicted, not refused (E9)", async () => {
    const { stub, dir } = setup({ sessionCap: 1 });
    await enrolledProfile(stub, dir);
    await manager(dir, stub.url, { key: "a" }).m.accessToken();
    expect(await manager(dir, stub.url, { key: "b" }).m.accessToken()).toStartWith("brg_at_");
  });
});

describe("profiles and configuration", () => {
  test("a named profile without credentials is an error", async () => {
    const { stub, dir } = setup();
    const { m } = manager(dir, stub.url, { profile: "reviewer" });
    expect(m.source()).toBe("none");
    await expect(m.accessToken()).rejects.toThrow(/profile "reviewer" is not signed in/);
  });

  test("BRIDGE_TOKEN alone is not a credential: source is none, and the hint says so", async () => {
    const { stub, dir } = setup();
    const { m } = manager(dir, stub.url, { staleStaticTokenPresent: true });
    expect(m.source()).toBe("none");
    await expect(m.accessToken()).rejects.toThrow(/BRIDGE_TOKEN is no longer supported — run \/bridge:login/);
    await enrolledProfile(stub, dir);
    expect(m.source()).toBe("installation");
    expect(await m.accessToken()).toStartWith("brg_at_");
    expect(m.status().hint).toBeUndefined();
  });

  test("opening the profile sweeps what a crash left: old key temps and old lock tombstones — never a fresh one", () => {
    const dir = mkdtempSync(join(tmpdir(), "open-sweep-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const age = (p: string, ms: number) => {
      const t = new Date(Date.now() - ms);
      utimesSync(p, t, t);
    };
    const oldTmp = join(dir, "key.json.4242.1758000000000.AbCd.tmp");
    const freshTmp = join(dir, "state.4242.1758000000001.XyZw.tmp");
    writeFileSync(oldTmp, '{"d":"secret"}');
    writeFileSync(freshTmp, "brg_js_…");
    age(oldTmp, 10 * 60_000);
    const oldTomb = join(dir, `${LOCK_DIR_NAME}.released-${crypto.randomUUID()}`);
    const freshTomb = join(dir, `${LOCK_DIR_NAME}.released-${crypto.randomUUID()}`);
    mkdirSync(oldTomb);
    mkdirSync(freshTomb);
    age(oldTomb, STALE_MS + 5_000);
    manager(dir, "http://127.0.0.1:1");
    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(freshTmp)).toBe(true);
    expect(existsSync(oldTomb)).toBe(false);
    expect(existsSync(freshTomb)).toBe(true);
  });

  test("a BRIDGE_API_URL with a path is refused up front, with a clear message, and nothing is sent", async () => {
    const { stub, dir } = setup();
    const { m } = manager(dir, `${stub.url}/bridge`);
    expect(m.configError()).toMatch(/BRIDGE_API_URL .*must be an origin/);
    await expect(m.accessToken()).rejects.toThrow(/must be an origin/);
    expect(await m.login("browser")).toMatch(/must be an origin/);
    expect(stub.stats.discoveryHits).toBe(0);
  });

  test("an invalid profile name is refused", () => {
    expect(resolveProfile("/x", "Bad Name")).toHaveProperty("error");
    expect(resolveProfile("/x", "reviewer")).toEqual({ name: "reviewer", dir: "/x/profiles/reviewer" });
    expect(resolveProfile("/x", "")).toEqual({ name: null, dir: "/x" });
  });

  test("a profile never signs for a different API", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, "https://elsewhere.example");
    await expect(m.accessToken()).rejects.toThrow(/signed in to .* but BRIDGE_API_URL is https:\/\/elsewhere/);
    expect(stub.stats.mintBodies).toHaveLength(0);
  });

  test("status shows the key's storage and thumbprint, never the key", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    const s = m.status();
    expect(s).toMatchObject({ credential: "installation", key_storage: "software" });
    expect(s.key_thumbprint).toBe(readInstallation(dir)!.jkt);
    expect(JSON.stringify(s)).not.toContain(readKey(dir)!.d);
  });
});

describe("revocation", () => {
  test("4008 session revoked: no mint until /bridge:connect, which sends reconnect=true (E9)", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    await m.accessToken();
    m.sessionRevoked(m.grant()!.sessionId);
    const e = await m.accessToken().catch((x) => x);
    expect(e.kind).toBe("session_revoked");
    expect(stub.stats.mintBodies).toHaveLength(1); // blocked locally, nothing sent
    m.requestSessionReconnect();
    await m.accessToken();
    expect(stub.stats.mintBodies[1]!.reconnect).toBe("true");
    // The flag is one-shot.
    m.invalidateAccess();
    await m.accessToken();
    expect(stub.stats.mintBodies[2]!.reconnect).toBeUndefined();
  });

  test("a restarted process of a revoked session learns it from the server, and connect recovers", async () => {
    const { stub, dir } = setup();
    const inst = await enrolledProfile(stub, dir);
    await manager(dir, stub.url).m.accessToken();
    stub.revokeSession(stub.sessionsFor(inst)[0]!.id);
    const { m } = manager(dir, stub.url); // a new process: nothing in memory
    expect((await m.accessToken().catch((x) => x)).kind).toBe("session_revoked");
    m.requestSessionReconnect();
    expect(await m.accessToken()).toStartWith("brg_at_");
    expect(stub.stats.locks).toBe(0);
  });

  test("a revoke for an OLDER session never blocks the current one", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    const at = await m.accessToken();
    m.sessionRevoked(crypto.randomUUID()); // a late 4008 for a session this process no longer uses
    expect(await m.accessToken()).toBe(at); // the current token was kept
    m.invalidateAccess();
    expect(await m.accessToken()).toStartWith("brg_at_"); // …and minting was not blocked
    expect(stub.stats.mintBodies[1]!.reconnect).toBeUndefined();
    expect(m.status().session).toBeUndefined();
    // Unknown (null) and the CURRENT session still block.
    m.sessionRevoked(m.grant()!.sessionId);
    expect((await m.accessToken().catch((x) => x)).kind).toBe("session_revoked");
  });

  test("requestSessionReconnect without a revoke sends nothing special", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    m.requestSessionReconnect();
    await m.accessToken();
    expect(stub.stats.mintBodies[0]!.reconnect).toBeUndefined();
  });

  test("4008 installation revoked/locked: signed out if it is still ours, switched if the profile holds a new one", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const a = manager(dir, stub.url, { key: "a" }).m;
    await a.accessToken();
    const first = a.grant()!.installationId;
    await enrolledProfile(stub, dir); // re-login elsewhere replaced the installation on disk
    expect(await a.installationRevoked(first)).toBe("switched");
    expect(await a.installationRevoked(null)).toBe("switched");
    expect(readInstallation(dir)).not.toBeNull();
    await a.accessToken();
    expect(await a.installationRevoked(a.grant()!.installationId)).toBe("logged_out");
    expect(readInstallation(dir)).toBeNull();
    expect(readKey(dir)).toBeNull();
  });
});

describe("login", () => {
  async function drive(url: string) {
    // The person's browser: authorize → 302 to the loopback callback → 302 to done.
    const toCallback = await fetch(url, { redirect: "manual" });
    const cb = toCallback.headers.get("location")!;
    return fetch(cb, { redirect: "manual" });
  }

  test("loopback: fresh key bound by dpop_jkt, PKCE, done=connected; the old installation revoked with ITS state, not advanced", async () => {
    const { stub, dir } = setup();
    const old = await enrolledProfile(stub, dir);
    const oldJkt = readInstallation(dir)!.jkt;
    const oldSeq = stub.installation(old)!.seq;
    const { m, events } = manager(dir, stub.url);
    const text = await m.login("browser");
    const url = text.match(/https?:\/\/\S+/)![0];
    const jkt = new URL(url).searchParams.get("dpop_jkt");
    expect(jkt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const done = await drive(url);
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${stub.url}/connect/done?result=connected`);
    const inst = readInstallation(dir)!; // the browser is answered only after completeLogin
    expect(inst.installationId).not.toBe(old);
    expect(inst.jkt).toBe(jkt!);
    expect(inst.jkt).not.toBe(oldJkt); // E1: never reused
    expect(seq(dir)).toBe(0);
    expect(events.loggedIn).toBe(1);
    expect(stub.isRevoked(old)).toBe("installation_revoked");
    expect(stub.installation(old)!.seq).toBe(oldSeq);
    expect(stub.isRevoked(inst.installationId)).toBeNull();
    expect(stub.stats.locks).toBe(0);
  });

  test("login: when the PREVIOUS installation cannot be revoked, the person is told to revoke it in Settings", async () => {
    const { stub, dir } = setup({ revokeBodyEmpty: true }); // every revoke answer is unusable
    const old = await enrolledProfile(stub, dir);
    const { m, events } = manager(dir, stub.url);
    const url = (await m.login("browser")).match(/https?:\/\/\S+/)![0];
    await drive(url);
    await until(() => events.notices.some((n) => n.includes("PREVIOUS")));
    expect(readInstallation(dir)!.installationId).not.toBe(old);
    expect(events.notices.join("\n")).toMatch(/PREVIOUS sign-in .* could not be revoked .* Settings → Agents → Machines/);
  });

  test("login whose new files cannot be written (full disk): BOTH installations revoked — none left live and unusable — and the person told", async () => {
    const { stub, dir } = setup();
    const old = await enrolledProfile(stub, dir);
    const { m, events } = manager(dir, stub.url);
    const url = (await m.login("browser")).match(/https?:\/\/\S+/)![0];
    failInstallationWrites = 1;
    const done = await drive(url);
    expect(failInstallationWrites).toBe(0); // the injected failure really fired
    expect(done.headers.get("location")).toBe(`${stub.url}/connect/done?result=error`);
    expect(readInstallation(dir)).toBeNull();
    expect(readKey(dir)).toBeNull();
    expect(readState(dir)).toBeNull();
    expect(stub.stats.enrols).toBe(2);
    expect(stub.stats.revokes).toHaveLength(2);
    expect(stub.isRevoked(old)).toBe("installation_revoked");
    expect(stub.isRevoked(stub.stats.revokes.find((r) => r.id !== old)!.id)).toBe("installation_revoked");
    expect(events.loggedIn).toBe(0);
    expect(events.notices.join()).toMatch(/could not be saved on this machine .*ENOSPC/);
    expect(events.notices.join()).not.toMatch(/STAYS? ENROLLED/);
  });

  test("…and when those revokes fail too, the person is told what STAYS ENROLLED and where to revoke them", async () => {
    const { stub, dir } = setup({ revokeBodyEmpty: true });
    await enrolledProfile(stub, dir);
    const { m, events } = manager(dir, stub.url);
    const url = (await m.login("browser")).match(/https?:\/\/\S+/)![0];
    failInstallationWrites = 1;
    await drive(url);
    expect(readInstallation(dir)).toBeNull();
    expect(events.notices.join()).toMatch(/"the new sign-in [0-9a-f-]+" and ".+" STAY ENROLLED in Bridge until you revoke them in Settings → Agents → Machines/);
  });

  test("loopback denied: browser sent to result=denied, credentials untouched, person told", async () => {
    const { stub, dir } = setup({ deny: true });
    const old = await enrolledProfile(stub, dir);
    const { m, events } = manager(dir, stub.url);
    const url = (await m.login("browser")).match(/https?:\/\/\S+/)![0];
    const done = await drive(url);
    expect(done.headers.get("location")).toBe(`${stub.url}/connect/done?result=denied`);
    expect(await until(() => events.notices.some((n) => n.includes("denied")))).toBe(true);
    expect(readInstallation(dir)!.installationId).toBe(old);
    expect(stub.isRevoked(old)).toBeNull();
    expect(events.notices.join()).toMatch(/denied/);
  });

  test("loopback listener refuses a foreign Host (DNS rebinding) and a wrong state", async () => {
    const { stub, dir } = setup();
    const { m } = manager(dir, stub.url);
    const url = new URL((await m.login("browser")).match(/https?:\/\/\S+/)![0]);
    const redirect = new URL(url.searchParams.get("redirect_uri")!);
    const state = url.searchParams.get("state")!;
    const rebound = await fetch(`${redirect}?code=x&state=${state}&iss=${encodeURIComponent(stub.issuer)}`, {
      headers: { Host: `evil.example:${redirect.port}` },
    });
    expect(rebound.status).toBe(403);
    const wrongState = await fetch(`${redirect}?code=x&state=nope&iss=${encodeURIComponent(stub.issuer)}`);
    expect(wrongState.status).toBe(400);
    expect(readInstallation(dir)).toBeNull();
  });

  test("an issuer mismatch (RFC 9207) is refused without exchanging the code", async () => {
    const { stub, dir } = setup();
    const { m, events } = manager(dir, stub.url);
    const url = new URL((await m.login("browser")).match(/https?:\/\/\S+/)![0]);
    const redirect = url.searchParams.get("redirect_uri")!;
    const res = await fetch(`${redirect}?code=x&state=${url.searchParams.get("state")}&iss=https://evil.example`, { redirect: "manual" });
    expect(res.headers.get("location")).toBe(`${stub.url}/connect/done?result=error`);
    expect(await until(() => events.notices.some((n) => n.includes("issuer_mismatch")))).toBe(true);
    expect(readInstallation(dir)).toBeNull();
    expect(events.notices.join()).toMatch(/issuer_mismatch/);
  });

  test("a pre-RFC-016 server: login refuses up front", async () => {
    const { stub, dir } = setup({ legacyServer: true });
    const { m } = manager(dir, stub.url);
    expect(await m.login("browser")).toMatch(/must be upgraded/);
  });

  test("device flow: shows the code, polls (a fresh proof per poll) through pending, completes", async () => {
    const { stub, dir } = setup({ devicePending: 1, deviceIntervalS: 1 });
    const { m, events } = manager(dir, stub.url);
    const text = await m.login("device");
    expect(text).toContain("BCDF-GHJK");
    expect(text).toContain(`${stub.url}/connect`);
    await until(() => readInstallation(dir) !== null);
    expect(readInstallation(dir)).not.toBeNull();
    expect(readKey(dir)).not.toBeNull();
    expect(seq(dir)).toBe(0);
    expect(events.loggedIn).toBe(1);
  }, 10_000);

  test("a second hit on the callback (reload / prefetch) gets the same outcome, not an error", async () => {
    const { stub, dir } = setup();
    const { m } = manager(dir, stub.url);
    const url = (await m.login("browser")).match(/https?:\/\/\S+/)![0];
    const cb = (await fetch(url, { redirect: "manual" })).headers.get("location")!;
    const [a, b] = await Promise.all([fetch(cb, { redirect: "manual" }), Bun.sleep(20).then(() => fetch(cb, { redirect: "manual" }))]);
    expect(a.headers.get("location")).toBe(`${stub.url}/connect/done?result=connected`);
    expect(b.headers.get("location")).toBe(`${stub.url}/connect/done?result=connected`);
  });

  test("a held callback survives a long wait for the installation lock (no idle-timeout cut)", async () => {
    const { stub, dir } = setup();
    const { m } = manager(dir, stub.url);
    const url = (await m.login("browser")).match(/https?:\/\/\S+/)![0];
    const cb = (await fetch(url, { redirect: "manual" })).headers.get("location")!;
    // Another session holds the lock for 12 s (past Bun's 10 s default idle timeout).
    const busy = withInstallationLock(dir, () => Bun.sleep(12_000));
    expect(await until(() => existsSync(join(dir, LOCK_DIR_NAME)))).toBe(true);
    const done = await fetch(cb, { redirect: "manual" });
    await busy;
    expect(done.headers.get("location")).toBe(`${stub.url}/connect/done?result=connected`);
  }, 30_000);

  test("logout while the code is being exchanged is not undone by the late exchange; the new installation is revoked", async () => {
    const { stub, dir } = setup({ codeDelayMs: 500 });
    const { m, events } = manager(dir, stub.url);
    const url = (await m.login("browser")).match(/https?:\/\/\S+/)![0];
    const cb = (await fetch(url, { redirect: "manual" })).headers.get("location")!;
    const done = fetch(cb, { redirect: "manual" });
    // The code exchange has reached the server (it answers after codeDelayMs).
    expect(await until(() => (stub.stats.tokenRequests["authorization_code"] ?? 0) >= 1)).toBe(true);
    await m.logout(true);
    expect((await done).headers.get("location")).toBe(`${stub.url}/connect/done?result=error`);
    expect(await until(() => stub.stats.revokes.length === 1)).toBe(true); // the late exchange's installation
    expect(readInstallation(dir)).toBeNull();
    expect(events.loggedIn).toBe(0);
    expect(stub.stats.revokes).toHaveLength(1);
  });

  function prompting(answer: boolean) {
    const seen = { shown: [] as string[], asked: [] as string[] };
    return {
      seen,
      prompt: {
        available: () => true,
        show: (m: string) => void seen.shown.push(m),
        confirm: async (m: string) => (seen.asked.push(m), answer),
      },
    };
  }

  test("device flow with a prompt: the code goes to the PERSON, never into the tool result", async () => {
    const { stub, dir } = setup({ deviceIntervalS: 1 });
    const p = prompting(true);
    const { m } = manager(dir, stub.url, { prompt: p.prompt });
    const text = await m.login("device");
    expect(text).not.toContain("BCDF-GHJK");
    expect(p.seen.shown.join()).toContain("BCDF-GHJK");
    await until(() => readInstallation(dir) !== null);
    expect(readInstallation(dir)).not.toBeNull();
    expect(p.seen.asked[0]).toContain('@agent-one (Agent One) in workspace "Acme"');
  }, 10_000);

  test("device flow declined in the terminal: nothing stored, the NEW installation revoked with its seq-0 state, the old one kept", async () => {
    const { stub, dir } = setup({ deviceIntervalS: 1 });
    const old = await enrolledProfile(stub, dir);
    const p = prompting(false);
    const { m, events } = manager(dir, stub.url, { prompt: p.prompt });
    await m.login("device");
    expect(await until(() => p.seen.asked.length > 0)).toBe(true);
    expect(await until(() => events.notices.some((n) => n.includes("declined")))).toBe(true);
    expect(p.seen.asked[0]).toContain("replaces this machine's current Bridge sign-in");
    expect(readInstallation(dir)!.installationId).toBe(old);
    expect(stub.isRevoked(old)).toBeNull();
    expect(stub.stats.revokes).toHaveLength(1);
    expect(stub.stats.revokes[0]!.id).not.toBe(old);
    expect(stub.stats.locks).toBe(0);
    expect(events.loggedIn).toBe(0);
    expect(events.notices.join()).toMatch(/declined/);
  }, 10_000);

  test("a device approval that lands after the login was cancelled is revoked, not dropped", async () => {
    // interval 1 s; the approving poll is in flight 1.0–1.6 s; the logout lands at ~1.2 s.
    const { stub, dir } = setup({ devicePollDelayMs: 600, deviceIntervalS: 1 });
    const { m, events } = manager(dir, stub.url);
    await m.login("device");
    // The (approving) poll has reached the server and is held there for 600 ms.
    expect(await until(() => (stub.stats.tokenRequests["urn:ietf:params:oauth:grant-type:device_code"] ?? 0) >= 1)).toBe(true);
    expect(stub.stats.enrols).toBe(0); // the poll is really in flight
    await m.logout(true);
    await until(() => stub.stats.revokes.length > 0);
    expect(stub.stats.enrols).toBe(1);
    expect(stub.stats.revokes).toHaveLength(1);
    expect(stub.isRevoked(stub.stats.revokes[0]!.id)).toBe("installation_revoked");
    expect(readInstallation(dir)).toBeNull();
    expect(events.loggedIn).toBe(0);
  }, 10_000);

  test("a STALE flow never clears the current one: device A declined after browser B started — a logout still cancels B", async () => {
    const { stub, dir } = setup({ deviceIntervalS: 1 });
    let answerA!: (ok: boolean) => void;
    const asked: string[] = [];
    const { m, events } = manager(dir, stub.url, {
      prompt: {
        available: () => true,
        show: () => {},
        confirm: (msg: string) => (asked.push(msg), new Promise<boolean>((r) => (answerA = r))),
      },
    });
    await m.login("device"); // A
    expect(await until(() => asked.length === 1)).toBe(true); // A is approved, waiting on the person
    const urlB = (await m.login("browser")).match(/https?:\/\/\S+/)![0]; // B replaces A
    answerA(false); // A is declined — late, it must not touch B's registration
    expect(await until(() => stub.stats.revokes.length === 1)).toBe(true); // A's installation revoked
    await m.logout(true); // must cancel B
    const cb = (await fetch(urlB, { redirect: "manual" })).headers.get("location")!;
    await fetch(cb, { redirect: "manual" }).catch(() => null); // B's listener is gone (or answers error)
    expect(await until(() => stub.stats.enrols >= 2, 1_000)).toBe(false); // B's code never exchanged
    expect(readInstallation(dir)).toBeNull();
    expect(events.loggedIn).toBe(0);
  }, 15_000);

  test("without a prompt, device mode is refused on a machine that is already signed in", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    const text = await m.login("device");
    expect(text).toMatch(/can't prompt you/);
    expect(text).not.toContain("BCDF-GHJK");
  });

  test("headless machines get the device flow automatically", async () => {
    const { stub, dir } = setup();
    const { m } = manager(dir, stub.url, { env: { SSH_CONNECTION: "1 2 3 4" } });
    expect(await m.login()).toContain("BCDF-GHJK");
  });
});

describe("logout and enrolment keys", () => {
  test("logout revokes with the CURRENT state + attempt (verified, not advanced) and deletes the files; local only deletes", async () => {
    const { stub, dir } = setup();
    const inst = await enrolledProfile(stub, dir);
    const { m, events } = manager(dir, stub.url);
    await m.accessToken();
    expect(await m.logout(false)).toMatch(/revoked in Bridge/);
    expect(stub.isRevoked(inst)).toBe("installation_revoked");
    expect(stub.stats.revokes).toEqual([{ id: inst, scope: "installation" }]);
    expect(stub.stats.locks).toBe(0);
    for (const f of ["installation.json", "key.json", "state", "attempt"]) expect(existsSync(join(dir, f))).toBe(false);
    expect(events.loggedOut).toBe(1);

    const inst2 = await enrolledProfile(stub, dir);
    // C17: --local says the machine stays enrolled, and where to revoke it.
    expect(await m.logout(true)).toMatch(/Signed out locally.*STAYS ENROLLED.*Settings → Agents → Machines/);
    expect(stub.isRevoked(inst2)).toBeNull();
    expect(readInstallation(dir)).toBeNull();
  });

  test("logout mid-mint (attempt on disk, answer lost): the revoke carries the attempt and passes", async () => {
    const { stub, dir } = setup({ loseMintResponses: 1 });
    const inst = await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    await m.accessToken().catch(() => {});
    expect(readAttempt(dir)).not.toBeNull();
    expect(await m.logout(false)).toMatch(/revoked in Bridge/);
    expect(stub.isRevoked(inst)).toBe("installation_revoked");
  });

  test("logout of an installation Bridge already LOCKED says a copy was used — not \"revoked\"", async () => {
    const { stub, dir } = setup();
    const inst = await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    await m.accessToken();
    stub.installation(inst)!.revoked = "installation_locked";
    const text = await m.logout(false);
    expect(text).toMatch(/LOCKED.*copy of its credential/);
    expect(text).not.toMatch(/access was revoked/);
    expect(readInstallation(dir)).toBeNull();
  });

  test("logout with Bridge unreachable: signed out locally and told how to revoke", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m } = manager(dir, stub.url);
    await m.accessToken();
    stub.stop();
    expect(await m.logout(false)).toMatch(/revoking in Bridge failed/);
    expect(readInstallation(dir)).toBeNull();
  });

  test("BRIDGE_ENROLMENT_KEY enrols once, even when several sessions boot together", async () => {
    const { stub, dir } = setup();
    const ek = stub.mintEnrolmentKey(5);
    const ms = Array.from({ length: 4 }, (_, i) => manager(dir, stub.url, { key: `k${i}`, enrolmentKey: ek }).m);
    await Promise.all(ms.map((m) => m.enrolFromKeyIfNeeded()));
    expect(stub.stats.enrols).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "installation.json"), "utf8")).apiUrl).toBe(stub.url);
    await Promise.all(ms.map((m) => m.accessToken()));
    expect(stub.stats.locks).toBe(0);
  });

  test("after /bridge:logout an enrolment key still in .env does not sign the machine back in; login clears that", async () => {
    const { stub, dir } = setup();
    const { m } = manager(dir, stub.url, { enrolmentKey: stub.mintEnrolmentKey(5) });
    await m.enrolFromKeyIfNeeded();
    expect(readInstallation(dir)).not.toBeNull();
    await m.logout(true);
    await m.enrolFromKeyIfNeeded();
    expect(readInstallation(dir)).toBeNull();
    expect(stub.stats.enrols).toBe(1);
    const url = (await m.login("browser")).match(/https?:\/\/\S+/)![0];
    await fetch((await fetch(url, { redirect: "manual" })).headers.get("location")!, { redirect: "manual" });
    expect(existsSync(join(dir, "logged-out"))).toBe(false);
  });

  test("C6: BRIDGE_ENROLMENT_KEY answered key_already_enrolled retries ONCE with a fresh key; twice ⇒ reported", async () => {
    const { stub, dir } = setup({ keyAlreadyEnrolled: 1 });
    const { m } = manager(dir, stub.url, { enrolmentKey: stub.mintEnrolmentKey(5) });
    await m.enrolFromKeyIfNeeded();
    expect(readInstallation(dir)).not.toBeNull();
    expect(stub.stats.enrols).toBe(1);

    const s2 = setup({ keyAlreadyEnrolled: 2 });
    const b = manager(s2.dir, s2.stub.url, { enrolmentKey: s2.stub.mintEnrolmentKey(5) });
    await b.m.enrolFromKeyIfNeeded();
    expect(readInstallation(s2.dir)).toBeNull();
    expect(s2.stub.stats.refusals.filter((r) => r.endsWith("key_already_enrolled"))).toHaveLength(2);
    expect(b.events.notices.join()).toMatch(/could not enrol/);
  });

  test("C6: a device login answered key_already_enrolled switches to a fresh key once and completes", async () => {
    const { stub, dir } = setup({ keyAlreadyEnrolled: 1, deviceIntervalS: 1 });
    const { m } = manager(dir, stub.url);
    await m.login("device");
    await until(() => readInstallation(dir) !== null);
    expect(readInstallation(dir)).not.toBeNull();
    expect(stub.installation(readInstallation(dir)!.installationId)!.jkt).toBe(readInstallation(dir)!.jkt);
  }, 10_000);

  test("the enrolment-key path holds the lock for ONE deadline across discovery + enrol + the C6 retry (not one per call)", async () => {
    // Each call alone fits the budget; together they do not. The retry must be cut
    // at the section's deadline — per-call budgets would let it finish (and held the
    // lock for up to 190 s in production, past the 120 s stale break).
    const { stub, dir } = setup({ discoveryDelayMs: 400, enrolDelayMs: 700, keyAlreadyEnrolled: 1 });
    const { m, events } = manager(dir, stub.url, { enrolmentKey: stub.mintEnrolmentKey(5), lockBudgetMs: 1_500 });
    const t0 = Date.now();
    await m.enrolFromKeyIfNeeded();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(1_400);
    expect(took).toBeLessThan(1_750); // an un-cut retry ends at ≈ 400 + 700 + 700 = 1 800 ms
    expect(readInstallation(dir)).toBeNull();
    expect(existsSync(join(dir, LOCK_DIR_NAME))).toBe(false);
    expect(events.notices.join()).toMatch(/could not enrol/);
 
    // A hung DISCOVERY is cut by the same deadline (its shared, cached request is not).
    const s2 = setup({ discoveryDelayMs: 2_500 });
    const b = manager(s2.dir, s2.stub.url, { enrolmentKey: s2.stub.mintEnrolmentKey(1), lockBudgetMs: 1_000 });
    const t1 = Date.now();
    await b.m.enrolFromKeyIfNeeded();
    expect(Date.now() - t1).toBeLessThan(1_400);
    expect(b.events.notices.join()).toMatch(/could not enrol/);
  });

  test("an enrolment whose files cannot be written: the new installation is revoked, nothing is left on disk, the person told", async () => {
    const { stub, dir } = setup();
    const { m, events } = manager(dir, stub.url, { enrolmentKey: stub.mintEnrolmentKey(5) });
    failInstallationWrites = 1;
    await m.enrolFromKeyIfNeeded();
    expect(failInstallationWrites).toBe(0);
    expect(readInstallation(dir)).toBeNull();
    expect(readKey(dir)).toBeNull();
    expect(readState(dir)).toBeNull();
    expect(stub.stats.enrols).toBe(1);
    expect(stub.stats.revokes).toHaveLength(1);
    expect(stub.isRevoked(stub.stats.revokes[0]!.id)).toBe("installation_revoked");
    expect(events.notices.join()).toMatch(/BRIDGE_ENROLMENT_KEY enrolled this machine, but its sign-in could not be saved on this machine .*ENOSPC/);
    expect(events.notices.join()).not.toMatch(/used up or expired/); // the key was fine
  });

  test("…and when that revoke fails, the ONE installation left is named: it STAYS ENROLLED until revoked in Settings", async () => {
    const { stub, dir } = setup({ revokeBodyEmpty: true });
    const { m, events } = manager(dir, stub.url, { enrolmentKey: stub.mintEnrolmentKey(5) });
    failInstallationWrites = 1;
    await m.enrolFromKeyIfNeeded();
    expect(readInstallation(dir)).toBeNull();
    expect(events.notices.join()).toMatch(/"the new sign-in [0-9a-f-]+" STAYS ENROLLED in Bridge until you revoke it in Settings → Agents → Machines/);
  });

  test("a used-up enrolment key tells the person, and nothing is written", async () => {
    const { stub, dir } = setup();
    // Well-formed, but with no uses left: the server's "used up / unknown" answer.
    const { m, events } = manager(dir, stub.url, { enrolmentKey: stub.mintEnrolmentKey(0) });
    await m.enrolFromKeyIfNeeded();
    expect(readInstallation(dir)).toBeNull();
    expect(readKey(dir)).toBeNull();
    expect(events.notices.join()).toMatch(/could not enrol/);
  });
});

describe("RFC-014 (0.23 / 0.24) → 0.25", () => {
  function legacyProfile(dir: string, apiUrl: string) {
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ apiUrl, installationId: "old", installationToken: "brg_it_old", installationName: "mac" }));
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "sessions", "session-a.json"), JSON.stringify({ sessionId: "s", refreshToken: "brg_rt_old", installationId: "old" }));
  }

  test("0.23 files are retired and the person is told to /bridge:login — even with BRIDGE_API_URL unset", async () => {
    const { stub, dir } = setup();
    legacyProfile(dir, stub.url);
    const { m } = manager(dir, "");
    expect(await m.retireLegacyCredentials()).toBe(true);
    expect(existsSync(join(dir, "credentials.json"))).toBe(false);
    expect(existsSync(join(dir, "sessions", "session-a.json"))).toBe(false);
    expect(m.configError()).toMatch(/plugin 0\.25 .* cannot be carried over — run \/bridge:login/);
    expect(m.apiUrl()).toBe(stub.url); // login works without re-running /bridge:configure
    await expect(m.accessToken()).rejects.toThrow(/run \/bridge:login/);
    expect(await m.retireLegacyCredentials()).toBe(false);
  });

  test("the first login clears the upgrade notice", async () => {
    const { stub, dir } = setup();
    legacyProfile(dir, stub.url);
    const { m } = manager(dir, "");
    await m.retireLegacyCredentials();
    const url = (await m.login("browser")).match(/https?:\/\/\S+/)![0];
    await fetch((await fetch(url, { redirect: "manual" })).headers.get("location")!, { redirect: "manual" });
    expect(await until(() => m.configError() === null)).toBe(true);
    expect(existsSync(join(dir, "upgrade-required.json"))).toBe(false);
  });
});
