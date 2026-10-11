/**
 * The plugin's `CredentialManager` as the SDK `Session`'s client (RFC-027 T4a).
 *
 * The connection is the SDK's; the credential stays the plugin's one step longer
 * (T4b moves it onto `AgentClient` once the SDK has the plugin's stronger sign-in:
 * the jkt-bound browser code, confirm-before-write device flow, O_EXCL attempt).
 *
 * The one translation that matters is the error: `Session` stops on a TERMINAL
 * `AgentClientError` and retries everything else, so a `CredentialError` that means
 * "a person must act" must arrive terminal, and a network failure must not. The
 * original `CredentialError` rides as `cause`: server.ts reads its `kind` to decide
 * what a stopped session waits for.
 */
import { AgentClientError, type AgentClientErrorCode, type SessionClient, type SendBody, type SendResult } from "../vendor/bridge-agent-sdk/index.js";
import type { DeliveriesResponse } from "../vendor/bridge-agent-sdk/core/index.js";
import { CredentialError, type CredentialManager } from "../auth/manager";

/** Exhaustive over `CredentialError.kind` — a new kind must decide here. */
export function credentialCode(kind: CredentialError["kind"]): AgentClientErrorCode {
  switch (kind) {
    case "not_logged_in":
    case "profile":
    case "api_url":
    case "logged_out":
    case "refused":
      return "refused";
    case "session_revoked":
      return "session_revoked";
    case "session_limit":
      return "session_limit";
    case "too_old":
      return "too_old";
    case "network":
      return "network";
    default: {
      const never: never = kind;
      return never;
    }
  }
}

export function toAgentClientError(err: unknown): AgentClientError {
  if (err instanceof CredentialError) return new AgentClientError({ code: credentialCode(err.kind), message: err.message, cause: err });
  // Anything else (a discovery 5xx mid-deploy, a timeout, the lock cap) retries.
  return new AgentClientError({ code: "network", message: err instanceof Error ? err.message : String(err), cause: err });
}

/** The CredentialError behind a Session's credential stop, if that is what it was. */
export function credentialCause(err: unknown): CredentialError | null {
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  return cause instanceof CredentialError ? cause : null;
}

/** JSON over the plugin's own `apiFetch` (DPoP, the one 401 retry, the deadline). Throws on non-2xx. */
export type ApiJson = (method: string, path: string, body?: unknown) => Promise<unknown>;

/**
 * `rotate` is what server.ts wires into `ManagerDeps.onAccessRotated` (the manager has one
 * rotation callback): it hands a refreshed token to the subscribed Session's in-band reauth.
 */
export function sessionClient(
  creds: CredentialManager,
  o: { sessionKey: () => string; softwareId: string; softwareVersion: string; api: ApiJson }
): SessionClient & { rotate(frame: { token: string; dpop: string }): void } {
  let rotated: ((frame: { token: string; dpop: string }) => void) | null = null;
  return {
    rotate: (frame) => rotated?.(frame),
    apiUrl: () => creds.apiUrl(),
    sessionKey: o.sessionKey,
    softwareId: () => o.softwareId,
    softwareVersion: () => o.softwareVersion,
    wsAuth: () => creds.wsAuth().catch((err) => Promise.reject(toAgentClientError(err))),
    grant: () => creds.grant(),
    invalidateAccess: (token) => creds.invalidateAccess(token),
    sessionRevoked: (id) => creds.sessionRevoked(id),
    installationRevoked: (id) => creds.installationRevoked(id),
    // One subscriber at a time: the live Session.
    onAccessRotated: (cb) => {
      rotated = cb;
      return () => {
        if (rotated === cb) rotated = null;
      };
    },
    api: {
      messages: { create: (channelId: string, body: SendBody & { title?: string }) => o.api("POST", "/api/messages", { channelId, ...body }) as Promise<SendResult> },
      threads: { reply: (threadId: string, body: SendBody) => o.api("POST", `/api/threads/${encodeURIComponent(threadId)}/messages`, body) as Promise<SendResult> },
      deliveries: { list: () => o.api("GET", "/api/deliveries") as Promise<DeliveriesResponse> },
    },
  };
}
