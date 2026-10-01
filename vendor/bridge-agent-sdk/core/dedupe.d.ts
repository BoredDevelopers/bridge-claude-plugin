/**
 * A message-id LRU with TTL — the SDK's in-memory half of dedupe (RFC-018 D8: an
 * OpenClaw consumer pairs this with its own DURABLE `createPersistentDedupe`
 * keyed `<accountId>:<message_id>`; the SDK owns only the in-process, no-disk
 * layer every consumer gets for free — a reconnect within the TTL must not
 * redeliver a message the caller already dispatched).
 *
 * NEW for the SDK — the plugin has no equivalent; its own dedupe (`sentAsks` in
 * server.ts) tracks OUTGOING tracked-message receipts, an unrelated concern.
 *
 * Pure: no timer of its own. `seen()` takes the current time from an injected
 * clock and expires lazily on the next call, so there is no background interval
 * for a caller to leak by forgetting to stop it.
 */
export interface DedupeOptions {
    /** How long a seen id is remembered. */
    ttlMs: number;
    /** Hard cap on remembered ids — the OLDEST is evicted first once exceeded. */
    maxSize: number;
    /** Injectable clock, default `Date.now`. */
    now?: () => number;
}
export declare class Dedupe {
    private readonly ttlMs;
    private readonly maxSize;
    private readonly now;
    private readonly seenAt;
    constructor(opts: DedupeOptions);
    /**
     * True the FIRST time `id` is seen (and records it); false on a repeat within
     * the TTL — an id that expired, or was evicted for size, is "first" again, which
     * is the correct trade for a bounded, no-disk cache: a duplicate delivered late
     * enough is no worse than one this process never saw at all.
     */
    seen(id: string): boolean;
    /** Un-remember `id` — for a delivered copy DROPPED before a consumer ever saw it (a full
     * `messages()` buffer): the drop must not permanently poison a later, real redelivery of
     * the same id (a `missed` replay row) by making it look already-seen. A no-op if `id`
     * isn't tracked. */
    forget(id: string): void;
    /** Insertion order is chronological, so the first non-expired entry ends the sweep. */
    private evictExpired;
    get size(): number;
}
