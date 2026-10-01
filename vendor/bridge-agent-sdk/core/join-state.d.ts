export declare function isJoinState(s: unknown): s is string;
/** The state's sequence number, or null when it is not a join state at all. */
export declare function joinStateSeq(s: string): number | null;
