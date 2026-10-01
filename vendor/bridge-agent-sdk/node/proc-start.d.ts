/** Runs `ps -o lstart= -p <pid>` under `env`, trimmed; "" on any failure (unavailable
 * `ps`, no such pid, …) — never throws. One object so tests can inject a fake without
 * touching PATH or spawning a real shim binary (ESM imports cannot be spied on). */
export declare const __psExec: {
    run(pid: number, env: NodeJS.ProcessEnv): Promise<string>;
};
/** Normalized start time of a live pid (what every writer records from S1.4 on). "" if unknown. */
export declare function procStartOf(pid: number): Promise<string>;
/** The pre-normalization form: `ps` in this process's own environment. "" if unknown. */
export declare function legacyProcStartOf(pid: number): Promise<string>;
/**
 * Is `recorded` the start time of the process now running as `pid`? Accepts the
 * normalized form and, for older records, the reader's-own-locale one. Only
 * meaningful for a non-empty `recorded` (callers decide what empty means).
 */
export declare function procStartMatches(pid: number, recorded: string): Promise<boolean>;
/** Same semantics as the plugin's `pidAlive`: EPERM means it exists but belongs to
 * someone else — alive. No subprocess involved, so this stays synchronous. */
export declare function pidAlive(pid: unknown): boolean;
