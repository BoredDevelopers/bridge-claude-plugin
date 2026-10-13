/**
 * `Session` — one WebSocket speaking protocol v2 (RFC-018 D3, RFC-027). Everything
 * observable comes back through the `DeliveryAdapter`, `pending`, `status()` and
 * `closed()` — no MCP notifications, no stderr prose.
 *
 * Kept from v1: the auth frame's credential + `supersede`, reauth-in-band, the ONE 4001
 * re-mint re-armed per socket (`REMINT_REARM_MS`), the liveness watchdog that DETACHES
 * before `close()` (Bun 1.3 fires `close` synchronously inside it), the `SessionLock`
 * gate (D3/D4), and reconnecting via `classifyClose`/`reconnectDelay`.
 *
 * v2 (RFC-027):
 * - every server frame is an envelope; a frame with a `seq` advances `lastSeq`, which is
 *   stored per GRANT (`SeqStore`) and sent on the auth frame, so a reconnect RESUMES —
 *   the server replays what this session missed, then what its model still owes;
 * - `pong` carries the last seq actually STORED (it trims the server's buffer — never a
 *   seq a crash could lose);
 * - entries go to the `DeliveryAdapter` and wait in `pending` until the host confirms
 *   them; `ack(ids, how)` is queued while offline and flushed after each authentication;
 * - `invalid_session` (the resume could not be honoured) leaves the socket open as a
 *   fresh session: the server pushes what is owed, the client takes the next seq as its
 *   new base;
 * - after 15 minutes with no sequenced frame, `GET /api/deliveries` reconciles — a bug in
 *   the live path cannot strand an entry (Telegram's `getDifference` rule).
 *
 * v3 (RFC-028 sessions, SDK 0.7.0): every connection DECLARES its `kind` (required; the server
 * never infers one) — a `gateway` (the agent's one triage connection, held by a lease), a
 * `session` (work session) or an `observer` (read-only copies). `scope` (a work session's channels
 * for UNHELD work) and `takeover: "gateway"` ride the auth frame of the FIRST connect only: after
 * it authenticated, a reconnect re-declares just the kind, so a scope changed since
 * (`api.sessions.setScope`) is not reverted and a takeover is never repeated by a transient close.
 * `supersede` is unchanged — this GRANT from another window — and NEVER implies a takeover.
 */
import { type AckHow, type CatchupPayload, type CloseClass, type CloseOutcome, type ConnectionKind, type HoldUpdatePayload, type InvalidSessionPayload, type Scope, type SessionInfo } from "../core";
import type { Runtime } from "./ports";
import type { AgentClient } from "./client";
import type { LockHolderInfo, SeqStore, SessionLock } from "./store";
import type { Api, SendBody, SendResult } from "./api";
import { AgentClientError } from "./errors";
import { Pending } from "./pending";
import type { DeliveryAdapter, Entry, Inbound } from "./delivery";
export type { Inbound } from "./delivery";
/**
 * What a `Session` needs from its credential holder — `AgentClient` is one; a consumer
 * with its own credential code (the Claude plugin until it moves onto `AgentClient`)
 * passes its own. `wsAuth` must reject with an `AgentClientError` for a credential
 * failure, or the session cannot tell a terminal one from a transient one and retries.
 */
export type SessionClient = Pick<AgentClient, "apiUrl" | "sessionKey" | "softwareId" | "softwareVersion" | "wsAuth" | "grant" | "invalidateAccess" | "sessionRevoked" | "installationRevoked" | "onAccessRotated"> & {
    readonly api: {
        readonly messages: Pick<Api["messages"], "create">;
        readonly threads: Pick<Api["threads"], "reply">;
        readonly deliveries: Pick<Api["deliveries"], "list">;
    };
};
/** The server's `receipt` frame payload (api ws.ts `broadcastReceiptEvent`). */
export interface ReceiptEvent {
    messageId: string;
    agentId: string;
    contextId: string;
    contextLabel: string | null;
    state: string;
    firstSeen?: boolean;
    at?: string;
}
export type StopKind = "superseded" | "too-old" | "revoked" | "session-in-use" | "gateway-taken-over" | "kind-not-allowed" | "credential" | "drain";
/** Why this `Session` will never reconnect again. `close` is present for the WS-close stop
 * classes (superseded / too-old / revoked / session-in-use / gateway-taken-over / kind-not-allowed); `credential` for a terminal
 * `AgentClient` mint failure (installation gone, refused, …). */
export interface SessionStop {
    kind: StopKind;
    close?: CloseOutcome;
    credential?: AgentClientError;
}
export type SessionStatus = {
    kind: "authenticated";
    agentId?: string;
    agentName?: string;
    handle: string | null;
    /** This session's grant id — the address others target, and the id on its sends. */
    contextId: string | null;
    advice?: unknown;
    /** RFC-028: what the server stored for this connection, its scope, and the threads it holds. */
    connectionKind?: ConnectionKind;
    scope?: {
        mode: Scope["mode"];
        channelIds: string[];
    };
    holds?: string[];
} | {
    kind: "closed";
    code?: number;
    reason?: string;
    cls: CloseClass;
} | {
    kind: "reconnecting";
    attempt: number;
    delayMs: number;
    cls: CloseClass;
} | {
    kind: "standby";
    holder?: LockHolderInfo;
}
/** Broadcasts over the resume budget: counts per channel, never bodies (RFC-027 D5). */
 | {
    kind: "catchup";
    channels: CatchupPayload["channels"];
}
/** The resume was refused; the socket carries on as a fresh session (RFC-027 D5). */
 | {
    kind: "invalid_session";
    lost: InvalidSessionPayload["lost"];
}
/** RFC-028 D3/D8: a thread's hold changed hands (left or reached this session). Not a turn: it asks the model for nothing. */
 | {
    kind: "hold_update";
    update: HoldUpdatePayload;
}
/** A receipt for a message this agent sent (✓ sent / ✓✓ seen) — display-only, never an entry. */
 | {
    kind: "receipt";
    receipt: ReceiptEvent;
}
/** A server `error` frame. Most precede a close (`closed` follows); the rest are only said here. */
 | {
    kind: "server_error";
    message: string;
}
/** The host stopped taking entries; this one was dropped here and stays owed by the server. */
 | {
    kind: "slow-consumer";
    droppedId: string;
} | {
    kind: "stopped";
    stop: SessionStop;
};
export interface SessionOptions {
    /**
     * RFC-028 D1: what this connection is. REQUIRED — a connection that declares none is refused
     * ("client too old"). `gateway` takes the agent's gateway lease (refused "gateway in use" while
     * another session holds it; see `takeover`); a Claude Code window is a `session` by default.
     */
    kind: ConnectionKind;
    /** RFC-028 D6: the starting scope of a work session (default: keep the grant's, `all` at first). First connect only. */
    scope?: Scope;
    /**
     * RFC-028 D2: for `kind: "gateway"`, MOVE the lease from a live gateway to this session (the old one
     * is closed "gateway taken over"). An explicit act of its own: `supersede` never implies it. First connect only.
     */
    takeover?: "gateway";
    /** Where entries go. Default: a `checkpoint` adapter — nothing pushed, everything waits in `pending`. */
    adapter?: DeliveryAdapter;
    /** Narrows the BROADCAST tier only (RFC-018 D8) — never the addressed tier (`isAddressed`). */
    filter?: (msg: Inbound) => boolean;
    /** Where `lastSeq` survives a restart. Default: memory only (a restart starts fresh). */
    seqStore?: SeqStore;
    /** RFC-017 D3: gates every connect attempt on actually holding it (`acquire()`). */
    lock?: SessionLock;
    /** Ask the server to take over this GRANT from a socket that holds it (also implied while `lock` is held). Never moves a gateway lease — that is `takeover`. */
    supersede?: boolean;
    sessionInfo?: Partial<SessionInfo>;
    /** Entries waiting for the adapter beyond this many drop the oldest (default 1000). */
    bufferSize?: number;
    /** No inbound frame for this long ⇒ reconnect. Default: 3 server heartbeats, 90 s before the first. */
    livenessTimeoutMs?: number;
    /** How often a standing-by `Session` retries `acquire()` (default 30 s). */
    standbyRetryMs?: number;
    /** No sequenced frame for this long ⇒ `GET /api/deliveries` (default 15 min). */
    reconcileAfterMs?: number;
    /** `false`: build the session without a socket (a test double, or connect later with `start()`). */
    autoConnect?: boolean;
}
/** `Session.readDeliveries` options: page size (the server bounds it) and the previous page's `next`. */
export interface ReadDeliveriesOptions {
    limit?: number;
    after?: string;
}
/** One page of owed entries; `next` is null on the last. */
export interface DeliveriesPage {
    entries: Entry[];
    next: string | null;
}
export declare class Session {
    private readonly rt;
    private readonly client;
    private readonly opts;
    /** Entries delivered and not yet confirmed by the model — `confirm(ids)` acks them `model`. */
    readonly pending: Pending;
    private ws;
    private started;
    private reconnectTimer;
    private watchdogTimer;
    private standbyTimer;
    private reconcileTimer;
    private reconcileRunning;
    private reconcileQueued;
    private readonly lock;
    private reconnectAttempt;
    private lastClose;
    private authenticatedAt;
    /** The starting `scope` / `takeover` are said once: until the first `authenticated`, never after. */
    private declaredOnce;
    private remintedAfter4001;
    /** The CURRENT socket's own credential — updated by `sendReauth` too, so a close
     * handler's `invalidateAccess`/revoked lookups act on what this socket actually rides. */
    private sockBearer;
    private sockGrant;
    private draining;
    private stopped;
    private readonly resolveClosed;
    private readonly closedPromise;
    private myContextId;
    private agentId;
    private agentName;
    private heartbeatMs;
    /** Resume state for ONE grant: the highest seq seen, and the highest STORED. `epoch` moves
     * on every reset, so a store write still in flight from before cannot restore the old base. */
    private seq;
    private seqWrites;
    private lastSequencedAt;
    private readonly adapter;
    private readonly settled;
    private readonly ownMessageIds;
    private readonly acks;
    private readonly pushQueue;
    private pushing;
    private readonly statusChannel;
    private readonly unsubscribeRotation;
    private readonly unsubscribeLockLost;
    constructor(rt: Runtime, client: SessionClient, opts: SessionOptions);
    /** Begin connecting — once. Only needed with `autoConnect: false`. */
    start(): void;
    status(): AsyncIterable<SessionStatus>;
    /** This session's own identity, for `isTurnTrigger`'s echo suppression (RFC-018 D8). */
    self(): {
        contextId: string | null;
        agentId: string | undefined;
        ownMessageIds: ReadonlySet<string>;
    };
    /** The seq this session would resume from (what it has stored for its grant). */
    lastSeq(): number;
    /** Why this session stopped, once it has — `null` while still live/reconnecting. */
    stopReason(): SessionStop | null;
    closed(): Promise<SessionStop>;
    /** A channel send — a NEW root, never a reply. The server attributes it to this session's grant (its access token). */
    send(channelId: string, content: string, opts?: Omit<SendBody, "content"> & {
        title?: string;
    }): Promise<SendResult>;
    /** ALWAYS `POST /api/threads/:id/messages` (RFC-018 D8: "parentId is never sent"). */
    reply(threadId: string, content: string, opts?: Omit<SendBody, "content">): Promise<SendResult>;
    /**
     * RFC-027 D4. `model` ONLY on evidence the model has these entries — a read tool that
     * returned them (a host receipt goes through `pending.confirm`, which lands here).
     * `dismissed`: this client decided not to surface them; never ✓✓. Any of this agent's
     * ids; idempotent; queued while offline and sent after the next authentication.
     */
    ack(ids: Iterable<string>, how: AckHow): void;
    /** Graceful shutdown: stop reconnecting, close the socket cleanly, resolve `closed()`. */
    drain(): Promise<void>;
    private wsUrl;
    private emitStatus;
    private clearWatchdog;
    private clearReconnectTimer;
    private clearStandbyRetry;
    /**
     * THE ENTRY POINT for every connection attempt (the first, and every reconnect).
     * With a `lock`, RFC-017 D3's standby behaviour lives here: acquire → connect;
     * standby → report the holder and retry; "lost" → `onLost` already finished us.
     */
    private connectOrStandby;
    private armStandbyRetry;
    /** Point `this.seq` at `grantId`, loading what was stored for it when it is not the current one. */
    private useGrant;
    private connect;
    /** Three server heartbeats once the server named its interval; the option, or 90 s, before. */
    private livenessMs;
    private credentialFailure;
    private scheduleReconnect;
    private finish;
    private sendReauth;
    private sendJson;
    /** Send every queued ack — only on an authenticated socket; otherwise they wait for the next one. */
    private flushAcks;
    private noteSeq;
    private clearReconcile;
    private armReconcile;
    /**
     * RFC-027 D5 on demand: fetch what this session still owes (`GET /api/deliveries`)
     * and deliver what is neither pending nor settled here. For a host that took an entry
     * out of `pending` after a failure it expects to pass — the timer above runs only on a
     * QUIET session. One fetch SEQUENCE at a time (it pages to the end inside one run):
     * calls made while one runs share one trailing sequence, so an id removed mid-fetch is
     * not missed. Rejects when ANY page fails (the caller picks the retry; pages already
     * delivered stay). A stopped session starts no fetch, and one that stops mid-sequence
     * delivers nothing more. `delivered` = entries newly made pending here, over all pages.
     */
    reconcile(): Promise<{
        delivered: number;
    }>;
    private runReconcile;
    private fetchOwed;
    /**
     * ONE page of what this session's model still owes (`GET /api/deliveries`), parsed
     * as the entries a host is handed — messages, task events and action requests, in
     * the order the server owes them. For a host with no push channel (a checkpoint host
     * answering "what did I miss?") and the way to clear an entry no push will bring back.
     *
     * Pure read: it does NOT ack, does NOT touch `pending`, and does NOT deliver. The
     * caller acks `ack(ids, "model")` for exactly the entries it handed to its model, and
     * only after the result carrying them is built — an entry acked here but lost on the
     * way is never redelivered. A walk over pages is best-effort, not a snapshot: a row
     * whose send transaction commits after the walk passed its position is missed by
     * that walk. Nothing owed is lost — a later walk, a reconcile or a push returns it;
     * ack only what you returned. Page with `next` (null = last page; `after` takes it
     * back); the server bounds `limit` (default 50, max 200). A malformed row is skipped.
     *
     * Rejects when the fetch fails, and on a STOPPED session (or one that stops
     * mid-fetch): unlike `reconcile`, whose empty result is the true "delivered nothing",
     * an empty page here would tell the caller its model owes nothing — a claim a stopped
     * session cannot back.
     */
    readDeliveries(opts?: ReadDeliveriesOptions): Promise<DeliveriesPage>;
    private onFrame;
    private handleAuthenticated;
    /**
     * One entry in. Already acked here → the ack was lost, send it again (never re-push).
     * Already pending → pushed once per process, whatever the server redelivers. A
     * broadcast the filter declines is not delivered (and not owed). Otherwise: pending,
     * then the adapter. `true` when the entry became pending here.
     */
    private deliver;
    private drainPushQueue;
    private settle;
    private rememberOwnSend;
}
