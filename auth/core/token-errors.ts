/**
 * RFC-016 §3.3 error table → what the client does. Pure, so the whole table is
 * one unit test. The server's `error` is the RFC 6749 §5.2 code; its
 * `error_description` is a TOKEN the client switches on (never prose) — or, for
 * the two stale-client answers, a `<token>: <hint>` string (`rfc014_retired: …`,
 * `dpop_proof_required: …`), matched by its token prefix.
 */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly status: number,
    readonly description?: string,
    readonly retryAfterS?: number,
    readonly dpopNonce?: string
  ) {
    super(`agent-auth: ${error}${description ? ` ${description}` : ""} (${status})`);
  }
}

export type InstallationGoneReason =
  | "installation_locked"
  | "installation_revoked"
  | "installation_expired"
  | "installation_unknown"
  | "agent_deactivated";

export type TokenAction =
  /** Terminal for the installation: stop, delete key + state, tell the human to re-enrol. */
  | { kind: "installation_gone"; reason: InstallationGoneReason }
  /**
   * `assertion_invalid` that survived one clock-corrected retry (C13: stop, KEEP the
   * files). The server also answers it for an unknown, malformed or keyless `client_id`
   * (no enumeration oracle), so it is not always a clock problem.
   */
  | { kind: "clock" }
  | { kind: "session_revoked" }
  | { kind: "session_limit" }
  | { kind: "corrupt_state" }
  /**
   * `invalid_dpop_proof` / `use_dpop_nonce` that survived the in-request retry. NOT
   * `key_already_enrolled` (C6): the same key can never pass; that one is `refused`
   * here, after the caller's one fresh-key retry.
   */
  | { kind: "new_proof" }
  /** `unsupported_grant_type` / `rfc014_retired`: plugin and server disagree on the protocol. */
  | { kind: "update_required" }
  | { kind: "rate_limited"; retryAfterS: number }
  /** A 4xx the table does not name: stop and show it, keep the files. */
  | { kind: "refused" }
  /** 5xx / network / timeout: retry later with the SAME attempt. */
  | { kind: "transient" };

const GONE = new Set<string>(["installation_locked", "installation_revoked", "installation_expired", "installation_unknown", "agent_deactivated"]);

export function classifyTokenError(e: unknown): TokenAction {
  if (!(e instanceof OAuthError)) return { kind: "transient" };
  if (e.status === 429) return { kind: "rate_limited", retryAfterS: e.retryAfterS ?? 30 };
  if (e.status >= 500) return { kind: "transient" };
  switch (e.error) {
    case "invalid_client":
      if (e.description && GONE.has(e.description)) return { kind: "installation_gone", reason: e.description as InstallationGoneReason };
      if (e.description === "assertion_invalid") return { kind: "clock" };
      return { kind: "refused" };
    case "invalid_grant":
      if (e.description?.startsWith("rfc014_retired:")) return { kind: "update_required" };
      if (e.description === "session_revoked") return { kind: "session_revoked" };
      if (e.description === "session_limit") return { kind: "session_limit" };
      return { kind: "refused" };
    case "invalid_request":
      return e.description === "corrupt_state" ? { kind: "corrupt_state" } : { kind: "refused" };
    case "invalid_dpop_proof":
      return e.description === "key_already_enrolled" ? { kind: "refused" } : { kind: "new_proof" };
    case "use_dpop_nonce":
      return { kind: "new_proof" };
    case "unsupported_grant_type":
      return { kind: "update_required" };
    default:
      return { kind: "refused" };
  }
}
