import type { Clock } from "./clock";
import type { Signer } from "./signer";
export { OAuthError, isOAuthError, TransportError, DiscoveryError, AbortedError } from "./token-errors";
export declare const GRANT_ENROLMENT_KEY = "urn:bridge:params:oauth:grant-type:enrolment-key";
export declare const GRANT_DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
export declare const GRANT_CLIENT_CREDENTIALS = "client_credentials";
/** RFC-016 §5.2: the mint timeout (one HTTP request). */
export declare const MINT_TIMEOUT_MS = 30000;
/**
 * Every retry of one logical request (nonce, proof, assertion) together. A caller
 * that makes SEVERAL requests under the installation lock passes the lock's `signal`
 * (one deadline for the whole critical section, auth/node/lock.ts HOLD_BUDGET_MS):
 * per-request budgets add up — discovery + enrol + the C6 retry was 10 + 90 + 90 s,
 * past the lock's 120 s stale break.
 */
export declare const MINT_BUDGET_MS = 90000;
/** How long a TokenClient trusts discovered metadata (a deploy can move endpoints). */
export declare const METADATA_TTL_MS: number;
/**
 * The HTTP exchange, with ONLY the transport wrapped: `fetch` and reading the body. The
 * body is read as text (a cut-off body is a lost answer, not a malformed one) and parsed
 * separately — a non-JSON body is `json: null`, never a throw. A failure while the
 * CALLER's own signal is cancelled is `AbortedError` (never retried); any other is a
 * `TransportError` (transient), including our own timeouts.
 */
/** What the TokenClient needs of `fetch` (so a test double or another runtime's fetch fits). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface AuthMetadata {
    issuer: string;
    authorization_endpoint: string;
    device_authorization_endpoint: string;
    token_endpoint: string;
    revocation_endpoint: string;
    grant_types_supported?: string[];
    dpop_signing_alg_values_supported?: string[];
    bridge_connect_done_uri?: string;
}
/**
 * RFC 8414 §3.3: the metadata's `issuer` MUST equal the issuer the discovery URL was
 * built from. Every endpoint the plugin sends a credential to is pinned to the API's
 * own origin — a tampered discovery answer must never route an assertion, a proof or
 * a join state to another host. (`bridge_connect_done_uri` is the WEB origin by design.)
 */
export declare function assertSameAuthority(apiUrl: string, m: AuthMetadata): void;
/** RFC-016 §3.6: a server that can mint for a key advertises `client_credentials`. */
export declare function supportsKeyCredentials(m: AuthMetadata): boolean;
/** What every enrolment grant returns (RFC-016 §3.2). */
export interface EnrolGrant {
    installation_id: string;
    join_state: string;
    agent?: {
        id: string;
        handle: string | null;
        name: string;
    };
    workspace?: {
        id: string;
        name: string;
    };
}
export interface MintGrant {
    access_token: string;
    token_type: "DPoP";
    expires_in: number;
    join_state: string;
    session_id: string;
}
export interface DeviceAuthorization {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
}
export interface MintInput {
    installationId: string;
    joinState: string;
    attempt: string;
    sessionKey: string;
    /** E9: only on an explicit user reconnect after a session revoke. */
    reconnect: boolean;
    platform?: string;
    clientVersion?: string;
}
/** A caller's deadline across several requests (the installation lock's critical section). */
export interface CallOpts {
    signal?: AbortSignal;
}
export interface RevokeInput {
    installationId: string;
    joinState: string;
    attempt: string | null;
    scope: "installation" | "session";
    sessionKey?: string;
}
export interface TokenClientOptions {
    /** The server clock estimate (E12); every token-endpoint `Date` teaches it. */
    clock: Clock;
    /**
     * This runtime's PUBLIC client id (RFC-016 §3.2 `AGENT_AUTH_CLIENTS`) — sent by the enrolment
     * flows. REQUIRED, no default: an SDK consumer must never silently enrol as another runtime.
     * The Claude plugin passes "bridge-claude-plugin" from its own (non-core) module.
     */
    clientId: string;
    /** Injected transport (tests, proxies, other runtimes). Default: the global `fetch`. */
    fetch?: FetchLike;
    /** How long discovered metadata is reused (default METADATA_TTL_MS). */
    metadataTtlMs?: number;
    /**
     * RFC-017 D5: this runtime's own identity, sent on EVERY grant request (enrolment key,
     * authorization_code, device code, client_credentials) — not just `mint`'s existing
     * `platform`/`clientVersion` (those feed `agent_grants.client_version`, unrelated to
     * this). Optional: an SDK consumer that omits it simply sends neither field, and the
     * server's `resolveSoftware` falls back to a bare `client_version` for that case (D5).
     */
    softwareId?: string;
    softwareVersion?: string;
    /**
     * Override the deadline constants (MINT_TIMEOUT_MS / MINT_BUDGET_MS / DISCOVERY_TIMEOUT_MS)
     * — test-only-friendly: production callers never set this, so they get the constants
     * (unset fields fall back individually). A test that needs a request to a server that
     * never answers to settle in milliseconds, not `MINT_TIMEOUT_MS`'s 30 s, sets these
     * instead of waiting out the real budgets.
     */
    timeouts?: {
        discoveryMs?: number;
        mintMs?: number;
        mintBudgetMs?: number;
    };
}
export declare class TokenClient {
    /** Last `DPoP-Nonce` per authorization-server origin (RFC 9449 §8). */
    private readonly nonces;
    /** Discovery, per API origin, for this client only — never a process-global forever cache. */
    private readonly metadata;
    private readonly clock;
    private readonly clientId;
    private readonly f;
    private readonly ttlMs;
    private readonly softwareId?;
    private readonly softwareVersion?;
    private readonly discoveryMs;
    private readonly mintMs;
    private readonly mintBudgetMs;
    constructor(o: TokenClientOptions);
    /** RFC-017 D5: spread into every grant's body — `{}` when this client was not given an identity. */
    private identityFields;
    /**
     * RFC 8414 discovery for `apiUrl` (an ORIGIN — see apiOrigin), reused for metadataTtlMs;
     * a failure is not kept. `signal` bounds only THIS caller's wait — a shared request is
     * never cancelled by it. A 5xx (a deploy in progress) is an OAuthError by status
     * (transient); unusable metadata is a DiscoveryError (refused).
     */
    discover(apiUrl: string, signal?: AbortSignal): Promise<AuthMetadata>;
    /** RFC 8628 §3.1 — public, no DPoP (the proof key is bound at the token request, C8). */
    deviceAuthorization(m: AuthMetadata, installationName: string, o?: CallOpts): Promise<DeviceAuthorization>;
    /**
     * POST with a fresh DPoP proof (and, via `build`, a fresh assertion `jti`) per try.
     * The `Date` of EVERY answer (error or not) re-teaches the clock (E12). Retries, each
     * at most once: `use_dpop_nonce` (with the nonce), `invalid_dpop_proof` (clock
     * re-learnt), `invalid_client`/`assertion_invalid` (same). All tries share
     * MINT_BUDGET_MS, and the caller's `signal` (its whole locked section) caps that further.
     */
    private postDpop;
    private static enrolled;
    enrolWithKey(m: AuthMetadata, signer: Signer, p: {
        enrolmentKey: string;
        installationName: string;
    }, o?: CallOpts): Promise<EnrolGrant>;
    exchangeCode(m: AuthMetadata, signer: Signer, p: {
        code: string;
        verifier: string;
        redirectUri: string;
    }, o?: CallOpts): Promise<EnrolGrant>;
    pollDeviceCode(m: AuthMetadata, signer: Signer, deviceCode: string, o?: CallOpts): Promise<EnrolGrant>;
    /** RFC-016 §3.3. The caller holds the installation lock and has written `attempt` first (E5). */
    mint(m: AuthMetadata, signer: Signer, p: MintInput, o?: CallOpts): Promise<MintGrant>;
    /** RFC-016 §3.5: verified, NOT advanced. The caller holds the installation lock. C11: success is `{"ok":true}`. */
    revoke(m: AuthMetadata, signer: Signer, p: RevokeInput, o?: CallOpts): Promise<void>;
}
/** C6: the enrolment was refused because this key is already registered — retry once with a fresh key. */
export declare function isKeyAlreadyEnrolled(e: unknown): boolean;
