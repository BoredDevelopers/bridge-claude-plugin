/**
 * How long to wait before reconnecting, by WHY the socket closed.
 *
 * Pure (no I/O, randomness injected) so every bound is unit-testable.
 *
 * ⚠️ JITTER IS THE POINT, NOT A NICETY. The old delay was `min(1s × attempt,
 * 30s)` — identical for every session — so a server restart made every
 * connected session retry in lockstep at 1s, 2s, 3s… That herd is what the
 * server's per-IP upgrade limit (bridge#190, burst 30) now refuses in bulk.
 * Exponential with EQUAL jitter (`b/2 + rand·b/2`) spreads them, and matches
 * the web client (`packages/web/src/lib/api.ts`), so both clients follow one
 * policy.
 *
 * Classes, by what fixes the refusal:
 * - transient   (1000/1001/1006/4006/anything unknown): the network or a
 *               restart; retry soon.
 * - session-cap (4007): this agent already has the server's maximum live
 *               sockets. A slot frees when a sibling session closes or a dead
 *               socket is swept — not within a second — and every refused
 *               retry spends the machine's per-IP upgrade budget that its
 *               HEALTHY sessions need. So: slow.
 * - credential  (4001 invalid token, 4003 deregistered/workspace archived):
 *               today both are undone by someone else with the SAME token
 *               (reactivate; workspace restore), so keep retrying — slowly — and
 *               the session recovers without anyone touching the terminal.
 * - revoked     (4008, reserved): the token itself was revoked or rotated away
 *               and will never work again. Retrying is pointless; stop and tell
 *               the user. Shipped ahead of the server feature on purpose:
 *               plugins update slowly, so the installed base should understand
 *               the code before the server first sends it.
 */

export type CloseClass = "transient" | "session-cap" | "credential" | "revoked";

const SCHEDULE: Record<Exclude<CloseClass, "revoked">, { baseMs: number; capMs: number }> = {
  transient: { baseMs: 1_000, capMs: 30_000 },
  "session-cap": { baseMs: 30_000, capMs: 300_000 },
  credential: { baseMs: 60_000, capMs: 300_000 },
};

export function classifyClose(code: number | undefined): CloseClass {
  switch (code) {
    case 4007:
      return "session-cap";
    case 4001:
    case 4003:
      return "credential";
    case 4008:
      return "revoked";
    default:
      return "transient";
  }
}

/**
 * Delay before reconnect attempt `attempt` (1-based), or `null` = do not
 * reconnect. `rand` in [0, 1).
 */
export function reconnectDelay(attempt: number, cls: CloseClass, rand: () => number = Math.random): number | null {
  if (cls === "revoked") return null;
  const { baseMs, capMs } = SCHEDULE[cls];
  const n = Math.max(1, Math.floor(attempt));
  const backoff = Math.min(capMs, baseMs * 2 ** (n - 1));
  return Math.round(backoff / 2 + rand() * (backoff / 2));
}

/** A human-readable reason for `status` and notifications. */
export function describeClose(cls: CloseClass, code: number | undefined, reason: string | undefined): string {
  const tail = `${code ?? "?"}${reason ? ` "${reason}"` : ""}`;
  switch (cls) {
    case "session-cap":
      return `too many live sessions for this agent (${tail}) — close another session, or wait for a slot`;
    case "credential":
      return `token rejected or agent deactivated (${tail}) — an admin can reactivate it; otherwise fix the token with /bridge:configure`;
    case "revoked":
      return `token revoked (${tail}) — set the new token with /bridge:configure, then /bridge:connect`;
    default:
      return `connection closed (${tail})`;
  }
}
