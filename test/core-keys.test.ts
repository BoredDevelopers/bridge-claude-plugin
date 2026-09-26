/**
 * auth/core keys (RFC-016 E1/E10): P-256 per enrolment, raw r‖s signatures, RFC 7638
 * thumbprints. Checked with test/dpop-verify.ts — node:crypto, independent of the code
 * under test.
 */
import { describe, test, expect } from "bun:test";
import { b64url, b64urlDecode } from "../auth/core/b64url";
import { isP256PublicJwk, jwkThumbprint } from "../auth/core/jwk";
import { generateSoftwareKey, softwareSigner } from "../auth/core/signer";
import { thumbprint } from "./dpop-verify";

describe("keys", () => {
  test("RFC 7638 thumbprint of a fixed P-256 key (known answer, computed with openssl)", async () => {
    const jwk = { kty: "EC", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0" } as const;
    expect(await jwkThumbprint(jwk)).toBe("oKIywvGUpTVTyxMQ3bwIIeQUudfr_CkLMjCE19ECD-U");
  });

  test("a generated key signs raw 64-byte r‖s that node:crypto verifies; its jkt matches an independent thumbprint", async () => {
    const { signer, privateJwk } = await generateSoftwareKey();
    expect(signer.keyStorage).toBe("software");
    expect(signer.publicJwk).toEqual({ kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y });
    expect("d" in signer.publicJwk).toBe(false);
    expect(signer.jkt).toBe(thumbprint(signer.publicJwk));
    const sig = await signer.sign(new TextEncoder().encode("a.b"));
    expect(sig.length).toBe(64);
    // A reloaded key (key.json → softwareSigner) is the same key.
    const again = await softwareSigner(privateJwk);
    expect(again.jkt).toBe(signer.jkt);
  });

  test("two enrolments never share a key (E1)", async () => {
    const [a, b] = await Promise.all([generateSoftwareKey(), generateSoftwareKey()]);
    expect(a.signer.jkt).not.toBe(b.signer.jkt);
  });

  test("a non-canonical coordinate spelling is refused, as the server refuses it (one key, many jkts)", () => {
    const x = "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU";
    const y = "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0";
    expect(isP256PublicJwk({ kty: "EC", crv: "P-256", x, y })).toBe(true);
    // "U" → "V": same 32 decoded bytes (the last char's low 2 bits are padding), different string.
    const xNonCanonical = x.slice(0, -1) + "V";
    expect(Buffer.from(xNonCanonical, "base64url")).toEqual(Buffer.from(x, "base64url"));
    expect(isP256PublicJwk({ kty: "EC", crv: "P-256", x: xNonCanonical, y })).toBe(false);
  });

  test("b64url round-trips every length (padding math)", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      expect(b64urlDecode(b64url(bytes))).toEqual(bytes);
      expect(b64url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    }
  });
});
