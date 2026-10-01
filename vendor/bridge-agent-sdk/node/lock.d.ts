/**
 * RFC-018 S1.4 — the installation lock: `CredentialStore.withLock`'s node
 * implementation (RFC-016 §5.2). ADAPTED from the plugin's `auth/node/lock.ts`:
 * behaviourally the same mechanism (`mkdir` as the atomic acquire; STALE = older
 * than 120 s BY THE CLOCK and nothing else — no pid check, no heartbeat; breaking a
 * stale lock itself serialized via `.break`), with the plugin's own explicit-timer
 * hold budget replaced by `../core/deadline.ts`'s `deadline()` (RFC-018 D2: "the
 * only way the SDK imposes a time limit" — this file is where the plugin ALREADY
 * used that exact shape, ahead of D2 existing as a rule, so this is a rename onto
 * the shared primitive, not a behaviour change). The plugin's cross-version
 * coexistence with an RFC-014 (≤ 0.24) `.lock` directory is NOT ported: that was
 * the Claude plugin's own upgrade path, and no SDK consumer has an equivalent
 * earlier on-disk format to share a profile with.
 *
 * ⚠️ CONTRACT (unchanged from the plugin): every request that presents or creates
 * this store's credential state runs inside ONE `withInstallationLock` call, and
 * reads `state`/`attempt` from disk INSIDE it — never a copy read before — so two
 * processes on the machine never present the same join state with different
 * attempts (a false lock, RFC-016 E6d). The holder bounds ALL its work by the
 * `signal` it is handed (`HOLD_BUDGET_MS < STALE_MS`), so a live holder is never
 * judged stale.
 *
 * ⚠️ BREAKING A STALE LOCK IS ITSELF SERIALIZED (`<lock>.break`). Without that, two
 * waiters that both judge the same stale lock race: the first removes it and takes
 * a fresh one, the second's remove then deletes THAT fresh lock and both end up
 * inside (measured under RFC-014: 15/20 trials with 8 processes, plugin history).
 *
 * Node `fs` + timers only — no `Bun.` API (the node adapter's grep guard,
 * `test/node/no-bun-apis.test.ts`).
 */
import * as fs from "node:fs";
export declare const LOCK_DIR_NAME = ".install-lock";
export declare const STALE_MS = 120000;
/** One deadline for everything a holder does inside (discovery + enrol, or mint, or revoke). */
export declare const HOLD_BUDGET_MS = 90000;
/** A waiter must outwait one stale holder, or it gives up just before the break. */
export declare const LOCK_WAIT_MS = 150000;
/** The mutating calls, as one object so tests can inject failures (ESM imports cannot be spied on). */
export declare const __lockIo: {
    rmSync: typeof fs.rmSync;
    renameSync: typeof fs.renameSync;
    writeFileSync: typeof fs.writeFileSync;
};
/**
 * Remove release tombstones (`.install-lock.released-<nonce>`) a failed release left
 * behind. Only those older than STALE_MS: a tombstone is a lock directory moved
 * aside, so its age is its lock's, and a lock that old is breakable anyway. Call
 * once when a process opens the profile. Returns how many it removed; never throws.
 */
export declare function sweepLockTombstones(profileDir: string): number;
export interface LockOptions {
    /** How long to wait for the lock (default LOCK_WAIT_MS). */
    waitMs?: number;
    /** The holder's budget; `signal` aborts when it is spent (default HOLD_BUDGET_MS; must be < STALE_MS). */
    holdMs?: number;
    /** Stop WAITING (not holding) — rejects with the signal's reason. */
    signal?: AbortSignal;
    /** Where a failed release is reported (it never fails the caller: the stale break reclaims the lock). */
    log?: (msg: string) => void;
}
export declare function withInstallationLock<T>(profileDir: string, fn: (lease: {
    signal: AbortSignal;
}) => Promise<T>, o?: LockOptions): Promise<T>;
