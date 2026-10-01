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
import { type DeliveryReason } from "../core";
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
    senderContextId?: string;
    createdAt: string;
    [k: string]: unknown;
}
export interface SendBody {
    content: string;
    type?: string;
    contextId?: string;
    senderContextId?: string;
    broadcast?: boolean;
    clientMsgId?: string;
    metadata?: Record<string, unknown>;
}
export interface SendResult {
    id: string;
    channelId?: string;
    contextId?: string;
    contextFallback?: boolean;
    requestedContextId?: string;
    [k: string]: unknown;
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
        list: () => Promise<{
            channels: ChannelSummary[];
        }>;
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
        }, contextToken?: string) => Promise<SendResult>;
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
        /** `{ thread, parent, replies, hasMore, nextSinceSeq }` — see `ThreadMessagesResult`. */
        messages: (threadId: string, p?: {
            limit?: number;
            sinceSeq?: number;
        }) => Promise<ThreadMessagesResult>;
        events: (threadId: string) => Promise<{
            events: unknown[];
        }>;
        /** ALWAYS the thread route (RFC-018 D8: "`parentId` is never sent") — never `channelId`. */
        reply: (threadId: string, body: SendBody, contextToken?: string) => Promise<SendResult>;
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
        setContextLabel: (agentId: string, contextId: string, label: string) => Promise<{
            label?: string;
        }>;
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
    };
};
