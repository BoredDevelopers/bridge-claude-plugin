/**
 * auth/core proofs (RFC-016 §3.3–3.4, E2, E11, E12): DPoP proofs, htu rules, client
 * assertions, the Date-header clock, join-state parsing. Verified with
 * test/dpop-verify.ts (node:crypto, hand-rolled normaliser).
 */
import { describe, test, expect } from "bun:test";
import { generateSoftwareKey } from "../auth/core/signer";
import { dpopProof, normalizeHtu, wsHtu } from "../auth/core/dpop";
import { clientAssertion, ASSERTION_TTL_S } from "../auth/core/assertion";
import { Clock } from "../auth/core/clock";
import { isJoinState, joinStateSeq } from "../auth/core/join-state";
import { parseJws, verifyEs256, sha256b64u, normHtu, makeJoinState } from "./dpop-verify";

describe("DPoP proofs (RFC 9449, RFC-016 §3.4 / E11)", () => {
  test("htu is normalised: lowercase scheme + host, no default port, no query or fragment", () => {
    for (const u of [
      "HTTPS://Bridge-API.Example.com:443/api/channels?limit=5#x",
      "http://127.0.0.1:4000/api/messages",
      "http://h.example:80/ws",
      "https://h.example/base/api/x?y",
    ]) {
      expect(normalizeHtu(u)).toBe(normHtu(u));
    }
    expect(normalizeHtu("HTTPS://Bridge-API.Example.com:443/api/x?q=1#f")).toBe("https://bridge-api.example.com/api/x");
    // Only http(s) names a Bridge endpoint (the server's normaliser refuses the rest).
    for (const u of ["ws://h.example/ws", "ftp://h.example/x", "file:///etc/passwd"]) expect(() => normalizeHtu(u)).toThrow();
  });

  test("the WS htu is the apiUrl ORIGIN + /ws, in http(s) form", () => {
    expect(wsHtu("https://Bridge-API.example.com")).toBe("https://bridge-api.example.com/ws");
    expect(wsHtu("http://127.0.0.1:4000/")).toBe("http://127.0.0.1:4000/ws");
    // A ws(s) URL maps to its http(s) form (default ports dropped on the way).
    expect(wsHtu("wss://Bridge-API.example.com/ws")).toBe("https://bridge-api.example.com/ws");
    expect(wsHtu("wss://h.example:443")).toBe("https://h.example/ws");
    expect(wsHtu("ws://127.0.0.1:4000/ws")).toBe("http://127.0.0.1:4000/ws");
    expect(() => wsHtu("ftp://h.example")).toThrow();
  });

  test("an empty access token or nonce is refused, never signed into a proof", async () => {
    const { signer } = await generateSoftwareKey();
    await expect(dpopProof(signer, new Clock(), { htm: "GET", htu: "http://h.example/ws", accessToken: "" })).rejects.toThrow();
    await expect(dpopProof(signer, new Clock(), { htm: "GET", htu: "http://h.example/ws", nonce: "" })).rejects.toThrow();
  });

  test("a resource proof: typ dpop+jwt, public jwk, htm, htu, iat, fresh jti, ath = SHA-256(token), nonce when given", async () => {
    const { signer } = await generateSoftwareKey();
    const clock = new Clock();
    const t = await dpopProof(signer, clock, { htm: "post", htu: "http://127.0.0.1:1/api/messages?x=1", accessToken: "brg_at_x", nonce: "n1" });
    const p = parseJws(t)!;
    expect(p.header).toEqual({ typ: "dpop+jwt", jwk: signer.publicJwk, alg: "ES256" });
    expect(verifyEs256(p, p.header.jwk)).toBe(true);
    expect(p.claims).toMatchObject({ htm: "POST", htu: "http://127.0.0.1:1/api/messages", ath: sha256b64u("brg_at_x"), nonce: "n1" });
    expect(Math.abs(p.claims.iat - Date.now() / 1000)).toBeLessThan(5);
    const t2 = await dpopProof(signer, clock, { htm: "POST", htu: "http://127.0.0.1:1/api/messages" });
    expect(parseJws(t2)!.claims.jti).not.toBe(p.claims.jti);
    expect("ath" in parseJws(t2)!.claims).toBe(false);
  });
});

describe("client assertion (E2)", () => {
  test("typ, kid = jkt, iss = sub = installation, aud = issuer (a string), exp = iat + 60 ≤ iat + 300", async () => {
    const { signer } = await generateSoftwareKey();
    const a = parseJws(await clientAssertion(signer, new Clock(), "inst-1", "https://x.example/api/agent-auth"))!;
    expect(a.header).toEqual({ typ: "client-authentication+jwt", kid: signer.jkt, alg: "ES256" });
    expect(verifyEs256(a, signer.publicJwk)).toBe(true);
    expect(a.claims).toMatchObject({ iss: "inst-1", sub: "inst-1", aud: "https://x.example/api/agent-auth" });
    expect(typeof a.claims.aud).toBe("string");
    expect(a.claims.exp - a.claims.iat).toBe(ASSERTION_TTL_S);
    expect(ASSERTION_TTL_S).toBeLessThanOrEqual(300);
  });

  test("every assertion carries a fresh jti (single-use server-side, E12)", async () => {
    const { signer } = await generateSoftwareKey();
    const jtis = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const jti = parseJws(await clientAssertion(signer, new Clock(), "inst-1", "https://x.example/api/agent-auth"))!.claims.jti;
      expect(typeof jti).toBe("string");
      expect(jti.length).toBeGreaterThanOrEqual(16);
      jtis.add(jti);
    }
    expect(jtis.size).toBe(20);
  });
});

describe("clock (E12)", () => {
  test("the observed server clock flows into assertion iat/exp and proof iat", async () => {
    const local = Date.parse("2020-01-01T00:00:00Z"); // far from the real clock: Date.now() cannot pass this
    const c = new Clock(() => local);
    c.observe("Wed, 01 Jan 2020 00:07:00 GMT");
    const want = local / 1000 + 420;
    const { signer } = await generateSoftwareKey();
    const a = parseJws(await clientAssertion(signer, c, "inst-1", "https://x.example/api/agent-auth"))!.claims;
    expect(a.iat).toBe(want);
    expect(a.exp).toBe(want + ASSERTION_TTL_S);
    const p = parseJws(await dpopProof(signer, c, { htm: "POST", htu: "https://x.example/api/agent-auth/token" }))!.claims;
    expect(p.iat).toBe(want);
  });

  test("a server BEHIND the local clock gives a negative offset", () => {
    const local = Date.parse("2026-09-25T10:00:00Z");
    const c = new Clock(() => local);
    c.observe("Fri, 25 Sep 2026 09:57:00 GMT");
    expect(c.offset()).toBe(-180_000);
    expect(c.nowS()).toBe(local / 1000 - 180);
  });

  test("only an IMF-fixdate within 24 h is learnt; anything else keeps the last offset", () => {
    const local = Date.parse("2026-09-25T10:00:00Z");
    const c = new Clock(() => local);
    c.observe("Fri, 25 Sep 2026 10:01:00 GMT");
    expect(c.offset()).toBe(60_000);
    for (const junk of [
      "1", // Date.parse("1") is a finite year-2001 date
      "2026-09-25T10:05:00Z", // ISO, not IMF-fixdate
      "Friday, 25-Sep-26 10:05:00 GMT", // obsolete RFC 850
      "Fri, 25 Sep 2026 10:05:00 +0000",
      "Sun, 27 Sep 2026 10:05:00 GMT", // 2 days off: a broken proxy, not a clock
      "Wed, 23 Sep 2026 10:05:00 GMT",
    ]) {
      c.observe(junk);
      expect(c.offset()).toBe(60_000);
    }
  });

  test("iat follows the server's Date, not the local clock", () => {
    let local = Date.parse("2026-09-25T10:00:00Z");
    const c = new Clock(() => local);
    expect(c.nowS()).toBe(local / 1000);
    c.observe("Fri, 25 Sep 2026 10:07:00 GMT"); // server 7 min ahead
    expect(c.nowS()).toBe(local / 1000 + 420);
    local += 1000;
    expect(c.nowS()).toBe(Date.parse("2026-09-25T10:07:01Z") / 1000);
    c.observe(null);
    c.observe("garbage");
    expect(c.offset()).toBe(420_000);
  });
});

describe("join state (§3.1)", () => {
  test("seq is parsed; anything not shaped like a join state is refused", () => {
    const s = makeJoinState(41);
    expect(isJoinState(s)).toBe(true);
    expect(joinStateSeq(s)).toBe(41);
    expect(joinStateSeq(makeJoinState(0))).toBe(0);
    // The server's shape (agent-tokens.ts JOIN_STATE_RE): decimal seq, NO leading zeros, ≤ 15 digits.
    for (const bad of [
      "",
      "brg_js_1_short",
      "brg_rt_1_" + "a".repeat(49),
      s + "x",
      s.replace("brg_js_41", "brg_js_-1"),
      s.replace("brg_js_41", "brg_js_041"),
      s.replace("brg_js_41", "brg_js_1234567890123456"),
    ]) {
      expect(isJoinState(bad)).toBe(false);
      expect(joinStateSeq(bad)).toBeNull();
    }
  });
});
