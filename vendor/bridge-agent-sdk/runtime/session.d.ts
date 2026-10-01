/**
 * `Session` — one WebSocket (RFC-018 D3), the plugin's `connectWs`/`handleWsMessage`
 * pair minus every Claude-ism (no MCP notifications, no stderr prose — everything
 * observable comes back through `messages()`/`status()`/`closed()`). Ported
 * behaviour, not redesigned: the auth frame shape, reauth-in-band, the ONE 4001
 * re-mint re-armed per socket (`REMINT_REARM_MS`), the liveness watchdog that
 * DETACHES before `close()` (Bun 1.3 fires `close` synchronously inside it —
 * `../core/deadline.ts` documents the same class of Bun/Node timer bug),
 * `supersede` riding on every auth frame while a `SessionLock` is held (D3/D4),
 * and reconnecting via `classifyClose`/`reconnectDelay` (`../core/reconnect-policy.ts`).
 */
import { type CloseClass, type CloseOutcome, type DeliveryReason, type SessionInfo, type WireMessage } from "../core";
import type { Runtime } from "./ports";
import type { AgentClient } from "./client";
import type { CursorStore, LockHolderInfo, SessionLock } from "./store";
import type { SendBody, SendResult } from "./api";
import { AgentClientError } from "./errors";
/** One inbound message, with the delivery reason(s) THIS session was sent it for
 * (`../core/wire.ts`'s `WireMessage` + the sibling `deliveryReasons` the message frame
 * and each replay entry both carry). */
export type Inbound = WireMessage & {
    deliveryReasons: DeliveryReason[];
};
export type StopKind = "superseded" | "too-old" | "revoked" | "credential" | "drain";
/** Why this `Session` will never reconnect again. `close` is present for the three WS-close
 * stop classes RFC-018 D3 names (superseded/too-old/revoked); `credential` for a terminal
 * `AgentClient` mint failure (installation gone, refused, …) — RFC-018's own grouping of
 * "credential" alongside the WS ones as one of the stop classes a consumer switches on. */
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
    contextId: string | null;
    advice?: unknown;
    /** This socket's auth frame carried `supersede: true` but the resumed `contextId`
     * is NOT this session's own `sessionKey` — the takeover did not actually take (the
     * plugin's `supersedeIneffective`). A caller may retry with an explicit takeover. */
    supersedeIneffective?: boolean;
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
} | {
    kind: "slow-consumer";
    droppedMessageId: string;
} | {
    kind: "stopped";
    stop: SessionStop;
};
export interface SessionOptions {
    /** Narrows the BROADCAST tier only (RFC-018 D8/plugin `channelDecision`) — never the
     * addressed tier (`isAddressed`), which always reaches `messages()` regardless. */
    filter?: (msg: Inbound) => boolean;
    cursorStore?: CursorStore;
    /** RFC-017 D3: gates every connect attempt on actually holding it (`acquire()`),
     * standing by and retrying otherwise — see `./store.ts`'s `SessionLock`. No structural
     * detection any more (review SIMPLIFY finding): every lock is this one shape. */
    lock?: SessionLock;
    sessionInfo?: Partial<SessionInfo>;
    /** `messages()`'s bounded buffer before the oldest is dropped (default 1000). */
    bufferSize?: number;
    /** No inbound frame for this long ⇒ force a reconnect (the Bun 1.3 detach-before-close
     * lesson). Default 90s, matching the plugin's `LIVENESS_TIMEOUT_MS`. */
    livenessTimeoutMs?: number;
    /** How often a standing-by `Session` retries `acquire()` (default 30s, the plugin's
     * `LOCK_RETRY_MS`). Ignored when no `lock` is given at all. */
    standbyRetryMs?: number;
}
export declare class Session {
    private readonly rt;
    private readonly client;
    private readonly opts;
    private ws;
    private reconnectTimer;
    private watchdogTimer;
    private standbyTimer;
    /** `undefined` when `opts.lock` is absent — `connectOrStandby()` falls straight through
     * to `connect()` with no acquisition gate at all. */
    private readonly lock;
    private reconnectAttempt;
    private lastClose;
    private authenticatedAt;
    private remintedAfter4001;
    /** The CURRENT (or most recently connected) socket's own credential — updated by
     * `sendReauth` too (minor finding 1, the plugin's `reauthedWith`), so a close handler's
     * `invalidateAccess`/revoked lookups always act on what this socket is ACTUALLY riding,
     * not the token it merely started with. Only one socket is ever live at a time, so one
     * instance field (not a per-socket map) is enough — a stale socket's close handler bails
     * on `this.ws !== sock` before ever reading these. */
    private sockBearer;
    private sockGrant;
    /** Whether the auth frame THIS socket sent carried `supersede: true` — read back once
     * `authenticated` arrives, to detect `supersedeIneffective` (the takeover did not
     * actually resume our own `sessionKey`). */
    private authSupersede;
    private draining;
    private stopped;
    private readonly resolveClosed;
    private readonly closedPromise;
    private myContextId;
    private mySendToken;
    private agentId;
    private agentName;
    private cursor;
    private readonly cursorReady;
    private readonly dedupe;
    private readonly ownMessageIds;
    private readonly messagesChannel;
    private readonly statusChannel;
    private readonly unsubscribeRotation;
    private readonly unsubscribeLockLost;
    constructor(rt: Runtime, client: AgentClient, opts?: SessionOptions);
    messages(): AsyncIterable<Inbound>;
    status(): AsyncIterable<SessionStatus>;
    /** This session's own identity, for `isTurnTrigger`'s echo suppression (own-sent ids +
     * self sender, RFC-018 D8). */
    self(): {
        contextId: string | null;
        agentId: string | undefined;
        ownMessageIds: ReadonlySet<string>;
    };
    /** Why this session stopped, once it has — `null` while still live/reconnecting. Named
     * `stopReason`, not `stop` (nit: the latter clashed in spirit with `AgentClient.stop()`,
     * an IMPERATIVE "stop the ticker" — this is a passive getter, never an action). */
    stopReason(): SessionStop | null;
    closed(): Promise<SessionStop>;
    /** A channel send — a NEW root, never a reply (`reply()` is the thread route). Remembers
     * the returned id for echo suppression. */
    send(channelId: string, content: string, opts?: Omit<SendBody, "content"> & {
        title?: string;
    }): Promise<SendResult>;
    /** ALWAYS `POST /api/threads/:id/messages` (RFC-018 D8: "parentId is never sent") — never
     * a channel-scoped send with a thread id bolted on. */
    reply(threadId: string, content: string, opts?: Omit<SendBody, "content">): Promise<SendResult>;
    /** A `seen` receipt for `messageId` — caller-driven (once the message has actually been
     * acted on), never automatic on delivery. A no-op while disconnected: the next reconnect's
     * replay redelivers anything an ack never reached the server for. */
    ack(messageId: string): void;
    /** Graceful shutdown: stop reconnecting, close the socket cleanly, resolve `closed()`. */
    drain(): Promise<void>;
    private wsUrl;
    private emitStatus;
    private clearWatchdog;
    private clearReconnectTimer;
    private clearStandbyRetry;
    /**
     * THE ENTRY POINT for every connection attempt (the initial one, and — via
     * `scheduleReconnect`'s timer — every reconnect): `connect()` is never called
     * directly except from here. With no `lock` at all this is a pass-through.
     *
     * With one, RFC-017 D3's standby behaviour lives HERE rather than in a consumer:
     * `acquire()` decides acquire/takeover (→ connect) or standby (→ report the holder,
     * retry on `standbyRetryMs`'s cadence — the plugin's `lockRetryTimer`). "lost" means
     * this handle already held the lock and just discovered it did not anymore — `onLost`
     * (subscribed once, in the constructor) has already run `finish()` for THE OWNERSHIP
     * RULE's reason (never re-decide by version), so there is nothing further to do here:
     * falling through to `connect()` would be exactly the re-take the rule forbids.
     */
    private connectOrStandby;
    private armStandbyRetry;
    private connect;
    private credentialFailure;
    private scheduleReconnect;
    private finish;
    private sendReauth;
    private onFrame;
    private handleAuthenticated;
    private handleInbound;
    private rememberOwnSend;
}
