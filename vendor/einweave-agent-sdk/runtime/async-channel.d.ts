/**
 * A single-consumer async queue — the primitive behind `Session.messages()` and
 * `Session.status()` (RFC-018 D3: "an `AsyncIterable<Inbound>` with a bounded
 * buffer that drops the oldest entry"). `push()` returns the item it dropped
 * (if the buffer was already full), so the caller can turn that into its own
 * `slow-consumer` status event — this class knows nothing about `Session`.
 */
export declare class AsyncChannel<T> implements AsyncIterable<T> {
    private readonly maxSize;
    private readonly buf;
    private waiting;
    private ended;
    /** `maxSize <= 0` means unbounded (used for `status()`, whose events are rare). */
    constructor(maxSize?: number);
    /** Enqueues `item`; returns the dropped item when the buffer was already at `maxSize`. */
    push(item: T): T | undefined;
    /** No more items will ever arrive — every pending/future `next()` resolves `done`. */
    end(): void;
    [Symbol.asyncIterator](): AsyncIterator<T>;
}
