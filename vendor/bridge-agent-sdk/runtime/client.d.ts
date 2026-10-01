/**
 * `AgentClient` — the plugin's `CredentialManager` (`auth/manager.ts`), minus
 * every Claude-ism: no `notify`/`prompt`/browser loopback, no profile files, no
 * prose (`../runtime/errors.ts`'s `AgentClientError` carries a stable `code`
 * instead). What is kept, faithfully: mint under the store's lock (E5's
 * write-ahead attempt), the refresh ticker with its jitter, single-flight
 * renewal, `invalidateAccess`, `sessionRevoked`/`installationRevoked`, and the
 * enrolment grants (key / authorization code / device).
 */
import { type EnrolGrant, type DeviceAuthorization, type Signer } from "../core";
import type { Runtime } from "./ports";
import type { CredentialStore } from "./store";
import { AgentClientError } from "./errors";
import { Session, type SessionOptions } from "./session";
import { type Api } from "./api";
export interface AgentClientOptions {
    apiUrl: string;
    store: CredentialStore;
    /** Override the signer reconstructed from the store's `privateJwk` — a hardware-backed
     * key, for instance. When given, the store's `privateJwk` is never read for signing
     * (only `jkt` is cross-checked, same as the software path). */
    signer?: Signer;
    /** RFC 7591 `software_id` — also this build's RFC-017 `software_id` (D4). */
    softwareId: string;
    softwareVersion: string;
    sessionKey: string;
    /** Test-only-friendly deadline overrides (`../core/protocol.ts`'s `TokenClientOptions.timeouts`). */
    timeouts?: {
        discoveryMs?: number;
        mintMs?: number;
        mintBudgetMs?: number;
    };
}
export declare class AgentClient {
    private readonly rt;
    private readonly opts;
    readonly api: Api;
    private access;
    private inflight;
    private ticker;
    /** The "late" branch's own one-shot delayed retry (minor finding 10) — tracked
     * separately from `ticker` (the `setInterval`) so `stop()` can clear it too; without
     * this, a `setTimeout` armed just before `stop()` still fires `go()` (a mint) after
     * the caller believed the ticker was fully stopped. */
    private lateRefreshTimer;
    /** RFC-016 E9: a revoked session mints again only after an explicit `requestSessionReconnect()`. */
    private sessionBlocked;
    private reconnectNext;
    /** §3.3 429: no mint before this instant. */
    private mintNotBefore;
    private resourceNonce;
    /** A stop-class refusal (§3.3 P5) — nothing mints while it stands; cleared by `requestSessionReconnect()`
     * or a fresh enrolment/logout, mirroring the plugin's `stopped` gate. */
    private stopped;
    private rotateOnNextMint;
    private lastSessionId;
    private readonly rotationListeners;
    private readonly clock;
    private readonly tokens;
    private constructor();
    /** Validates `apiUrl` eagerly (the same check `httpHtu`/`wsHtu` would throw on later) —
     * async for symmetry with a future store/signer probe, and because every other
     * SDK-facing entry point in this package is. */
    static open(rt: Runtime, opts: AgentClientOptions): Promise<AgentClient>;
    apiUrl(): string;
    softwareId(): string;
    softwareVersion(): string;
    sessionKey(): string;
    private lockOpts;
    source(): Promise<"installation" | "none">;
    private current;
    accessToken(): Promise<string>;
    /** `Authorization: DPoP …` + a fresh proof for ONE HTTP request (§3.4, C16). */
    httpAuth(method: string, path: string): Promise<{
        token: string;
        headers: {
            Authorization: string;
            DPoP: string;
        };
    }>;
    /** RFC 9449 §9: a 401 `use_dpop_nonce` challenge — the next proof carries it. */
    noteResourceNonce(nonce: string | null): void;
    /** A resource answer's `Date` (E12): proofs are judged by the server's clock. */
    observeServerDate(date: string | null): void;
    /** The `auth` frame's credential: token + a proof for `GET <apiUrl origin>/ws` (E11). */
    wsAuth(): Promise<{
        token: string;
        dpop: string;
    }>;
    private wsProof;
    /** Forget the in-memory access token (a 401, a 4001 or a 4009). Given the token that
     * failed, only that one is dropped — see the plugin's identical guard. */
    invalidateAccess(tokenUsed?: string): void;
    grant(): {
        installationId: string;
        sessionId: string;
    } | null;
    /** A fresh access token replaced the one a live `Session` authenticated with — it must
     * carry it in-band (`reauth`). Returns an unsubscribe. */
    onAccessRotated(cb: (frame: {
        token: string;
        dpop: string;
    }) => void): () => void;
    /** E9: after a session revoke, only an explicit reconnect mints again. Also clears a stop. */
    requestSessionReconnect(): void;
    refreshStop(): AgentClientError | null;
    /** Mint now. Single-flight across callers. */
    private renew;
    private renewUnderLock;
    private mintLocked;
    /** The critical section of a mint. Reads the store HERE, under the lock — never earlier. */
    private mintInside;
    /** §3.3's error table → an `AgentClientError`, reusing `classifyTokenError`'s vocabulary
     * (`../runtime/errors.ts`'s comment on why `code` never invents a second table). */
    private mintRefused;
    private toClientError;
    private toAccess;
    /** One wall-clock check every tick — a process that slept past the refresh point wakes
     * with a stale timer, but `rt.clock.now()` is right (real time) or advances explicitly
     * (a fake clock in a test), same argument as the plugin's `armTicker`. */
    private armTicker;
    /** 4008 "session revoked": this session is over until an explicit reconnect (E9). */
    sessionRevoked(sessionId: string | null): void;
    /** 4008 "installation revoked"/"installation locked" for the installation a socket
     * authenticated with. `"switched"` when the store now holds a DIFFERENT installation
     * (a re-enrolment elsewhere superseded the old one) — nothing is deleted then. */
    installationRevoked(revokedId: string | null): Promise<"switched" | "deleted" | "absent">;
    /** RFC-016 §3.2 key-credential enrolment (an enrolment key exchanged once). C6: the same
     * key can never pass twice — one fresh-key retry. */
    enrolWithKey(enrolmentKey: string, installationName: string): Promise<EnrolGrant>;
    /** RFC-016 §3.2 authorization-code enrolment (a browser/PKCE flow) — the loopback
     * listener and the browser launch are the CALLER's (Claude-ism / OpenClaw-ism); this
     * only exchanges the code the caller already collected. */
    enrolWithAuthorizationCode(p: {
        code: string;
        verifier: string;
        redirectUri: string;
    }, installationName: string): Promise<EnrolGrant>;
    /** RFC 8628 device-code enrolment. Returns the code to show the person and a `complete()`
     * that polls to approval (or expiry/cancel) and, on success, writes the store — the SDK
     * equivalent of the plugin's `startDevice`, minus the terminal prompt. */
    deviceAuthorization(installationName: string): Promise<{
        auth: DeviceAuthorization;
        complete: (opts?: {
            signal?: AbortSignal;
        }) => Promise<EnrolGrant>;
    }>;
    private discoverOrRefuse;
    /**
     * M3, mirroring the plugin's `completeLogin` choreography (`auth/manager.ts`): under
     * the SAME installation lock as the write — re-check-then-write, never earlier — read
     * whatever installation is CURRENTLY on this store (there may be none), write the new
     * one (`fileStore.write()` itself refuses over a newer-format installation and clears
     * the OLD installation.json first, so a crash never mixes an old install record with a
     * new key — see node/store.ts), and only AFTER that succeeds revoke the previous
     * installation server-side (best-effort — a failed revoke never undoes a successful
     * enrolment). A write that throws (disk full, EACCES) means NEITHER installation is
     * usable from this store: abandon the brand-new one server-side too (it is live in
     * Bridge but has no home on disk) before propagating the error — the plugin's
     * `abandonEnrolment`. Also closes minor finding 9: two concurrent enrolments against
     * ONE store both funnel their disk write through this SAME lock, so whichever writes
     * second reads the first's fresh installation as `old` and revokes IT — neither is
     * ever silently orphaned (live server-side, unreachable on disk).
     */
    private writeEnrolment;
    /** `abandonEnrolment`: a grant that never made it to disk — revoke it server-side so it
     * is not left live in Bridge with no local key to use it from. Best-effort; the caller
     * swallows. */
    private revokeGrant;
    /** Revoke a PREVIOUS installation this store held — discovers against ITS OWN `apiUrl`
     * (it may differ from `this.opts.apiUrl`, the same as the plugin's `revokeStored`).
     * Always a fresh `softwareSigner` from `record.privateJwk`: every installation THIS SDK
     * enrols is a software key (`generateSoftwareKey()`), so `this.opts.signer` (an override
     * for the CURRENT installation only) is never the right key for a DIFFERENT, previous
     * one. Best-effort; the caller swallows. */
    private revokeRecord;
    /** Sign this store out. The revoke (§3.5, verified not advanced) is best-effort — the
     * store is cleared either way, matching the plugin's "logout always works locally". */
    logout(opts?: {
        revoke?: boolean;
    }): Promise<void>;
    /** One `Session` (one WebSocket) authenticated as this client. */
    session(opts?: SessionOptions): Session;
    /** Stop the refresh ticker — call once before dropping this client. */
    stop(): void;
}
