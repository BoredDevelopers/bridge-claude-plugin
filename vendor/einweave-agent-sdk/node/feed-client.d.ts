import { type FeedHello, type FeedHistory, type FeedServerFrame } from "../core";
export interface FeedClientOptions {
    /** Give up waiting for `hello`. Default 5 s. */
    connectTimeoutMs?: number;
    /** Frames buffered for a slow iterator before the oldest is dropped. Default 1000. */
    maxBuffered?: number;
    /** Default timeout of one `history()` call. Default 30 s. */
    historyTimeoutMs?: number;
    /**
     * Abort the connect (or, once connected, the connection). A caller that is shutting
     * down must not wait out `connectTimeoutMs` on a socket that accepts but never says
     * hello; aborting destroys the socket, rejects a pending connect with `closed`, and
     * ends the iterable.
     */
    signal?: AbortSignal;
}
export interface FeedClient extends AsyncIterable<FeedServerFrame> {
    readonly hello: FeedHello;
    /** Start the stream, replaying up to `replay` buffered events first. */
    subscribe(replay?: number): void;
    history(req: {
        channel_id: string;
        before?: string;
        limit: number;
    }, opts?: {
        timeoutMs?: number;
    }): Promise<FeedHistory>;
    /** Resolves when the connection has ended, from either side. */
    readonly closed: Promise<void>;
    close(): void;
}
export declare function feedClient(path: string, options?: FeedClientOptions): Promise<FeedClient>;
