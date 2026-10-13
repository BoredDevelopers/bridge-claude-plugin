/**
 * `AgentClient.api` — typed HTTP methods for every endpoint the plugin's
 * `server.ts` calls (RFC-018 S1.3 plan item 3), built on ONE request function
 * that carries DPoP + the resource nonce + a single 401 retry + 429
 * `Retry-After`, adapted from the plugin's `apiFetch`.
 *
 * DIVERGES from the plugin in one deliberate way: `apiFetch` left its
 * `deadline()` uncleared on the success path so a CALLER reading the response
 * body afterwards stayed inside the same budget. Every method here reads the
 * body itself before returning, so `request()` clears the deadline in a
 * `finally` — matching `../core/deadline.ts`'s own documented contract
 * ("callers MUST call clear() … skipping it leaks both") rather than the
 * plugin's caller-specific workaround.
 */
import { type ConnectionKind, type DeliveryReason, type DeliveriesResponse, type Scope } from "../core";
import type { Runtime } from "./ports";
import type { AgentClient } from "./client";
export declare class ApiRequestError extends Error {
    readonly name = "ApiRequestError";
    readonly status: number;
    readonly body: unknown;
    readonly retryAfterS?: number;
    constructor(status: number, body: unknown, retryAfterS?: number);
}
export declare function isApiRequestError(e: unknown): e is ApiRequestError;
export interface ChannelSummary {
    id: string;
    name: string;
    visibility?: "public" | "private";
    [k: string]: unknown;
}
export interface ReadStateEntry {
    channelId: string;
    lastReadSeq?: number;
    unreadThreads?: number;
    [k: string]: unknown;
}
export interface MarkReadResult {
    ok: true;
    advanced: boolean;
    lastReadSeq: number;
    readAt: string;
}
export interface MessageEnvelope {
    id: string;
    channelId: string;
    threadId: string | null;
    seq?: number;
    content: string;
    type: string;
    agentId?: string | null;
    agentName?: string | null;
    /** The sending session's grant id, or null for a person / a session-less send. */
    senderContextId?: string | null;
    createdAt: string;
    [k: string]: unknown;
}
/**
 * What a post may carry. There is NO `contextId` / `broadcast` (RFC-028 D7): the thread's
 * hold is the target, from outside the agent and inside it; to move work to another
 * session of the agent, `threads.hold({action: "handover"})`. The server answers 400 to
 * a body that still names either.
 */
export interface SendBody {
    content: string;
    type?: string;
    /** RFC-028 D3: this reply takes the thread's hold (from a live holder only with `confirm`). Replies only. */
    take?: boolean;
    confirm?: boolean;
    clientMsgId?: string;
    metadata?: Record<string, unknown>;
}
/** A session as a hold shows it (RFC-028 D3/D4). `parked`: not online and past the 120 s grace — nobody is there. */
export interface HoldHolder {
    id: string;
    label: string | null;
    online: boolean;
    parked?: boolean;
}
/** Where the posting session stands on the thread: it `held` it, or only `contribution`s to a sibling's hold (offer `take`). */
export interface SendHold {
    state: "held" | "contribution";
    holder: HoldHolder;
}
export interface SendResult {
    id: string;
    channelId?: string;
    /** RFC-028: present for an agent's post. */
    hold?: SendHold;
    [k: string]: unknown;
}
/** One row of `GET /api/threads?takeable=1` (RFC-028 D8): a thread this session could take. */
export interface TakeableThread {
    thread: {
        id: string;
        title: string;
        kind?: string;
        status?: string;
        replyCount?: number;
        lastActivityAt?: string;
    };
    channel: {
        id: string;
        name: string;
    };
    hold: {
        state: "unheld" | "parked" | "held";
        holder: (HoldHolder & {
            parked: boolean;
        }) | null;
    };
    why: "addressed" | "participant";
}
export interface TakeableResult {
    threads: TakeableThread[];
    /** Opaque cursor for the next page (`cursor`); null on the last one. */
    next: string | null;
}
/** `POST /api/threads/:id/hold` (RFC-028 D3/D8). */
export type HoldRequest = {
    action: "take";
    confirm?: boolean;
} | {
    action: "release";
    agentId?: string;
} | {
    action: "handover";
    to: string;
    agentId?: string;
};
export interface HoldResult {
    threadId: string;
    agentId: string;
    hold: {
        state: "held";
        holder: HoldHolder;
    } | null;
    changed: boolean;
    moved: number;
}
/** One session of an agent (`GET /api/agents/:id/sessions`, RFC-028 D8). */
export interface AgentSession {
    id: string;
    label: string | null;
    /** null: it has not connected since kinds existed. */
    kind: ConnectionKind | null;
    scope: {
        mode: "all" | "channels" | "none";
        channelIds: string[];
    };
    state: "live" | "parked";
    online: boolean;
    parked: boolean;
    lastSeenAt: string | null;
    createdAt: string;
    /** Thread ids this session holds. */
    holds: string[];
}
export interface ThreadSummary {
    id: string;
    title: string;
    kind?: "discussion" | "question" | "task";
    status?: string;
    replyCount?: number;
    unreadCount?: number;
    lastActivityAt?: string;
    [k: string]: unknown;
}
export interface ThreadResult {
    threadId: string;
    kind?: string;
    status?: string;
    answerMessageId?: string | null;
    [k: string]: unknown;
}
/**
 * `GET /api/threads/:id/messages` (`routes/threads.ts`) — NOT `{ messages: [...] }`
 * (that shape is `GET /api/messages`'s, `messages.list` below). A thread's own read
 * names its root separately (`parent`, `null` for a thread with none) from its
 * replies, and pages by `sinceSeq`/`hasMore`/`nextSinceSeq` — `since` (an ISO
 * timestamp) is not an accepted query param here, unlike the channel view.
 * RFC-018 S1.5 conformance caught this: `threads.messages` used to claim the
 * `messages.list` shape and every read against a real server threw at `.messages.some(...)`.
 */
export interface ThreadMessagesResult {
    thread: {
        id: string;
        channelId: string;
        title: string;
        kind?: string;
        status?: string;
        answerMessageId: string | null;
        replyCount: number;
        lastSeq: number;
    } | null;
    parent: (MessageEnvelope & {
        deliveryReasons?: DeliveryReason[];
    }) | null;
    replies: (MessageEnvelope & {
        deliveryReasons?: DeliveryReason[];
    })[];
    hasMore: boolean;
    nextSinceSeq: number;
    agent: string;
}
export interface AgentSummary {
    id: string;
    name: string;
    handle: string | null;
    online?: boolean;
    state?: string;
    [k: string]: unknown;
}
/**
 * One principal in `GET /api/presence` (RFC-025): every person and agent in the workspace
 * who is connected or was seen in the last 30 days. `lastSeenAt` is exact; null only when
 * never seen. `handle` is what an @mention resolves (null when none) — `id` is opaque.
 */
export interface PresencePrincipal {
    id: string;
    name: string;
    handle: string | null;
    kind: "agent" | "human";
    connected: boolean;
    connectedAt: string | null;
    lastSeenAt: string | null;
}
/**
 * `presenceEnabled: false` — a workspace admin turned presence off (RFC-025 D10): people
 * are OMITTED, not offline; only agents (and nobody else) are listed. Read it before
 * concluding from an empty people list that nobody is around.
 */
export interface PresenceList {
    principals: PresencePrincipal[];
    presenceEnabled: boolean;
}
export interface ContextSummary {
    id: string;
    label?: string | null;
    state: string;
    lastHeartbeatAt?: string;
    clientVersion?: string | null;
    [k: string]: unknown;
}
export interface TaskResult {
    id: string;
    status: string;
    [k: string]: unknown;
}
export type Api = ReturnType<typeof createApi>;
export declare function createApi(rt: Runtime, client: AgentClient): {
    channels: {
        /** `includeArchived`: an archived channel resolves too (so join/leave can say "archived", not "no such channel"). */
        list: (p?: {
            includeArchived?: boolean;
        }) => Promise<{
            channels: ChannelSummary[];
        }>;
        join: (channelId: string) => Promise<unknown>;
        leave: (channelId: string) => Promise<unknown>;
        /** Who will read what is posted here (decision 17). */
        audience: (channelId: string) => Promise<unknown>;
        readState: () => Promise<{
            channels: ReadStateEntry[];
        }>;
        markRead: (channelId: string, body?: {
            lastReadSeq?: number;
            fromSeq?: number;
        }) => Promise<MarkReadResult>;
    };
    messages: {
        list: (p: {
            channel: string;
            limit?: number;
            since?: string;
            sinceSeq?: number;
        }) => Promise<{
            messages: (MessageEnvelope & {
                deliveryReasons?: DeliveryReason[];
            })[];
        }>;
        /** Root-only (RFC-012 slice 5.4) — `body` must never carry `threadId`/`parentId`; reply with `threads.reply`. */
        create: (channelId: string, body: SendBody & {
            title?: string;
        }) => Promise<SendResult>;
        receipts: (ids: string[]) => Promise<{
            receipts: unknown[];
        }>;
    };
    threads: {
        list: (p: {
            channel: string;
            query?: string;
        }) => Promise<{
            channelId: string | null;
            threads: ThreadSummary[];
        }>;
        /**
         * RFC-028 D8: the open threads this session could take — addressed to the agent or posted in by it, not held
         * by this session: unheld › parked › held by another live session, newest first, cursor-paged (default 10).
         * `channel` narrows to one channel; omitted = across the agent's channels. Agents only.
         */
        takeable: (p?: {
            channel?: string;
            limit?: number;
            cursor?: string;
        }) => Promise<TakeableResult>;
        /**
         * RFC-028 D3: `take` | `release` | `handover {to}` on a thread's hold. An agent acts for its calling
         * session. A take from an ONLINE holder needs `confirm: true` (409 `holder_online` otherwise, naming
         * the holder — an `ApiRequestError` with `body.holder`).
         */
        hold: (threadId: string, body: HoldRequest) => Promise<HoldResult>;
        /** `{ thread, parent, replies, hasMore, nextSinceSeq }` — see `ThreadMessagesResult`. */
        messages: (threadId: string, p?: {
            limit?: number;
            sinceSeq?: number;
        }) => Promise<ThreadMessagesResult>;
        events: (threadId: string) => Promise<{
            events: unknown[];
        }>;
        /** ALWAYS the thread route (RFC-018 D8: "`parentId` is never sent") — never `channelId`. */
        reply: (threadId: string, body: SendBody) => Promise<SendResult>;
        rename: (threadId: string, title: string) => Promise<ThreadResult>;
        markRead: (threadId: string, body?: {
            lastReadSeq?: number;
            fromSeq?: number;
        }) => Promise<MarkReadResult>;
        markAnswer: (threadId: string, messageId: string) => Promise<ThreadResult>;
        unmarkAnswer: (threadId: string) => Promise<ThreadResult>;
        setKind: (threadId: string, kind: "discussion" | "question") => Promise<ThreadResult>;
    };
    agents: {
        list: () => Promise<{
            agents: AgentSummary[];
        }>;
        contexts: (agentId: string) => Promise<{
            contexts: ContextSummary[];
        }>;
        /** RFC-028 D8: the agent's live sessions — kind, scope, live or parked, and the threads each holds (the agent itself, and its managers). */
        sessions: (agentId: string) => Promise<{
            sessions: AgentSession[];
        }>;
        setContextLabel: (agentId: string, contextId: string, label: string) => Promise<{
            label?: string;
        }>;
    };
    presence: {
        list: () => Promise<PresenceList>;
    };
    sessions: {
        /**
         * RFC-028 D6: this session's scope — the channels whose UNHELD work a work session takes. Narrows
         * unheld work only; a held thread reaches its holder whatever the scope. Stored on the grant and
         * patched onto the live socket; a reconnect does not re-send the starting scope, so this sticks.
         */
        setScope: (scope: Scope) => Promise<{
            scope: {
                mode: Scope["mode"];
                channelIds: string[];
            };
        }>;
    };
    /** RFC-027 D5: what THIS session's model still owes — its own entries and its agent's unowned, not yet seen. */
    deliveries: {
        /** One page, oldest first. `limit` is the server's to bound (default 50, max 200); `after` is a previous page's `next`. */
        list: (opts?: {
            limit?: number;
            after?: string;
        }) => Promise<DeliveriesResponse>;
    };
    tasks: {
        claim: (messageId: string) => Promise<TaskResult>;
        updateStatus: (messageId: string, body: {
            status: string;
            message?: string;
            result?: unknown;
        }) => Promise<TaskResult>;
        cancel: (messageId: string, reason?: string) => Promise<TaskResult>;
        list: (p?: {
            assignee?: string;
            status?: string;
        }) => Promise<{
            tasks: TaskResult[];
        }>;
        /** Who can see this task's thread (decision 17). */
        audience: (messageId: string) => Promise<unknown>;
    };
};
