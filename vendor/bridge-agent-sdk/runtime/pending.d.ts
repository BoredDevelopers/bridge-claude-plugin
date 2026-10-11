/**
 * `Pending` — the entries a session has delivered that its MODEL has not yet confirmed
 * (RFC-027 D7). Not "Inbox": that is the product's word for a principal's work queue
 * (slice 4). This is per-process, per-session bookkeeping, and the server stays the
 * truth: whatever is dropped here is still owed there and comes back on the next resume
 * or reconcile.
 *
 * METADATA ONLY — never message text. A consumer that renders a notice about a pending
 * entry (the Claude plugin's "missed" notice) must not be able to leak a body through it.
 *
 * Constructible on its own (no socket, no `Session`) so a consumer can test against the
 * real thing; a `Session` wires `onConfirm` to its ack queue.
 */
import type { EntryKind } from "../core";
export interface PendingEntry {
    id: string;
    kind: EntryKind;
    channelId: string | null;
    threadId: string | null;
    /** A message's type ("text", "task", …), a task event's change, an action's name. */
    type: string | null;
    senderHandle: string | null;
    /** Epoch ms the adapter's push resolved; null until then (or never, for a checkpoint host). */
    pushedAt: number | null;
    /** A frame of this entry was sent before (a resume, a reconcile) — the server's own flag. */
    redelivery: boolean;
}
export interface PendingOptions {
    /** Oldest entries are forgotten past this many (default 1000) — the server still owes them. */
    maxSize?: number;
    /** Called with the ids `confirm()` actually took — a `Session` acks them `model`. */
    onConfirm?: (ids: string[]) => void;
}
export declare class Pending {
    private readonly opts;
    private readonly held;
    constructor(opts?: PendingOptions);
    get size(): number;
    has(id: string): boolean;
    /** False when `id` is already held — an entry is pushed once per process, however often it is redelivered. */
    add(entry: PendingEntry): boolean;
    markPushed(id: string, at: number): void;
    /** In arrival order; copies, so a caller cannot edit the set through them. */
    list(): PendingEntry[];
    /**
     * The model has these. Only ids this set HOLDS are taken (and acked `model` through
     * `onConfirm`) — a host receipt naming anything else (another process's entry, a stale
     * id, a forged tag) confirms nothing. Returns what was taken.
     */
    confirm(ids: Iterable<string>): string[];
    /** Forget these without confirming (they were acked another way). */
    remove(ids: Iterable<string>): void;
}
