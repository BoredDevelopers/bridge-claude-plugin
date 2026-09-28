/**
 * auth/core/protocol.ts `TokenClient` against the strict RFC-016 stub — and the
 * stub's own strictness: each "refused" case below is a guard that must stay red
 * for a wrong client, or every higher-level suite is testing against a pushover.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { createPrivateKey, sign as nodeSign } from "node:crypto";
import { startAuthStub, STUB_CLIENT_ID } from "./agent-auth-stub";
import { TokenClient, OAuthError, TransportError, DiscoveryError, MINT_BUDGET_MS, type AuthMetadata, type FetchLike } from "../auth/core/protocol";
import { classifyTokenError } from "../auth/core/token-errors";
import { STALE_MS } from "../auth/node/lock";
import { Clock } from "../auth/core/clock";
import { generateSoftwareKey, type Signer } from "../auth/core/signer";
import { dpopProof } from "../auth/core/dpop";
import { signJwt } from "../auth/core/jws";
import { CLIENT_ASSERTION_TYPE } from "../auth/core/assertion";
import { parseJws, verifyEs256 } from "./dpop-verify";

const stops: (() => void)[] = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

/** A TokenClient as the plugin builds one; `now` injects a client clock that is off (E12). */
const client = (o: { now?: () => number; fetch?: FetchLike } = {}) => {
  const clock = new Clock(o.now);
  return { clock, tc: new TokenClient({ clock, clientId: STUB_CLIENT_ID, fetch: o.fetch }) };
};

async function setup(opts: Parameters<typeof startAuthStub>[0] = {}) {
  const stub = startAuthStub(opts);
  stops.push(() => stub.stop());
  const { clock, tc } = client();
  const meta = await tc.discover(stub.url);
  const key = await generateSoftwareKey();
  const ek = stub.mintEnrolmentKey(10);
  const g = await tc.enrolWithKey(meta, key.signer, { enrolmentKey: ek, installationName: "t" });
  return { stub, meta, clock, tc, ek, signer: key.signer, key, inst: g.installation_id, state0: g.join_state };
}

const mintWith = (tc: TokenClient, meta: AuthMetadata, signer: Signer, inst: string, joinState: string, attempt: string, sessionKey = "s1", reconnect = false) =>
  tc.mint(meta, signer, { installationId: inst, joinState, attempt, sessionKey, reconnect });

const refused = (p: Promise<unknown>) => p.then(() => null, (e) => e as OAuthError);

test("every retry of one mint fits inside the lock's 120 s stale break (§5.2)", () => {
  expect(MINT_BUDGET_MS).toBeLessThan(STALE_MS);
});

describe("enrolment (§3.2)", () => {
  test("the DPoP proof's key IS the installation key; seq 0; the same key cannot enrol twice", async () => {
    const { stub, meta, tc, ek, signer, inst, state0 } = await setup();
    expect(stub.installation(inst)!.jkt).toBe(signer.jkt);
    expect(stub.installation(inst)!.keyStorage).toBe("software"); // E10: declared by the client
    expect(state0).toStartWith("brg_js_0_");
    const e = await refused(tc.enrolWithKey(meta, signer, { enrolmentKey: ek, installationName: "again" }));
    expect(e).toMatchObject({ error: "invalid_dpop_proof", description: "key_already_enrolled" });
  });

  test("C6: key_already_enrolled is NOT retried with the same key (only a fresh key can pass)", async () => {
    const stub = startAuthStub({ keyAlreadyEnrolled: 5 });
    stops.push(() => stub.stop());
    const ek = stub.mintEnrolmentKey(5);
    const { tc } = client();
    const meta = await tc.discover(stub.url);
    const key = (await generateSoftwareKey()).signer;
    const e = await refused(tc.enrolWithKey(meta, key, { enrolmentKey: ek, installationName: "x" }));
    expect(e).toMatchObject({ error: "invalid_dpop_proof", description: "key_already_enrolled" });
    expect(stub.stats.refusals.filter((r) => r.endsWith("key_already_enrolled"))).toHaveLength(1);
  });

  test("C7: a code bound to one key (dpop_jkt) redeemed with another is refused invalid_grant and BURNT; C9: a replayed code locks what it enrolled", async () => {
    const { stub, meta, tc } = await setup();
    const authorize = async (jkt: string) => {
      const verifier = "v".repeat(43);
      const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
      const redirect = "http://127.0.0.1:1/callback";
      const q = new URLSearchParams({ response_type: "code", client_id: "bridge-claude-plugin", redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "s", dpop_jkt: jkt });
      const loc = (await fetch(`${meta.authorization_endpoint}?${q}`, { redirect: "manual" })).headers.get("location")!;
      return { code: new URL(loc).searchParams.get("code")!, verifier, redirectUri: redirect };
    };
    const a = (await generateSoftwareKey()).signer;
    const b = (await generateSoftwareKey()).signer;
    const c1 = await authorize(a.jkt);
    // As the server: invalid_grant with NO description (the reason is only in the stub's stats).
    const mismatch = await refused(tc.exchangeCode(meta, b, c1));
    expect(mismatch).toMatchObject({ error: "invalid_grant" });
    expect(mismatch!.description).toBeUndefined();
    expect(stub.stats.refusals).toContain("token/authorization_code:dpop_jkt_mismatch");
    expect(await refused(tc.exchangeCode(meta, a, c1))).toMatchObject({ error: "invalid_grant" }); // burnt
    const c2 = await authorize(a.jkt);
    const g = await tc.exchangeCode(meta, a, c2);
    expect(await refused(tc.exchangeCode(meta, (await generateSoftwareKey()).signer, c2))).toMatchObject({ error: "invalid_grant" });
    expect(stub.isRevoked(g.installation_id)).toBe("installation_locked");
  });
});

describe("mint (§3.3) and the join-state chain (E6)", () => {
  test("advances the chain, returns a DPoP token + the next state + a session", async () => {
    const { stub, meta, tc, signer, inst, state0 } = await setup();
    const g = await mintWith(tc, meta, signer, inst, state0, "a".repeat(43));
    expect(g.token_type).toBe("DPoP");
    expect(g.join_state).toStartWith("brg_js_1_");
    expect(stub.stats).toMatchObject({ mints: 1, replays: 0, locks: 0 });
  });

  test("replay: previous state + the SAME attempt ⇒ the same successor, no lock (E6b)", async () => {
    const { stub, meta, tc, signer, inst, state0 } = await setup();
    const g1 = await mintWith(tc, meta, signer, inst, state0, "a".repeat(43));
    const g2 = await mintWith(tc, meta, signer, inst, state0, "a".repeat(43));
    expect(g2.join_state).toBe(g1.join_state);
    expect(stub.stats).toMatchObject({ replays: 1, locks: 0 });
  });

  test("previous state with ANOTHER attempt ⇒ locked; then every presentation is installation_locked (E6d/E8)", async () => {
    const { stub, meta, tc, signer, inst, state0 } = await setup();
    const g1 = await mintWith(tc, meta, signer, inst, state0, "a".repeat(43));
    expect(await refused(mintWith(tc, meta, signer, inst, state0, "b".repeat(43)))).toMatchObject({ error: "invalid_client", description: "installation_locked" });
    expect(stub.stats.locks).toBe(1);
    expect(await refused(mintWith(tc, meta, signer, inst, g1.join_state, "c".repeat(43)))).toMatchObject({ description: "installation_locked" });
  });

  test("C4: a missing or malformed attempt is attempt_invalid and does NOT lock", async () => {
    const { stub, meta, tc, signer, inst, state0 } = await setup();
    expect(await refused(mintWith(tc, meta, signer, inst, state0, "short"))).toMatchObject({ error: "invalid_request", description: "attempt_invalid" });
    expect(await refused(mintWith(tc, meta, signer, inst, state0, "a".repeat(40) + "!!!"))).toMatchObject({ description: "attempt_invalid" });
    expect(stub.stats.locks).toBe(0);
    expect((await mintWith(tc, meta, signer, inst, state0, "a".repeat(43))).join_state).toStartWith("brg_js_1_");
  });

  test("an OLDER state (two back) locks; a bad CRC is corrupt_state and does NOT lock", async () => {
    const { stub, meta, tc, signer, inst, state0 } = await setup();
    const g1 = await mintWith(tc, meta, signer, inst, state0, "a".repeat(43));
    const bad = g1.join_state.slice(0, -1) + (g1.join_state.endsWith("A") ? "B" : "A");
    expect(await refused(mintWith(tc, meta, signer, inst, bad, "x".repeat(43)))).toMatchObject({ error: "invalid_request", description: "corrupt_state" });
    expect(stub.stats.locks).toBe(0);
    await mintWith(tc, meta, signer, inst, g1.join_state, "b".repeat(43));
    expect(await refused(mintWith(tc, meta, signer, inst, state0, "a".repeat(43)))).toMatchObject({ description: "installation_locked" });
  });

  test("request validation precedes client authentication, as on the server: corrupt_state / attempt_invalid / session_key_invalid", async () => {
    const { stub, meta, tc, signer, inst, state0 } = await setup();
    const bad = state0.slice(0, -1) + (state0.endsWith("A") ? "B" : "A");
    // An unknown client_id would be installation_unknown — but the request is judged first.
    expect(await refused(mintWith(tc, meta, signer, "not-an-installation", bad, "a".repeat(43)))).toMatchObject({ error: "invalid_request", description: "corrupt_state" });
    expect(await refused(mintWith(tc, meta, signer, "not-an-installation", state0, "short"))).toMatchObject({ error: "invalid_request", description: "attempt_invalid" });
    expect(await refused(mintWith(tc, meta, signer, "not-an-installation", state0, "a".repeat(43), "has:colon"))).toMatchObject({ error: "invalid_request", description: "session_key_invalid" });
    const rv = (installationId: string, joinState: string, scope: any = "installation") => tc.revoke(meta, signer, { installationId, joinState, attempt: null, scope });
    // Revoke, as on the server: scope → corrupt_state → attempt → session_key, all before authentication.
    expect(await refused(rv("not-an-installation", bad, "everything"))).toMatchObject({ error: "invalid_request", description: "scope_invalid" });
    expect(await refused(rv("not-an-installation", bad))).toMatchObject({ error: "invalid_request", description: "corrupt_state" });
    expect(await refused(rv("not-an-installation", state0, "session"))).toMatchObject({ error: "invalid_request", description: "session_key_invalid" });
    expect(stub.stats).toMatchObject({ mints: 0, locks: 0 });
    expect(stub.isRevoked(inst)).toBeNull();
  });

  test("a wrong key (not the installation's) is refused before the chain is touched", async () => {
    const { stub, meta, tc, inst, state0 } = await setup();
    const other = (await generateSoftwareKey()).signer;
    // Its proof verifies (self-signed), its assertion does not verify against the registered key.
    expect(await refused(mintWith(tc, meta, other, inst, state0, "a".repeat(43)))).toMatchObject({ error: "invalid_client", description: "assertion_invalid" });
    expect(stub.stats).toMatchObject({ mints: 0, locks: 0 });
  });

  test("an unknown installation is assertion_invalid, never installation_unknown (no enumeration oracle, as the server)", async () => {
    const { stub, meta, tc, signer, state0 } = await setup();
    const e = await refused(mintWith(tc, meta, signer, crypto.randomUUID(), state0, "a".repeat(43)));
    expect(e).toMatchObject({ error: "invalid_client", description: "assertion_invalid" });
    expect(classifyTokenError(e)).toEqual({ kind: "clock" }); // C13: stop, keep the files
    expect(stub.stats.refusals).toContain("token/client_credentials:unknown_client");
    // A malformed client_id is judged BEFORE the proof (server order): no proof at all still says assertion_invalid.
    const r = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: "not-a-uuid", client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: "x.y.z", join_state: state0, attempt: "a".repeat(43), session_key: "s" }),
    });
    expect(await r.json()).toMatchObject({ error: "invalid_client", error_description: "assertion_invalid" });
  });

  test("session_revoked without reconnect; reconnect=true opens a new session (E9)", async () => {
    const { stub, meta, tc, signer, inst, state0 } = await setup();
    const g1 = await mintWith(tc, meta, signer, inst, state0, "a".repeat(43));
    stub.revokeSession(g1.session_id);
    expect(await refused(mintWith(tc, meta, signer, inst, g1.join_state, "b".repeat(43)))).toMatchObject({ error: "invalid_grant", description: "session_revoked" });
    // The refusal rolled back: the SAME state is still current.
    const g3 = await mintWith(tc, meta, signer, inst, g1.join_state, "b".repeat(43), "s1", true);
    expect(g3.session_id).not.toBe(g1.session_id);
    expect(stub.stats.locks).toBe(0);
  });

  test("clock skew: a server 10 min ahead refuses the first assertion; the retry uses its Date and succeeds", async () => {
    const { stub, meta, signer, inst, state0 } = await setup();
    // A fresh client whose machine clock is 10 min behind, never taught by an answer yet.
    const { tc } = client({ now: () => Date.now() - 600_000 });
    const g = await mintWith(tc, meta, signer, inst, state0, "a".repeat(43));
    expect(g.join_state).toStartWith("brg_js_1_");
    expect(stub.stats.refusals.some((r) => r.includes("iat"))).toBe(true);
  });

  test("use_dpop_nonce: retried once with the server's nonce (E12)", async () => {
    const { stub, meta, tc, signer, inst, state0 } = await setup({ requireNonce: true });
    stub.rotateNonce();
    const g = await mintWith(tc, meta, signer, inst, state0, "a".repeat(43));
    expect(g.token_type).toBe("DPoP");
    expect(stub.stats.refusals.filter((r) => r.endsWith("use_dpop_nonce")).length).toBeGreaterThanOrEqual(1);
  });

  test("a mint answered with any token_type but DPoP is refused, never used", async () => {
    const { meta, tc, signer, inst, state0 } = await setup({ mintTokenType: "Bearer" });
    expect(await refused(mintWith(tc, meta, signer, inst, state0, "a".repeat(43)))).toMatchObject({ error: "invalid_response" });
  });

  test("the RFC-014 grants are retired as the server retires them: invalid_grant rfc014_retired (E13)", async () => {
    const { stub } = await setup();
    for (const grant_type of ["refresh_token", "urn:bridge:params:oauth:grant-type:session"]) {
      const r = await fetch(`${stub.url}/api/agent-auth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type }) });
      const j = (await r.json()) as any;
      expect(r.status).toBe(400);
      expect(j.error).toBe("invalid_grant");
      expect(j.error_description).toStartWith("rfc014_retired: ");
      expect(classifyTokenError(new OAuthError({ error: j.error, status: r.status, description: j.error_description }))).toEqual({ kind: "update_required" });
    }
    const r = await fetch(`${stub.url}/api/agent-auth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "password" }) });
    expect(((await r.json()) as any).error).toBe("unsupported_grant_type");
  });
});

describe("the stub refuses what a wrong client would send", () => {
  test("enrolment in the server's order: secret format (invalid_grant) → key_storage → proof (dpop_proof_required)", async () => {
    const { stub } = await setup();
    const post = (body: object) =>
      fetch(`${stub.url}/api/agent-auth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as any);
    const EK = "urn:bridge:params:oauth:grant-type:enrolment-key";
    // A malformed / bad-CRC secret is judged first, before key_storage and before the proof.
    expect(await post({ grant_type: EK, enrolment_key: "brg_ek_t", key_storage: "tpm" })).toEqual({ error: "invalid_grant" });
    const ek = stub.mintEnrolmentKey();
    const badCrc = ek.slice(0, -1) + (ek.endsWith("A") ? "B" : "A");
    expect(await post({ grant_type: EK, enrolment_key: badCrc, key_storage: "tpm" })).toEqual({ error: "invalid_grant" });
    expect(await post({ grant_type: EK, enrolment_key: ek, key_storage: "tpm" })).toMatchObject({ error: "invalid_request", error_description: "key_storage_invalid" });
    expect(await post({ grant_type: EK, enrolment_key: ek, installation_name: "x" })).toMatchObject({
      error: "invalid_dpop_proof",
      error_description: expect.stringMatching(/^dpop_proof_required: /),
    });
    expect(() => stub.addEnrolmentKey("brg_ek_t")).toThrow(/well-formed/);
  });

  test("an authorization code is burnt by ANY mismatch (client_id, redirect_uri, verifier) — one try, as the server", async () => {
    const { stub, meta, tc } = await setup();
    const authorize = async () => {
      const verifier = "v".repeat(43);
      const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
      const redirect = "http://127.0.0.1:1/callback";
      const q = new URLSearchParams({ response_type: "code", client_id: STUB_CLIENT_ID, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "s" });
      const loc = (await fetch(`${meta.authorization_endpoint}?${q}`, { redirect: "manual" })).headers.get("location")!;
      return { code: new URL(loc).searchParams.get("code")!, verifier, redirectUri: redirect };
    };
    const other = new TokenClient({ clock: new Clock(), clientId: "someone-else" });
    for (const [label, wrong] of [
      ["client_id", async (c: any, k: Signer) => other.exchangeCode(meta, k, c)],
      ["redirect_uri", async (c: any, k: Signer) => tc.exchangeCode(meta, k, { ...c, redirectUri: "http://127.0.0.1:2/callback" })],
      ["pkce", async (c: any, k: Signer) => tc.exchangeCode(meta, k, { ...c, verifier: "w".repeat(43) })],
    ] as const) {
      const c = await authorize();
      const k = (await generateSoftwareKey()).signer;
      expect(await refused(wrong(c, k))).toMatchObject({ error: "invalid_grant" });
      expect(stub.stats.refusals).toContain(`token/authorization_code:${label}`);
      expect(await refused(tc.exchangeCode(meta, k, c))).toMatchObject({ error: "invalid_grant" }); // burnt
    }
    // The authorize endpoint refuses an unknown client outright (never redirects).
    const q = new URLSearchParams({ response_type: "code", client_id: "nope", redirect_uri: "http://127.0.0.1:1/cb", code_challenge: "c".repeat(43), code_challenge_method: "S256", state: "s" });
    expect((await fetch(`${meta.authorization_endpoint}?${q}`, { redirect: "manual" })).status).toBe(400);
  });

  test("device grant as the server: client_id checked, every poll proves the key, pending / slow_down / access_denied / expired_token", async () => {
    const stub = startAuthStub({ devicePending: 1 }); // server default interval: 5 s
    stops.push(() => stub.stop());
    const { tc } = client();
    const meta = await tc.discover(stub.url);
    const k = (await generateSoftwareKey()).signer;
    const d = await tc.deviceAuthorization(meta, "mac");
    expect(d.interval).toBe(5);
    expect(await refused(new TokenClient({ clock: new Clock(), clientId: "nope" }).deviceAuthorization(meta, "mac"))).toMatchObject({ error: "invalid_client" });
    // A pending poll still needs the proof (and a sane key_storage), as the server's enrolmentKey() runs every poll.
    const raw = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: d.device_code, client_id: STUB_CLIENT_ID }),
    });
    expect(await raw.json()).toMatchObject({ error: "invalid_dpop_proof", error_description: expect.stringMatching(/^dpop_proof_required: /) });
    expect(await refused(new TokenClient({ clock: new Clock(), clientId: "nope" }).pollDeviceCode(meta, k, d.device_code))).toMatchObject({ error: "invalid_grant" });
    const p1 = await refused(tc.pollDeviceCode(meta, k, d.device_code));
    expect(p1).toMatchObject({ error: "authorization_pending" });
    expect(classifyTokenError(p1)).toEqual({ kind: "pending" });
    const p2 = await refused(tc.pollDeviceCode(meta, k, d.device_code)); // < 5 s later
    expect(p2).toMatchObject({ error: "slow_down" });
    expect(classifyTokenError(p2)).toEqual({ kind: "slow_down" });

    for (const [o, want] of [
      [{ deviceDeny: true }, "access_denied"],
      [{ deviceExpire: true }, "expired_token"],
    ] as const) {
      const st = startAuthStub(o);
      stops.push(() => st.stop());
      const c2 = client();
      const m2 = await c2.tc.discover(st.url);
      const d2 = await c2.tc.deviceAuthorization(m2, "mac");
      const e = await refused(c2.tc.pollDeviceCode(m2, k, d2.device_code));
      expect(e).toMatchObject({ error: want });
      expect(classifyTokenError(e)).toEqual({ kind: "refused" });
    }
    // Paced polling succeeds.
    const fast = startAuthStub({ devicePending: 1, deviceIntervalS: 0 });
    stops.push(() => fast.stop());
    const c3 = client();
    const m3 = await c3.tc.discover(fast.url);
    const d3 = await c3.tc.deviceAuthorization(m3, "mac");
    expect(await refused(c3.tc.pollDeviceCode(m3, k, d3.device_code))).toMatchObject({ error: "authorization_pending" });
    const g = await c3.tc.pollDeviceCode(m3, k, d3.device_code);
    expect(fast.installation(g.installation_id)!.jkt).toBe(k.jkt);
  });

  test("every stub answer carries its skewed Date — a 502 and a redirect too", async () => {
    const stub = startAuthStub({ clockSkewS: 600, discoveryFail: 1 });
    stops.push(() => stub.stop());
    const skewOf = (r: Response) => Date.parse(r.headers.get("date")!) - Date.now();
    const bad = await fetch(`${stub.url}/.well-known/oauth-authorization-server/api/agent-auth`);
    expect(bad.status).toBe(502);
    expect(Math.abs(skewOf(bad) - 600_000)).toBeLessThan(2_000);
    const q = new URLSearchParams({ response_type: "code", client_id: STUB_CLIENT_ID, redirect_uri: "http://127.0.0.1:1/cb", code_challenge: "c".repeat(43), code_challenge_method: "S256", state: "s" });
    const redirect = await fetch(`${stub.url}/api/agent-auth/authorize?${q}`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(Math.abs(skewOf(redirect) - 600_000)).toBeLessThan(2_000);
    const nf = await fetch(`${stub.url}/nowhere`);
    expect(Math.abs(skewOf(nf) - 600_000)).toBeLessThan(2_000);
  });

  test("a proof whose jwk spells x NON-canonically (same point, another jkt) is refused, as the server's es256.ts does", async () => {
    const { stub } = await setup();
    const { signer } = await generateSoftwareKey();
    const B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const x = signer.publicJwk.x;
    const i = B.indexOf(x[42]!);
    const loose = x.slice(0, 42) + B[i + 1]!; // canonical has the 2 low bits clear; set one
    expect(Buffer.from(loose, "base64url").equals(Buffer.from(x, "base64url"))).toBe(true);
    const url = `${stub.url}/api/agent-auth/token`;
    const proof = await signJwt(signer, { typ: "dpop+jwt", jwk: { ...signer.publicJwk, x: loose } }, { jti: crypto.randomUUID(), htm: "POST", htu: url, iat: Math.floor(Date.now() / 1000) });
    const ekNc = stub.mintEnrolmentKey(1);
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", DPoP: proof },
      body: JSON.stringify({ grant_type: "urn:bridge:params:oauth:grant-type:enrolment-key", enrolment_key: ekNc, installation_name: "x" }),
    });
    // The server answers a bad proof WITHOUT a description (measured, key-credentials-real-api); the stub records why.
    expect(await r.json()).toEqual({ error: "invalid_dpop_proof" });
    expect(stub.stats.refusals.at(-1)).toEndWith(":jwk");
  });

  test("a valid assertion with a proof by ANOTHER key is refused invalid_dpop_proof (proof jkt = registered key)", async () => {
    const { meta, signer, inst, state0, clock, stub } = await setup();
    const other = (await generateSoftwareKey()).signer;
    const iat = clock.nowS();
    const assertion = await signJwt(signer, { typ: "client-authentication+jwt", kid: signer.jkt }, { iss: inst, sub: inst, aud: meta.issuer, jti: crypto.randomUUID(), iat, exp: iat + 60 });
    const r = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", DPoP: await dpopProof(other, clock, { htm: "POST", htu: meta.token_endpoint }) },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: inst, client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: assertion, join_state: state0, attempt: "a".repeat(43), session_key: "s" }),
    });
    // The server answers a bad proof WITHOUT a description (measured, key-credentials-real-api); the stub records why.
    expect(await r.json()).toEqual({ error: "invalid_dpop_proof" });
    expect(stub.stats.refusals.at(-1)).toEndWith(":jkt");
    expect(stub.stats).toMatchObject({ mints: 0, locks: 0 });
  });

  test("a proof with a `crit` header is refused (the server's es256.ts refuses any crit)", async () => {
    const { meta, signer, inst, state0, clock, stub } = await setup();
    const proof = await signJwt(signer, { typ: "dpop+jwt", jwk: signer.publicJwk, crit: ["x"], x: 1 }, { jti: crypto.randomUUID(), htm: "POST", htu: meta.token_endpoint, iat: clock.nowS() });
    const iat = clock.nowS();
    const assertion = await signJwt(signer, { typ: "client-authentication+jwt", kid: signer.jkt }, { iss: inst, sub: inst, aud: meta.issuer, jti: crypto.randomUUID(), iat, exp: iat + 60 });
    const r = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", DPoP: proof },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: inst, client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: assertion, join_state: state0, attempt: "a".repeat(43), session_key: "s" }),
    });
    // The server answers a bad proof WITHOUT a description (measured, key-credentials-real-api); the stub records why.
    expect(await r.json()).toEqual({ error: "invalid_dpop_proof" });
    expect(stub.stats.refusals.at(-1)).toEndWith(":crit");
    expect(stub.stats.mints).toBe(0);
  });

  test("an assertion whose aud is an ARRAY is refused (rfc7523bis: the issuer as sole STRING value)", async () => {
    const { meta, signer, inst, state0, clock, stub } = await setup();
    const iat = clock.nowS();
    const assertion = await signJwt(signer, { typ: "client-authentication+jwt", kid: signer.jkt }, { iss: inst, sub: inst, aud: [meta.issuer], jti: crypto.randomUUID(), iat, exp: iat + 60 });
    const r = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", DPoP: await dpopProof(signer, clock, { htm: "POST", htu: meta.token_endpoint }) },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: inst, client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: assertion, join_state: state0, attempt: "a".repeat(43), session_key: "s" }),
    });
    expect(await r.json()).toMatchObject({ error: "invalid_client", error_description: "assertion_invalid" });
    expect(stub.stats.refusals).toContain("token/client_credentials:assertion_aud");
  });

  test("a DER-encoded ES256 signature is refused (JWS wants raw r‖s)", async () => {
    const { key } = await setup();
    const priv = createPrivateKey({ key: { ...key.privateJwk }, format: "jwk" });
    const input = "e30.e30";
    const der = nodeSign("sha256", Buffer.from(input), { key: priv, dsaEncoding: "der" });
    const jws = parseJws(`${input}.${der.toString("base64url")}`)!;
    jws.header.alg = "ES256";
    expect(verifyEs256(jws, key.signer.publicJwk)).toBe(false);
  });

  test("resource: Bearer, a wrong htu, and a replayed proof are all 401", async () => {
    const { stub, meta, tc, signer, inst, state0, clock } = await setup();
    const g = await mintWith(tc, meta, signer, inst, state0, "a".repeat(43));
    const url = `${stub.url}/api/channels`;
    // Bearer use of a DPoP-bound token ⇒ 401 even WITH a valid proof (E3).
    const bearer = await fetch(url, {
      headers: { Authorization: `Bearer ${g.access_token}`, DPoP: await dpopProof(signer, clock, { htm: "GET", htu: url, accessToken: g.access_token }) },
    });
    expect(bearer.status).toBe(401);
    expect(bearer.headers.get("www-authenticate")).toContain("DPoP");
    const wrongHtu = await fetch(url, {
      headers: { Authorization: `DPoP ${g.access_token}`, DPoP: await dpopProof(signer, clock, { htm: "GET", htu: `${stub.url}/api/agents`, accessToken: g.access_token }) },
    });
    expect(wrongHtu.status).toBe(401);
    const proof = await dpopProof(signer, clock, { htm: "GET", htu: url, accessToken: g.access_token });
    expect((await fetch(url, { headers: { Authorization: `DPoP ${g.access_token}`, DPoP: proof } })).status).toBe(200);
    expect((await fetch(url, { headers: { Authorization: `DPoP ${g.access_token}`, DPoP: proof } })).status).toBe(401);
  });
});

describe("revoke (§3.5)", () => {
  test("with the current state: revoked, NOT advanced (a mint right after would still present that state)", async () => {
    const { stub, meta, tc, signer, inst, state0 } = await setup();
    const g1 = await mintWith(tc, meta, signer, inst, state0, "a".repeat(43));
    const seqBefore = stub.installation(inst)!.seq;
    await tc.revoke(meta, signer, { installationId: inst, joinState: g1.join_state, attempt: null, scope: "session", sessionKey: "s1" });
    expect(stub.installation(inst)!.seq).toBe(seqBefore);
    expect(stub.installation(inst)!.revoked).toBeNull();
    const g2 = await mintWith(tc, meta, signer, inst, g1.join_state, "b".repeat(43), "s1", true);
    expect(g2.join_state).toStartWith("brg_js_2_");
  });

  test("with a stale state: LOCKED, not revoked — a thief cannot revoke to hide", async () => {
    const { stub, meta, tc, signer, inst, state0 } = await setup();
    const g1 = await mintWith(tc, meta, signer, inst, state0, "a".repeat(43));
    await mintWith(tc, meta, signer, inst, g1.join_state, "b".repeat(43));
    expect(await refused(tc.revoke(meta, signer, { installationId: inst, joinState: state0, attempt: null, scope: "installation" }))).toMatchObject({ description: "installation_locked" });
    expect(stub.isRevoked(inst)).toBe("installation_locked");
  });

  test('C11: a revoke answered without {"ok":true} is not taken as success', async () => {
    const { meta, tc, signer, inst, state0 } = await setup({ revokeBodyEmpty: true });
    expect(await refused(tc.revoke(meta, signer, { installationId: inst, joinState: state0, attempt: null, scope: "installation" }))).toMatchObject({ error: "invalid_response" });
  });

  test("a CLIENT's session revoke is `client_revoked`: the next mint with that session_key opens a NEW session, no reconnect needed (E9)", async () => {
    const { stub, meta, tc, signer, inst, state0 } = await setup();
    const g1 = await mintWith(tc, meta, signer, inst, state0, "a".repeat(43));
    await tc.revoke(meta, signer, { installationId: inst, joinState: g1.join_state, attempt: null, scope: "session", sessionKey: "s1" });
    expect(stub.sessions.get(g1.session_id)!.revoked).toBe("client_revoked");
    const g2 = await mintWith(tc, meta, signer, inst, g1.join_state, "b".repeat(43)); // reconnect=false
    expect(g2.session_id).not.toBe(g1.session_id);
  });

  test("revoking an unknown session is a no-op answered {\"ok\":true} (C11, as the server)", async () => {
    const { stub, meta, tc, signer, inst, state0 } = await setup();
    await tc.revoke(meta, signer, { installationId: inst, joinState: state0, attempt: null, scope: "session", sessionKey: "never-minted" });
    expect(stub.isRevoked(inst)).toBeNull();
  });

  test("previous state + its attempt passes (a mint whose answer was lost)", async () => {
    const { stub, meta, tc, signer, inst, state0 } = await setup();
    await mintWith(tc, meta, signer, inst, state0, "a".repeat(43));
    await tc.revoke(meta, signer, { installationId: inst, joinState: state0, attempt: "a".repeat(43), scope: "installation" });
    expect(stub.isRevoked(inst)).toBe("installation_revoked");
  });
});

/** What the TokenClient throws when the answer is not a well-formed OAuth answer — or no answer at all. */
describe("TokenClient failure shapes (classifyTokenError input)", () => {
  /** A token endpoint that answers `respond(req)` — a proxy in front of Bridge. */
  function fakeAs(respond: (req: Request) => Response | Promise<Response>) {
    const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: respond });
    stops.push(() => srv.stop(true));
    const base = `http://127.0.0.1:${srv.port}`;
    const meta: AuthMetadata = {
      issuer: `${base}/api/agent-auth`,
      authorization_endpoint: `${base}/api/agent-auth/authorize`,
      device_authorization_endpoint: `${base}/api/agent-auth/device_authorization`,
      token_endpoint: `${base}/api/agent-auth/token`,
      revocation_endpoint: `${base}/api/agent-auth/revoke`,
    };
    return meta;
  }
  const mintAt = async (meta: AuthMetadata) =>
    refused(mintWith(client().tc, meta, (await generateSoftwareKey()).signer, crypto.randomUUID(), "brg_js_0_" + "A".repeat(49), "a".repeat(43)));

  test("no answer (connection refused) ⇒ TransportError ⇒ transient", async () => {
    const e = await mintAt({ ...fakeAs(() => new Response("")), token_endpoint: "http://127.0.0.1:1/api/agent-auth/token" });
    expect(e).toBeInstanceOf(TransportError);
    expect(classifyTokenError(e)).toEqual({ kind: "transient" });
  });

  test("a body cut off mid-read ⇒ TransportError (a lost answer, not a malformed one)", async () => {
    // Raw TCP: a 200 promising 1000 bytes, then the socket closes after 24.
    const srv = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(sock) {
          sock.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"access_token":"brg_at_');
          sock.flush();
          setTimeout(() => sock.end(), 50);
        },
      },
    });
    stops.push(() => srv.stop(true));
    const base = `http://127.0.0.1:${srv.port}`;
    const e = await mintAt({ ...fakeAs(() => new Response("")), issuer: `${base}/api/agent-auth`, token_endpoint: `${base}/api/agent-auth/token` });
    expect(e).toBeInstanceOf(TransportError);
    expect(classifyTokenError(e)).toEqual({ kind: "transient" });
  });

  test("a proxy's HTML error pages become status-based OAuthErrors: 403 refused, 502 transient, 429 rate_limited", async () => {
    const html = (status: number, extra: Record<string, string> = {}) =>
      fakeAs(() => new Response("<html><body>Access denied</body></html>", { status, headers: { "Content-Type": "text/html", ...extra } }));
    const e403 = await mintAt(html(403));
    expect(e403).toMatchObject({ name: "OAuthError", error: "http_403", status: 403 });
    expect(classifyTokenError(e403)).toEqual({ kind: "refused" });
    const e502 = await mintAt(html(502));
    expect(e502).toMatchObject({ name: "OAuthError", error: "http_502", status: 502 });
    expect(classifyTokenError(e502)).toEqual({ kind: "transient" });
    const e429 = await mintAt(html(429, { "Retry-After": "7" }));
    expect(e429).toMatchObject({ name: "OAuthError", error: "rate_limited", status: 429, retryAfterS: 7 });
    expect(classifyTokenError(e429)).toEqual({ kind: "rate_limited", retryAfterS: 7 });
    // JSON, but not an RFC 6749 §5.2 object.
    const odd = await mintAt(fakeAs(() => Response.json({ error: 42 }, { status: 400 })));
    expect(odd).toMatchObject({ error: "http_400", status: 400 });
    // A 200 that is not a mint answer.
    const ok = await mintAt(fakeAs(() => new Response("<html>ok</html>", { status: 200 })));
    expect(ok).toMatchObject({ error: "invalid_response" });
  });

  test("the server's Date is learnt from EVERY token-endpoint answer, a refusal included (E12)", async () => {
    const { meta, signer, inst, state0 } = await setup({ clockSkewS: 600 });
    const { tc, clock } = client(); // a fresh client: offset 0, nothing learnt yet
    expect(clock.offset()).toBe(0);
    const bad = state0.slice(0, -1) + (state0.endsWith("A") ? "B" : "A");
    expect(await refused(mintWith(tc, meta, signer, inst, bad, "a".repeat(43)))).toMatchObject({ description: "corrupt_state" });
    expect(Math.abs(clock.offset() - 600_000)).toBeLessThan(2_000);
  });

  test("the proof's htu is the endpoint's origin + path: a query on the advertised endpoint is not signed into it (C16)", async () => {
    const { meta, tc, signer, inst, state0, stub } = await setup();
    const g = await mintWith(tc, { ...meta, token_endpoint: `${meta.token_endpoint}?via=proxy#f` }, signer, inst, state0, "a".repeat(43));
    expect(g.token_type).toBe("DPoP");
    expect(stub.stats.refusals).toEqual([]);
  });

  test("a trailing-slash apiUrl: discovery and every proof's htu stay single-slash (C16)", async () => {
    const stub = startAuthStub();
    stops.push(() => stub.stop());
    // Bun.serve collapses `//` in req.url, so the stub cannot see a doubled slash: record what the client ASKED for.
    const asked: string[] = [];
    const { tc } = client({ fetch: (input, init) => (asked.push(input), fetch(input, init)) });
    const meta = await tc.discover(`${stub.url}/`);
    expect(asked).toEqual([`${stub.url}/.well-known/oauth-authorization-server/api/agent-auth`]);
    expect(meta.token_endpoint).toBe(`${stub.url}/api/agent-auth/token`);
    const { signer } = await generateSoftwareKey();
    const g = await tc.enrolWithKey(meta, signer, { enrolmentKey: stub.mintEnrolmentKey(1), installationName: "t" });
    const m = await mintWith(tc, meta, signer, g.installation_id, g.join_state, "a".repeat(43));
    expect(m.token_type).toBe("DPoP");
    expect(stub.stats.refusals).toEqual([]);
  });
});

describe("TokenClient construction, discovery cache, typed failures", () => {
  test("clientId is REQUIRED (a type error if omitted, a throw if empty) — no runtime's id is baked into auth/core", () => {
    // @ts-expect-error — clientId has no default: an SDK consumer can never silently enrol as the Claude plugin.
    expect(() => new TokenClient({ clock: new Clock() })).toThrow(/clientId/);
    expect(() => new TokenClient({ clock: new Clock(), clientId: "" })).toThrow(/clientId/);
  });

  test("every public-client request sends the GIVEN clientId (device authorization, device poll, code exchange)", async () => {
    const sent: Record<string, unknown>[] = [];
    const capture: FetchLike = async (_url, init) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    };
    const tc = new TokenClient({ clock: new Clock(), clientId: "bridge-openclaw", fetch: capture });
    const base = "http://127.0.0.1:9";
    const meta = { issuer: `${base}/api/agent-auth`, token_endpoint: `${base}/api/agent-auth/token`, device_authorization_endpoint: `${base}/api/agent-auth/device_authorization` } as AuthMetadata;
    const k = (await generateSoftwareKey()).signer;
    await refused(tc.deviceAuthorization(meta, "mac"));
    await refused(tc.pollDeviceCode(meta, k, "brg_dc_x"));
    await refused(tc.exchangeCode(meta, k, { code: "brg_ac_x", verifier: "v".repeat(43), redirectUri: "http://127.0.0.1:1/cb" }));
    expect(sent.map((b) => b.client_id)).toEqual(["bridge-openclaw", "bridge-openclaw", "bridge-openclaw"]);
  });

  test("RFC-017 D5: software_id + software_version ride on EVERY grant (enrolment key, code, device, mint) when given", async () => {
    const sent: Record<string, unknown>[] = [];
    const capture: FetchLike = async (_url, init) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    };
    const tc = new TokenClient({ clock: new Clock(), clientId: "bridge-claude-plugin", fetch: capture, softwareId: "bridge-claude-plugin", softwareVersion: "0.26.0" });
    const base = "http://127.0.0.1:9";
    const meta = { issuer: `${base}/api/agent-auth`, token_endpoint: `${base}/api/agent-auth/token`, device_authorization_endpoint: `${base}/api/agent-auth/device_authorization` } as AuthMetadata;
    const k = (await generateSoftwareKey()).signer;
    await refused(tc.enrolWithKey(meta, k, { enrolmentKey: "ek", installationName: "t" }));
    await refused(tc.exchangeCode(meta, k, { code: "c", verifier: "v".repeat(43), redirectUri: "http://127.0.0.1:1/cb" }));
    await refused(tc.pollDeviceCode(meta, k, "dc"));
    await refused(tc.mint(meta, k, { installationId: "i", joinState: "brg_js_0_x", attempt: "a".repeat(43), sessionKey: "s1", reconnect: false }));
    expect(sent).toHaveLength(4);
    for (const b of sent) {
      expect(b.software_id).toBe("bridge-claude-plugin");
      expect(b.software_version).toBe("0.26.0");
    }
  });

  test("…and neither field is sent at all when the TokenClient was never given an identity (pre-017 shape, unchanged)", async () => {
    const sent: Record<string, unknown>[] = [];
    const capture: FetchLike = async (_url, init) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    };
    const tc = new TokenClient({ clock: new Clock(), clientId: "bridge-claude-plugin", fetch: capture });
    const k = (await generateSoftwareKey()).signer;
    const meta = { issuer: "x", token_endpoint: "http://127.0.0.1:9/t", device_authorization_endpoint: "http://127.0.0.1:9/d" } as AuthMetadata;
    await refused(tc.enrolWithKey(meta, k, { enrolmentKey: "ek", installationName: "t" }));
    expect("software_id" in sent[0]!).toBe(false);
    expect("software_version" in sent[0]!).toBe(false);
  });

  test("discovery is cached PER CLIENT with a TTL; a failure is never cached", async () => {
    const stub = startAuthStub({ discoveryFail: 1 });
    stops.push(() => stub.stop());
    const a = client().tc;
    expect(await refused(a.discover(stub.url))).toMatchObject({ error: "http_502", status: 502 });
    await a.discover(stub.url);
    await a.discover(stub.url);
    expect(stub.stats.discoveryHits).toBe(2); // the 502, then one fetch reused
    await client().tc.discover(stub.url); // another client: its own cache
    expect(stub.stats.discoveryHits).toBe(3);
    const short = new TokenClient({ clock: new Clock(), clientId: STUB_CLIENT_ID, metadataTtlMs: 0 });
    await short.discover(stub.url);
    await short.discover(stub.url);
    expect(stub.stats.discoveryHits).toBe(5);
  });

  test("unusable metadata is a DiscoveryError (refused); an apiUrl with a path is refused with a clear message", async () => {
    const stub = startAuthStub();
    stops.push(() => stub.stop());
    const lying = client({
      fetch: (async () => Response.json({ issuer: "https://evil.example/api/agent-auth", token_endpoint: "https://evil.example/t" })) as any,
    }).tc;
    const e = await refused(lying.discover(stub.url));
    expect(e).toBeInstanceOf(DiscoveryError);
    expect(classifyTokenError(e)).toEqual({ kind: "refused" });
    expect(() => client().tc.discover(`${stub.url}/bridge`)).toThrow(/must be an origin/);
  });

  test("the CALLER cancelling is `aborted` (never retried); a timeout is `transient`", async () => {
    const slow = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => (await Bun.sleep(3_000), new Response("{}")) });
    stops.push(() => slow.stop(true));
    const base = `http://127.0.0.1:${slow.port}`;
    const meta: AuthMetadata = {
      issuer: `${base}/api/agent-auth`,
      authorization_endpoint: `${base}/a`,
      device_authorization_endpoint: `${base}/d`,
      token_endpoint: `${base}/api/agent-auth/token`,
      revocation_endpoint: `${base}/r`,
    };
    const { tc } = client();
    const k = (await generateSoftwareKey()).signer;
    const input = { installationId: crypto.randomUUID(), joinState: "brg_js_0_" + "A".repeat(49), attempt: "a".repeat(43), sessionKey: "s", reconnect: false };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const cancelled = await refused(tc.mint(meta, k, input, { signal: ac.signal }));
    expect(cancelled).toMatchObject({ name: "AbortedError" });
    expect(classifyTokenError(cancelled)).toEqual({ kind: "aborted" });
    const timedOut = await refused(tc.mint(meta, k, input, { signal: AbortSignal.timeout(100) }));
    expect(timedOut).toBeInstanceOf(TransportError);
    expect(classifyTokenError(timedOut)).toEqual({ kind: "transient" });
  });

  test("Retry-After as an HTTP-date is honoured", async () => {
    const at = new Date(Date.now() + 8_000).toUTCString();
    const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": at } }) });
    stops.push(() => srv.stop(true));
    const base = `http://127.0.0.1:${srv.port}`;
    const meta = { issuer: `${base}/api/agent-auth`, token_endpoint: `${base}/api/agent-auth/token` } as AuthMetadata;
    const e = await refused(mintWith(client().tc, meta, (await generateSoftwareKey()).signer, crypto.randomUUID(), "brg_js_0_" + "A".repeat(49), "a".repeat(43)));
    const a = classifyTokenError(e);
    expect(a.kind).toBe("rate_limited");
    expect((a as any).retryAfterS).toBeGreaterThanOrEqual(6);
    expect((a as any).retryAfterS).toBeLessThanOrEqual(9);
  });
});
