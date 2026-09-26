/**
 * Shared RFC-016 agent-auth routes for test stubs that run their OWN Bun.serve
 * app (WS + a handful of REST endpoints) and only need a WORKING plugin
 * credential, not to exercise the auth protocol itself.
 *
 * Not a second, laxer implementation: it IS the strict stub's core
 * (agent-auth-stub.ts `createAuthCore`) — every enrolment and mint these suites
 * trigger, with its token-endpoint proof and assertion, is verified exactly as in
 * the auth suites. ⚠️ Only the AGENT-AUTH routes: the suites' own REST and WS
 * handlers accept any token and verify no DPoP proof. The HTTP and WS proofs are
 * proven by agent-login-e2e.test.ts (and auth-manager.test.ts for HTTP) against the
 * stub's own API/WS — not by these suites.
 *
 * A stub calls `handle(req)` FIRST in its own `fetch`; a non-null Response is
 * agent-auth's to answer, `null` means "not an agent-auth route, handle it
 * yourself". The plugin enrols for real via BRIDGE_ENROLMENT_KEY before it can
 * open a socket.
 */
import { createAuthCore, type StubOptions } from "./agent-auth-stub";

export interface AgentAuthRoutes {
  /** Call first in a stub's fetch handler; a non-null Response is already final. */
  handle(req: Request): Promise<Response | null>;
  /** A key in the server's format (+ CRC) that `enrolFromKeyIfNeeded()` can redeem `uses` times. */
  mintEnrolmentKey(uses?: number): string;
  /** Register a specific, well-formed key (see mintAgentToken) — for a key shared across stubs. */
  addEnrolmentKey(key: string, uses?: number): void;
}

export function createAgentAuthRoutes(opts: Pick<StubOptions, "agentId" | "accessTtlS"> = {}): AgentAuthRoutes {
  const core = createAuthCore(opts);
  return {
    mintEnrolmentKey: (uses = 1) => core.mintEnrolmentKey(uses),
    addEnrolmentKey: (key, uses = 1) => core.addEnrolmentKey(key, uses),
    handle: (req) => core.handleAuth(req),
  };
}
