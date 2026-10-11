import { type ListedProc } from "./proc-registry";
export interface TailInput {
    isTTY?: boolean;
    setRawMode?(on: boolean): unknown;
    setEncoding?(encoding: "utf8"): unknown;
    resume?(): unknown;
    pause?(): unknown;
    on(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
    off(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
}
export interface TailOutput {
    isTTY?: boolean;
    columns?: number;
    rows?: number;
    write(text: string): unknown;
    on?(event: "resize", listener: () => void): unknown;
    off?(event: "resize", listener: () => void): unknown;
}
/** The slice of `process` the tail listens on; injectable so a test can raise a signal without sending one. */
export interface TailProcess {
    on(event: string, listener: (...args: any[]) => void): unknown;
    off(event: string, listener: (...args: any[]) => void): unknown;
}
export interface TailOptions {
    /** Proc-registry state dirs to look for sessions in. */
    procsDirs?: string[];
    /** Attach to this feed socket directly, skipping the registry. */
    socket?: string;
    /** Pick a session by label, context id prefix, sessionKey prefix or pid. */
    session?: string;
    /** Merge every live session, with a session column. */
    all?: boolean;
    /** Which session wins when several are live: the one started here. Default `process.cwd()`. */
    cwd?: string;
    stdin?: TailInput;
    stdout?: TailOutput;
    stderr?: {
        write(text: string): unknown;
    };
    env?: Record<string, string | undefined>;
    /** Signals (SIGINT/SIGTERM/SIGHUP) and `exit` only; see the header for why not uncaught errors. */
    process?: TailProcess;
    /** Default: stdout is a TTY and `NO_COLOR` is unset. */
    color?: boolean;
    /**
     * Mouse reporting (click a message to fold it, wheel to scroll). Default true on a TTY.
     * While it is on a terminal's own text selection needs a modifier (Option-drag on macOS,
     * Shift-drag elsewhere); `false` writes no mouse sequence at all.
     */
    mouse?: boolean;
    /** Registry poll interval. Default 1000 ms. */
    pollIntervalMs?: number;
    /** Row width when stdout has no `columns` (piped). Default 100. */
    width?: number;
    /** Replay requested on attach. Default 500 (the session's whole ring). */
    replay?: number;
    /** Stop from outside. */
    signal?: AbortSignal;
    /** Registry reader. Default `listProcs` in its read-only mode. */
    listProcs?: (dir: string) => Promise<ListedProc[]>;
}
export type TailResult = {
    reason: "quit" | "aborted";
} | {
    reason: "signal";
    signal: string;
} | {
    reason: "unsupported_version" | "error";
    message: string;
};
/**
 * Alternate screen, hidden cursor, focus reporting (so the title can count what arrived
 * while you were elsewhere), autowrap OFF (any row a width miscount lets through is clipped
 * at the edge instead of wrapping and scrolling the whole screen) and, unless `mouse` is
 * false, SGR mouse reporting.
 */
export declare function tailEnter(mouse: boolean): string;
/**
 * The inverse of `tailEnter`, plus clearing the title it set. Mouse reporting goes off FIRST:
 * a tail that leaves it on makes the user's shell print garbage on every click.
 */
export declare function tailLeave(mouse: boolean): string;
export declare const TAIL_ENTER: string;
export declare const TAIL_LEAVE: string;
export declare function runTail(options?: TailOptions): Promise<TailResult>;
