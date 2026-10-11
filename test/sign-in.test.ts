/**
 * auth/login.ts (`SignIn`) against the strict stub (agent-auth-stub.ts): what this plugin
 * adds on top of the SDK's AgentClient — profiles and configuration text, the login UX
 * (loopback + browser, device + the person's prompt), logout, the enrolment key and its
 * logged-out marker, D8's newer-format refusal. Mint, lock and chain mechanics are the
 * SDK's own tests; end-to-end behaviour through server.ts is agent-login-e2e.test.ts.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, AgentClientError, isTerminalCredentialError } from "../vendor/bridge-agent-sdk/index.js";
import { withInstallationLock, STALE_MS, LOCK_DIR_NAME } from "../vendor/bridge-agent-sdk/node.js";
import { joinStateSeq } from "../vendor/bridge-agent-sdk/core/index.js";
import { startAuthStub } from "./agent-auth-stub";
import { enrolledProfile, readInstallation, readKey, readState, readAttempt, agentClientOn } from "./key-fixtures";
import { SignIn, describeCredential, waitFor, type SignInDeps } from "../auth/login";
import { resolveProfile } from "../auth/profile";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(stubOpts: Parameters<typeof startAuthStub>[0] = {}) {
  const stub = startAuthStub(stubOpts);
  const dir = mkdtempSync(join(tmpdir(), "sign-in-"));
  cleanups.push(() => stub.stop(), () => rmSync(dir, { recursive: true, force: true }));
  return { stub, dir };
}

function signIn(dir: string, apiUrl: string, { profile, key, ...over }: Partial<Omit<SignInDeps, "profile">> & { profile?: string; key?: string } = {}) {
  const events = { notices: [] as string[], loggedIn: 0, loggedOut: 0 };
  const m = new SignIn({
    rt: createRuntime(),
    profile: resolveProfile(dir, profile),
    envApiUrl: apiUrl,
    enrolmentKey: "",
    sessionKey: async () => key ?? "session-a",
    clientVersion: "9.9.9",
    env: { EINWEAVE_BROWSER: "none" },
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

/** One authenticated use: mints when there is no token. Throws the person's text. */
const use = (m: SignIn) => m.httpAuth("GET", "/api/channels");

const seq = (dir: string) => joinStateSeq(readState(dir)!);

async function until(pred: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await Bun.sleep(20);
  }
  return pred();
}

/** The person's browser: authorize → 302 to the loopback callback → 302 to done. */
async function drive(url: string) {
  const cb = (await fetch(url, { redirect: "manual" })).headers.get("location")!;
  return fetch(cb, { redirect: "manual" });
}

const urlIn = (text: string) => text.match(/https?:\/\/\S+/)![0];

/** A write that cannot land: installation.json is a non-empty directory, so the rename onto it fails. */
function blockInstallationWrite(dir: string): void {
  mkdirSync(join(dir, "installation.json", "x"), { recursive: true });
}

describe("credential errors in this plugin's words", () => {
  test("every SDK code decides what a stopped session waits for", () => {
    const e = (code: AgentClientError["code"]) => new AgentClientError({ code });
    expect(waitFor(e("not_enrolled"))).toBe("files");
    expect(waitFor(e("installation_gone"))).toBe("files");
    expect(waitFor(e("server_mismatch"))).toBe("files");
    for (const c of ["refused", "session_limit", "too_old", "corrupt_state", "update_required", "clock"] as const) expect(waitFor(e(c))).toBe("stop-lift");
    for (const c of ["session_revoked", "network", "rate_limited", "aborted", "declined"] as const) expect(waitFor(e(c))).toBeNull();
    expect(waitFor(new Error("not ours"))).toBeNull();
  });

  test("the SDK's codes become the plugin's sentences", () => {
    expect(describeCredential(new AgentClientError({ code: "installation_gone", reason: "installation_locked" }), "1.0.0")).toStartWith("credential copy detected");
    expect(describeCredential(new AgentClientError({ code: "too_old", minimum: "0.31.0" }), "1.0.0")).toBe(
      "this plugin (1.0.0) is older than Bridge accepts (>= 0.31.0) — /plugin update bridge, then /reload-plugins"
    );
    expect(describeCredential(new AgentClientError({ code: "refused", message: "this Bridge server does not support key credentials (RFC-016)" }), "1.0.0")).toMatch(/must be upgraded/);
    expect(describeCredential(new AgentClientError({ code: "clock" }), "1.0.0")).toMatch(/check the system clock/);
  });
});

describe("profiles and configuration", () => {
  test("a named profile without credentials is an error", async () => {
    const { stub, dir } = setup();
    const { m } = signIn(dir, stub.url, { profile: "reviewer" });
    expect(m.source()).toBe("none");
    await expect(use(m)).rejects.toThrow(/profile "reviewer" is not signed in/);
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
    signIn(dir, "http://127.0.0.1:1");
    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(freshTmp)).toBe(true);
    expect(existsSync(oldTomb)).toBe(false);
    expect(existsSync(freshTomb)).toBe(true);
  });

  test("a EINWEAVE_API_URL with a path is refused up front, with a clear message, and nothing is sent", async () => {
    const { stub, dir } = setup();
    const { m } = signIn(dir, `${stub.url}/bridge`);
    expect(m.configError()).toMatch(/EINWEAVE_API_URL is unusable: .*origin/);
    await expect(use(m)).rejects.toThrow(/origin/);
    expect(await m.login("browser")).toMatch(/origin/);
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
    const { m } = signIn(dir, "https://elsewhere.example");
    await expect(use(m)).rejects.toThrow(/signed in to .* but EINWEAVE_API_URL is https:\/\/elsewhere/);
    expect(stub.stats.mintBodies).toHaveLength(0);
  });

  test("status shows the key's storage and thumbprint, never the key", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m } = signIn(dir, stub.url);
    const s = m.status();
    expect(s).toMatchObject({ credential: "installation", key_storage: "software" });
    expect(s.key_thumbprint).toBe(readInstallation(dir)!.jkt);
    expect(JSON.stringify(s)).not.toContain(readKey(dir)!.d);
  });
});

describe("stop-lift: a stop is about ONE installation", () => {
  test("a stop-class refusal stands until a DIFFERENT installation is on disk — or /bridge:connect", async () => {
    const { stub, dir } = setup({ sessionCap: 0 });
    await enrolledProfile(stub, dir);
    const { m } = signIn(dir, stub.url);
    await expect(use(m)).rejects.toThrow(/too many live sessions/);
    expect((await m.refreshStop())?.code).toBe("session_limit");
    expect((await m.refreshStop())?.code).toBe("session_limit"); // the same installation: still stopped
    await enrolledProfile(stub, dir); // a /bridge:login in ANOTHER window
    expect(await m.refreshStop()).toBeNull();
  });
});

describe("the Session's client", () => {
  test("a half-present sign-in (installation.json without its key) STOPS the session and waits for files — the SDK alone would retry", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    rmSync(join(dir, "key.json"));
    const { m } = signIn(dir, stub.url);
    const c = (await m.sessionClient())!;
    const err = await c.wsAuth().catch((e) => e);
    expect(isTerminalCredentialError(err)).toBe(true);
    expect(waitFor(err)).toBe("files");
    expect(describeCredential(err, "9.9.9")).toMatch(/run \/bridge:login/);
    expect(stub.stats.mintBodies).toHaveLength(0);
  });

  test("no sign-in at all: refused before the store is read, same wait", async () => {
    const { stub, dir } = setup();
    const { m } = signIn(dir, stub.url);
    const err = await (await m.sessionClient())!.wsAuth().catch((e) => e);
    expect(isTerminalCredentialError(err)).toBe(true);
    expect(waitFor(err)).toBe("files");
    expect(describeCredential(err, "9.9.9")).toBe("this machine is not signed in to Bridge — run /bridge:login");
  });
  test("signed in to ANOTHER API: stopped with the configuration text, nothing sent", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m } = signIn(dir, "https://elsewhere.example");
    const err = await (await m.sessionClient())!.wsAuth().catch((e) => e);
    expect(isTerminalCredentialError(err)).toBe(true);
    expect(waitFor(err)).toBe("files");
    expect(describeCredential(err, "9.9.9")).toMatch(/signed in to .* but EINWEAVE_API_URL is https:\/\/elsewhere/);
    expect(stub.stats.discoveryHits).toBe(0);
  });
});

describe("RFC-017 D8: a newer-format installation.json is never mistaken for 'not signed in'", () => {
  async function newerFormatProfile(stub: Parameters<typeof enrolledProfile>[0], dir: string) {
    await enrolledProfile(stub, dir);
    const before = readFileSync(join(dir, "installation.json"), "utf8");
    writeFileSync(join(dir, "installation.json"), JSON.stringify({ ...JSON.parse(before), format: 99 }));
    return () => readFileSync(join(dir, "installation.json"), "utf8");
  }

  test("configError names the D8 message, not 'not signed in'", async () => {
    const { stub, dir } = setup();
    await newerFormatProfile(stub, dir);
    const { m } = signIn(dir, stub.url);
    expect(m.configError()).toBe("this profile was signed in by a newer Bridge plugin — /reload-plugins to use it");
  });

  test("enrolFromKeyIfNeeded refuses: the newer file is byte-identical afterward, and nothing was enrolled", async () => {
    const { stub, dir } = setup();
    const snapshot = await newerFormatProfile(stub, dir);
    const before = snapshot();
    const { m, events } = signIn(dir, stub.url, { enrolmentKey: stub.mintEnrolmentKey(5) });
    await m.enrolFromKeyIfNeeded();
    expect(snapshot()).toBe(before);
    expect(stub.stats.enrols).toBe(1); // only the ORIGINAL enrolment
    expect(events.notices.join()).toBe(""); // headless: never through chat, log only
  });

  test("a /bridge:login run in the stale window refuses up front: no browser, nothing exchanged, the newer file survives", async () => {
    const { stub, dir } = setup();
    const snapshot = await newerFormatProfile(stub, dir);
    const before = snapshot();
    const { m } = signIn(dir, stub.url);
    expect(await m.login("browser")).toBe("this profile was signed in by a newer Bridge plugin — /reload-plugins to use it");
    expect(await m.login("device")).toBe("this profile was signed in by a newer Bridge plugin — /reload-plugins to use it");
    expect(snapshot()).toBe(before);
    expect(readKey(dir)).not.toBeNull();
    expect(stub.stats.discoveryHits).toBe(0);
    expect(stub.stats.revokes).toHaveLength(0);
  });
});

describe("RFC-017 P5: too_old", () => {
  test("the server's minimum is parsed into the message, every file is kept", async () => {
    const { stub, dir } = setup({ tooOldMints: 1 });
    await enrolledProfile(stub, dir);
    const { m } = signIn(dir, stub.url);
    await expect(use(m)).rejects.toThrow("this plugin (9.9.9) is older than Bridge accepts (>= 0.26.0) — /plugin update bridge, then /reload-plugins");
    expect(readInstallation(dir)).not.toBeNull();
    expect(readKey(dir)).not.toBeNull();
    expect(readState(dir)).not.toBeNull();
    await expect(use(m)).rejects.toThrow(/older than Bridge accepts/); // stopped: not asked again
    expect(stub.stats.tokenRequests.client_credentials).toBe(1);
  });

  test("a description with no `>= x.y.z` (client_blocked) falls back gracefully", async () => {
    const { stub, dir } = setup({ tooOldMints: 1, tooOldReason: "client_blocked: bridge-claude-plugin 9.9.9 is withdrawn — /plugin update bridge" });
    await enrolledProfile(stub, dir);
    const { m } = signIn(dir, stub.url);
    await expect(use(m)).rejects.toThrow("this plugin (9.9.9) is older than Bridge accepts — /plugin update bridge, then /reload-plugins");
  });
});

describe("login", () => {
  test("loopback: fresh key bound by dpop_jkt, PKCE, done=connected; the old installation revoked with ITS state, not advanced", async () => {
    const { stub, dir } = setup();
    const old = await enrolledProfile(stub, dir);
    const oldJkt = readInstallation(dir)!.jkt;
    const oldSeq = stub.installation(old)!.seq;
    const { m, events } = signIn(dir, stub.url);
    const url = urlIn(await m.login("browser"));
    const jkt = new URL(url).searchParams.get("dpop_jkt");
    expect(jkt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const done = await drive(url);
    expect(done.headers.get("location")).toBe(`${stub.url}/connect/done?result=connected`);
    const inst = readInstallation(dir)!;
    expect(inst.installationId).not.toBe(old);
    expect(inst.jkt).toBe(jkt!); // C7: the key in the authorize URL exchanged the code
    expect(inst.jkt).not.toBe(oldJkt);
    expect(seq(dir)).toBe(0);
    expect(events.loggedIn).toBe(1);
    expect(events.notices.join()).toMatch(/this machine is connected/);
    expect(await until(() => stub.isRevoked(old) === "installation_revoked")).toBe(true);
    expect(stub.installation(old)!.seq).toBe(oldSeq);
    expect(stub.isRevoked(inst.installationId)).toBeNull();
    expect(stub.stats.locks).toBe(0);
  });

  test("login: when the PREVIOUS installation cannot be revoked, the person is told to revoke it in Settings", async () => {
    const { stub, dir } = setup({ revokeBodyEmpty: true });
    const old = await enrolledProfile(stub, dir);
    const { m, events } = signIn(dir, stub.url);
    await drive(urlIn(await m.login("browser")));
    expect(await until(() => events.notices.some((n) => n.includes("PREVIOUS")))).toBe(true);
    expect(readInstallation(dir)!.installationId).not.toBe(old);
    expect(events.notices.join("\n")).toMatch(/PREVIOUS sign-in .* could not be revoked .* Settings → Agents → Machines/);
  });

  test("login whose new files cannot be written: the new installation is revoked — not left live and unusable — and the person told", async () => {
    // (Revoking a PREVIOUS installation on the same failure is the SDK's writeEnrolment, tested there.)
    const { stub, dir } = setup();
    const { m, events } = signIn(dir, stub.url);
    const url = urlIn(await m.login("browser"));
    blockInstallationWrite(dir);
    const done = await drive(url);
    expect(done.headers.get("location")).toBe(`${stub.url}/connect/done?result=error`);
    expect(readInstallation(dir)).toBeNull();
    expect(stub.stats.enrols).toBe(1);
    expect(await until(() => stub.stats.revokes.length === 1)).toBe(true);
    expect(stub.isRevoked(stub.stats.revokes[0]!.id)).toBe("installation_revoked");
    expect(events.loggedIn).toBe(0);
    expect(events.notices.join()).toMatch(/could not be saved on this machine/);
  });

  test("…and when those revokes fail too, the person is told what STAYS ENROLLED and where to revoke them", async () => {
    const { stub, dir } = setup({ revokeBodyEmpty: true });
    const { m, events } = signIn(dir, stub.url);
    const url = urlIn(await m.login("browser"));
    blockInstallationWrite(dir);
    await drive(url);
    expect(await until(() => events.notices.some((n) => n.includes("could not be saved")))).toBe(true);
    expect(events.notices.join()).toMatch(/"[0-9a-f-]{36}" STAYS ENROLLED in Bridge until you revoke it in Settings → Agents → Machines/);
  });

  test("loopback denied: browser sent to result=denied, credentials untouched, person told", async () => {
    const { stub, dir } = setup({ deny: true });
    const old = await enrolledProfile(stub, dir);
    const { m, events } = signIn(dir, stub.url);
    const done = await drive(urlIn(await m.login("browser")));
    expect(done.headers.get("location")).toBe(`${stub.url}/connect/done?result=denied`);
    expect(await until(() => events.notices.some((n) => n.includes("denied")))).toBe(true);
    expect(readInstallation(dir)!.installationId).toBe(old);
    expect(stub.isRevoked(old)).toBeNull();
  });

  test("loopback listener refuses a foreign Host (DNS rebinding) and a wrong state", async () => {
    const { stub, dir } = setup();
    const { m } = signIn(dir, stub.url);
    const url = new URL(urlIn(await m.login("browser")));
    const redirect = new URL(url.searchParams.get("redirect_uri")!);
    const state = url.searchParams.get("state")!;
    const rebound = await fetch(`${redirect}?code=x&state=${state}&iss=${encodeURIComponent(stub.issuer)}`, { headers: { Host: `evil.example:${redirect.port}` } });
    expect(rebound.status).toBe(403);
    const wrongState = await fetch(`${redirect}?code=x&state=nope&iss=${encodeURIComponent(stub.issuer)}`);
    expect(wrongState.status).toBe(400);
    expect(readInstallation(dir)).toBeNull();
  });

  test("an issuer mismatch (RFC 9207) is refused without exchanging the code", async () => {
    const { stub, dir } = setup();
    const { m, events } = signIn(dir, stub.url);
    const url = new URL(urlIn(await m.login("browser")));
    const redirect = url.searchParams.get("redirect_uri")!;
    const res = await fetch(`${redirect}?code=x&state=${url.searchParams.get("state")}&iss=https://evil.example`, { redirect: "manual" });
    expect(res.headers.get("location")).toBe(`${stub.url}/connect/done?result=error`);
    expect(await until(() => events.notices.some((n) => n.includes("issuer_mismatch")))).toBe(true);
    expect(readInstallation(dir)).toBeNull();
    expect(stub.stats.tokenRequests["authorization_code"] ?? 0).toBe(0);
  });

  test("a pre-RFC-016 server: login refuses up front", async () => {
    const { stub, dir } = setup({ legacyServer: true });
    const { m } = signIn(dir, stub.url);
    expect(await m.login("browser")).toMatch(/must be upgraded/);
  });

  test("device flow: shows the code, polls through pending, completes", async () => {
    const { stub, dir } = setup({ devicePending: 1, deviceIntervalS: 1 });
    const { m, events } = signIn(dir, stub.url);
    const text = await m.login("device");
    expect(text).toContain("BCDF-GHJK");
    expect(text).toContain(`${stub.url}/connect`);
    expect(await until(() => readInstallation(dir) !== null)).toBe(true);
    expect(readKey(dir)).not.toBeNull();
    expect(seq(dir)).toBe(0);
    expect(events.loggedIn).toBe(1);
  }, 10_000);

  test("a second hit on the callback (reload / prefetch) gets the same outcome, not an error", async () => {
    const { stub, dir } = setup();
    const { m } = signIn(dir, stub.url);
    const cb = (await fetch(urlIn(await m.login("browser")), { redirect: "manual" })).headers.get("location")!;
    const [a, b] = await Promise.all([fetch(cb, { redirect: "manual" }), Bun.sleep(20).then(() => fetch(cb, { redirect: "manual" }))]);
    expect(a.headers.get("location")).toBe(`${stub.url}/connect/done?result=connected`);
    expect(b.headers.get("location")).toBe(`${stub.url}/connect/done?result=connected`);
  });

  test("a held callback survives a long wait for the installation lock (no idle-timeout cut)", async () => {
    const { stub, dir } = setup();
    const { m } = signIn(dir, stub.url);
    const cb = (await fetch(urlIn(await m.login("browser")), { redirect: "manual" })).headers.get("location")!;
    // Another session holds the lock for 12 s (past Bun's 10 s default idle timeout).
    const busy = withInstallationLock(dir, () => Bun.sleep(12_000));
    expect(await until(() => existsSync(join(dir, LOCK_DIR_NAME)))).toBe(true);
    const done = await fetch(cb, { redirect: "manual" });
    await busy;
    expect(done.headers.get("location")).toBe(`${stub.url}/connect/done?result=connected`);
  }, 30_000);

  test("logout while the code is being exchanged is not undone by the late exchange; the new installation is revoked", async () => {
    const { stub, dir } = setup({ codeDelayMs: 500 });
    const { m, events } = signIn(dir, stub.url);
    const cb = (await fetch(urlIn(await m.login("browser")), { redirect: "manual" })).headers.get("location")!;
    const done = fetch(cb, { redirect: "manual" });
    expect(await until(() => (stub.stats.tokenRequests["authorization_code"] ?? 0) >= 1)).toBe(true);
    await m.logout(true);
    await done.catch(() => null);
    expect(readInstallation(dir)).toBeNull();
    expect(existsSync(join(dir, "logged-out"))).toBe(true);
    expect(events.loggedIn).toBe(0);
    expect(events.notices.join()).not.toMatch(/is connected/);
    // The late exchange's installation was written, then signed out of AND revoked — even
    // by a local logout: nobody asked for it, so nothing may be left enrolled.
    expect(stub.stats.enrols).toBe(1);
    expect(stub.stats.revokes).toHaveLength(1);
    expect(stub.isRevoked(stub.stats.revokes[0]!.id)).toBe("installation_revoked");
  });

  function prompting(answer: boolean) {
    const seen = { shown: [] as string[], asked: [] as string[] };
    return {
      seen,
      prompt: { available: () => true, show: (m: string) => void seen.shown.push(m), confirm: async (m: string) => (seen.asked.push(m), answer) },
    };
  }

  test("device flow with a prompt: the code goes to the PERSON, never into the tool result", async () => {
    const { stub, dir } = setup({ deviceIntervalS: 1 });
    const p = prompting(true);
    const { m } = signIn(dir, stub.url, { prompt: p.prompt });
    const text = await m.login("device");
    expect(text).not.toContain("BCDF-GHJK");
    expect(p.seen.shown.join()).toContain("BCDF-GHJK");
    expect(await until(() => readInstallation(dir) !== null)).toBe(true);
    expect(p.seen.asked[0]).toContain('@agent-one (Agent One) in workspace "Acme"');
  }, 10_000);

  test("device flow declined in the terminal: nothing stored, the NEW installation revoked, the old one kept", async () => {
    const { stub, dir } = setup({ deviceIntervalS: 1 });
    const old = await enrolledProfile(stub, dir);
    const p = prompting(false);
    const { m, events } = signIn(dir, stub.url, { prompt: p.prompt });
    await m.login("device");
    expect(await until(() => events.notices.some((n) => n.includes("declined")))).toBe(true);
    expect(p.seen.asked[0]).toContain("replaces this machine's current Bridge sign-in");
    expect(readInstallation(dir)!.installationId).toBe(old);
    expect(stub.isRevoked(old)).toBeNull();
    expect(stub.stats.revokes).toHaveLength(1);
    expect(stub.stats.revokes[0]!.id).not.toBe(old);
    expect(events.loggedIn).toBe(0);
  }, 10_000);

  test("a device approval that lands after the login was cancelled is revoked, not dropped", async () => {
    // interval 1 s; the approving poll is in flight 1.0–1.6 s; the logout lands at ~1.2 s.
    const { stub, dir } = setup({ devicePollDelayMs: 600, deviceIntervalS: 1 });
    const { m, events } = signIn(dir, stub.url);
    await m.login("device");
    expect(await until(() => (stub.stats.tokenRequests["urn:ietf:params:oauth:grant-type:device_code"] ?? 0) >= 1)).toBe(true);
    expect(stub.stats.enrols).toBe(0);
    await m.logout(true);
    expect(await until(() => stub.stats.revokes.length > 0)).toBe(true);
    expect(stub.stats.enrols).toBe(1);
    expect(stub.isRevoked(stub.stats.revokes[0]!.id)).toBe("installation_revoked");
    expect(readInstallation(dir)).toBeNull();
    expect(events.loggedIn).toBe(0);
  }, 10_000);

  test("a prompted device login cancelled while its approval is in flight: the person is never asked, the installation revoked", async () => {
    const { stub, dir } = setup({ devicePollDelayMs: 600, deviceIntervalS: 1 });
    const p = prompting(true);
    const { m, events } = signIn(dir, stub.url, { prompt: p.prompt });
    await m.login("device");
    expect(await until(() => (stub.stats.tokenRequests["urn:ietf:params:oauth:grant-type:device_code"] ?? 0) >= 1)).toBe(true);
    await m.logout(true);
    expect(await until(() => stub.stats.revokes.length > 0)).toBe(true);
    expect(p.seen.asked).toEqual([]);
    expect(readInstallation(dir)).toBeNull();
    expect(events.loggedIn).toBe(0);
  }, 10_000);

  test("a STALE flow never clears the current one: device A declined after browser B started — a logout still cancels B", async () => {
    const { stub, dir } = setup({ deviceIntervalS: 1 });
    let answerA!: (ok: boolean) => void;
    const asked: string[] = [];
    const { m, events } = signIn(dir, stub.url, {
      prompt: { available: () => true, show: () => {}, confirm: (msg: string) => (asked.push(msg), new Promise<boolean>((r) => (answerA = r))) },
    });
    await m.login("device"); // A
    expect(await until(() => asked.length === 1)).toBe(true);
    const urlB = urlIn(await m.login("browser")); // B replaces A
    answerA(false); // A is declined — late, it must not touch B's registration
    expect(await until(() => stub.stats.revokes.length === 1)).toBe(true);
    await m.logout(true); // must cancel B
    const cb = (await fetch(urlB, { redirect: "manual" }).catch(() => null))?.headers.get("location");
    if (cb) await fetch(cb, { redirect: "manual" }).catch(() => null);
    expect(await until(() => stub.stats.enrols >= 2, 1_000)).toBe(false); // B's code never exchanged
    expect(readInstallation(dir)).toBeNull();
    expect(events.loggedIn).toBe(0);
  }, 15_000);

  test("without a prompt, device mode is refused on a machine that is already signed in", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m } = signIn(dir, stub.url);
    const text = await m.login("device");
    expect(text).toMatch(/can't prompt you/);
    expect(text).not.toContain("BCDF-GHJK");
  });

  test("headless machines get the device flow automatically", async () => {
    const { stub, dir } = setup();
    const { m } = signIn(dir, stub.url, { env: { SSH_CONNECTION: "1 2 3 4" } });
    expect(await m.login()).toContain("BCDF-GHJK");
  });
});

describe("logout and enrolment keys", () => {
  test("logout revokes with the CURRENT state (verified, not advanced) and deletes the files; local only deletes", async () => {
    const { stub, dir } = setup();
    const inst = await enrolledProfile(stub, dir);
    const { m, events } = signIn(dir, stub.url);
    await use(m);
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
    const { m } = signIn(dir, stub.url);
    await use(m).catch(() => {});
    expect(readAttempt(dir)).not.toBeNull();
    expect(await m.logout(false)).toMatch(/revoked in Bridge/);
    expect(stub.isRevoked(inst)).toBe("installation_revoked");
  });

  test("logout of an installation Bridge already LOCKED says a copy was used — not \"revoked\"", async () => {
    const { stub, dir } = setup();
    const inst = await enrolledProfile(stub, dir);
    const { m } = signIn(dir, stub.url);
    await use(m);
    stub.installation(inst)!.revoked = "installation_locked";
    const text = await m.logout(false);
    expect(text).toMatch(/LOCKED.*copy of its credential/);
    expect(text).not.toMatch(/access was revoked/);
    expect(readInstallation(dir)).toBeNull();
  });

  test("logout with Bridge unreachable: signed out locally and told how to revoke", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m } = signIn(dir, stub.url);
    await use(m);
    stub.stop();
    expect(await m.logout(false)).toMatch(/revoking in Bridge failed/);
    expect(readInstallation(dir)).toBeNull();
  });

  test("EINWEAVE_ENROLMENT_KEY enrols once, even when several sessions boot together", async () => {
    const { stub, dir } = setup();
    const ek = stub.mintEnrolmentKey(5);
    const ms = Array.from({ length: 4 }, (_, i) => signIn(dir, stub.url, { key: `k${i}`, enrolmentKey: ek }).m);
    await Promise.all(ms.map((m) => m.enrolFromKeyIfNeeded()));
    expect(stub.stats.enrols).toBe(1);
    expect(readInstallation(dir)!.apiUrl).toBe(stub.url);
    await Promise.all(ms.map((m) => use(m)));
    expect(stub.stats.locks).toBe(0);
  });

  test("after /bridge:logout an enrolment key still in .env does not sign the machine back in; login clears that", async () => {
    const { stub, dir } = setup();
    const { m } = signIn(dir, stub.url, { enrolmentKey: stub.mintEnrolmentKey(5) });
    await m.enrolFromKeyIfNeeded();
    expect(readInstallation(dir)).not.toBeNull();
    await m.logout(true);
    await m.enrolFromKeyIfNeeded();
    expect(readInstallation(dir)).toBeNull();
    expect(stub.stats.enrols).toBe(1);
    await drive(urlIn(await m.login("browser")));
    expect(await until(() => readInstallation(dir) !== null)).toBe(true);
    expect(existsSync(join(dir, "logged-out"))).toBe(false);
  });

  test("C6: EINWEAVE_ENROLMENT_KEY answered key_already_enrolled twice ⇒ reported", async () => {
    const { stub, dir } = setup({ keyAlreadyEnrolled: 2 });
    const { m, events } = signIn(dir, stub.url, { enrolmentKey: stub.mintEnrolmentKey(5) });
    await m.enrolFromKeyIfNeeded();
    expect(readInstallation(dir)).toBeNull();
    expect(stub.stats.refusals.filter((r) => r.endsWith("key_already_enrolled"))).toHaveLength(2);
    expect(events.notices.join()).toMatch(/could not enrol/);
  });

  test("an enrolment whose files cannot be written: the new installation is revoked, no installation on disk, the person told", async () => {
    const { stub, dir } = setup();
    const { m, events } = signIn(dir, stub.url, { enrolmentKey: stub.mintEnrolmentKey(5) });
    blockInstallationWrite(dir);
    await m.enrolFromKeyIfNeeded();
    expect(readInstallation(dir)).toBeNull();
    expect(stub.stats.enrols).toBe(1);
    expect(stub.stats.revokes).toHaveLength(1);
    expect(stub.isRevoked(stub.stats.revokes[0]!.id)).toBe("installation_revoked");
    expect(events.notices.join()).toMatch(/EINWEAVE_ENROLMENT_KEY enrolled this machine, but its sign-in could not be saved on this machine/);
    expect(events.notices.join()).not.toMatch(/used up or expired/);
  });

  test("…and when that revoke fails, the installation left is named: it STAYS ENROLLED until revoked in Settings", async () => {
    const { stub, dir } = setup({ revokeBodyEmpty: true });
    const { m, events } = signIn(dir, stub.url, { enrolmentKey: stub.mintEnrolmentKey(5) });
    blockInstallationWrite(dir);
    await m.enrolFromKeyIfNeeded();
    expect(readInstallation(dir)).toBeNull();
    expect(events.notices.join()).toMatch(/"[0-9a-f-]{36}" STAYS ENROLLED in Bridge until you revoke it in Settings → Agents → Machines/);
  });

  test("a used-up enrolment key tells the person, and nothing is written", async () => {
    const { stub, dir } = setup();
    const { m, events } = signIn(dir, stub.url, { enrolmentKey: stub.mintEnrolmentKey(0) });
    await m.enrolFromKeyIfNeeded();
    expect(readInstallation(dir)).toBeNull();
    expect(readKey(dir)).toBeNull();
    expect(events.notices.join()).toMatch(/could not enrol/);
  });

  test("a sibling session on this machine mints from the same chain: zero locks", async () => {
    const { stub, dir } = setup();
    await enrolledProfile(stub, dir);
    const { m } = signIn(dir, stub.url);
    await use(m);
    const sibling = await agentClientOn(stub.url, dir, "sibling");
    cleanups.push(() => sibling.stop());
    await sibling.accessToken();
    expect(stub.stats.locks).toBe(0);
  });
});
