export type CloseClass = "transient" | "expired" | "evicted" | "session-cap" | "credential" | "revoked" | "superseded" | "too-old";
export declare function classifyClose(code: number | undefined, reason?: string): CloseClass;
/**
 * Delay before reconnect attempt `attempt` (1-based), or `null` = do not
 * reconnect. `rand` in [0, 1).
 */
export declare function reconnectDelay(attempt: number, cls: CloseClass, rand?: () => number): number | null;
/**
 * Just enough of the new holder's identity (a lock record) to NAME it in
 * `closeOutcome` — pid, version, tty, terminal, cwd. Every field is optional: a
 * lock record a consumer cannot read at all still produces a `closeOutcome` with
 * no `holder`, and a consumer renders its own generic fallback.
 */
export interface HolderIdentity {
    pid: number;
    version?: string;
    tty?: string;
    termProgram?: string;
    cwd?: string;
}
/** The stable, data-only reason a consumer switches on to pick its OWN wording (D4). */
export type StopReason = "session-revoked" | "installation-revoked" | "installation-locked" | "policy-unknown" | "superseded" | "too-old";
/**
 * The data `describeClose`'s prose used to encode (D4: "turned into data"). Always
 * carries `class`/`code`/`reason`/`retry`; the terminal classes (`revoked`,
 * `superseded`, `too-old`) additionally carry `stop` and whatever structured
 * fields apply to that stop reason. No sentence is assembled here — a consumer
 * reads `stop` (and `holder`/`holderIsNewer`/`keyDeleted`/`remedy`) and writes its
 * own text, in its own commands.
 */
export interface CloseOutcome {
    class: CloseClass;
    code: number | undefined;
    reason: string | undefined;
    /** Whether a consumer should reconnect on its own — `reconnectDelay(...) !== null`'s class-level twin. */
    retry: boolean;
    stop?: StopReason;
    /** `superseded` only: the incumbent's identity, when a lock record was readable. */
    holder?: HolderIdentity;
    /** `superseded` only: true iff `holder.version` is a STRICTLY newer, well-formed semver than `opts.myVersion`. */
    holderIsNewer?: boolean;
    /** `revoked` only, and only when THIS close made the caller delete the installation's files (4008 locked). */
    keyDeleted?: boolean;
    /**
     * `too-old` only: the tail after "client too old: " / "client version
     * withdrawn: " — the server's OWN remedy text (`client-versions.ts`
     * `closeReason`), passed through verbatim. Not SDK prose: the server already
     * knows which software this is and picked the instruction.
     */
    remedy?: string;
}
export declare function closeOutcome(cls: CloseClass, code: number | undefined, reason: string | undefined, opts?: {
    keyDeleted?: boolean;
    holder?: HolderIdentity;
    myVersion?: string;
}): CloseOutcome;
