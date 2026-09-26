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
 * we drop search + hash. Only http(s) — the server's normaliser refuses anything else.
 */
export function normalizeHtu(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`DPoP htu must be http(s), got ${u.protocol}`);
  return `${u.protocol}//${u.host}${u.pathname}`;
}

const HTTP_FORM: Record<string, string> = { "ws:": "http:", "wss:": "https:", "http:": "http:", "https:": "https:" };

/**
 * The API base as an ORIGIN (`scheme://host[:port]`, no trailing slash, http(s) form).
 * Bridge's server compares `htu` against `deployment.apiUrl`, which IS an origin, so an
 * apiUrl carrying a path (`https://h/bridge`), query or fragment would sign proofs no
 * server accepts — refused here with a clear message rather than as a 401 later. A
 * trailing "/" (or several) is fine. `allowWsPath` also accepts the `/ws` path of a ws(s) URL.
 */
export function apiOrigin(apiUrl: string, allowWsPath = false): string {
  const u = new URL(apiUrl);
  const scheme = HTTP_FORM[u.protocol];
  if (!scheme) throw new Error(`the Bridge API URL must be http(s) or ws(s), got ${u.protocol}`);
  const pathOk = /^\/*$/.test(u.pathname) || (allowWsPath && u.pathname === "/ws");
  if (!pathOk || u.search || u.hash || u.username || u.password) {
    throw new Error(`the Bridge API URL must be an origin like https://bridge-api.example.com — got ${JSON.stringify(apiUrl)}`);
  }
  // Re-parse in the http(s) form so the default port of THAT scheme is dropped.
  return new URL(`${scheme}//${u.host}`).origin;
}

/**
 * RFC-016 C16: an HTTP request's `htu` is the apiUrl ORIGIN + the request PATH — no
 * query, no fragment, and never a double slash from a trailing-slash apiUrl or a path
 * given with or without its leading "/". apiUrl must be an origin (apiOrigin).
 */
export function httpHtu(apiUrl: string, path: string): string {
  const pathname = "/" + path.split(/[?#]/, 1)[0]!.replace(/^\/+/, "");
  return normalizeHtu(`${apiOrigin(apiUrl)}${pathname}`);
}

/**
 * E11: the WebSocket `htu` is the apiUrl ORIGIN + `/ws`, in its http(s) form — never
 * ws(s). Accepts the socket URL itself (`wss://h/ws`) too. Never a nonce on WS (C15):
 * WS proofs are bound by `iat` + `jti` only.
 */
export function wsHtu(apiUrl: string): string {
  return normalizeHtu(`${apiOrigin(apiUrl, true)}/ws`);
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
  // An empty token would still hash to an `ath`; an empty nonce is no nonce. Both are caller bugs.
  if (p.accessToken === "") throw new Error("DPoP proof: empty access token");
  if (p.nonce === "") throw new Error("DPoP proof: empty nonce");
  return signJwt(
    signer,
    { typ: "dpop+jwt", jwk: signer.publicJwk },
    {
      jti: newJti(),
      htm: p.htm.toUpperCase(),
      htu: normalizeHtu(p.htu),
      iat: clock.nowS(),
      ...(p.accessToken !== undefined ? { ath: await accessTokenHash(p.accessToken) } : {}),
      ...(p.nonce !== undefined ? { nonce: p.nonce } : {}),
    }
  );
}
