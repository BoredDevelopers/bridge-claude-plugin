/**
 * `tail`'s state (RFC-022 D7), as a pure reducer: events in, next state out. The app
 * (`../node/tail.ts`) owns the streams and the clock and feeds this; nothing here knows a
 * socket, a terminal or a timer, so every key and every replay edge is a plain unit test.
 *
 * NEW for the SDK. What it holds: the newest `TAIL_MAX_MESSAGES` messages (older ones are
 * dropped — the server stays the only store, D3), each one's fold state, the selection,
 * whether the view is following the bottom, the unread marker, and the connection.
 *
 *   - Dedupe by `key` (the message `id`, plus the session in `--all` mode). A reattach
 *     replays the session's buffer, so the same message arrives again; it must not show twice.
 *   - Messages are kept in time order (`ts`), not arrival order: with several sessions
 *     merged, each one's replay arrives in a block of its own.
 *   - Unread: an INCOMING message that arrives while the view is not at the bottom, or
 *     while the pane does not have focus, counts and starts the `new` divider; any key
 *     or focus-in clears it. A message that lands in the middle (an old one from a
 *     replay) is history, never unread.
 */
import { type FoldState, type TailConnection, type TailMessage } from "./tail-render";
import type { FeedMessage, FeedServerFrame } from "./feed";
export declare const TAIL_MAX_MESSAGES = 2000;
export interface TailState {
    messages: readonly TailMessage[];
    /** Only the non-default entries (`open` is absent). */
    fold: ReadonlyMap<string, FoldState>;
    selected: string | null;
    follow: boolean;
    unreadFrom: string | null;
    unread: number;
    focused: boolean;
    /** The aggregate over `links`: what the pane header shows. */
    connection: TailConnection;
    /** Per-session link state ("" when not merging); a session's own status never speaks for another's. */
    links: ReadonlyMap<string, TailConnection>;
    /** The attached session, for the pane header. */
    agent: string | null;
    label: string | null;
    size: {
        cols: number;
        rows: number;
    };
    quit: boolean;
}
export declare function initialTailState(size?: {
    cols: number;
    rows: number;
}): TailState;
export type TailKey = "j" | "k" | "up" | "down" | "enter" | "e" | "g" | "G" | "q" | "ctrl-c" | (string & {});
export type TailEvent = 
/**
 * A frame from a session's feed. `session` is the `--all` column. `history`: it came from
 * the replay on attach, so it can never be unread (the app decides; see `../node/tail.ts`).
 */
{
    type: "frame";
    frame: FeedServerFrame;
    session?: string;
    history?: boolean;
} | {
    type: "key";
    key: TailKey;
} | {
    type: "focus";
    focused: boolean;
} | {
    type: "resize";
    cols: number;
    rows: number;
} | {
    type: "attached";
    agent: string | null;
    label: string | null;
    session?: string;
}
/** `agent`/`label`, when given, refresh the pane header for the sessions still attached. */
 | {
    type: "detached";
    session?: string;
    agent?: string | null;
    label?: string | null;
};
export declare function messageKey(m: Pick<FeedMessage, "id">, session?: string): string;
export declare function hasMessage(state: TailState, key: string): boolean;
export declare function tailReduce(s: TailState, ev: TailEvent): TailState;
/** Raw terminal input to events: arrows, enter, ctrl-c, focus in/out, and single keys. */
export declare function parseTailInput(chunk: string): TailEvent[];
