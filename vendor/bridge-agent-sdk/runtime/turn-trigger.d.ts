import type { Inbound } from "./session";
export interface TurnSelf {
    /** This session's own context id — a message whose `senderContextId` equals this is an echo. */
    contextId?: string | null;
    /** Ids this session itself has sent (`Session.self().ownMessageIds`) — an echo even when
     * it comes back re-targeted at this session by id, not just by `senderContextId`. */
    ownMessageIds?: ReadonlySet<string>;
}
export declare function isTurnTrigger(msg: Inbound, self: TurnSelf): boolean;
