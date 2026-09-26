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

export class OAuthError extends Error {
  override readonly name = "OAuthError";
  readonly error: string;
  readonly status: number;
  readonly description?: string;
  readonly retryAfterS?: number;
  readonly dpopNonce?: string;

  constructor(i: OAuthErrorInit) {
    super(`agent-auth: ${i.error}${i.description ? ` ${i.description}` : ""} (${i.status})`);
    this.error = i.error;
    this.status = i.status;
    this.description = i.description;
    this.retryAfterS = i.retryAfterS;
    this.dpopNonce = i.dpopNonce;
  }
}

export function isOAuthError(e: unknown): e is OAuthError {
  const o = e as { name?: unknown; error?: unknown; status?: unknown } | null;
  return typeof o === "object" && o !== null && o.name === "OAuthError" && typeof o.error === "string" && typeof o.status === "number";
}

/** The request never got an HTTP answer (connection, DNS, TLS, a dropped socket). The TokenClient throws this. */
export class TransportError extends Error {
  override readonly name = "TransportError";
}

/**
 * Only a failure to get an answer is transient: `fetch`'s TypeError, an abort or
 * timeout (DOMException `AbortError` / `TimeoutError`), or a TransportError. By name,
 * so a DOMException from another realm counts too. Anything else thrown is a bug —
 * retrying it forever would hide it.
 */
function isTransportFailure(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "TypeError" || name === "AbortError" || name === "TimeoutError" || name === "TransportError";
}

export const GONE_REASONS = ["installation_locked", "installation_revoked", "installation_expired", "installation_unknown", "agent_deactivated"] as const;
export type InstallationGoneReason = (typeof GONE_REASONS)[number];

function isGoneReason(d: string | undefined): d is InstallationGoneReason {
  return (GONE_REASONS as readonly string[]).includes(d as string);
}

export type TokenAction =
  /** Terminal for the installation: stop, delete key + state, tell the human to re-enrol. */
  | { kind: "installation_gone"; reason: InstallationGoneReason }
  /**
   * `assertion_invalid` that survived one clock-corrected retry (C13: stop, KEEP the
   * files). The server also answers it for an unknown, malformed or keyless `client_id`
   * (no enumeration oracle), so it is not always a clock problem. Clock skew can ALSO
   * surface as `invalid_dpop_proof` (`new_proof`): the server checks the proof before the
   * assertion. Both recover once the response's `Date` has been observed.
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
  /** `unsupported_grant_type` / `rfc014_retired` / `dpop_proof_required`: plugin and server disagree on the protocol. */
  | { kind: "update_required" }
  | { kind: "rate_limited"; retryAfterS: number }
  /** A refusal the table does not name, or a non-transport throw: stop and show it, keep the files. */
  | { kind: "refused" }
  /** 5xx / network / timeout: retry later with the SAME attempt. */
  | { kind: "transient" };

/** Exhaustiveness check for a `switch` over `TokenAction["kind"]`. */
export function assertNever(x: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(x)}`);
}

const DEFAULT_RETRY_AFTER_S = 30;

function retryAfter(s: number | undefined): number {
  return typeof s === "number" && Number.isFinite(s) && s >= 0 ? Math.max(1, Math.ceil(s)) : DEFAULT_RETRY_AFTER_S;
}

export function classifyTokenError(e: unknown): TokenAction {
  if (!isOAuthError(e)) return isTransportFailure(e) ? { kind: "transient" } : { kind: "refused" };
  if (e.status === 429) return { kind: "rate_limited", retryAfterS: retryAfter(e.retryAfterS) };
  if (e.status >= 500) return { kind: "transient" };
  switch (e.error) {
    case "invalid_client":
      if (isGoneReason(e.description)) return { kind: "installation_gone", reason: e.description };
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
      // A 0.25 client always sends a proof: "required" means a retry would only loop.
      if (e.description?.startsWith("dpop_proof_required:")) return { kind: "update_required" };
      return e.description === "key_already_enrolled" ? { kind: "refused" } : { kind: "new_proof" };
    case "use_dpop_nonce":
      return { kind: "new_proof" };
    case "unsupported_grant_type":
      return { kind: "update_required" };
    default:
      return { kind: "refused" };
  }
}
