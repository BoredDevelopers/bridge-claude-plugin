/**
 * SOURCE: Claude Code plugin `claude-channel-bridge` 0.26.2 (commit c8b0db6),
 * `auth/core/token-errors.ts`. BYTE-IDENTICAL below the marker — RFC-018 D1/D10: the
 * plugin's auth/core files "move into @bridge/agent-sdk unchanged", and until the
 * plugin re-platforms onto this package (S5) the two copies are kept identical by
 * `test/byte-identity.test.ts` against the pinned original in
 * `fixtures/plugin-core/token-errors.ts`.
 */
/**
 * RFC-016 §3.3 error table → what the client does. Pure, so the whole table is
 * one unit test. The server's `error` is the RFC 6749 §5.2 code; its
 * `error_description` is a TOKEN the client switches on (never prose) — or, for
 * the two stale-client answers, a `<token>: <hint>` string (`rfc014_retired: …`,
 * `dpop_proof_required: …`), matched by its token prefix.
 *
 * Errors are recognised by BRAND (`name` + fields), never `instanceof`: once this
 * lives in `@bridge/agent-sdk`, two copies of the package (the dual-package hazard)
 * would each have their own class.
 */
export interface OAuthErrorInit {
    error: string;
    status: number;
    description?: string;
    retryAfterS?: number;
    dpopNonce?: string;
}
export declare class OAuthError extends Error {
    readonly name = "OAuthError";
    readonly error: string;
    readonly status: number;
    readonly description?: string;
    readonly retryAfterS?: number;
    readonly dpopNonce?: string;
    constructor(i: OAuthErrorInit);
}
export declare function isOAuthError(e: unknown): e is OAuthError;
/** The request never got an HTTP answer (connection, DNS, TLS, a dropped socket). The TokenClient throws this. */
export declare class TransportError extends Error {
    readonly name = "TransportError";
}
/** Discovery answered, but not with usable metadata (issuer mismatch, missing / foreign endpoint): a wrong URL, not a hiccup. */
export declare class DiscoveryError extends Error {
    readonly name = "DiscoveryError";
}
/** The CALLER cancelled (its signal aborted for a reason other than a timeout): stop, never retry on our own. */
export declare class AbortedError extends Error {
    readonly name = "AbortedError";
}
export declare const GONE_REASONS: readonly ["installation_locked", "installation_revoked", "installation_expired", "installation_unknown", "agent_deactivated"];
export type InstallationGoneReason = (typeof GONE_REASONS)[number];
export type TokenAction = 
/** Terminal for the installation: stop, delete key + state, tell the human to re-enrol. */
{
    kind: "installation_gone";
    reason: InstallationGoneReason;
}
/**
 * `assertion_invalid` that survived one clock-corrected retry (C13: stop, KEEP the
 * files). The server also answers it for an unknown, malformed or keyless `client_id`
 * (no enumeration oracle), so it is not always a clock problem. Clock skew can ALSO
 * surface as `invalid_dpop_proof` (`new_proof`): the server checks the proof before the
 * assertion. Both recover once the response's `Date` has been observed.
 */
 | {
    kind: "clock";
} | {
    kind: "session_revoked";
} | {
    kind: "session_limit";
} | {
    kind: "corrupt_state";
}
/**
 * `invalid_dpop_proof` / `use_dpop_nonce` that survived the in-request retry. NOT
 * `key_already_enrolled` (C6): the same key can never pass; that one is `refused`
 * here, after the caller's one fresh-key retry.
 */
 | {
    kind: "new_proof";
}
/** `unsupported_grant_type` / `rfc014_retired` / `dpop_proof_required`: plugin and server disagree on the protocol. */
 | {
    kind: "update_required";
} | {
    kind: "rate_limited";
    retryAfterS: number;
}
/**
 * RFC-017 D5: `unauthorized_client` with a `client_too_old:` or `client_blocked:`
 * description — this build itself is refused (below `minimum`, or individually
 * `blocked`). Stop minting until the process restarts; keep the files (this is not a
 * credential problem, so there is nothing to delete).
 */
 | {
    kind: "too_old";
}
/** A refusal the table does not name, or a non-transport throw: stop and show it, keep the files. */
 | {
    kind: "refused";
}
/** 5xx / network / timeout: retry later with the SAME attempt. */
 | {
    kind: "transient";
}
/** The caller cancelled: stop quietly, keep the files, never retry on our own. */
 | {
    kind: "aborted";
}
/** RFC 8628 §3.5 device polling: not approved yet — poll again after the interval. */
 | {
    kind: "pending";
}
/** RFC 8628 §3.5: polling too fast — add 5 s to the interval, then poll again. */
 | {
    kind: "slow_down";
};
/** Exhaustiveness check for a `switch` over `TokenAction["kind"]`. */
export declare function assertNever(x: never): never;
export declare function classifyTokenError(e: unknown): TokenAction;
