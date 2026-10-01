import { type LockDecision } from "../core";
import type { SessionLock } from "../runtime/store";
/** RFC-017 D3/D8: the lock record's own format — additive fields never bump it (the
 * same D8 rule `./format-guard.ts` states). Mirrors the plugin's `LockRecord` shape
 * so a Claude-plugin session lock and an SDK one can read each other's records for
 * the SAME session key (never expected in practice — session keys are per
 * consumer — but there is no reason to diverge the wire shape gratuitously). */
export interface LockRecord {
    pid: number;
    procStart: string;
    sessionKey: string;
    at: string;
    format?: number;
    software?: string;
    version?: string;
    tty?: string;
    termProgram?: string;
    cwd?: string;
    startedAt?: string;
}
export interface SessionLockIdentity {
    tty?: string;
    termProgram?: string;
    cwd?: string;
}
export interface SessionLockOptions {
    /** The state dir — `locks/` is created inside it (0700), same layout as the plugin. */
    dir: string;
    sessionKey: string;
    /** RFC-017 D4 `software_id` (e.g. `bridge-openclaw`), written into the record for a
     * human-readable standby notice — `decideLock` itself only compares `version`. */
    software: string;
    /** This build's own version — `decideLock`'s "me". */
    version: string;
    identity?: SessionLockIdentity;
    /** The renewal/retry interval for a LIVE holder (default 30 s, the plugin's `LOCK_RETRY_MS`). */
    retryMs?: number;
    /** A live-but-wedged holder's lock is stale past this (default 5 min, the plugin's `LOCK_STALE_MS`). */
    staleMs?: number;
    /** Where an unverifiable-holder warning is reported (minor finding 8: `ps` missing, or a
     * record's own `procStart` empty — this build fails OPEN there, never steals, but a
     * caller may want to know verification was impossible). Best-effort; never throws. */
    log?: (msg: string) => void;
}
export type SessionLockDecision = LockDecision | "lost";
export interface SessionLockHandle extends SessionLock {
    /** Attempt to acquire now — auto (newer wins, RFC-017 D3) or `takeover: true` (the
     * person's explicit choice, which always wins, even onto an older version). Returns
     * `"lost"` when THIS handle already held the lock and just discovered a different
     * live pid there — `onLost` has already fired by the time this resolves. */
    acquire(opts?: {
        takeover?: boolean;
    }): Promise<SessionLockDecision>;
    /** The current holder's record, best-effort (unreadable/absent reads as `null`) —
     * for a standby notice. Never judges liveness itself; see `isHeld()` for that. */
    holder(): Promise<LockRecord | null>;
    /** Stop renewing and release OUR lock. A no-op if we do not currently hold it, and
     * never removes a DIFFERENT holder's record (a takeover, or a stale-path race, may
     * have handed it to someone else by the time this runs). */
    release(): void;
}
export declare function sessionLock(opts: SessionLockOptions): SessionLockHandle;
