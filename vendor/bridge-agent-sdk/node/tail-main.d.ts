import { type TailOptions } from "./tail";
export declare const TAIL_USAGE = "usage: bridge-tail (--procs <dir> ... | --socket <path>) [options]\n\n  --procs <dir>      proc-registry state dir to find sessions in (repeatable)\n  --socket <path>    attach to this feed socket directly\n  --session <sel>    pick a session by label, context id, sessionKey prefix or pid\n  --all              merge every live session, with a session column\n  --no-color         plain text, no colour\n  --help             this text\n\nkeys: j/k or arrows move, enter folds (opens the rest of a long message), e folds all, g/G first/last, q quits\n";
export interface TailArgs {
    procsDirs: string[];
    socket?: string;
    session?: string;
    all: boolean;
    color?: boolean;
    help: boolean;
}
/** Throws a plain `Error` whose message is the whole complaint. */
export declare function parseTailArgs(argv: readonly string[]): TailArgs;
/**
 * Run the command; resolves to the process exit code (0 quit/abort, 1 failed, 2 usage,
 * 128+n for a signal). The process-wide error handlers live HERE and not in `runTail`: a
 * library must not swallow its host's errors, but a CLI that is about to die should put
 * the terminal back first — so a fatal error aborts `runTail` (which restores) and is
 * then printed, with its stack, by this function.
 */
export declare function tailMain(argv: readonly string[], io?: Pick<TailOptions, "stdin" | "stdout" | "stderr" | "env" | "process">): Promise<number>;
