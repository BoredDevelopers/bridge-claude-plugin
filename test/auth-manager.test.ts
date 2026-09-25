/**
 * The credential manager (auth/manager.ts, RFC-014 §7.2) against a strict stub
 * authorization server (no grace: any re-presented rotated token is counted as
 * reuse and revokes the grant). Several managers on one profile directory stand in
 * for several plugin processes on one machine.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAuthStub } from "./agent-auth-stub";
import { CredentialManager, CredentialError, type ManagerDeps } from "../auth/manager";
import { resolveProfile } from "../auth/profile";
import { withProfileLock } from "../auth/lock";
import { writeInstallation, readInstallation, readSession, sessionFileFor } from "../auth/store";

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
    rotated: [] as string[],
    notices: [] as string[],
    loggedIn: 0,
    loggedOut: 0,
    shown: [] as string[],
    asked: [] as string[],
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
    onAccessRotated: (t) => events.rotated.push(t),
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

/** Put an enrolled installation on disk, as a completed login would. */
function enrolled(stub: ReturnType<typeof startAuthStub>, dir: string) {
  const g = stub.enrol();
  writeInstallation(dir, { apiUrl: stub.url, installationId: g.installation_id, installationToken: g.installation_token });
  return g.installation_id;
}

describe("session start and refresh", () => {
  test("first bearer starts a session: rotated installation token + session file persisted, 0600, metadata sent", async () => {
    const { stub, dir } = setup();
    const before = enrolled(stub, dir);
    const tokenBefore = readInstallation(dir)!.installationToken;
    const { m } = manager(dir, stub.url);
    const at = await m.bearer();
    expect(at).toStartWith("brg_at_");
    expect(readInstallation(dir)!.installationToken).not.toBe(tokenBefore);
    expect(readInstallation(dir)!.installationId).toBe(before);
    expect(readSession(dir, "session-a")!.refreshToken).toStartWith("brg_rt_");
    expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
    expect(statSync(sessionFileFor(dir, "session-a")).mode & 0o777).toBe(0o600);
    expect(stub.stats.sessionMeta).toEqual([{ platform: "test-os", client_version: "9.9.9" }]);
    // Cached: no second grant.
    expect(await m.bearer()).toBe(at);
    expect(stub.stats.sessionGrants).toBe(1);
  });

  test("drain waits for a renew in flight to persist its rotated token (shutdown)", async () => {
    const { stub, dir } = setup({ sessionDelayMs: 300 });
    enrolled(stub, dir);
    const { m } = manager(dir, stub.url);
    void m.bearer();
    await Bun.sleep(50);
    expect(readSession(dir, "session-a")).toBeNull(); // really in flight
    await m.drain(5_000);
    expect(readSession(dir, "session-a")).not.toBeNull();
  });

  test("after invalidation the SAME session is refreshed (not a new one)", async () => {
    const { stub, dir } = setup();
    enrolled(stub, dir);
    const { m } = manager(dir, stub.url);
    const a = await m.bearer();
    m.invalidateAccess();
    const b = await m.bearer();
    expect(b).not.toBe(a);
    expect(stub.stats).toMatchObject({ sessionGrants: 1, refreshes: 1, reuse: 0 });
  });

  test("concurrent callers in one process share one renewal", async () => {
    const { stub, dir } = setup();
    enrolled(stub, dir);
    const { m } = manager(dir, stub.url);
    const all = await Promise.all([m.bearer(), m.bearer(), m.bearer()]);
    expect(new Set(all).size).toBe(1);
    expect(stub.stats.sessionGrants).toBe(1);
  });

  test("many sessions on one machine start at once: every one succeeds, zero reuse", async () => {
    const { stub, dir } = setup();
    enrolled(stub, dir);
    const ms = Array.from({ length: 6 }, (_, i) => manager(dir, stub.url, { key: `s${i}` }).m);
    const tokens = await Promise.all(ms.map((m) => m.bearer()));
    expect(new Set(tokens).size).toBe(6);
    expect(stub.stats).toMatchObject({ sessionGrants: 6, reuse: 0 });
  });

  test("two processes of the SAME session refresh from disk, never from memory: zero reuse", async () => {
    const { stub, dir } = setup();
    enrolled(stub, dir);
    const p1 = manager(dir, stub.url).m;
    const p2 = manager(dir, stub.url).m;
    await p1.bearer();
    for (let i = 0; i < 4; i++) {
      p1.invalidateAccess();
      p2.invalidateAccess();
      await Promise.all([p1.bearer(), p2.bearer()]);
    }
    expect(stub.stats.reuse).toBe(0);
    expect(stub.stats.sessionGrants).toBe(1);
  });

  test("a dead session (invalid_grant on refresh) is replaced by a new session", async () => {
    const { stub, dir } = setup();
    const inst = enrolled(stub, dir);
    const { m } = manager(dir, stub.url);
    await m.bearer();
    stub.revokeSession(stub.sessionsFor(inst)[0]!.id);
    m.invalidateAccess();
    expect(await m.bearer()).toStartWith("brg_at_");
    expect(stub.stats.sessionGrants).toBe(2);
  });

  test("a dead installation deletes the profile's credentials and says to log in", async () => {
    const { stub, dir } = setup();
    const inst = enrolled(stub, dir);
    const { m } = manager(dir, stub.url);
    stub.revokeInstallation(inst);
    await expect(m.bearer()).rejects.toThrow(/run \/bridge:login/);
    expect(readInstallation(dir)).toBeNull();
  });

  test("a network failure keeps the files and is reported as retryable", async () => {
    const { stub, dir } = setup();
    enrolled(stub, dir);
    const { m } = manager(dir, stub.url);
    await m.bearer();
    stub.stop();
    m.invalidateAccess();
    const e = await m.bearer().catch((x) => x);
    expect(e).toBeInstanceOf(CredentialError);
    expect(e.kind).toBe("network");
    expect(readInstallation(dir)).not.toBeNull();
    expect(readSession(dir, "session-a")).not.toBeNull();
  });

  test("a discovery 5xx (deploy in progress) is retryable, not a sign-out", async () => {
    const { stub, dir } = setup({ discoveryFail: 1 });
    enrolled(stub, dir);
    const { m } = manager(dir, stub.url);
    const e = await m.bearer().catch((x) => x);
    expect(e.kind).toBe("network");
    expect(await m.bearer()).toStartWith("brg_at_");
  });

  test("invalidating with a token that is no longer current keeps the current one", async () => {
    const { stub, dir } = setup();
    enrolled(stub, dir);
    const { m } = manager(dir, stub.url);
    const old = await m.bearer();
    m.invalidateAccess(old);
    const fresh = await m.bearer();
    m.invalidateAccess(old); // a late 401 for a request sent with the old token
    expect(await m.bearer()).toBe(fresh);
    expect(stub.stats.refreshes).toBe(1);
  });

  test("the refresh ticker renews ahead of expiry and hands the live socket the new token", async () => {
    const { stub, dir } = setup({ accessTtlS: 6 });
    enrolled(stub, dir);
    const { m, events } = manager(dir, stub.url, { tickMs: 50, random: () => 0 });
    const first = await m.bearer();
    // 6 s token: refresh at 5 s (a sixth ahead), jitter 0.
    await Bun.sleep(5_400);
    expect(events.rotated.length).toBeGreaterThanOrEqual(1);
    expect(events.rotated[0]).not.toBe(first);
    expect(stub.stats.refreshes).toBeGreaterThanOrEqual(1);
  }, 15_000);
});

describe("profiles and configuration", () => {
  test("a named profile without credentials is an error", async () => {
    const { stub, dir } = setup();
    const { m } = manager(dir, stub.url, { profile: "reviewer" });
    expect(m.source()).toBe("none");
    await expect(m.bearer()).rejects.toThrow(/profile "reviewer" is not signed in/);
  });

  // RFC-014 slice 5b: the server rejects a static BRIDGE_TOKEN outright, so the
  // manager no longer treats it as a credential source at all — only as a hint
  // that whoever set it should run /bridge:login instead.
  test("BRIDGE_TOKEN alone is not a credential: source is none, and the hint says so", async () => {
    const { stub, dir } = setup();
    const { m } = manager(dir, stub.url, { staleStaticTokenPresent: true });
    expect(m.source()).toBe("none");
    await expect(m.bearer()).rejects.toThrow(/BRIDGE_TOKEN is no longer supported — run \/bridge:login/);
    expect(m.status().hint).toMatch(/BRIDGE_TOKEN is no longer supported — run \/bridge:login/);
    // Never sent anywhere — bearer() must go through the real flow once there
    // IS a credential, ignoring BRIDGE_TOKEN entirely.
    enrolled(stub, dir);
    expect(m.source()).toBe("installation");
    expect(await m.bearer()).toStartWith("brg_at_");
    expect(m.status().hint).toBeUndefined();
  });

  test("an invalid profile name is refused", () => {
    expect(resolveProfile("/x", "Bad Name")).toHaveProperty("error");
    expect(resolveProfile("/x", "reviewer")).toEqual({ name: "reviewer", dir: "/x/profiles/reviewer" });
    expect(resolveProfile("/x", "")).toEqual({ name: null, dir: "/x" });
  });

  test("a profile never sends its tokens to a different API", async () => {
    const { stub, dir } = setup();
    enrolled(stub, dir);
    const { m } = manager(dir, "https://elsewhere.example");
    await expect(m.bearer()).rejects.toThrow(/signed in to .* but BRIDGE_API_URL is https:\/\/elsewhere/);
    expect(stub.stats.sessionGrants).toBe(0);
  });
});

describe("revocation", () => {
  test("4008 session revoked deletes only this session's file", async () => {
    const { stub, dir } = setup();
    enrolled(stub, dir);
    const { m } = manager(dir, stub.url);
    await m.bearer();
    await m.sessionRevoked(m.grant()!.sessionId);
    expect(readSession(dir, "session-a")).toBeNull();
    expect(readInstallation(dir)).not.toBeNull();
  });

  test("a revoke for an OLDER session never deletes the newer session file", async () => {
    const { stub, dir } = setup();
    enrolled(stub, dir);
    const { m } = manager(dir, stub.url);
    await m.bearer();
    await m.sessionRevoked("some-older-session-id");
    expect(readSession(dir, "session-a")).not.toBeNull();
  });

  test("4008 installation revoked: signed out if it is still ours, switched if the profile holds a new one", async () => {
    const { stub, dir } = setup();
    enrolled(stub, dir);
    const a = manager(dir, stub.url, { key: "a" }).m;
    const b = manager(dir, stub.url, { key: "b" }).m;
    await a.bearer();
    await b.bearer();
    const first = a.grant()!.installationId;
    // Re-login elsewhere replaced the installation on disk.
    enrolled(stub, dir);
    expect(await a.installationRevoked(first)).toBe("switched");
    expect(readInstallation(dir)).not.toBeNull();
    // Unknown which one the socket used: retry rather than sign out.
    expect(await a.installationRevoked(null)).toBe("switched");
    expect(readInstallation(dir)).not.toBeNull();
    // Now a genuine revoke of the current one.
    await a.bearer();
    expect(await a.installationRevoked(a.grant()!.installationId)).toBe("logged_out");
    expect(readInstallation(dir)).toBeNull();
  });
});

describe("login", () => {
  async function drive(url: string) {
    // The person's browser: authorize → 302 to the loopback callback → 302 to done.
    const toCallback = await fetch(url, { redirect: "manual" });
    const cb = toCallback.headers.get("location")!;
    return fetch(cb, { redirect: "manual" });
  }

  test("loopback: code exchanged with PKCE, browser sent to /connect/done?result=connected, old installation revoked after", async () => {
    const { stub, dir } = setup();
    const old = enrolled(stub, dir);
    const { m, events } = manager(dir, stub.url);
    const text = await m.login("browser");
    const url = text.match(/https?:\/\/\S+/)![0];
    const done = await drive(url);
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${stub.url}/connect/done?result=connected`);
    await Bun.sleep(100);
    const inst = readInstallation(dir)!;
    expect(inst.installationId).not.toBe(old);
    expect(events.loggedIn).toBe(1);
    expect(stub.isRevoked(old)).toBe(true);
    expect(stub.isRevoked(inst.installationId)).toBe(false);
  });

  test("loopback denied: browser sent to result=denied, credentials untouched, person told", async () => {
    const { stub, dir } = setup({ deny: true });
    const old = enrolled(stub, dir);
    const { m, events } = manager(dir, stub.url);
    const url = (await m.login("browser")).match(/https?:\/\/\S+/)![0];
    const done = await drive(url);
    expect(done.headers.get("location")).toBe(`${stub.url}/connect/done?result=denied`);
    await Bun.sleep(50);
    expect(readInstallation(dir)!.installationId).toBe(old);
    expect(stub.isRevoked(old)).toBe(false);
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
    await Bun.sleep(50);
    expect(readInstallation(dir)).toBeNull();
    expect(events.notices.join()).toMatch(/issuer_mismatch/);
  });

  test("device flow: shows the code, polls through pending, completes", async () => {
    const { stub, dir } = setup({ devicePending: 1 });
    const { m, events } = manager(dir, stub.url);
    const text = await m.login("device");
    expect(text).toContain("BCDF-GHJK");
    expect(text).toContain(`${stub.url}/connect`);
    for (let i = 0; i < 40 && !readInstallation(dir); i++) await Bun.sleep(100);
    expect(readInstallation(dir)).not.toBeNull();
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

  test("a held callback survives a long wait for the profile lock (no idle-timeout cut)", async () => {
    const { stub, dir } = setup();
    const { m } = manager(dir, stub.url);
    const url = (await m.login("browser")).match(/https?:\/\/\S+/)![0];
    const cb = (await fetch(url, { redirect: "manual" })).headers.get("location")!;
    // Another session holds the lock for 12 s (past Bun's 10 s default idle timeout).
    const busy = withProfileLock(dir, () => Bun.sleep(12_000));
    await Bun.sleep(50);
    const done = await fetch(cb, { redirect: "manual" });
    await busy;
    expect(done.headers.get("location")).toBe(`${stub.url}/connect/done?result=connected`);
  }, 30_000);

  test("logout while the code is being exchanged is not undone by the late exchange", async () => {
    const { stub, dir } = setup({ codeDelayMs: 500 });
    const { m, events } = manager(dir, stub.url);
    const url = (await m.login("browser")).match(/https?:\/\/\S+/)![0];
    const cb = (await fetch(url, { redirect: "manual" })).headers.get("location")!;
    const done = fetch(cb, { redirect: "manual" });
    await Bun.sleep(100);
    await m.logout(true);
    expect((await done).headers.get("location")).toBe(`${stub.url}/connect/done?result=error`);
    // Past the 500 ms exchange: the late answer must not write anything.
    await Bun.sleep(900);
    expect(readInstallation(dir)).toBeNull();
    expect(events.loggedIn).toBe(0);
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
    const { stub, dir } = setup();
    const p = prompting(true);
    const { m } = manager(dir, stub.url, { prompt: p.prompt });
    const text = await m.login("device");
    expect(text).not.toContain("BCDF-GHJK");
    expect(p.seen.shown.join()).toContain("BCDF-GHJK");
    for (let i = 0; i < 40 && !readInstallation(dir); i++) await Bun.sleep(100);
    expect(readInstallation(dir)).not.toBeNull();
    expect(p.seen.asked[0]).toContain('@agent-one (Agent One) in workspace "Acme"');
  }, 10_000);

  test("device flow declined in the terminal: nothing stored, the new installation revoked, the old one kept", async () => {
    const { stub, dir } = setup();
    const old = enrolled(stub, dir);
    const p = prompting(false);
    const { m, events } = manager(dir, stub.url, { prompt: p.prompt });
    await m.login("device");
    for (let i = 0; i < 40 && p.seen.asked.length === 0; i++) await Bun.sleep(100);
    await Bun.sleep(200);
    expect(p.seen.asked[0]).toContain("replaces this machine's current Bridge sign-in");
    expect(readInstallation(dir)!.installationId).toBe(old);
    expect(stub.isRevoked(old)).toBe(false);
    expect(stub.stats.revoked).toHaveLength(1); // the declined one
    expect(stub.stats.revoked[0]).not.toBe(old);
    expect(events.loggedIn).toBe(0);
    expect(events.notices.join()).toMatch(/declined/);
  }, 10_000);

  test("without a prompt, device mode is refused on a machine that is already signed in", async () => {
    const { stub, dir } = setup();
    enrolled(stub, dir);
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
  test("logout revokes in Bridge and deletes the files; local only deletes", async () => {
    const { stub, dir } = setup();
    const inst = enrolled(stub, dir);
    const { m, events } = manager(dir, stub.url);
    await m.bearer();
    expect(await m.logout(false)).toMatch(/revoked/);
    expect(stub.isRevoked(inst)).toBe(true);
    expect(readInstallation(dir)).toBeNull();
    expect(existsSync(join(dir, "sessions"))).toBe(false);
    expect(events.loggedOut).toBe(1);

    const inst2 = enrolled(stub, dir);
    await m.logout(true);
    expect(stub.isRevoked(inst2)).toBe(false);
    expect(readInstallation(dir)).toBeNull();
  });

  test("BRIDGE_ENROLMENT_KEY enrols once, even when several sessions boot together", async () => {
    const { stub, dir } = setup();
    stub.addEnrolmentKey("brg_ek_test", 5);
    const ms = Array.from({ length: 4 }, (_, i) => manager(dir, stub.url, { key: `k${i}`, enrolmentKey: "brg_ek_test" }).m);
    await Promise.all(ms.map((m) => m.enrolFromKeyIfNeeded()));
    expect(stub.stats.enrols).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")).apiUrl).toBe(stub.url);
    await Promise.all(ms.map((m) => m.bearer()));
    expect(stub.stats.reuse).toBe(0);
  });

  test("after /bridge:logout an enrolment key still in .env does not sign the machine back in; login clears that", async () => {
    const { stub, dir } = setup();
    stub.addEnrolmentKey("brg_ek_again", 5);
    const { m } = manager(dir, stub.url, { enrolmentKey: "brg_ek_again" });
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

  test("a used-up enrolment key tells the person, and nothing is written", async () => {
    const { stub, dir } = setup();
    const { m, events } = manager(dir, stub.url, { enrolmentKey: "brg_ek_spent" });
    await m.enrolFromKeyIfNeeded();
    expect(readInstallation(dir)).toBeNull();
    expect(events.notices.join()).toMatch(/could not enrol/);
  });
});
