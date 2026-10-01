/**
 * `AgentClient`/`Session` errors — branded (a `name` + `code` predicate, never
 * `instanceof`: the same dual-package hazard `../core/token-errors.ts` guards
 * against) and coded, not prose. `code` is what a caller switches on; `message`
 * exists only for a log line and is never the server's own text UNLESS the
 * server sent it — `remedy` (from `../core`'s `CloseOutcome.remedy`) is the one
 * place that happens, verbatim, because it is the server's own instruction
 * (`client-versions.ts`), never this SDK's wording.
 *
 * `code` is deliberately the SAME vocabulary as `../core/token-errors.ts`'s
 * `TokenAction["kind"]` — `AgentClient` classifies every mint failure with
 * `classifyTokenError` and wraps the result here without inventing a second
 * table that could drift from the first.
 */
import type { InstallationGoneReason } from "../core";
export type AgentClientErrorCode = "not_enrolled" | "installation_gone" | "clock" | "session_revoked" | "session_limit" | "corrupt_state" | "update_required" | "rate_limited" | "too_old" | "refused" | "network" | "aborted"
/** The store's installation was enrolled against a DIFFERENT server than this client's
 * own `apiUrl` (`AgentClient.mintInside`'s own check, origins compared via `apiOrigin`)
 * — never minted at all, so never a real server refusal, and never a 4001: retrying
 * would just repeat the same local mismatch forever. Hand-edited config (an `apiUrl`
 * changed without a fresh login for the new one) hits this too. */
 | "server_mismatch";
export interface AgentClientErrorInit {
    code: AgentClientErrorCode;
    message?: string;
    cause?: unknown;
    /** `installation_gone` only — RFC-016 §3.3/§5.4's reason table. */
    reason?: InstallationGoneReason;
    /** `rate_limited` only — seconds, already clamped positive (`token-errors.ts`'s `retryAfter`). */
    retryAfterS?: number;
    /** `too_old` only, when the server's description named one (`>= x.y.z`) — data, not a sentence. */
    minimum?: string;
    /** `server_mismatch` only: the store's installation's own apiUrl (an `apiOrigin()`
     * origin) — data, never a pre-built sentence, same convention as `minimum`/`reason`. */
    installedApiUrl?: string;
    /** `server_mismatch` only: this client's OWN configured apiUrl (an `apiOrigin()` origin). */
    configuredApiUrl?: string;
}
export declare class AgentClientError extends Error {
    readonly name = "AgentClientError";
    readonly code: AgentClientErrorCode;
    readonly reason?: InstallationGoneReason;
    readonly retryAfterS?: number;
    readonly minimum?: string;
    readonly installedApiUrl?: string;
    readonly configuredApiUrl?: string;
    constructor(i: AgentClientErrorInit);
}
export declare function isAgentClientError(e: unknown): e is AgentClientError;
export declare function isTerminalCredentialError(e: unknown): e is AgentClientError;
