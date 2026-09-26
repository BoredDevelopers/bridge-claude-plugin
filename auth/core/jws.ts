/** Compact JWS, ES256 only (RFC 7515; RFC-016 E1: ES256 is the one mandatory alg). Pure. */
import { b64url, b64urlJson, randomB64url } from "./b64url";
import type { Signer } from "./signer";

export async function signJwt(signer: Signer, header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string> {
  const input = `${b64urlJson({ ...header, alg: signer.alg })}.${b64urlJson(claims)}`;
  const sig = await signer.sign(new TextEncoder().encode(input));
  return `${input}.${b64url(sig)}`;
}

/** 128-bit random `jti` — fresh for every assertion and proof (both are single-use server-side, E12). */
export const newJti = () => randomB64url(16);
