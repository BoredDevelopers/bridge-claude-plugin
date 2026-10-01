/**
 * Persistence PORTS (RFC-018 S1.3 plan, item 2) — interfaces only. The node
 * implementations (a real `fileStore(dir)`, the RFC-017 session lock with its
 * proc registry) land in S1.4/T3; this file also ships an in-memory
 * implementation of each, for tests AND for an embedder that wants no disk at
 * all (a serverless OpenClaw account, a browser demo).
 */
import type { EcPrivateJwk, KeyStorage } from "../core";
/** What an enrolment (`../core/protocol.ts`'s `EnrolGrant`) actually leaves behind on this machine. */
export interface Installation {
    installationId: string;
    installationName?: string;
    apiUrl: string;
    jkt: string;
    keyStorage: KeyStorage;
    agent?: {
        id: string;
        handle: string | null;
        name: string;
    };
    workspace?: {
        id: string;
        name: string;
    };
}
/** The whole credential, as one unit — a store MAY split this into several files
 * (the plugin's `installation.json` + `key.json` + `state`), but reads/writes it
 * atomically from `AgentClient`'s point of view. */
export interface CredentialRecord {
    installation: Installation;
    privateJwk: EcPrivateJwk;
    joinState: string;
}
/**
 * Key + join-state, behind one async lock (S1.3 plan). Every mint/enrol/revoke in
 * `AgentClient` runs inside `withLock` — the plugin's `withInstallationLock`,
 * generalised past `node:fs` so this file stays a Web-globals interface; the node
 * adapter's flock-style implementation (S1.4's `fileStore`) is what makes the lock
 * hold across PROCESSES, not just within one. No access-token slot: `AgentClient`
 * always re-checks `expiresAt` itself and mints fresh the moment it is unsure, so
 * caching a mint on the store would only ever be a redundant, staleness-prone copy
 * of state `AgentClient` already holds in memory (RFC-018 S1.4 plan item 5 — dropped
 * dead interface surface, not carried from the plugin's own on-disk cache).
 */
export interface CredentialStore {
    read(): Promise<CredentialRecord | null>;
    /** Replace the whole credential (a fresh enrolment, or a login that supersedes an old one). */
    write(record: CredentialRecord): Promise<void>;
    /** RFC-016 §3.3: advance the join-state only — never call this with an OLDER state than
     * what `read()` last returned (`../core/join-state.ts`'s `joinStateSeq` is how a caller
     * checks; this port does not re-validate, the same trust boundary `store.writeStateIfNotOlder`
     * documents in the plugin). */
    writeJoinState(joinState: string): Promise<void>;
    /** Delete everything — logout, or a terminal `installation_gone`. */
    clear(): Promise<void>;
    /** E5's write-ahead attempt: created before a mint request leaves the process, read back
     * on the retry after a lost answer, deleted once the new join-state is durable. */
    readAttempt(): Promise<string | null>;
    writeAttempt(attempt: string): Promise<void>;
    clearAttempt(): Promise<void>;
    /** Serializes every read-modify-write below against this ONE store — the plugin's
     * installation lock, generalised. `signal` aborts once `budgetMs` elapses (default left to
     * the implementation; the node lock's is RFC-016's `HOLD_BUDGET_MS`) so a caller's network
     * calls made while holding it share one deadline, never several that add up past the lock's
     * own stale-break. */
    withLock<T>(fn: (signal: AbortSignal) => Promise<T>, opts?: {
        budgetMs?: number;
    }): Promise<T>;
}
/** In-memory `CredentialStore` — tests, and an embedder that wants no disk at all.
 * The lock is a promise chain: callers queue, never overlap, same observable shape
 * as a real file lock without the file. */
export declare function memoryCredentialStore(): CredentialStore;
/** The WS replay cursor (`../core/cursor.ts`), persisted so it survives a restart. */
export interface CursorStore {
    read(): Promise<string | null>;
    write(cursor: string | null): Promise<void>;
}
export declare function memoryCursorStore(initial?: string | null): CursorStore;
/** Just enough of a lock record to name a holder in a standby status — `Session` never
 * interprets these fields itself, only forwards them (the node `LockRecord` is a superset
 * and satisfies this structurally). */
export interface LockHolderInfo {
    pid?: number;
    version?: string;
    software?: string;
}
/**
 * RFC-017 ownership (D3/D4), COLLAPSED to one interface (review SIMPLIFY finding —
 * pre-prod, every real consumer needs the full thing: OpenClaw now, the Claude plugin at
 * S5; the old "plain, supersede-only" mode existed only for tests, never a real embedder).
 * `Session` sends `supersede: true` on every auth frame while `isHeld()` is true (D4),
 * gates every connect attempt on `acquire()` (RFC-017 D3's standby behaviour, moved INTO
 * `Session` itself per RFC-018: "Bridge-specific logic lives in the SDK; a runtime plugin
 * only maps"), and stops (never reconnects) when `onLost` fires while connected or a
 * server-side close reports superseded (`markLost()`), because THE OWNERSHIP RULE says
 * only a NON-holder compares versions and takes over, never a holder that just lost it.
 * The node adapter (T3) is what makes `isHeld`/`acquire` mean something across processes
 * on one host (a pid-checked lock file); this interface only names the shape `Session`
 * needs from it. No more structural detection: every `SessionOptions.lock` is this shape.
 */
export interface SessionLock {
    isHeld(): boolean | Promise<boolean>;
    /** Registers a callback for "another holder won while connected"; returns an unsubscribe. */
    onLost(cb: () => void): () => void;
    /** Who wins `sessionKey` right now — "acquire" (no live holder or already ours),
     * "takeover" (the auto path won, or an explicit takeover), "standby" (a live holder we
     * do not outrank), or "lost" (THE OWNERSHIP RULE: this handle already held it and a
     * different live holder has since won — `onLost` has already fired by the time this
     * resolves; never re-decided by version). */
    acquire(opts?: {
        takeover?: boolean;
    }): Promise<"acquire" | "takeover" | "standby" | "lost">;
    /** The current holder, best-effort — `null` when unreadable/absent. For a standby status only. */
    holder(): Promise<LockHolderInfo | null>;
    /** Stop renewing and release OUR hold, if we have one. A no-op otherwise. */
    release(): void;
    /**
     * Mark this handle LOST the same way discovering a different live LOCAL holder would
     * (sticky: `held` becomes false, `onLost` fires if we were actually holding, and every
     * LATER `acquire()` on this SAME handle instance returns `"lost"` rather than trying
     * again) — for a loss signalled from OUTSIDE this handle's own acquire()/isHeld()/renewal
     * (RFC-018 minor finding 4: a server-side "session superseded" WS close, which means a
     * DIFFERENT window already won this session key, whatever this handle's own file-level
     * bookkeeping currently believes). A no-op the second time it's called.
     */
    markLost(): void;
}
/** In-memory `SessionLock` — ONE fake covering both the "we win immediately" and "someone
 * else holds it" scripts (test-only controls, no version comparison of its own: that rule
 * is core's `decideLock`, already exhaustively tested against the real node lock; this
 * fake only needs to SCRIPT a scenario for `Session`'s orchestration). */
export declare function memorySessionLock(initialHolder?: LockHolderInfo | null): SessionLock & {
    /** Test-only: the OTHER holder stepped aside — the next `acquire()` (this session's own
     * standby retry, or an explicit one) wins. Distinct from `release()`, which gives up
     * OUR OWN hold (a caller shutting down), never another holder's. */
    holderGone(): void;
    /** Test-only: a DIFFERENT holder won the key while THIS handle held it — fires `onLost`
     * synchronously (the T3 pre-send-check shape the real node lock uses), so a caller
     * mid-`isHeld()`/mid-`acquire()` observes the loss the same way. */
    loseToOther(holder?: LockHolderInfo | null): void;
};
