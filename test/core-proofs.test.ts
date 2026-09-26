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
  });

  test("the WS htu is the apiUrl ORIGIN + /ws, in http(s) form", () => {
    expect(wsHtu("https://Bridge-API.example.com")).toBe("https://bridge-api.example.com/ws");
    expect(wsHtu("http://127.0.0.1:4000/")).toBe("http://127.0.0.1:4000/ws");
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
});

describe("clock (E12)", () => {
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
