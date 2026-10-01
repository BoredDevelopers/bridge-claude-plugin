/** The protocol version in `hello.v`. A client that sees another number stops, naming both. */
export declare const FEED_PROTOCOL_VERSION = 1;
export type FeedSenderKind = "agent" | "human";
export interface FeedMessage {
    t: "message";
    dir: "in" | "out";
    id: string;
    ts: string;
    channel: {
        id: string;
        name: string;
    };
    thread_id?: string;
    /** The thread's title, when the session knows it — a tail shows it on a reply (D7). */
    thread_title?: string;
    is_root: boolean;
    sender: {
        id: string;
        handle: string;
        kind: FeedSenderKind;
    };
    to?: {
        handle: string;
        context_id?: string;
    };
    targeted: boolean;
    type: string;
    text: string;
}
export type FeedStatusState = "connected" | "reconnecting" | "stopped";
export interface FeedStatus {
    t: "status";
    state: FeedStatusState;
    reason?: string;
}
export interface FeedHello {
    t: "hello";
    v: number;
    software_id: string;
    software_version: string;
    agent: {
        id: string;
        handle: string;
    };
    context_id: string;
    label?: string;
    cwd?: string;
}
/** Reserved for RFC-021 (thread binding). Typed so a consumer can ignore it; never sent in v1. */
export interface FeedBinding {
    t: "binding";
    thread_ids: string[];
}
/**
 * The end of the replay a `subscribe` asked for: every frame before it on this connection
 * is the session's buffer, every frame after it is live. Sent after every subscribe, also
 * when nothing was replayed (`count: 0`). A viewer needs the boundary — a replayed message
 * is history, not something that just arrived — and neither a clock (a message `ts` is the
 * Bridge server's) nor a pause in the stream can supply it.
 */
export interface FeedReplayed {
    t: "replayed";
    count: number;
}
export interface FeedHistory {
    t: "history";
    req: string;
    messages: FeedMessage[];
    more: boolean;
}
export interface FeedErrorFrame {
    t: "error";
    req?: string;
    code: string;
    message: string;
}
export interface FeedSubscribe {
    t: "subscribe";
    replay?: number;
}
export interface FeedHistoryRequest {
    t: "history";
    req: string;
    channel_id: string;
    before?: string;
    limit: number;
}
/** What a session publishes into the ring buffer (and so what a replay can contain). */
export type FeedEvent = FeedMessage | FeedStatus;
export type FeedServerFrame = FeedHello | FeedMessage | FeedStatus | FeedReplayed | FeedBinding | FeedHistory | FeedErrorFrame;
export type FeedClientFrame = FeedSubscribe | FeedHistoryRequest;
/** Every server-to-client `t`, and every client-to-server one — the fixture test keys on these. */
export declare const FEED_SERVER_FRAME_KINDS: readonly ["hello", "message", "status", "replayed", "binding", "history", "error"];
export declare const FEED_CLIENT_FRAME_KINDS: readonly ["subscribe", "history"];
export type FeedErrorCode = 
/** The preferred or fallback socket directory is not private to this user. */
"unsafe_dir"
/** A live listener already owns the socket path — never stolen. */
 | "in_use"
/** The path exists and is not a socket — never unlinked. */
 | "not_a_socket" | "bad_path"
/** The server speaks a `hello.v` this client does not know. */
 | "unsupported_version"
/** The peer broke the protocol (no hello, over-long line). */
 | "protocol"
/** The server answered a request with an `error` frame (`remoteCode` has its code). */
 | "remote" | "timeout" | "closed";
/**
 * Branded like every SDK error (a `name` + `code` predicate, never `instanceof` — the
 * dual-package hazard `./token-errors.ts` documents).
 */
export declare class FeedError extends Error {
    readonly name = "FeedError";
    readonly code: FeedErrorCode;
    /** `remote` only: the `code` of the `error` frame the server sent. */
    readonly remoteCode?: string;
    constructor(code: FeedErrorCode, message: string, opts?: {
        cause?: unknown;
        remoteCode?: string;
    });
}
export declare function isFeedError(e: unknown): e is FeedError;
/** One JSON object and a newline. Strips every string on the way out (D4): the sender does not trust itself either. */
export declare function encodeFrame(frame: FeedServerFrame | FeedClientFrame): string;
/**
 * The longest line either side will buffer. Counted in UTF-16 code units (this module
 * has no byte view of a string), which is within a factor of three of bytes — the point
 * is a bound, not an exact size. A peer with no newline cannot grow our memory past it.
 */
export declare const FEED_MAX_LINE: number;
export type FeedLine = {
    kind: "json";
    value: unknown;
} | {
    kind: "error";
    code: "bad_json" | "line_too_long";
    message: string;
};
/**
 * Streaming NDJSON decoder: feed it string chunks as they arrive. Handles a line split
 * across chunks and several lines in one. After `line_too_long` the decoder is spent —
 * there is no way to find the next line boundary without buffering what we refuse to —
 * so the caller closes the connection, and every later `push` returns nothing.
 */
export declare class FeedLineDecoder {
    private readonly maxLine;
    private buf;
    private spent;
    constructor(maxLine?: number);
    push(chunk: string): FeedLine[];
    private overflow;
}
export type ParseResult<F> = {
    kind: "frame";
    frame: F;
} | {
    kind: "skip";
} | {
    kind: "error";
    message: string;
};
/** Validate a decoded JSON value as a server frame. Strips every string. Never throws. */
export declare function parseServerFrame(value: unknown): ParseResult<FeedServerFrame>;
/** Validate a decoded JSON value as a client frame. Never throws. */
export declare function parseClientFrame(value: unknown): ParseResult<FeedClientFrame>;
export declare const FEED_RING_MAX_EVENTS = 500;
export declare const FEED_RING_MAX_BYTES: number;
export interface FeedRingEntry {
    event: FeedEvent;
    /** The encoded (already stripped) line, ready to write — a replay never re-encodes. */
    line: string;
    bytes: number;
}
/**
 * The session's only copy of recent feed events (RFC-022 D3: nothing at rest). Bounded
 * by BOTH an event count and the total encoded bytes, oldest evicted first. A single
 * event larger than the byte cap is still kept — alone — so a push never leaves the
 * buffer empty and the eviction loop always terminates (it never evicts the newest).
 */
export declare class FeedRing {
    private readonly maxEvents;
    private readonly maxBytes;
    private entries;
    private total;
    constructor(maxEvents?: number, maxBytes?: number);
    push(event: FeedEvent): FeedRingEntry;
    /** The newest `n` entries (all when omitted), oldest first. */
    last(n?: number): FeedRingEntry[];
    get size(): number;
    get bytes(): number;
}
