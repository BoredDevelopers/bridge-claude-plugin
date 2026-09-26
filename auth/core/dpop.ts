/**
 * DPoP proofs (RFC 9449) and the `htu` rules Bridge compares them by (RFC-016
 * §3.4, E11). Pure.
 */
import { sha256B64url } from "./b64url";
import { signJwt, newJti } from "./jws";
import type { Clock } from "./clock";
import type { Signer } from "./signer";

/**
 * §3.4: lowercase scheme and host, no default port, no query or fragment. The
 * WHATWG URL parser already lowercases scheme + host and drops a default port;
 * we drop search + hash.
 */
export function normalizeHtu(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname}`;
}

/**
 * E11: the WebSocket `htu` is the normalised apiUrl ORIGIN + `/ws`, in its
 * http(s) form — never ws(s). RFC-016 C16: HTTP = the same origin + request path.
 * Never a nonce on WS (C15): WS proofs are bound by `iat` + `jti` only.
 */
export function wsHtu(apiUrl: string): string {
  return `${new URL(apiUrl).origin}/ws`;
}

/** `ath`: base64url SHA-256 of the ASCII access token (RFC 9449 §4.2). */
export const accessTokenHash = (accessToken: string) => sha256B64url(accessToken);

export interface ProofInput {
  htm: string;
  htu: string;
  /** Present when the proof accompanies an access token (resource + WS). */
  accessToken?: string;
  /** A server-supplied `DPoP-Nonce` (RFC 9449 §8/§9). */
  nonce?: string;
}

export async function dpopProof(signer: Signer, clock: Clock, p: ProofInput): Promise<string> {
  return signJwt(
    signer,
    { typ: "dpop+jwt", jwk: signer.publicJwk },
    {
      jti: newJti(),
      htm: p.htm.toUpperCase(),
      htu: normalizeHtu(p.htu),
      iat: clock.nowS(),
      ...(p.accessToken !== undefined ? { ath: await accessTokenHash(p.accessToken) } : {}),
      ...(p.nonce ? { nonce: p.nonce } : {}),
    }
  );
}
