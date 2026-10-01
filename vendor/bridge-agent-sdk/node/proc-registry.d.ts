/**
 * RFC-018 S1.4 — `procRegistry(dir)`: every process of an `@bridge/agent-sdk`
 * consumer sharing a state dir writes `<dir>/procs/<pid>.json` describing
 * itself, so a person (or a future status surface) can answer "where is the
 * other window" — RFC-017 D2's registry. ADAPTED from the plugin's
 * `proc-registry.ts`: same shape and the same liveness rule the session lock
 * uses (`./session-lock.ts`'s `holderIsLive`) — a dead pid, or a live pid that
 * is now someone else entirely (reuse), is stale and is swept on `list()`,
 * never returned; an unverifiable one (`ps` unavailable, or the record's own
 * `procStart` was never captured) is neither: listed with `verified: false`
 * rather than guessed at in either direction. `list()` is ASYNC where the
 * plugin's was sync — `./proc-start.ts`'s `procStartOf` runs `ps` through
 * `node:child_process.execFile`, not a synchronous Bun-only spawn (D1).
 *
 * D8: a record whose declared `format` is higher than PROC_FORMAT was written
 * by a newer build — `list()` skips it (neither sweeps it nor reports it)
 * rather than delete or "repair" it.
 *
 * `pidAlive`/`procStartOf`/`legacyProcStartOf` come from `./proc-start.ts`
 * (shared with the session lock, unlike the plugin's two independent copies).
 *
 * Node `fs` only — no `Bun.` API (the node adapter's grep guard,
 * `test/node/no-bun-apis.test.ts`).
 */
import { mkdirSync, writeFileSync, renameSync, unlinkSync, readdirSync, readFileSync } from "node:fs";
import { pidAlive, procStartOf, legacyProcStartOf } from "./proc-start";
export type ProcState = "connected" | "standby" | "superseded" | "disconnected";
/** What THIS process knows about itself; `writeProc` adds `format` and stamps `startedAt` from the clock. */
export interface ProcInfo {
    pid: number;
    /** Normalized `ps -o lstart=` at write time — "" if `ps` is unavailable (e.g. Windows). */
    procStart: string;
    /** RFC-017 D4 `software_id` (`bridge-claude-plugin`, `bridge-openclaw`, …). */
    software: string;
    version: string;
    sessionKey: string;
    /** A consumer-defined scope narrower than the whole state dir (the plugin's "profile"); "" if not used. */
    profile: string;
    /** The parent process that owns this one, or null (headless / not found). */
    claudePid: number | null;
    /** "" when unknown. */
    tty: string;
    termProgram: string;
    cwd: string;
    state: ProcState;
    /**
     * RFC-022 D5: the session's local feed socket, so a `tail` finds sessions by listing
     * this registry rather than scanning directories. OPTIONAL and additive — a record
     * without it (every older build, or a session whose feed failed to open) is still
     * valid, and an older reader ignores the unknown key — so PROC_FORMAT does not move
     * (bumping it would make every older build skip these records entirely, D8).
     */
    feed?: string;
}
export interface ProcRecord extends ProcInfo {
    format: number;
    startedAt: string;
}
/** `list()`'s own addition — never written to disk. `false` means `ps`/procStart could
 * not confirm this record's pid is still the SAME process: still listed (never swept
 * on a guess), but flagged so a caller can say so rather than assert it as fact. */
export interface ListedProc extends ProcRecord {
    verified: boolean;
}
/** The highest format this build knows how to interpret. */
export declare const PROC_FORMAT = 0;
export declare function procsDir(dir: string): string;
/** The syscalls, one object so tests can inject failures. Production never replaces them. */
export declare const __io: {
    mkdirSync: typeof mkdirSync;
    writeFileSync: typeof writeFileSync;
    renameSync: typeof renameSync;
    unlinkSync: typeof unlinkSync;
    readdirSync: typeof readdirSync;
    readFileSync: typeof readFileSync;
};
/** Injected for tests; production calls the real pidAlive / proc-start.ts. */
export declare const __ps: {
    pidAlive: typeof pidAlive;
    procStartOf: typeof procStartOf;
    legacyProcStartOf: typeof legacyProcStartOf;
};
/** Injected for tests (a fake `startedAt`); production is the real clock. */
export declare const __clock: {
    now: () => number;
};
/**
 * Write (or replace) this process's own record — 0600, tmp + rename, in the existing
 * 0700 state dir. `startedAt` is stamped from `__clock` here, not passed in. Best-effort,
 * like every other store here: this is telemetry, and a disk problem writing it must
 * never take Bridge down.
 */
export declare function writeProc(dir: string, info: ProcInfo): void;
/**
 * Patch this process's own `state` in place. A no-op if the record is gone (a
 * shutdown raced it) or if it declares a format newer than this build's own write.
 */
export declare function updateProcState(dir: string, pid: number, state: ProcState): void;
/** Remove this process's own record. A no-op if it is already gone. */
export declare function removeProc(dir: string, pid: number): void;
/**
 * Every OTHER live-OR-UNVERIFIABLE Bridge process sharing this state dir. Stale
 * entries — a dead pid, or a reused one — are swept, never returned. A record at a
 * newer format is left exactly as found. An UNVERIFIABLE one is neither: listed
 * with `verified: false`.
 *
 * `options` is for a VIEWER (RFC-022 `tail`), which must not own the registry's
 * housekeeping: it may run in another PID namespace sharing the state dir, where every
 * live session's pid looks dead and a sweep would delete its record every poll.
 * `sweep: false` lists the same set but unlinks nothing. `skipCheck` returns true for a
 * record the caller already trusts (one it is attached to): it is listed, unverified,
 * without the `ps` probe a re-check would spawn.
 */
export interface ListProcsOptions {
    sweep?: boolean;
    skipCheck?: (rec: ProcRecord) => boolean;
}
export declare function listProcs(dir: string, excludePid?: number, options?: ListProcsOptions): Promise<ListedProc[]>;
/** Ergonomic wrapper binding the four functions above to one `dir` (RFC-018 S1.4). */
export declare function procRegistry(dir: string): {
    write(info: ProcInfo): void;
    updateState(pid: number, state: ProcState): void;
    remove(pid: number): void;
    list(excludePid?: number, options?: ListProcsOptions): Promise<ListedProc[]>;
};
