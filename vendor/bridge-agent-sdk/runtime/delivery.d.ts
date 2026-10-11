/**
 * How a session's entries reach the host's model (RFC-027 D7). The SAME server log and
 * ack serve every host; only this seam differs:
 *
 * - `channel`: the session pushes each entry the moment it arrives (Claude Code channels,
 *   OpenClaw). `pushedAt` is stamped when `push` resolves.
 * - `checkpoint`: nothing is pushed; entries wait in `Session.pending` until the host's
 *   own hooks pick them up and confirm (Codex, Cursor).
 * - `owned-turn`: a session einweave runs itself — reserved, no behaviour yet.
 *
 * An entry is confirmed (`ack model`) only by the adapter's host — `Session.pending.confirm`
 * from a host receipt, or `Session.ack` from a read tool that returned it. Never on push.
 */
import type { ActionRequestPayload, DeliveryReason, TaskEventPayload, WireMessage } from "../core";
/** One inbound message, with the reason(s) THIS session was sent it for. */
export type Inbound = WireMessage & {
    deliveryReasons: DeliveryReason[];
};
/** What a host is handed. `redelivery`: a frame of it was sent before (resume, reconcile). */
export type Entry = {
    kind: "message";
    id: string;
    redelivery: boolean;
    message: Inbound;
} | {
    kind: "task_event";
    id: string;
    redelivery: boolean;
    event: TaskEventPayload;
} | {
    kind: "action_request";
    id: string;
    redelivery: boolean;
    action: ActionRequestPayload;
};
export interface DeliveryAdapter {
    readonly mode: "channel" | "checkpoint" | "owned-turn";
    /** `channel` only: hand the entry to the host; resolve once it accepted it. A rejection leaves it pending, unpushed. */
    push?(entry: Entry): Promise<void>;
    /** The session stopped for good — no more entries. */
    close?(): void;
}
/**
 * A `channel` adapter that is a pull loop: `entries()` yields each entry, and `push`
 * resolves when the consumer TAKES it — so `pushedAt` means "the consumer has it", and a
 * consumer that stops reading backs the session's own bounded queue up (where an overflow
 * is dropped, reported as `slow-consumer`, and stays owed by the server). For consumers
 * that want an async loop (OpenClaw's monitor) and for tests.
 */
export declare function queueAdapter(): DeliveryAdapter & {
    entries(): AsyncIterable<Entry>;
};
