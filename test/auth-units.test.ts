/**
 * Small pure-ish pieces of auth/ (RFC-016 §5): device polling, headless detection,
 * discovery. (The installation-lock tests live in installation-lock.test.ts.)
 */
import { describe, test, expect } from "bun:test";
import { pollDevice } from "../auth/device";
import { isHeadless } from "../auth/browser";
import { assertSameAuthority, supportsKeyCredentials, OAuthError, TransportError, type AuthMetadata, type EnrolGrant } from "../auth/core/protocol";

/** One scripted token-endpoint answer per poll ("ok", "transport", or an OAuth error code; "rate_limited:<s>"). */
function answers(list: string[]) {
  let i = 0;
  const grant: EnrolGrant = { installation_id: "i1", join_state: "brg_js_0_" + "a".repeat(49) };
  return {
    polls: () => i,
    poll: async () => {
      const a = list[Math.min(i++, list.length - 1)]!;
      if (a === "ok") return grant;
      if (a === "transport") throw new TransportError("no answer");
      if (a.startsWith("rate_limited:")) throw new OAuthError({ error: "rate_limited", status: 429, retryAfterS: Number(a.split(":")[1]) });
      throw new OAuthError({ error: a, status: 400 });
    },
    grant,
  };
}

const auth = { device_code: "dc", user_code: "U", verification_uri: "v", expires_in: 600, interval: 5 };

describe("device polling (RFC 8628 §3.5)", () => {
  test("pending waits, slow_down adds 5 s for good, then success", async () => {
    const s = answers(["authorization_pending", "slow_down", "authorization_pending", "ok"]);
    const waits: number[] = [];
    const r = await pollDevice(s.poll, auth, { sleep: async (ms) => void waits.push(ms) });
    expect(r).toEqual({ ok: true, grant: s.grant });
    expect(waits).toEqual([5000, 5000, 10000, 10000]);
  });

  test("access_denied ends the flow; the deadline ends it too", async () => {
    expect(await pollDevice(answers(["access_denied"]).poll, auth, { sleep: async () => {} })).toEqual({ ok: false, error: "access_denied" });
    let t = 0;
    const r = await pollDevice(answers(["authorization_pending"]).poll, { ...auth, expires_in: 20 }, {
      sleep: async (ms) => void (t += ms),
      now: () => t,
    });
    expect(r).toEqual({ ok: false, error: "expired_token" });
  });

  test("no answer (transport) keeps polling; a 429 waits its Retry-After on top of the interval, once", async () => {
    const s = answers(["transport", "rate_limited:3", "authorization_pending", "ok"]);
    const waits: number[] = [];
    const r = await pollDevice(s.poll, auth, { sleep: async (ms) => void waits.push(ms) });
    expect(r).toEqual({ ok: true, grant: s.grant });
    expect(waits).toEqual([5000, 5000, 8000, 5000]);
  });

  test("a cancelled poll stops as cancelled", async () => {
    const ac = new AbortController();
    const r = await pollDevice(answers(["authorization_pending"]).poll, auth, {
      signal: ac.signal,
      sleep: async () => ac.abort(),
    });
    expect(r).toEqual({ ok: false, error: "cancelled" });
  });
});

describe("headless detection", () => {
  test("SSH and CI are headless everywhere; Linux needs a display; macOS is not", () => {
    expect(isHeadless({ SSH_CONNECTION: "a" }, "darwin")).toBe(true);
    expect(isHeadless({ CI: "true" }, "darwin")).toBe(true);
    expect(isHeadless({}, "darwin")).toBe(false);
    expect(isHeadless({}, "linux")).toBe(true);
    expect(isHeadless({ DISPLAY: ":0" }, "linux")).toBe(false);
    expect(isHeadless({ WAYLAND_DISPLAY: "w" }, "linux")).toBe(false);
    expect(isHeadless({ WSL_DISTRO_NAME: "Ubuntu" }, "linux")).toBe(false);
  });
});

describe("discovery", () => {
  test("a pre-RFC-016 server (no client_credentials) is recognised", () => {
    const m = { grant_types_supported: ["authorization_code", "refresh_token"] } as AuthMetadata;
    expect(supportsKeyCredentials(m)).toBe(false);
    expect(supportsKeyCredentials({ ...m, grant_types_supported: ["client_credentials"] })).toBe(true);
    expect(supportsKeyCredentials({} as AuthMetadata)).toBe(false);
  });
});

describe("discovery authority (RFC 8414 §3.3)", () => {
  const api = "https://bridge-api.example.test";
  const meta = (over: Partial<AuthMetadata> = {}): AuthMetadata => ({
    issuer: `${api}/api/agent-auth`,
    authorization_endpoint: `${api}/api/agent-auth/authorize`,
    device_authorization_endpoint: `${api}/api/agent-auth/device_authorization`,
    token_endpoint: `${api}/api/agent-auth/token`,
    revocation_endpoint: `${api}/api/agent-auth/revoke`,
    bridge_connect_done_uri: "https://bridge-web.example.test/connect/done",
    ...over,
  });

  test("the API's own document is accepted (a trailing slash on the URL too; the web done-URI may differ)", () => {
    expect(() => assertSameAuthority(api, meta())).not.toThrow();
    expect(() => assertSameAuthority(`${api}/`, meta())).not.toThrow();
  });

  test("a different issuer is refused", () => {
    expect(() => assertSameAuthority(api, meta({ issuer: "https://evil.example.test/api/agent-auth" }))).toThrow(/issuer/);
  });

  test("a credential endpoint on another origin is refused, even with the right issuer", () => {
    expect(() => assertSameAuthority(api, meta({ token_endpoint: "https://evil.example.test/token" }))).toThrow(/token_endpoint/);
    expect(() => assertSameAuthority(api, meta({ revocation_endpoint: "http://bridge-api.example.test/revoke" }))).toThrow(/revocation_endpoint/);
  });
});
