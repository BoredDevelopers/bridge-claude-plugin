/** P-256 JWKs and their RFC 7638 thumbprint (the server's `jkt`, RFC-016 E1). Pure. */
import { b64url, b64urlDecode, sha256B64url } from "./b64url";

export interface EcPublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}
export interface EcPrivateJwk extends EcPublicJwk {
  d: string;
}

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

/**
 * 32 bytes in CANONICAL base64url. The server refuses a non-canonical spelling (stray
 * low bits in the last char): it decodes to the same point but hashes to a different
 * RFC 7638 thumbprint — one key, many jkts (server `es256.ts isP256PublicJwk`).
 */
function isB64url32(v: unknown): v is string {
  return typeof v === "string" && B64URL_32.test(v) && b64url(b64urlDecode(v)) === v;
}

export function isP256PublicJwk(j: unknown): j is EcPublicJwk {
  const o = j as Record<string, unknown> | null;
  return !!o && o.kty === "EC" && o.crv === "P-256" && isB64url32(o.x) && isB64url32(o.y);
}

export function isP256PrivateJwk(j: unknown): j is EcPrivateJwk {
  return isP256PublicJwk(j) && isB64url32((j as any).d);
}

/** Only the public members — never let `d` ride into a header by spreading a private JWK. */
export function publicPart(j: EcPublicJwk): EcPublicJwk {
  return { kty: "EC", crv: "P-256", x: j.x, y: j.y };
}

/**
 * RFC 7638 §3: SHA-256 over the REQUIRED members in lexicographic order —
 * `{"crv","kty","x","y"}` for EC — with no whitespace, base64url.
 * (JSON.stringify keeps insertion order, so the literal below IS the canonical form.)
 */
export function jwkThumbprint(j: EcPublicJwk): Promise<string> {
  return sha256B64url(JSON.stringify({ crv: j.crv, kty: j.kty, x: j.x, y: j.y }));
}
