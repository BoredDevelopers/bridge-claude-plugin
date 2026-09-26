/** RFC-016 §3.3: the token endpoint's error table → what the client does. Pure. */
import { describe, test, expect } from "bun:test";
import { classifyTokenError, OAuthError } from "../auth/core/token-errors";

describe("§3.3 error table → client action", () => {
  const e = (error: string, description?: string, status = 400, retry?: number) => new OAuthError(error, status, description, retry);
  test.each([
    [e("invalid_client", "installation_locked"), { kind: "installation_gone", reason: "installation_locked" }],
    [e("invalid_client", "installation_revoked"), { kind: "installation_gone", reason: "installation_revoked" }],
    [e("invalid_client", "installation_expired"), { kind: "installation_gone", reason: "installation_expired" }],
    [e("invalid_client", "installation_unknown"), { kind: "installation_gone", reason: "installation_unknown" }],
    [e("invalid_client", "agent_deactivated"), { kind: "installation_gone", reason: "agent_deactivated" }],
    [e("invalid_client", "assertion_invalid"), { kind: "clock" }],
    [e("invalid_client"), { kind: "refused" }],
    [e("invalid_grant", "session_revoked"), { kind: "session_revoked" }],
    [e("invalid_grant", "session_limit"), { kind: "session_limit" }],
    [e("invalid_request", "corrupt_state"), { kind: "corrupt_state" }],
    [e("invalid_dpop_proof"), { kind: "new_proof" }],
    [e("use_dpop_nonce"), { kind: "new_proof" }],
    [e("unsupported_grant_type"), { kind: "update_required" }],
    // Server-verified rows (bridge routes/agent-auth.ts + agent-credentials.ts), beyond the RFC table:
    // C6 — the same key can never pass, so it is NOT a "new proof" (the fresh-key retry happens before classification).
    [e("invalid_dpop_proof", "key_already_enrolled"), { kind: "refused" }],
    // A proofless enrolment/poll (the proof never reached the server): a proof problem.
    [e("invalid_dpop_proof", "dpop_proof_required: update the Bridge plugin and run /bridge:login"), { kind: "new_proof" }],
    // E13: an RFC-014 grant reached the server — this client speaks the retired protocol.
    [e("invalid_grant", "rfc014_retired: update the Bridge plugin and run /bridge:login"), { kind: "update_required" }],
    // Code replay / consumed device code / verifier or dpop_jkt mismatch (C7): bare invalid_grant.
    [e("invalid_grant"), { kind: "refused" }],
    // Request-shape refusals are client bugs: stop, show, keep the files (C13 "unlisted").
    [e("invalid_request", "attempt_invalid"), { kind: "refused" }],
    [e("invalid_request", "session_key_invalid"), { kind: "refused" }],
    [e("invalid_request", "scope_invalid"), { kind: "refused" }],
    [e("invalid_request", "key_storage_invalid"), { kind: "refused" }],
    [e("rate_limited", undefined, 429, 7), { kind: "rate_limited", retryAfterS: 7 }],
    [e("rate_limited", undefined, 429), { kind: "rate_limited", retryAfterS: 30 }],
    [e("http_502", undefined, 502), { kind: "transient" }],
    [e("http_500", undefined, 500), { kind: "transient" }],
    [new Error("fetch failed"), { kind: "transient" }],
  ] as const)("%o", (err, action) => {
    expect(classifyTokenError(err)).toEqual(action as any);
  });
});
