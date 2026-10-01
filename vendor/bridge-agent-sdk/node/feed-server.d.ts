import { type FeedEvent, type FeedHello, type FeedHistoryRequest, type FeedMessage } from "../core";
/** What the caller supplies for `hello`; `t` and `v` are the server's to set. */
export type FeedHelloInfo = Omit<FeedHello, "t" | "v">;
export interface FeedHistoryResult {
    messages: FeedMessage[];
    more: boolean;
}
/** Fetches older messages from the Bridge server with the session's own credentials. `signal` aborts on timeout. */
export type FeedHistoryHandler = (req: FeedHistoryRequest, signal: AbortSignal) => Promise<FeedHistoryResult>;
export interface FeedPathOptions {
    stateDir: string;
    contextId: string;
    /** Root for the short-path fallback. Default `os.tmpdir()`. */
    tmpRoot?: string;
    /** Longest socket path (bytes) accepted before falling back. Default 103 (macOS) / 107 (Linux). */
    maxPathBytes?: number;
    /** The uid the fallback directory must belong to. Default `process.getuid()`. */
    uid?: number;
}
export interface FeedServerOptions extends FeedPathOptions {
    /** Called per connection, so a label change reaches the next client. */
    hello: () => FeedHelloInfo;
    history?: FeedHistoryHandler;
    /** Ring bounds. Defaults 500 events / 2 MiB. */
    maxEvents?: number;
    maxBytes?: number;
    /** A client whose unsent backlog exceeds this — beyond its own replay — is dropped. Default 1 MiB. */
    maxBacklogBytes?: number;
    /** Per `history` request. Default 15 s. */
    historyTimeoutMs?: number;
    /** Concurrent `history` requests per client. Default 4. */
    maxHistoryInflight?: number;
}
export interface FeedServer {
    /** The socket path actually bound — advertise this (proc registry `feed`). */
    readonly path: string;
    /** Append to the ring and fan out to subscribed clients. Never throws, never blocks. */
    publish(event: FeedEvent): void;
    /** Subscribed clients right now. */
    clientCount(): number;
    /** Stop listening, end clients, unlink the socket. Idempotent. */
    close(): Promise<void>;
}
/**
 * Where to bind. Preferred `<stateDir>/feed/<contextId>.sock`; when that is too long for
 * a socket path, `<tmp>/bridge-feed-<uid>/bf-<hash>.sock` (the hash keeps the name short
 * however long the context id is). Creates and verifies the directory; throws `FeedError`
 * (`unsafe_dir` / `bad_path`) rather than use one it cannot vouch for.
 */
export declare function resolveFeedSocketPath(o: FeedPathOptions): string;
export declare function feedServer(options: FeedServerOptions): Promise<FeedServer>;
