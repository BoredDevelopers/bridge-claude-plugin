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
 * - transient   (1000/1001/1006/1011/4006/anything unknown): the network or a
 *               restart; retry soon. 1011 "grant check failed" (RFC-016) is the
 *               server's grant re-check hitting a database error — its fault, not
 *               the token's: same token, retry soon.
 * - session-cap (4007): this agent already has the server's maximum live
 *               sockets. A slot frees when a sibling session closes or a dead
 *               socket is swept — not within a second — and every refused
 *               retry spends the machine's per-IP upgrade budget that its
 *               HEALTHY sessions need. So: slow.
 * - credential  (4001 token or proof refused, 4003 deregistered/workspace
 *               archived): a 4001 gets ONE immediate re-mint (RFC-016 C14, in
 *               server.ts); after that, and for 4003 (undone by someone else:
 *               reactivate, workspace restore), keep retrying — slowly — so the
 *               session recovers without anyone touching the terminal.
 * - expired     (4009, RFC-014 D9): the access token ran out before a reauth. The
 *               credential manager refreshes on the way back in, so retry soon.
 * - evicted     (4008 "session evicted", bridge#209): the agent hit its live-session
 *               cap and the server evicted THIS session to make room. Nothing is
 *               wrong with the credential: mint a new session (no reconnect=true,
 *               no block — E9's stop is for a session a PERSON revoked) and
 *               reconnect soon.
 * - revoked     (4008): the session or the machine's installation was revoked
 *               ("session revoked" / "installation revoked") or LOCKED because a
 *               copy of its credential was used ("installation locked", RFC-016 E8)
 *               and will never work again. Retrying is pointless; stop and tell the
 *               user.
 */

export type CloseClass = "transient" | "expired" | "evicted" | "session-cap" | "credential" | "revoked";

const SCHEDULE: Record<Exclude<CloseClass, "revoked">, { baseMs: number; capMs: number }> = {
  transient: { baseMs: 1_000, capMs: 30_000 },
  expired: { baseMs: 1_000, capMs: 30_000 },
  evicted: { baseMs: 1_000, capMs: 30_000 },
  "session-cap": { baseMs: 30_000, capMs: 300_000 },
  credential: { baseMs: 60_000, capMs: 300_000 },
};

export function classifyClose(code: number | undefined, reason?: string): CloseClass {
  switch (code) {
    case 4007:
      return "session-cap";
    case 4001:
    case 4003:
      return "credential";
    case 4008:
      return reason === "session evicted" ? "evicted" : "revoked";
    case 4009:
      return "expired";
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
export function describeClose(
  cls: CloseClass,
  code: number | undefined,
  reason: string | undefined,
  /** Whether THIS close made the plugin delete the installation's files (4008 revoked / locked). */
  opts: { keyDeleted?: boolean } = {}
): string {
  const tail = `${code ?? "?"}${reason ? ` "${reason}"` : ""}`;
  switch (cls) {
    case "session-cap":
      return `too many live sessions for this agent (${tail}) — close another session, or wait for a slot`;
    case "credential":
      switch (code) {
        case 4001:
          return `Bridge refused this session's access token (${tail}) — a new one is minted; if this keeps happening, run /bridge:login`;
        case 4003:
          return `agent deactivated or workspace archived (${tail}) — retrying slowly; an admin can reactivate it, otherwise run /bridge:login`;
        default:
          return `Bridge refused this session's credential (${tail}) — retrying slowly; if this keeps happening, run /bridge:login`;
      }
    case "expired":
      return `access token expired (${tail}) — refreshing`;
    case "evicted":
      return `this session was evicted to make room under the agent's live-session cap (${tail}) — reconnecting with a new session`;
    case "revoked":
      if (reason === "session revoked") return `this session was revoked in Bridge (${tail}) — /bridge:connect starts a new session`;
      if (reason === "installation revoked")
        return `this machine was signed out of Bridge (${tail}) — run /bridge:login to connect it again`;
      if (reason === "installation locked")
        return `credential copy detected — Bridge LOCKED this machine's sign-in because a copy of its credential was used somewhere else (${tail})${opts.keyDeleted ? "; its key was deleted here" : ""} — check this machine, then run /bridge:login to re-enrol`;
      return `token revoked (${tail}) — run /bridge:login, then /bridge:connect`;
    default:
      return `connection closed (${tail})`;
  }
}
