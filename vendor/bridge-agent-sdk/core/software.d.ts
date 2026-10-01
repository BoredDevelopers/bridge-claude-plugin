/**
 * RFC-018 D4 / RFC-017 D5 — this runtime's self-reported identity: `software_id` +
 * `software_version`, sent on every grant request (`TokenClient`'s own
 * `identityFields`, ./protocol.ts) and the auth frame's `sessionInfo.softwareId`
 * (packages/api/src/ws.ts `SessionInfo`), plus the `User-Agent` header every HTTP
 * request carries. NEW for the SDK — the plugin has no equivalent module; it built
 * these fields ad hoc at each call site.
 */
export interface SoftwareIdentity {
    /** The OAuth client id (RFC 7591 `software_id`) — e.g. `bridge-claude-plugin`, `bridge-openclaw`. */
    softwareId: string;
    /** This build's own version. A plain string (`client-versions.ts` parses it server-side; this module never has to). */
    softwareVersion: string;
    /** The HOST runtime, e.g. `bun`, `node`, `openclaw`. */
    runtimeName: string;
    runtimeVersion: string;
    /** From `process.platform`/`process.arch` on Node/Bun, or the caller's own probe elsewhere. */
    os: string;
    arch: string;
}
/**
 * `bridge-agent-sdk/<v> (<runtime>/<v>; <os>/<arch>) <software_id>/<v>` (D4). The
 * SDK's own version is threaded through by the caller (`sdkVersion`) rather than
 * read off `package.json` here — a source file has no reliable way to know its own
 * package version, and the caller (built by `bun build`, D5) already does.
 */
export declare function userAgent(sdkVersion: string, id: SoftwareIdentity): string;
/**
 * The subset of `TokenClientOptions` (./protocol.ts) that carries a
 * `SoftwareIdentity` — spread this into a `TokenClient` construction rather than
 * naming `softwareId`/`softwareVersion`/`clientId` three times at every call site.
 * `clientId` (the OAuth public client id) and `softwareId` are the SAME string by
 * convention (RFC-018 D4) — `TokenClient` keeps them as two options because
 * `clientId` predates `software_id` (RFC-016) and a consumer is free to diverge.
 */
export declare function identityTokenClientOptions(id: SoftwareIdentity): {
    clientId: string;
    softwareId: string;
    softwareVersion: string;
};
