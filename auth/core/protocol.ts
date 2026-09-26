/**
 * The agent authorization server's client side (RFC-016 §3): discovery, the
 * enrolment grants, the `client_credentials` mint, the Bridge revoke — every
 * token-endpoint request carries a fresh DPoP proof by the installation key.
 * Pure HTTP (an injected `fetch`, default the global one, + WebCrypto): no files, no locks — the caller owns
 * those (auth/node/lock.ts: every mint / revoke / enrolment runs inside ONE
 * installation lock and passes its `signal` here), and that split is what lets this
 * move into `@bridge/agent-sdk`.
 *
 * Failure shape (what classifyTokenError switches on):
 *   - no HTTP answer (connection, DNS, TLS, a body cut off mid-read) ⇒ `TransportError`
 *     — `fetch` and the body read are the ONLY calls wrapped, so a bug elsewhere
 *     (a TypeError) stays a bug (`refused`), never "retry forever";
 *   - any HTTP error answer ⇒ `OAuthError`, even a proxy's HTML page: a non-JSON or
 *     malformed body becomes `http_<status>` (`rate_limited` for 429), so 5xx is
 *     transient BY STATUS and 4xx is refused — never an unclassified throw;
 *   - a 2xx whose body is not what the grant promises ⇒ `OAuthError invalid_response`.
 */
import { clientAssertion, CLIENT_ASSERTION_TYPE } from "./assertion";
import { apiOrigin, dpopProof } from "./dpop";
import { isJoinState } from "./join-state";
import { OAuthError, isOAuthError, TransportError, DiscoveryError, AbortedError } from "./token-errors";
import type { Clock } from "./clock";
import type { Signer } from "./signer";

export { OAuthError, isOAuthError, TransportError, DiscoveryError, AbortedError } from "./token-errors";

export const GRANT_ENROLMENT_KEY = "urn:bridge:params:oauth:grant-type:enrolment-key";
export const GRANT_DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
export const GRANT_CLIENT_CREDENTIALS = "client_credentials";

/** RFC-016 §5.2: the mint timeout (one HTTP request). */
export const MINT_TIMEOUT_MS = 30_000;
/**
 * Every retry of one logical request (nonce, proof, assertion) together. A caller
 * that makes SEVERAL requests under the installation lock passes the lock's `signal`
 * (one deadline for the whole critical section, auth/node/lock.ts HOLD_BUDGET_MS):
 * per-request budgets add up — discovery + enrol + the C6 retry was 10 + 90 + 90 s,
 * past the lock's 120 s stale break.
 */
export const MINT_BUDGET_MS = 90_000;
const DISCOVERY_TIMEOUT_MS = 10_000;
/** How long a TokenClient trusts discovered metadata (a deploy can move endpoints). */
export const METADATA_TTL_MS = 60 * 60_000;

/** A timeout's reason is a `TimeoutError`; anything else a caller's signal carries is the caller cancelling. */
function callerCancelled(signal: AbortSignal | undefined): boolean {
  return !!signal?.aborted && (signal.reason as { name?: unknown } | undefined)?.name !== "TimeoutError";
}

/** Reject when `signal` aborts, without cancelling `p` itself (it may be shared). */
function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  const why = () => (callerCancelled(signal) ? new AbortedError("cancelled by the caller", { cause: signal.reason }) : signal.reason);
  if (signal.aborted) return Promise.reject(why());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(why());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e) => (signal.removeEventListener("abort", onAbort), reject(e))
    );
  });
}

/**
 * The HTTP exchange, with ONLY the transport wrapped: `fetch` and reading the body. The
 * body is read as text (a cut-off body is a lost answer, not a malformed one) and parsed
 * separately — a non-JSON body is `json: null`, never a throw. A failure while the
 * CALLER's own signal is cancelled is `AbortedError` (never retried); any other is a
 * `TransportError` (transient), including our own timeouts.
 */
/** What the TokenClient needs of `fetch` (so a test double or another runtime's fetch fits). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function exchange(f: FetchLike, url: string, init: RequestInit, callerSignal?: AbortSignal): Promise<{ res: Response; json: unknown }> {
  let res: Response;
  let text: string;
  try {
    res = await f(url, init);
    text = await res.text();
  } catch (e) {
    if (callerCancelled(callerSignal)) throw new AbortedError("cancelled by the caller", { cause: callerSignal!.reason });
    throw new TransportError(`Bridge agent-auth ${new URL(url).pathname}: no answer (${(e as { message?: unknown })?.message ?? e})`, { cause: e });
  }
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { res, json };
}

/** RFC 9110 §10.2.3: delay-seconds or an HTTP-date. Undefined when absent or unparseable. */
function retryAfterS(ra: string | null, now = Date.now()): number | undefined {
  if (ra === null || ra.trim() === "") return undefined;
  if (/^\s*\d+(\.\d+)?\s*$/.test(ra)) return Number(ra);
  const t = Date.parse(ra);
  return Number.isFinite(t) ? Math.max(0, (t - now) / 1000) : undefined;
}

/** Any HTTP error answer → OAuthError. A body that is not an RFC 6749 §5.2 object is judged by status alone. */
function toOAuthError(res: Response, json: unknown): OAuthError {
  const o = json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const retry = retryAfterS(res.headers.get("retry-after"));
  return new OAuthError({
    error: typeof o.error === "string" && o.error !== "" ? o.error : res.status === 429 ? "rate_limited" : `http_${res.status}`,
    status: res.status,
    description: typeof o.error_description === "string" ? o.error_description : undefined,
    retryAfterS: retry,
    dpopNonce: res.headers.get("dpop-nonce") ?? undefined,
  });
}

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
export function assertSameAuthority(apiUrl: string, m: AuthMetadata): void {
  const origin = apiOrigin(apiUrl);
  if (m.issuer !== `${origin}/api/agent-auth`) {
    throw new DiscoveryError(`Bridge agent-auth discovery issuer ${JSON.stringify(m.issuer)} does not match ${origin} — refusing it`);
  }
  for (const k of ["token_endpoint", "revocation_endpoint", "authorization_endpoint", "device_authorization_endpoint"] as const) {
    const v = m[k];
    if (v === undefined) continue;
    let o: string;
    try {
      o = new URL(v).origin;
    } catch {
      throw new DiscoveryError(`Bridge agent-auth discovery ${k} is not a URL — refusing it`);
    }
    if (o !== origin) throw new DiscoveryError(`Bridge agent-auth discovery ${k} points at ${o}, not ${origin} — refusing it`);
  }
}

/** RFC-016 §3.6: a server that can mint for a key advertises `client_credentials`. */
export function supportsKeyCredentials(m: AuthMetadata): boolean {
  return Array.isArray(m.grant_types_supported) && m.grant_types_supported.includes(GRANT_CLIENT_CREDENTIALS);
}

/** What every enrolment grant returns (RFC-016 §3.2). */
export interface EnrolGrant {
  installation_id: string;
  join_state: string;
  agent?: { id: string; handle: string | null; name: string };
  workspace?: { id: string; name: string };
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
  /** This runtime's PUBLIC client id (RFC-016 §3.2 `AGENT_AUTH_CLIENTS`, e.g. `bridge-claude-plugin`) — used by the enrolment flows. */
  clientId: string;
  /** Injected transport (tests, proxies, other runtimes). Default: the global `fetch`. */
  fetch?: FetchLike;
  /** How long discovered metadata is reused (default METADATA_TTL_MS). */
  metadataTtlMs?: number;
}

export class TokenClient {
  /** Last `DPoP-Nonce` per authorization-server origin (RFC 9449 §8). */
  private readonly nonces = new Map<string, string>();
  /** Discovery, per API origin, for this client only — never a process-global forever cache. */
  private readonly metadata = new Map<string, { at: number; p: Promise<AuthMetadata> }>();
  private readonly clock: Clock;
  private readonly clientId: string;
  private readonly f: FetchLike;
  private readonly ttlMs: number;

  constructor(o: TokenClientOptions) {
    if (typeof o.clientId !== "string" || o.clientId === "") throw new Error("TokenClient needs the runtime's public clientId");
    this.clock = o.clock;
    this.clientId = o.clientId;
    this.f = o.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.ttlMs = o.metadataTtlMs ?? METADATA_TTL_MS;
  }

  /**
   * RFC 8414 discovery for `apiUrl` (an ORIGIN — see apiOrigin), reused for metadataTtlMs;
   * a failure is not kept. `signal` bounds only THIS caller's wait — a shared request is
   * never cancelled by it. A 5xx (a deploy in progress) is an OAuthError by status
   * (transient); unusable metadata is a DiscoveryError (refused).
   */
  discover(apiUrl: string, signal?: AbortSignal): Promise<AuthMetadata> {
    const origin = apiOrigin(apiUrl);
    const hit = this.metadata.get(origin);
    if (hit && Date.now() - hit.at < this.ttlMs) return abortable(hit.p, signal);
    const p = (async () => {
      const { res, json } = await exchange(this.f, `${origin}/.well-known/oauth-authorization-server/api/agent-auth`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (!res.ok) throw toOAuthError(res, json);
      const m = json as AuthMetadata | null;
      if (!m || typeof m.token_endpoint !== "string" || typeof m.issuer !== "string") {
        throw new DiscoveryError(`Bridge agent-auth discovery returned no token endpoint — is ${origin} a Bridge API?`);
      }
      assertSameAuthority(origin, m);
      return m;
    })();
    this.metadata.set(origin, { at: Date.now(), p });
    p.catch(() => {
      if (this.metadata.get(origin)?.p === p) this.metadata.delete(origin);
    });
    return abortable(p, signal);
  }

  /** RFC 8628 §3.1 — public, no DPoP (the proof key is bound at the token request, C8). */
  async deviceAuthorization(m: AuthMetadata, installationName: string, o: CallOpts = {}): Promise<DeviceAuthorization> {
    const { res, json } = await exchange(
      this.f,
      m.device_authorization_endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: this.clientId, installation_name: installationName }),
        signal: o.signal ? AbortSignal.any([AbortSignal.timeout(MINT_TIMEOUT_MS), o.signal]) : AbortSignal.timeout(MINT_TIMEOUT_MS),
      },
      o.signal
    );
    if (!res.ok) throw toOAuthError(res, json);
    const d = json as Partial<DeviceAuthorization> | null;
    if (typeof d?.device_code !== "string" || typeof d?.user_code !== "string" || typeof d?.verification_uri !== "string") {
      throw new OAuthError({ error: "invalid_response", status: res.status, description: "device authorization answered without device_code + user_code + verification_uri" });
    }
    return d as DeviceAuthorization;
  }

  /**
   * POST with a fresh DPoP proof (and, via `build`, a fresh assertion `jti`) per try.
   * The `Date` of EVERY answer (error or not) re-teaches the clock (E12). Retries, each
   * at most once: `use_dpop_nonce` (with the nonce), `invalid_dpop_proof` (clock
   * re-learnt), `invalid_client`/`assertion_invalid` (same). All tries share
   * MINT_BUDGET_MS, and the caller's `signal` (its whole locked section) caps that further.
   */
  private async postDpop(
    url: string,
    signer: Signer,
    build: () => Promise<Record<string, string>>,
    hasAssertion: boolean,
    signal?: AbortSignal
  ): Promise<unknown> {
    const origin = new URL(url).origin;
    const budget = signal ? AbortSignal.any([AbortSignal.timeout(MINT_BUDGET_MS), signal]) : AbortSignal.timeout(MINT_BUDGET_MS);
    let nonceRetried = false;
    let proofRetried = false;
    let assertionRetried = false;
    for (;;) {
      const body = await build();
      // C16: dpopProof signs the endpoint's normalised origin + path — never its query.
      const proof = await dpopProof(signer, this.clock, { htm: "POST", htu: url, nonce: this.nonces.get(origin) });
      const { res, json } = await exchange(
        this.f,
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", DPoP: proof },
          body: JSON.stringify(body),
          signal: AbortSignal.any([AbortSignal.timeout(MINT_TIMEOUT_MS), budget]),
        },
        signal
      );
      this.clock.observe(res.headers.get("date"));
      const nonce = res.headers.get("dpop-nonce");
      if (nonce) this.nonces.set(origin, nonce);
      if (res.ok) return json;
      const err = toOAuthError(res, json);
      if (err.error === "use_dpop_nonce" && nonce && !nonceRetried) {
        nonceRetried = true;
        continue;
      }
      // C6: `key_already_enrolled` is NOT a proof problem — the same key can never pass;
      // the caller retries with a FRESH key (isKeyAlreadyEnrolled). `dpop_proof_required:`
      // means the server thinks we sent none: a retry would only loop.
      if (
        err.error === "invalid_dpop_proof" &&
        err.description !== "key_already_enrolled" &&
        !err.description?.startsWith("dpop_proof_required:") &&
        !proofRetried
      ) {
        proofRetried = true;
        continue;
      }
      if (hasAssertion && err.error === "invalid_client" && err.description === "assertion_invalid" && !assertionRetried) {
        assertionRetried = true;
        continue;
      }
      throw err;
    }
  }

  private static enrolled(json: unknown): EnrolGrant {
    const j = json as Partial<EnrolGrant> | null;
    if (typeof j?.installation_id !== "string" || !isJoinState(j?.join_state)) {
      throw new OAuthError({ error: "invalid_response", status: 200, description: "enrolment answered without installation_id + join_state" });
    }
    return j as EnrolGrant;
  }

  async enrolWithKey(m: AuthMetadata, signer: Signer, p: { enrolmentKey: string; installationName: string }, o: CallOpts = {}): Promise<EnrolGrant> {
    return TokenClient.enrolled(
      await this.postDpop(
        m.token_endpoint,
        signer,
        async () => ({
          grant_type: GRANT_ENROLMENT_KEY,
          enrolment_key: p.enrolmentKey,
          installation_name: p.installationName,
          key_storage: signer.keyStorage,
        }),
        false,
        o.signal
      )
    );
  }

  async exchangeCode(m: AuthMetadata, signer: Signer, p: { code: string; verifier: string; redirectUri: string }, o: CallOpts = {}): Promise<EnrolGrant> {
    return TokenClient.enrolled(
      await this.postDpop(
        m.token_endpoint,
        signer,
        async () => ({
          grant_type: "authorization_code",
          code: p.code,
          code_verifier: p.verifier,
          redirect_uri: p.redirectUri,
          client_id: this.clientId,
          key_storage: signer.keyStorage,
        }),
        false,
        o.signal
      )
    );
  }

  async pollDeviceCode(m: AuthMetadata, signer: Signer, deviceCode: string, o: CallOpts = {}): Promise<EnrolGrant> {
    return TokenClient.enrolled(
      await this.postDpop(
        m.token_endpoint,
        signer,
        async () => ({ grant_type: GRANT_DEVICE_CODE, device_code: deviceCode, client_id: this.clientId, key_storage: signer.keyStorage }),
        false,
        o.signal
      )
    );
  }

  /** RFC-016 §3.3. The caller holds the installation lock and has written `attempt` first (E5). */
  async mint(m: AuthMetadata, signer: Signer, p: MintInput, o: CallOpts = {}): Promise<MintGrant> {
    const json = (await this.postDpop(
      m.token_endpoint,
      signer,
      async () => ({
        grant_type: GRANT_CLIENT_CREDENTIALS,
        client_id: p.installationId,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: await clientAssertion(signer, this.clock, p.installationId, m.issuer),
        join_state: p.joinState,
        attempt: p.attempt,
        session_key: p.sessionKey,
        ...(p.reconnect ? { reconnect: "true" } : {}),
        ...(p.platform ? { platform: p.platform } : {}),
        ...(p.clientVersion ? { client_version: p.clientVersion } : {}),
      }),
      true,
      o.signal
    )) as Partial<MintGrant> | null;
    if (json?.token_type !== "DPoP" || typeof json?.access_token !== "string" || !isJoinState(json?.join_state) || typeof json?.session_id !== "string") {
      throw new OAuthError({ error: "invalid_response", status: 200, description: "mint answered without a DPoP token + join_state + session_id" });
    }
    return json as MintGrant;
  }

  /** RFC-016 §3.5: verified, NOT advanced. The caller holds the installation lock. C11: success is `{"ok":true}`. */
  async revoke(m: AuthMetadata, signer: Signer, p: RevokeInput, o: CallOpts = {}): Promise<void> {
    const json = (await this.postDpop(
      m.revocation_endpoint,
      signer,
      async () => ({
        client_id: p.installationId,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: await clientAssertion(signer, this.clock, p.installationId, m.issuer),
        join_state: p.joinState,
        ...(p.attempt ? { attempt: p.attempt } : {}),
        scope: p.scope,
        ...(p.sessionKey ? { session_key: p.sessionKey } : {}),
      }),
      true,
      o.signal
    )) as { ok?: unknown } | null;
    if (json?.ok !== true) throw new OAuthError({ error: "invalid_response", status: 200, description: 'revoke answered without {"ok":true}' });
  }
}

/** C6: the enrolment was refused because this key is already registered — retry once with a fresh key. */
export function isKeyAlreadyEnrolled(e: unknown): boolean {
  return isOAuthError(e) && e.error === "invalid_dpop_proof" && e.description === "key_already_enrolled";
}
