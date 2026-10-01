/**
 * SOURCE: Claude Code plugin `claude-channel-bridge` 0.26.2 (commit c8b0db6),
 * `auth/core/deadline.ts`. BYTE-IDENTICAL below the marker — RFC-018 D1/D10: the
 * plugin's auth/core files "move into @bridge/agent-sdk unchanged", and until the
 * plugin re-platforms onto this package (S5) the two copies are kept identical by
 * `test/byte-identity.test.ts` against the pinned original in
 * `fixtures/plugin-core/deadline.ts`.
 *
 * NOTE (review finding, nit): the body below reaches `setTimeout`/`clearTimeout`/
 * `DOMException` as AMBIENT globals rather than through `Runtime.timer` — a deliberate
 * exception to `/core`'s usual "no ambient timer" shape, kept ONLY because this file is
 * byte-identical to the plugin's (see the sentinel below; `tsconfig.core.json`'s DOM lib
 * supplies these three globals, so it still passes the purity gate). Left as-is on
 * purpose: the plugin-side half of this equivalence check (comparing the PLUGIN's own
 * `deadline.ts` against this file once IT re-platforms onto the SDK) lands in S5, not
 * here.
 */
/**
 * The one place a deadline is built (RFC-016 §5.2 lineage; the future SDK's `deadline()`).
 *
 * NEVER `AbortSignal.timeout(ms)` composed through `AbortSignal.any([...])`: it is
 * unreliable on Bun 1.3–1.4 (the scheduled abort silently never fires once the last
 * abort listener on the timeout signal is removed — coder/xum#4958, oven-sh/bun#29546)
 * and on Node (nodejs/node#57736, confirmed). We hit this for real: the installation
 * lock's hold budget never fired on Bun 1.3 (auth/node/lock.ts). The fix there and here
 * is the same shape: an explicit `AbortController` + `setTimeout`, which always fires.
 *
 * Aborts with a `DOMException("…", "TimeoutError")` — the exact reason/name every
 * caller's classification keys on (auth/core/token-errors.ts `isTransportFailure`,
 * auth/core/protocol.ts `callerCancelled`): keep that contract if this ever changes.
 * A `parents` signal that aborts first wins, WITH ITS OWN REASON (so a caller's own
 * cancel still classifies as a caller cancel, never as our timeout).
 *
 * Callers MUST call `clear()` (in a `finally`) once done with `signal` — it clears the
 * timer and detaches the parent listeners; skipping it leaks both.
 */
export interface Deadline {
    readonly signal: AbortSignal;
    clear(): void;
}
export declare function deadline(ms: number, ...parents: (AbortSignal | undefined)[]): Deadline;
