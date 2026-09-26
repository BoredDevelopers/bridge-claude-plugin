/** RFC-016 §3.3: the token endpoint's error table → what the client does. Pure. */
import { describe, test, expect } from "bun:test";
import { assertNever, classifyTokenError, isOAuthError, OAuthError, TransportError, type TokenAction } from "../auth/core/token-errors";

describe("§3.3 error table → client action", () => {
  const e = (error: string, description?: string, status = 400, retryAfterS?: number) => new OAuthError({ error, status, description, retryAfterS });
  test.each([
    [e("invalid_client", "installation_locked"), { kind: "installation_gone", reason: "installation_locked" }],
    [e("invalid_client", "installation_revoked"), { kind: "installation_gone", reason: "installation_revoked" }],
    [e("invalid_client", "installation_expired"), { kind: "installation_gone", reason: "installation_expired" }],
    [e("invalid_client", "installation_unknown"), { kind: "installation_gone", reason: "installation_unknown" }],
    [e("invalid_client", "agent_deactivated"), { kind: "installation_gone", reason: "agent_deactivated" }],
    [e("invalid_client", "assertion_invalid"), { kind: "clock" }],
    [e("invalid_client"), { kind: "refused" }],
    // RFC 6749 §5.2 allows invalid_client at 401: classified by code, not status.
    [e("invalid_client", "installation_revoked", 401), { kind: "installation_gone", reason: "installation_revoked" }],
    [e("invalid_client", undefined, 401), { kind: "refused" }],
    [e("invalid_grant", "session_revoked"), { kind: "session_revoked" }],
    [e("invalid_grant", "session_limit"), { kind: "session_limit" }],
    [e("invalid_request", "corrupt_state"), { kind: "corrupt_state" }],
    [e("invalid_dpop_proof"), { kind: "new_proof" }],
    [e("use_dpop_nonce"), { kind: "new_proof" }],
    [e("unsupported_grant_type"), { kind: "update_required" }],
    // Server-verified rows (bridge routes/agent-auth.ts + agent-credentials.ts), beyond the RFC table:
    // C6 — the same key can never pass, so it is NOT a "new proof" (the fresh-key retry happens before classification).
    [e("invalid_dpop_proof", "key_already_enrolled"), { kind: "refused" }],
    // A proofless request: a 0.25 client always sends one, so a retry would loop — the server's hint is the action.
    [e("invalid_dpop_proof", "dpop_proof_required: update the Bridge plugin and run /bridge:login"), { kind: "update_required" }],
    // E13: an RFC-014 grant reached the server — this client speaks the retired protocol.
    [e("invalid_grant", "rfc014_retired: update the Bridge plugin and run /bridge:login"), { kind: "update_required" }],
    // Code replay / consumed device code / verifier or dpop_jkt mismatch (C7): bare invalid_grant.
    [e("invalid_grant"), { kind: "refused" }],
    // Request-shape refusals are client bugs: stop, show, keep the files (C13 "unlisted").
    [e("invalid_request", "attempt_invalid"), { kind: "refused" }],
    [e("invalid_request", "session_key_invalid"), { kind: "refused" }],
    [e("invalid_request", "scope_invalid"), { kind: "refused" }],
    [e("invalid_request", "key_storage_invalid"), { kind: "refused" }],
    // 429: status wins over the code; Retry-After clamped to ≥ 1 s, garbage → 30 s.
    [e("rate_limited", undefined, 429, 7), { kind: "rate_limited", retryAfterS: 7 }],
    [e("rate_limited", undefined, 429), { kind: "rate_limited", retryAfterS: 30 }],
    [e("invalid_client", "installation_revoked", 429, 5), { kind: "rate_limited", retryAfterS: 5 }],
    [e("rate_limited", undefined, 429, 0), { kind: "rate_limited", retryAfterS: 1 }],
    [e("rate_limited", undefined, 429, 2.5), { kind: "rate_limited", retryAfterS: 3 }],
    [e("rate_limited", undefined, 429, -4), { kind: "rate_limited", retryAfterS: 30 }],
    [e("rate_limited", undefined, 429, NaN), { kind: "rate_limited", retryAfterS: 30 }],
    [e("http_502", undefined, 502), { kind: "transient" }],
    [e("http_500", undefined, 500), { kind: "transient" }],
    [e("invalid_client", "installation_revoked", 503), { kind: "transient" }],
    // Only a TRANSPORT failure is transient; any other throw is a bug to show, not to retry forever.
    [new TransportError("socket hang up"), { kind: "transient" }],
    [new DOMException("The operation timed out.", "TimeoutError"), { kind: "transient" }],
    [new DOMException("The operation was aborted.", "AbortError"), { kind: "transient" }],
    [new Error("not a P-256 private JWK"), { kind: "refused" }],
    [new RangeError("boom"), { kind: "refused" }],
    ["a string", { kind: "refused" }],
    [null, { kind: "refused" }],
  ] as const)("%o", (err, action) => {
    expect(classifyTokenError(err)).toEqual(action as any);
  });

  test("a real fetch failure (TypeError from fetch) is transient", async () => {
    const err = await fetch("http://127.0.0.1:1/").then(
      () => null,
      (x: unknown) => x
    );
    expect(err).toBeInstanceOf(TypeError);
    expect(classifyTokenError(err)).toEqual({ kind: "transient" });
  });
});

describe("OAuthError brand (dual-package hazard)", () => {
  test("named, options-constructed, and recognised by brand — not by instanceof", () => {
    const err = new OAuthError({ error: "invalid_client", status: 400, description: "installation_revoked", dpopNonce: "n" });
    expect(err.name).toBe("OAuthError");
    expect(err).toMatchObject({ error: "invalid_client", status: 400, description: "installation_revoked", dpopNonce: "n" });
    expect(err.message).toBe("agent-auth: invalid_client installation_revoked (400)");
    expect(isOAuthError(err)).toBe(true);
    // A second copy of the class (another package instance): same brand + fields, different prototype.
    const foreign = Object.assign(new Error("x"), { name: "OAuthError", error: "invalid_client", status: 400, description: "installation_revoked" });
    expect(foreign instanceof OAuthError).toBe(false);
    expect(isOAuthError(foreign)).toBe(true);
    expect(classifyTokenError(foreign)).toEqual({ kind: "installation_gone", reason: "installation_revoked" });
    // The brand alone is not enough: the fields must be there.
    expect(isOAuthError(Object.assign(new Error("x"), { name: "OAuthError" }))).toBe(false);
    // …and the fields alone are not enough: some other error that happens to carry `error` + `status`.
    const lookalike = Object.assign(new Error("x"), { error: "invalid_client", status: 400, description: "installation_revoked" });
    expect(isOAuthError(lookalike)).toBe(false);
    expect(classifyTokenError(lookalike)).toEqual({ kind: "refused" });
  });

  test("assertNever throws for an unhandled action", () => {
    expect(() => assertNever({ kind: "nope" } as never)).toThrow();
    const exhaustive = (a: TokenAction): string => {
      switch (a.kind) {
        case "installation_gone":
        case "clock":
        case "session_revoked":
        case "session_limit":
        case "corrupt_state":
        case "new_proof":
        case "update_required":
        case "rate_limited":
        case "refused":
        case "transient":
          return a.kind;
        default:
          return assertNever(a);
      }
    };
    expect(exhaustive({ kind: "clock" })).toBe("clock");
  });
});
