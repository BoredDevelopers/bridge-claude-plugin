import type { Clock } from "./clock";
import type { Signer } from "./signer";
/**
 * §3.4: lowercase scheme and host, no default port, no query or fragment. The
 * WHATWG URL parser already lowercases scheme + host and drops a default port;
 * we drop search + hash. Only http(s) — the server's normaliser refuses anything else.
 */
export declare function normalizeHtu(url: string): string;
/**
 * The API base as an ORIGIN (`scheme://host[:port]`, no trailing slash, http(s) form).
 * Bridge's server compares `htu` against `deployment.apiUrl`, which IS an origin, so an
 * apiUrl carrying a path (`https://h/bridge`), query or fragment would sign proofs no
 * server accepts — refused here with a clear message rather than as a 401 later. A
 * trailing "/" (or several) is fine. `allowWsPath` also accepts the `/ws` path of a ws(s) URL.
 */
export declare function apiOrigin(apiUrl: string, allowWsPath?: boolean): string;
/**
 * RFC-016 C16: an HTTP request's `htu` is the apiUrl ORIGIN + the request PATH — no
 * query, no fragment, and never a double slash from a trailing-slash apiUrl or a path
 * given with or without its leading "/". apiUrl must be an origin (apiOrigin).
 */
export declare function httpHtu(apiUrl: string, path: string): string;
/**
 * E11: the WebSocket `htu` is the apiUrl ORIGIN + `/ws`, in its http(s) form — never
 * ws(s). Accepts the socket URL itself (`wss://h/ws`) too. Never a nonce on WS (C15):
 * WS proofs are bound by `iat` + `jti` only.
 */
export declare function wsHtu(apiUrl: string): string;
/** `ath`: base64url SHA-256 of the ASCII access token (RFC 9449 §4.2). */
export declare const accessTokenHash: (accessToken: string) => Promise<string>;
export interface ProofInput {
    htm: string;
    htu: string;
    /** Present when the proof accompanies an access token (resource + WS). */
    accessToken?: string;
    /** A server-supplied `DPoP-Nonce` (RFC 9449 §8/§9). */
    nonce?: string;
}
export declare function dpopProof(signer: Signer, clock: Clock, p: ProofInput): Promise<string>;
