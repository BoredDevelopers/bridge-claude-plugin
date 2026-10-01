/**
 * The WS wire shapes, kept in one place so `Session` (S1.3) and every consumer
 * read them from a single definition rather than re-guessing the frame layout at
 * each call site — the exact failure mode RFC-018 §1 calls out in the dead
 * `openclaw-bridge-plugin` ("drifted in six places").
 *
 * NEW for the SDK, transcribed from the server's real shapes — not extracted from
 * the plugin, which built these ad hoc inline. Sources: `packages/api/src/ws.ts`
 * (`SessionInfo`, the `auth`/`reauth` input, the `authenticated`/`message`/`replay`
 * frames, `broadcastMessage`) and `packages/api/src/routing.ts` (`DeliveryReason`,
 * `ADDRESSED_REASONS`/`BROADCAST_REASONS`, `isAddressed`). Kept in sync with those
 * by `fixtures/frames/*.json` + the drift test once S1.5 lands; for now this is a
 * hand-transcribed but faithful copy — a change to either shape without the other
 * is exactly what the fixtures are for.
 */
/** The server picked THIS agent specifically — never suppressible by a client. */
export declare const ADDRESSED_REASONS: readonly ["target", "assignee", "mention", "thread"];
/** A standing subscription matched — a client MAY narrow this tier. */
export declare const BROADCAST_REASONS: readonly ["channel", "member", "type", "tag"];
export type DeliveryReason = (typeof ADDRESSED_REASONS)[number] | (typeof BROADCAST_REASONS)[number];
/** True if the server picked this recipient specifically (mirrors routing.ts). */
export declare function isAddressed(reasons: Iterable<DeliveryReason> | undefined): boolean;
/**
 * What a client tells the server about itself on the auth frame (`ws.ts`'s
 * `SessionInfo`, the fields a Bridge caller controls — `clientName` etc. name the
 * TERMINAL, not the software; `softwareId`/`clientVersion` name the BUILD, RFC-017
 * D5).
 */
export interface SessionInfo {
    clientName?: string;
    hostName?: string;
    repoName?: string;
    worktreeName?: string;
    branchName?: string;
    headShortSha?: string;
    sessionLabel?: string;
    sessionKey?: string;
    clientVersion?: string;
    softwareId?: string;
}
export interface AuthFrame {
    type: "auth";
    token: string;
    sessionInfo?: SessionInfo;
    /** Present only when this session already holds an HTTP send token (a reconnect). */
    sendToken?: string;
    /** The DPoP proof for this frame's implicit `GET /ws` (E11). */
    dpop?: unknown;
    /** RFC-017 D3: ask to take over a session another window holds. */
    supersede?: boolean;
    /** Replay cursor — an ISO-8601 timestamp (see ./cursor.ts). */
    since?: string;
}
export interface ReauthFrame {
    type: "reauth";
    token: string;
    dpop?: unknown;
}
export interface AuthenticatedFrame {
    type: "authenticated";
    data: {
        agentId: string;
        agentName: string;
        /** This agent's current @handle in its own tenant, or null if it holds none. */
        handle: string | null;
        contextId: string;
        /** Only present when just minted — never re-disclosed for an existing context. */
        sendToken?: string;
        /** RFC-017 D7: present only when a newer build is available and this session is the holder. */
        client?: unknown;
    };
}
export interface ErrorFrame {
    type: "error";
    data: {
        message: string;
    };
}
/**
 * One broadcast message (`broadcastMessage`'s parameter, minus the server-internal
 * `deliveryReasons` Map — see `InboundMessage` below for how it reaches the wire).
 */
export interface WireMessage {
    id: string;
    channelId: string;
    agentId?: string | null;
    userId?: string | null;
    agentName?: string | null;
    senderType?: "agent" | "human";
    senderName?: string;
    content: string;
    type?: string;
    metadata?: string | null;
    threadId: string | null;
    isRoot?: boolean;
    seq?: number;
    createdAt: string;
    senderContextId: string;
    senderProvenance?: string;
    senderContextLabel?: string | null;
}
/**
 * A LIVE message frame: `deliveryReasons` sits BESIDE `data`, never inside it (the
 * message is canonical and identical for every recipient; the reason is a property
 * of THIS delivery — same layout as a Zulip event's `flags`). `interestedAgents` is
 * advisory only; the socket send is the security boundary.
 */
export interface MessageFrame {
    type: "message";
    data: WireMessage & {
        interestedAgents: string[];
    };
    deliveryReasons: DeliveryReason[];
}
/**
 * A REPLAY batch: the reason travels ON EACH ENTRY instead, because a batch is a
 * list a client may re-order or filter — an index-coupled parallel array would not
 * survive that. `missed: true` marks a redelivery of a targeted message this
 * session's replay cursor swallowed (never recorded as delivered until acked).
 */
export interface ReplayFrame {
    type: "replay";
    data: {
        messages: (WireMessage & {
            deliveryReasons: DeliveryReason[];
        })[];
        missed?: true;
    };
}
/**
 * The numeric WS close codes the server sends, named so nothing above this layer
 * hard-codes a magic number. `policy` (4008) carries every REASON
 * `./reconnect-policy.ts`'s `classifyClose` distinguishes (revoked / superseded /
 * too-old / evicted) — the code alone never tells them apart; the reason PREFIX
 * does.
 */
export declare const WS_CLOSE_CODES: {
    readonly authTimeout: 4006;
    readonly invalidToken: 4001;
    readonly deregisteredOrArchived: 4003;
    readonly tooManySessions: 4007;
    readonly policy: 4008;
    readonly tokenExpired: 4009;
    readonly grantCheckFailed: 1011;
};
