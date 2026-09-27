/**
 * The STUB's side of RFC-016: parse + verify compact ES256 JWS, RFC 7638
 * thumbprints, `htu` normalisation — written INDEPENDENTLY of auth/core/ (node:crypto
 * with `dsaEncoding: "ieee-p1363"`, a hand-rolled canonical JSON, a hand-rolled URL
 * normaliser). A verifier that reused the client's own helpers would pass a client
 * bug on both sides: a DER signature, a wrong member order, a kept query string.
 */
import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";

export interface Jws {
  header: Record<string, any>;
  claims: Record<string, any>;
  signingInput: string;
  signature: Buffer;
}

export function parseJws(token: unknown): Jws | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")),
      claims: JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")),
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2]!, "base64url"),
    };
  } catch {
    return null;
  }
}

/** 32 bytes in CANONICAL base64url (the server refuses a non-canonical spelling: one point, many jkts). */
function canonical32(v: unknown): boolean {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(v)) return false;
  const b = Buffer.from(v, "base64url");
  return b.length === 32 && b.toString("base64url") === v;
}

export function isPublicP256(jwk: any): boolean {
  // `d` present = a private key was put in a header — refuse, loudly.
  return !!jwk && typeof jwk === "object" && jwk.kty === "EC" && jwk.crv === "P-256" && canonical32(jwk.x) && canonical32(jwk.y) && !("d" in jwk);
}

/** ES256, raw r‖s only (64 bytes) — a DER signature fails here even though it is "valid". */
export function verifyEs256(jws: Jws, jwk: any): boolean {
  if (jws.header.alg !== "ES256" || jws.signature.length !== 64 || !isPublicP256(jwk)) return false;
  try {
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
    return nodeVerify("sha256", Buffer.from(jws.signingInput), { key, dsaEncoding: "ieee-p1363" }, jws.signature);
  } catch {
    return false;
  }
}

export function thumbprint(jwk: any): string {
  const canonical = '{"crv":"' + jwk.crv + '","kty":"' + jwk.kty + '","x":"' + jwk.x + '","y":"' + jwk.y + '"}';
  return createHash("sha256").update(canonical).digest("base64url");
}

export const sha256b64u = (s: string) => createHash("sha256").update(s, "ascii").digest("base64url");

/** §3.4 by hand: lowercase scheme + host, no default port, no query / fragment. */
export function normHtu(url: string): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/.exec(url);
  if (!m) return url;
  const scheme = m[1]!.toLowerCase();
  let host = m[2]!.toLowerCase();
  if ((scheme === "http" && host.endsWith(":80")) || (scheme === "https" && host.endsWith(":443"))) host = host.slice(0, host.lastIndexOf(":"));
  return `${scheme}://${host}${m[3] || "/"}`;
}

/** CRC32 (IEEE) — the join state's checksum, which the client never computes. */
export function crc32(s: string): number {
  let c = ~0;
  for (let i = 0; i < s.length; i++) {
    c ^= s.charCodeAt(i);
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export function base62(n: number, width: number): string {
  let out = "";
  for (let i = 0; i < width; i++) {
    out = B62[n % 62] + out;
    n = Math.floor(n / 62);
  }
  return out;
}
export function randomBase62(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => B62[b % 62]).join("");
}

/** A server-side join state `brg_js_<seq>_<43 base62><6 base62 CRC32>` (RFC-016 §3.1). */
export function makeJoinState(seq: number): string {
  const body = `brg_js_${seq}_${randomBase62(43)}`;
  return body + base62(crc32(body), 6);
}

export function joinStateCrcOk(s: string): boolean {
  const m = /^(brg_js_\d+_[0-9A-Za-z]{43})([0-9A-Za-z]{6})$/.exec(s);
  return !!m && base62(crc32(m[1]!), 6) === m[2];
}
