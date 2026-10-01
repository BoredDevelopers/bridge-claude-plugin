import type { FeedMessage } from "./feed";
/** A feed message as `tail` holds it. `key` is the dedupe/fold identity; `session` is set in `--all` mode. */
export interface TailMessage extends FeedMessage {
    key: string;
    session?: string;
}
/** `open` is the default; `full` lifts the row cap; `folded` is one row. */
export type FoldState = "open" | "full" | "folded";
/** A body longer than this many rendered rows is cut to it, with a `(+N lines)` row (D7). */
export declare const BODY_CAP_ROWS = 8;
export type TailStyle = "none" | "dim" | "mute" | "bright" | "amber" | "green" | "blue" | "greenHalf" | "blueHalf";
/**
 * The palette. `dim` is the time/channel/thread grey and is the same on every row;
 * `mute` is the lighter grey a broadcast's sender and text use (the mockup's #8b8b93
 * against its #71717a); `*Half` is a bar "at half strength" — a darker 256-colour
 * rather than SGR 2 (faint), which terminals disagree about.
 */
export declare const TAIL_SGR: Record<Exclude<TailStyle, "none">, string>;
/** Free text: control characters out (again), plus the bidi overrides and unpaired surrogates. */
export declare function cleanText(s: string): string;
/** A name-like field: cleaned, and a newline or tab becomes a space so it stays on one row. */
export declare function cleanLine(s: string): string;
/** Columns one code point takes: 0 for controls and combining marks, 2 for wide, else 1. */
export declare function charWidth(cp: number): number;
/** Display width of a string, in terminal columns. */
export declare function stringWidth(s: string): number;
/** Cut to at most `max` columns, ending in `…` when anything was cut. Never splits a cell. */
export declare function truncateTo(s: string, max: number): string;
/** The wrapped body, one string per row, before the cap. */
export declare function bodyRows(m: TailMessage, contentWidth: number): string[];
/** Where a message sits: the outgoing indent by pane width (D7), and the columns left for text after the bar. */
export declare function messageLayout(dir: "in" | "out", width: number): {
    indent: number;
    content: number;
};
/** Would this message's body be cut by the row cap at this pane width? (`enter` opens it in full.) */
export declare function isCapped(m: TailMessage, width: number): boolean;
/** `HH:MM:SS` in LOCAL time, or dashes for a `ts` that does not parse. */
export declare function clockOf(ts: string): string;
/** The local calendar day, as a comparison key; `""` for a bad `ts`. */
export declare function dayKey(ts: string): string;
export interface MessageRenderOptions {
    width: number;
    color: boolean;
    fold?: FoldState;
    selected?: boolean;
    /** Show the session column (`--all`). */
    showSession?: boolean;
}
/** Render one message to rows (header + body, or the one folded row). */
export declare function renderMessage(m: TailMessage, o: MessageRenderOptions): string[];
/**
 * Clip an already-painted row to `width` visible columns: SGR codes pass through, text is
 * cut on whole cells, and a reset is appended when the cut dropped the row's own. For a
 * pane narrower than the layout's minimum, where the renderers' rows would otherwise run
 * past the screen edge.
 */
export declare function clipRow(row: string, width: number): string;
/** `── Thu 1 Oct ──`, centred. */
export declare function dateSeparator(ts: string, width: number, color: boolean): string;
/** The amber divider before the first unread message. */
export declare function newDivider(width: number, color: boolean): string;
export interface TranscriptView {
    fold?: (key: string) => FoldState;
    selectedKey?: string | null;
    unreadFromKey?: string | null;
}
export interface TranscriptOptions {
    width: number;
    color: boolean;
    showSession?: boolean;
    /** Reuse rendered rows across frames (see `createRenderCache`). */
    cache?: RenderCache;
}
/**
 * Rendered rows per (message, width, fold, selected, colour, session column). A frame
 * after a keypress or a new message changes one or two of those, so everything else is a
 * lookup instead of a re-wrap — the cost that made holding `j` lag at 2000 messages.
 * Messages never change under a key, so nothing else needs invalidating; resize and
 * colour are in the key. `hits`/`misses` are for tests.
 */
export interface RenderCache {
    rows: Map<string, string[]>;
    hits: number;
    misses: number;
}
export declare function createRenderCache(): RenderCache;
export interface Transcript {
    rows: string[];
    /** Per message, the rows it owns (its date line and `new` divider included) — what the viewport keeps in sight. */
    spans: {
        key: string;
        start: number;
        end: number;
    }[];
}
/** Every message as rows, with a date line at each new local day and the `new` divider. */
export declare function renderTranscript(messages: readonly TailMessage[], view: TranscriptView, o: TranscriptOptions): Transcript;
export interface ViewportOptions {
    selectedKey?: string | null;
    /** Stick to the bottom (the selection is the newest message). */
    follow: boolean;
    /** Where the window was last time; kept unless the selection forces a move. */
    prevTop: number;
}
/**
 * The rows to show in `height` lines. Following: the last `height` rows. Otherwise the
 * previous window is kept — a message arriving below must not move what is being read —
 * and moved only as far as needed to bring the selected message into view (its start,
 * when it is taller than the window).
 */
export declare function viewport(t: Transcript, height: number, o: ViewportOptions): {
    rows: string[];
    top: number;
};
export type TailConnection = "waiting" | "connected" | "reconnecting" | "stopped" | "ended";
export interface HeaderInfo {
    handle?: string;
    label?: string;
    state: TailConnection;
}
/** `bridge tail · @agent · label · state`. */
export declare function renderHeader(info: HeaderInfo, width: number, color: boolean): string;
export interface FooterInfo {
    total: number;
    ins: number;
    outs: number;
}
/** `N messages · X in · Y out`, with the key hints when they fit. */
export declare function renderFooter(info: FooterInfo, width: number, color: boolean): string;
