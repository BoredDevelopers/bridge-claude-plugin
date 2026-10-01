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
 * while you were elsewhere), and autowrap OFF: any row a width miscount lets through is
 * clipped at the edge instead of wrapping and scrolling the whole screen.
 */
export declare const TAIL_ENTER = "\u001B[?1049h\u001B[?25l\u001B[?1004h\u001B[?7l";
/** The inverse of `TAIL_ENTER`, plus clearing the title it set. */
export declare const TAIL_LEAVE = "\u001B[?7h\u001B[?1004l\u001B[?25h\u001B[?1049l\u001B]2;\u0007";
export declare function runTail(options?: TailOptions): Promise<TailResult>;
