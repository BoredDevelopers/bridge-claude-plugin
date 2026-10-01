/**
 * The WS replay cursor's `since` math. ADAPTED from the plugin's `sinceParam()` /
 * cursor-advance logic (server.ts, pre-`@bridge/agent-sdk`) — same arithmetic,
 * turned into two pure functions with the clock and the cursor as PARAMETERS
 * instead of a module-level `let lastMessageTime` and `Date.now()`, so `Session`
 * (S1.3) can own the state and this stays unit-testable with no wall clock.
 *
 * Deliberately unrelated to `./clock.ts`'s `Clock`: that class tracks the SERVER's
 * clock offset for signing (`iat` on a DPoP proof / assertion); the replay cursor
 * always walks this process's OWN local clock, exactly as the plugin did.
 */
/** A long-idle reconnect must not dump an unbounded backlog into the session. */
export declare const MAX_REPLAY_AGE_MS: number;
/**
 * The `since` ISO-8601 timestamp to send on the next auth frame. `lastMessageTime`
 * is the cursor (an ISO string, or `null` on first-ever connect); `nowMs` is
 * injected so this stays pure.
 *
 * Subtracts 1ms from the saved cursor so the server's `>` (not `>=`) comparison
 * cannot miss a message stamped in the exact same instant as the last one
 * delivered, then clamps to `nowMs - MAX_REPLAY_AGE_MS` so a session idle for
 * days cannot request days of backlog. `null`/non-finite cursor falls back to
 * "now" — a fresh session requests zero replay, same as the plugin's own default.
 */
export declare function sinceParam(lastMessageTime: string | null, nowMs: number): string;
/**
 * Advance the cursor with a delivered message's `createdAt` (ISO-8601). The
 * cursor only ever moves FORWARD, and ISO-8601 timestamps compare correctly as
 * plain strings (lexicographic order = chronological order for a fixed-width,
 * zero-padded, single-timezone format) — matching the plugin's own `>` compare, no
 * `Date` parse needed on the hot path.
 */
export declare function advanceCursor(current: string | null, createdAt: string | null | undefined): string | null;
