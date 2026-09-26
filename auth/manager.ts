/**
 * The credential manager (RFC-016 §5): turns a profile's key + join state into a
 * DPoP-bound access token for this Claude session, keeps it fresh, and runs login /
 * logout / headless enrolment.
 *
 * ⚠️ EVERY MINT, REVOKE AND ENROLMENT RUNS INSIDE ONE `withInstallationLock` CALL, and
 * reads `installation.json` / `key.json` / `state` / `attempt` FROM DISK INSIDE IT —
 * never a copy read before the lock, never memory. `attempt` is created BEFORE the
 * request and deleted only AFTER the new state is durable (E5, store.ts header). Every
 * session on the machine mints from the same chain: presenting a state a sibling already
 * advanced, without its attempt, is exactly how the server recognises a COPIED
 * credential — and it locks the installation for good (E6d). Only the 1 h access token
 * (and the signer that proves it) lives in memory.
 *
 * Every network call inside a locked section is bounded by the lease's ONE `signal`
 * (LOCK_HOLD_BUDGET_MS from acquisition, < the lock's 120 s stale break), passed to
 * `discover` and to every TokenClient call — per-call budgets would add up past it.
 */
import { hostname } from "os";
import { withInstallationLock, sweepLockTombstones, HOLD_BUDGET_MS } from "./node/lock";
import * as store from "./node/store";
import {
  TokenClient,
  Clock,
  classifyTokenError,
  assertNever,
  isOAuthError,
  isKeyAlreadyEnrolled,
  supportsKeyCredentials,
  dpopProof,
  httpHtu,
  wsHtu,
  generateSoftwareKey,
  softwareSigner,
  type AuthMetadata,
  type EnrolGrant,
  type Signer,
  type EcPrivateJwk,
  type InstallationGoneReason,
} from "./core";
import { PLUGIN_CLIENT_ID } from "./client-id";
import { startLoopback, type LoopbackLogin } from "./loopback";
import { pollDevice } from "./device";
import { isHeadless, browserDisabled, openBrowser } from "./browser";
import { profileLabel, type Profile } from "./profile";

export type CredentialSource = "installation" | "none";

/** Shown when there is no credential but BRIDGE_TOKEN is still set. Presence check only. */
const STALE_TOKEN_HINT = "BRIDGE_TOKEN is no longer supported — run /bridge:login";

/** A pre-RFC-016 server: it cannot mint for a key, and a 0.25 plugin cannot use its grants. */
const SERVER_TOO_OLD =
  "this Bridge server does not support key credentials yet (no client_credentials grant, RFC-016) — it must be upgraded before plugin 0.25 can sign in";

const UPDATE_REQUIRED =
  "Bridge refused this plugin's sign-in protocol — the plugin and the Bridge server disagree on it; update the plugin (/plugin update bridge), then run /bridge:login";

const SESSION_REVOKED = "this session was revoked in Bridge — /bridge:connect starts a new one";

/**
 * Why no access token can be produced — the text is shown to the model as-is.
 * - not_logged_in / profile / api_url / logged_out: needs a login (possibly in another
 *   session — server.ts watches for the files to appear).
 * - session_revoked / session_limit: this SESSION stops; /bridge:connect retries.
 * - refused: the server said no for a reason retrying will not fix; files kept.
 * - network: retry later (the attempt, if any, stays on disk for the replay).
 */
export class CredentialError extends Error {
  constructor(
    readonly kind: "not_logged_in" | "profile" | "api_url" | "logged_out" | "session_revoked" | "session_limit" | "refused" | "network",
    message: string
  ) {
    super(message);
  }
}

export interface ManagerDeps {
  profile: Profile | { error: string };
  /** BRIDGE_API_URL from the environment / .env, trailing slashes stripped ("" = unset). */
  envApiUrl: string;
  /** Whether BRIDGE_TOKEN is set. Only a presence check — the value is never read or sent. */
  staleStaticTokenPresent: boolean;
  enrolmentKey: string;
  sessionKey: () => string;
  /** Resolves once sessionKey() is final — a session keyed by a provisional key would be orphaned. */
  sessionKeyReady: () => Promise<unknown>;
  platform: string;
  clientVersion: string;
  env: Record<string, string | undefined>;
  /** A fresh access token replaced the one the live socket authenticated with: send `reauth` with this proof. */
  onAccessRotated: (frame: { token: string; dpop: string }) => void;
  /** This process now holds a new installation (login): reconnect on it. */
  onLoggedIn: () => void;
  onLoggedOut: () => void;
  notify: (text: string) => void;
  log: (text: string) => void;
  /**
   * Talk to the PERSON, not the model (MCP elicitation). The model can call `login`,
   * so anything a prompt injection could exfiltrate or approve — the device code,
   * the "bind this machine to that agent" decision — goes through here.
   */
  prompt: {
    available: () => boolean;
    show: (message: string) => void;
    confirm: (message: string) => Promise<boolean>;
  };
  /** Injected for tests. */
  random?: () => number;
  /** Injected for tests: the locked-section deadline (default LOCK_HOLD_BUDGET_MS; must stay < STALE_MS). */
  lockBudgetMs?: number;
  now?: () => number;
  tickMs?: number;
}

interface Access {
  token: string;
  expiresAt: number;
  refreshAt: number;
  sessionId: string;
  installationId: string;
  apiUrl: string;
  /** The key this token is bound to (E3): every use is proven by it. */
  signer: Signer;
}

const EXPIRY_SLACK_MS = 60_000;

/**
 * ONE deadline for every network call made while holding the installation lock
 * (discovery + mint; discovery + revoke; discovery + enrol + the C6 retry): the lock's
 * own hold budget, handed to the holder as its lease `signal`. 30 s below STALE_MS.
 */
export const LOCK_HOLD_BUDGET_MS = HOLD_BUDGET_MS;

type NewKey = { privateJwk: EcPrivateJwk; signer: Signer };

export class CredentialManager {
  private access: Access | null = null;
  private inflight: Promise<Access> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private pendingLogin: { cancel: () => void } | null = null;
  /** E9: this session was revoked; only an explicit /bridge:connect mints again (with reconnect=true). */
  private sessionBlocked = false;
  private reconnectNext = false;
  /** §3.3 429: no mint before this instant (the attempt stays on disk for the retry). */
  private mintNotBefore = 0;
  /** RFC 9449 §9: the resource server's last `DPoP-Nonce`. */
  private resourceNonce: string | undefined;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly clock: Clock;
  private readonly tokens: TokenClient;

  constructor(private readonly d: ManagerDeps) {
    this.now = d.now ?? Date.now;
    this.random = d.random ?? Math.random;
    this.clock = new Clock(this.now);
    this.tokens = new TokenClient({ clock: this.clock, clientId: PLUGIN_CLIENT_ID });
    this.openProfile();
  }

  private get profile(): Profile | null {
    return "error" in this.d.profile ? null : this.d.profile;
  }

  /**
   * Once per process: remove what a crash left behind — temp files (they can hold the
   * PRIVATE KEY; only old ones: a sibling may be mid-write) and release tombstones of the
   * installation lock (only those past the stale break). Never fatal.
   */
  private openProfile(): void {
    const p = this.profile;
    if (!p) return;
    try {
      const n = store.sweepOrphanTemps(p.dir) + sweepLockTombstones(p.dir);
      if (n > 0) this.d.log(`bridge auth: removed ${n} leftover file(s) from an earlier crash in ${p.dir}`);
    } catch (e) {
      this.d.log(`bridge auth: could not sweep ${p.dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private lockOpts() {
    return { holdMs: this.d.lockBudgetMs ?? LOCK_HOLD_BUDGET_MS, log: this.d.log };
  }

  private installation(): store.Installation | null {
    const p = this.profile;
    return p ? store.readInstallation(p.dir) : null;
  }

  /** Where credentials come from right now. */
  source(): CredentialSource {
    if (!this.profile) return "none";
    return this.installation() ? "installation" : "none";
  }

  /** The API this process talks to: the environment's, else the profile's own (or its retired 0.23/0.24 one). */
  apiUrl(): string {
    const p = this.profile;
    return this.d.envApiUrl || this.installation()?.apiUrl || (p ? store.readUpgradeMarker(p.dir)?.apiUrl : "") || "";
  }

  /** A configuration problem that no amount of retrying fixes, or null. */
  configError(): string | null {
    if ("error" in this.d.profile) return this.d.profile.error;
    const p = this.profile!;
    const inst = this.installation();
    if (inst && this.d.envApiUrl && inst.apiUrl !== this.d.envApiUrl) {
      return `profile "${profileLabel(p)}" is signed in to ${inst.apiUrl}, but BRIDGE_API_URL is ${this.d.envApiUrl} — its key is never used anywhere else. Run /bridge:login to sign in to ${this.d.envApiUrl}.`;
    }
    // Login needs the API URL, so that hint comes first.
    if (!this.apiUrl()) return "BRIDGE_API_URL is not set — run /bridge:configure, then /bridge:login";
    if (this.source() === "none") {
      // The marker (after retirement) — or the RFC-014 files themselves, in the moment
      // before startup retires them.
      if (store.readUpgradeMarker(p.dir) || store.hasLegacyCredentials(p.dir)) {
        return `${p.name ? `profile "${p.name}": ` : ""}Bridge plugin 0.25 signs in with a per-machine key (RFC-016); the sign-in from plugin 0.24 or earlier (RFC-014) cannot be carried over — run /bridge:login`;
      }
      if (this.d.staleStaticTokenPresent) return STALE_TOKEN_HINT;
      return p.name ? `profile "${p.name}" is not signed in — run /bridge:login` : "this machine is not signed in to Bridge — run /bridge:login";
    }
    return null;
  }

  /** The live access token, minting when there is none (or it is about to expire). */
  private async current(): Promise<Access> {
    const err = this.configError();
    if (err) throw new CredentialError(this.source() === "none" ? "not_logged_in" : "profile", err);
    const a = this.access;
    if (a && this.now() < a.expiresAt - EXPIRY_SLACK_MS) return a;
    return this.renew("expiring");
  }

  /** The current access token (minting if needed) — for status and tests; requests use httpAuth / wsAuth. */
  async accessToken(): Promise<string> {
    return (await this.current()).token;
  }

  /**
   * `Authorization: DPoP …` + a fresh proof for ONE HTTP request (§3.4, C16): `htm` the
   * method, `htu` the API origin + `path` (no query), `ath` the token's hash, and the
   * resource server's last nonce if it asked for one.
   */
  async httpAuth(method: string, path: string): Promise<{ token: string; headers: { Authorization: string; DPoP: string } }> {
    const a = await this.current();
    const proof = await dpopProof(a.signer, this.clock, { htm: method, htu: httpHtu(a.apiUrl, path), accessToken: a.token, nonce: this.resourceNonce });
    return { token: a.token, headers: { Authorization: `DPoP ${a.token}`, DPoP: proof } };
  }

  /** RFC 9449 §9: a 401 `use_dpop_nonce` from the API — the next proof carries it. */
  noteResourceNonce(nonce: string | null): void {
    if (nonce) this.resourceNonce = nonce;
  }

  /** A resource answer's `Date` (E12): proofs are judged by the server's clock. */
  observeServerDate(date: string | null): void {
    this.clock.observe(date);
  }

  /** The `auth` frame's credential (E11): token + a proof for GET <apiUrl origin>/ws. */
  async wsAuth(): Promise<{ token: string; dpop: string }> {
    const a = await this.current();
    return { token: a.token, dpop: await this.wsProof(a) };
  }

  private wsProof(a: Access): Promise<string> {
    // C15: never a nonce on WS.
    return dpopProof(a.signer, this.clock, { htm: "GET", htu: wsHtu(a.apiUrl), accessToken: a.token });
  }

  /**
   * Forget the in-memory access token (a 401, a 4001 or a 4009): the next use mints.
   * Given the token that failed, only that one is dropped — a 401 for a request sent
   * just before a concurrent mint must not throw the NEW token away.
   */
  invalidateAccess(tokenUsed?: string): void {
    if (tokenUsed !== undefined && this.access?.token !== tokenUsed) return;
    this.access = null;
  }

  /** The grant the current access token belongs to (recorded per socket at auth). */
  grant(): { installationId: string; sessionId: string } | null {
    return this.access ? { installationId: this.access.installationId, sessionId: this.access.sessionId } : null;
  }

  /**
   * E9 client contract: after a session revoke, only an EXPLICIT user reconnect mints
   * again, and it says so (`reconnect=true`). Called by the `connect` tool. One-shot.
   */
  requestSessionReconnect(): void {
    if (this.sessionBlocked) this.reconnectNext = true;
  }

  /** Mint now. Single-flight across callers in this process. */
  renew(reason: string): Promise<Access> {
    if (!this.inflight) {
      const hadAccess = this.access !== null;
      this.inflight = this.renewUnderLock(reason)
        .then(async (a) => {
          this.access = a;
          this.armTicker();
          if (hadAccess) {
            try {
              this.d.onAccessRotated({ token: a.token, dpop: await this.wsProof(a) });
            } catch (e) {
              this.d.log(`bridge auth: could not hand the socket the new token: ${e}`);
            }
          }
          return a;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  private async renewUnderLock(reason: string): Promise<Access> {
    try {
      return await this.mintLocked(reason);
    } catch (e) {
      // Everything that is not a known terminal state is retryable: discovery 5xx
      // during a deploy, the lock wait cap, a timeout, a failed state write.
      throw this.networkError(e);
    }
  }

  private async mintLocked(reason: string): Promise<Access> {
    const profile = this.profile!;
    await this.d.sessionKeyReady();
    if (this.sessionBlocked && !this.reconnectNext) throw new CredentialError("session_revoked", SESSION_REVOKED);
    const waitS = Math.ceil((this.mintNotBefore - this.now()) / 1000);
    if (waitS > 0) throw new CredentialError("network", `Bridge sign-in is rate-limited — retrying in ${waitS}s`);
    return withInstallationLock(profile.dir, ({ signal }) => this.mintInside(profile.dir, reason, signal), this.lockOpts());
  }

  /** The critical section of a mint. The caller holds the installation lock; `signal` is its lease. */
  private async mintInside(dir: string, reason: string, signal: AbortSignal): Promise<Access> {
    // ⚠️ From disk, HERE — under the lock. Never earlier, never from memory.
    const inst = store.readInstallation(dir);
    if (!inst) throw new CredentialError("logged_out", "signed out of Bridge — run /bridge:login");
    const jwk = store.readKey(dir);
    const state = store.readState(dir);
    if (!jwk || !state) {
      throw new CredentialError("refused", "this machine's Bridge sign-in is incomplete (key.json or state is missing or damaged) — run /bridge:login");
    }
    const meta = await this.tokens.discover(inst.apiUrl, signal);
    if (!supportsKeyCredentials(meta)) throw new CredentialError("refused", SERVER_TOO_OLD);
    const signer = await softwareSigner(jwk);
    if (signer.jkt !== inst.jkt) {
      throw new CredentialError("refused", "this machine's Bridge sign-in is incomplete (key.json does not match installation.json) — run /bridge:login");
    }
    // E5: the write-ahead attempt exists — durably — BEFORE the request leaves this machine.
    let attempt: string;
    try {
      attempt = await store.createOrReadAttempt(dir);
    } catch (e) {
      if (e instanceof store.AttemptUnreadableError) throw new CredentialError("refused", e.message);
      throw e;
    }
    const reconnect = this.reconnectNext;
    let g;
    try {
      g = await this.tokens.mint(
        meta,
        signer,
        {
          installationId: inst.installationId,
          joinState: state,
          attempt,
          sessionKey: this.d.sessionKey(),
          reconnect,
          platform: this.d.platform,
          clientVersion: this.d.clientVersion,
        },
        { signal }
      );
    } catch (e) {
      // ⚠️ `attempt` STAYS on disk for every failure. The server may have advanced the
      // chain before the answer was lost; the retry must present state + THIS attempt to
      // be answered as a replay (E6b) instead of a copy (E6d).
      throw this.mintRefused(e, dir);
    }
    // §3.3 / E5 order: the new state durably first, THEN drop the attempt. A throw in
    // between (full disk) leaves the attempt, and the next mint replays.
    store.writeStateIfNotOlder(dir, g.join_state);
    store.deleteAttempt(dir);
    this.sessionBlocked = false;
    this.reconnectNext = false;
    this.d.log(`bridge auth: minted for session ${g.session_id} (${reason}${reconnect ? ", reconnect" : ""})`);
    return this.toAccess(g.access_token, g.expires_in, g.session_id, inst, signer);
  }

  /** §3.3 error table → a CredentialError (and, for a dead installation, its files gone). Runs under the lock. */
  private mintRefused(e: unknown, dir: string): Error {
    const a = classifyTokenError(e);
    const detail = isOAuthError(e) ? `${e.error}${e.description ? `/${e.description}` : ""}` : e instanceof Error ? e.message : String(e);
    switch (a.kind) {
      case "installation_gone":
        // Terminal (§3.3, §5.4, C12): the key can never be used again — delete it.
        store.deleteInstallationFiles(dir);
        return new CredentialError("logged_out", goneMessage(a.reason));
      case "clock":
        // C13: stop, KEEP the files — a clock problem is not a key problem.
        return new CredentialError(
          "refused",
          "Bridge refused this machine's signature (assertion_invalid) even after correcting for clock skew — check the system clock, then /bridge:connect"
        );
      case "session_revoked":
        this.sessionBlocked = true;
        this.reconnectNext = false;
        return new CredentialError("session_revoked", SESSION_REVOKED);
      case "session_limit":
        return new CredentialError("session_limit", "this agent has too many live sessions in Bridge (session_limit) — close one, then /bridge:connect");
      case "corrupt_state":
        return new CredentialError("refused", "this machine's Bridge state file is damaged (corrupt_state) — run /bridge:login to re-enrol");
      case "update_required":
        return new CredentialError("refused", `${UPDATE_REQUIRED} (${detail})`);
      case "rate_limited":
        this.mintNotBefore = this.now() + a.retryAfterS * 1000;
        return new CredentialError("network", `Bridge sign-in is rate-limited — retrying in ${a.retryAfterS}s`);
      case "refused":
        // C4 attempt_invalid and every description the table does not name: stop, keep files.
        return new CredentialError("refused", `Bridge refused this machine's sign-in (${detail})`);
      case "new_proof":
      case "transient":
        return this.networkError(e);
      case "aborted":
        return new CredentialError("network", `Bridge sign-in was cancelled (${detail})`);
      case "pending":
      case "slow_down":
        // Device-flow answers — never a mint's. Treat as an unlisted refusal.
        return new CredentialError("refused", `Bridge answered the mint unexpectedly (${detail})`);
      default:
        return assertNever(a);
    }
  }

  private networkError(e: unknown): Error {
    if (e instanceof CredentialError) return e;
    if (isOAuthError(e)) return new CredentialError("network", `Bridge sign-in failed: ${e.error} (${e.status})`);
    return new CredentialError("network", `Bridge sign-in unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }

  private toAccess(tok: string, expiresInS: number, sessionId: string, inst: store.Installation, signer: Signer): Access {
    const now = this.now();
    const lifeMs = Math.max(1, expiresInS) * 1000;
    // Mint ahead (§5.3 "~10 min before expiry"): 10 min for a 1 h token (a sixth of any
    // shorter one), minus a per-process random share so a machine's sessions do not all
    // queue on the installation lock together.
    const marginMs = Math.min(600_000, lifeMs / 6);
    const jitterMs = this.random() * Math.min(120_000, marginMs / 2);
    return {
      token: tok,
      expiresAt: now + lifeMs,
      refreshAt: now + lifeMs - marginMs - jitterMs,
      sessionId,
      installationId: inst.installationId,
      apiUrl: inst.apiUrl,
      signer,
    };
  }

  /**
   * One wall-clock check every tick, not a timer per token: a laptop that sleeps
   * past the refresh point wakes with a stale setTimeout, but Date.now() is right.
   * After a long sleep every session on the machine is due at once — a random
   * delay spreads them.
   */
  private armTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      const a = this.access;
      if (!a || this.inflight) return;
      const now = this.now();
      if (now < a.refreshAt) return;
      const late = now - a.refreshAt > 60_000;
      const go = () => this.renew("scheduled").catch((e) => this.d.log(`bridge auth: scheduled mint failed: ${e.message}`));
      if (late) setTimeout(go, this.random() * 30_000).unref?.();
      else void go();
    }, this.d.tickMs ?? 15_000);
    this.ticker.unref?.();
  }

  /** 4008 "session revoked": this session is over until an explicit /bridge:connect (E9). */
  sessionRevoked(sessionId: string | null): void {
    if (sessionId === null || this.access?.sessionId === sessionId) this.access = null;
    this.sessionBlocked = true;
    this.reconnectNext = false;
  }

  /**
   * 4008 "installation revoked" / "installation locked" for the installation the socket
   * authenticated with. If the profile now holds a DIFFERENT installation (re-login
   * elsewhere revokes the old one), switch to it quietly. Unknown which one the socket
   * used: try again — a dead installation is refused at the next mint.
   */
  async installationRevoked(revokedId: string | null): Promise<"switched" | "logged_out"> {
    if (revokedId === null || this.access?.installationId === revokedId) this.access = null;
    const p = this.profile;
    if (!p) return "logged_out";
    return withInstallationLock(
      p.dir,
      async () => {
        const inst = store.readInstallation(p.dir);
        if (!inst) return "logged_out" as const;
        if (inst.installationId !== revokedId) return "switched" as const; // includes "unknown" (null)
        store.deleteInstallationFiles(p.dir);
        return "logged_out" as const;
      },
      this.lockOpts()
    );
  }

  /**
   * RFC-014 (0.23 / 0.24) → 0.25: a profile still holding RFC-014 files (credentials.json,
   * sessions/*.json with a refresh token) cannot be carried over. Delete them and leave the
   * marker configError() turns into "run /bridge:login". True when something was retired.
   * store.retireLegacy touches ONLY RFC-014 files (pinned by test/auth-store.test.ts).
   *
   * Only THIS process's profile, deliberately: a process does not reach into profiles it
   * was not started for (their locks, their markers, possibly another API).
   */
  async retireLegacyCredentials(): Promise<boolean> {
    const p = this.profile;
    if (!p || !store.hasLegacyCredentials(p.dir)) return false;
    const m = await withInstallationLock(p.dir, async () => store.retireLegacy(p.dir), this.lockOpts());
    if (m) this.d.log(`bridge auth: retired plugin-0.24 (RFC-014) credentials in ${p.dir} — run /bridge:login`);
    return m !== null;
  }

  /** Let a mint in flight persist its new state before the process exits. */
  async drain(maxMs: number): Promise<void> {
    if (this.inflight) await Promise.race([this.inflight.catch(() => {}), new Promise((r) => setTimeout(r, maxMs))]);
  }

  status(): Record<string, unknown> {
    const p = this.profile;
    const inst = this.installation();
    const src = this.source();
    const problem = this.configError();
    return {
      profile: p ? profileLabel(p) : null,
      credential: src,
      storage: p?.dir ?? null,
      api_url: this.apiUrl() || null,
      ...(inst
        ? {
            installation_id: inst.installationId,
            installation_name: inst.installationName ?? null,
            key_storage: inst.keyStorage,
            key_thumbprint: inst.jkt,
          }
        : {}),
      ...(this.access ? { access_token_expires_at: new Date(this.access.expiresAt).toISOString() } : {}),
      ...(this.sessionBlocked ? { session: "revoked — /bridge:connect starts a new one" } : {}),
      ...(src === "none" && this.d.staleStaticTokenPresent ? { hint: STALE_TOKEN_HINT } : {}),
      ...(problem ? { problem } : {}),
      ...(this.pendingLogin ? { login: "waiting for approval in the browser" } : {}),
    };
  }

  private installationName(): string {
    const p = this.profile;
    // The first DNS label: "Mac.lan" / "box.corp.example" name the machine, not the network.
    const host = hostname().split(".")[0] || "machine";
    return p?.name ? `${host} (${p.name})` : host;
  }

  /**
   * Start a login and return what to tell the person. Completion (or failure) is
   * reported later through `notify` — the browser step can take minutes. A fresh
   * key is generated per login (E1) and proves itself at the token request.
   */
  async login(mode: "auto" | "browser" | "device" = "auto"): Promise<string> {
    if ("error" in this.d.profile) return this.d.profile.error;
    const apiUrl = this.apiUrl();
    if (!apiUrl) return "BRIDGE_API_URL is not set — run /bridge:configure first.";
    let meta: AuthMetadata;
    try {
      meta = await this.tokens.discover(apiUrl);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    if (!supportsKeyCredentials(meta)) return `Cannot sign in: ${SERVER_TOO_OLD}.`;
    this.pendingLogin?.cancel();
    this.pendingLogin = null;
    const name = this.installationName();
    const key = await generateSoftwareKey();

    const device = mode === "device" || (mode === "auto" && isHeadless(this.d.env));
    if (!device) {
      let lb: LoopbackLogin;
      try {
        lb = await startLoopback(meta, name, { dpopJkt: key.signer.jkt });
      } catch (e) {
        this.d.log(`bridge auth: loopback listener failed (${e}); using a device code`);
        return this.startDevice(meta, apiUrl, name, key);
      }
      let opened = false;
      if (!browserDisabled(this.d.env)) opened = await openBrowser(lb.authorizeUrl);
      if (!opened && !browserDisabled(this.d.env) && mode === "auto") {
        lb.close();
        return this.startDevice(meta, apiUrl, name, key);
      }
      let cancelled = false;
      this.pendingLogin = { cancel: () => ((cancelled = true), lb.close()) };
      void (async () => {
        const a = await lb.answer;
        if (cancelled) return;
        if ("error" in a) {
          lb.finish(a.error === "access_denied" ? "denied" : "error");
          this.loginFailed(a.error);
          return;
        }
        try {
          // C7: the code is bound to THIS key (dpop_jkt) and burnt on any mismatch, so no
          // fresh-key retry here (C6 applies to the enrolment-key and device flows only).
          const g = await this.tokens.exchangeCode(meta, key.signer, { code: a.code, verifier: lb.verifier, redirectUri: lb.redirectUri });
          if (!(await this.completeLogin(meta, apiUrl, name, g, key, () => cancelled))) return lb.finish("error");
          lb.finish("connected");
        } catch (e) {
          lb.finish("error");
          this.loginFailed(isOAuthError(e) ? e.error : String(e));
        }
      })();
      return opened
        ? `Opened your browser to connect this machine to Bridge. Approve it there — I'll report back here.\nIf the browser didn't open: ${lb.authorizeUrl}`
        : `Open this URL in a browser on this machine to connect it to Bridge:\n${lb.authorizeUrl}`;
    }
    return this.startDevice(meta, apiUrl, name, key);
  }

  private async startDevice(meta: AuthMetadata, apiUrl: string, name: string, key: NewKey): Promise<string> {
    const canPrompt = this.d.prompt.available();
    // Without a direct line to the person, a device code in the tool result is readable
    // (and relayable) by the model. Tolerable only when there is no sign-in to lose.
    if (!canPrompt && this.installation()) {
      return (
        "Device sign-in needs to show its code to you directly, and this client can't prompt you. " +
        "Use /bridge:login in a session with a browser, or /bridge:logout first."
      );
    }
    let auth;
    try {
      auth = await this.tokens.deviceAuthorization(meta, name);
    } catch (e) {
      return `Could not start a device sign-in: ${isOAuthError(e) ? e.error : String(e)}`;
    }
    const ac = new AbortController();
    this.pendingLogin = { cancel: () => ac.abort() };
    // C6/C8: the key on the poll that collects the approval is registered; if the server
    // says that key is already enrolled, switch to a fresh key ONCE and poll on.
    let freshKeyUsed = false;
    const poll = async () => {
      try {
        return await this.tokens.pollDeviceCode(meta, key.signer, auth.device_code);
      } catch (e) {
        if (!isKeyAlreadyEnrolled(e) || freshKeyUsed) throw e;
        freshKeyUsed = true;
        key = await generateSoftwareKey();
        return await this.tokens.pollDeviceCode(meta, key.signer, auth.device_code);
      }
    };
    void (async () => {
      const r = await pollDevice(poll, auth, { signal: ac.signal });
      if (ac.signal.aborted) {
        // Cancelled (logout / a new login) while the approving poll was in flight: that
        // poll ENROLLED a key nobody will keep — revoke it, or it stays a live machine.
        if (r.ok) await this.revokeNew(meta, key.signer, r.grant);
        return;
      }
      if (!r.ok) return this.loginFailed(r.error);
      try {
        if (canPrompt && !(await this.d.prompt.confirm(this.bindQuestion(r.grant)))) {
          await this.revokeNew(meta, key.signer, r.grant);
          this.pendingLogin = null;
          this.d.notify("Bridge: machine not connected — the sign-in was declined in the terminal.");
          return;
        }
        await this.completeLogin(meta, apiUrl, name, r.grant, key, () => ac.signal.aborted);
      } catch (e) {
        this.loginFailed(String(e));
      }
    })();
    const mins = Math.round(auth.expires_in / 60);
    const instructions =
      `To connect this machine to Bridge, open ${auth.verification_uri} on any device and enter the code:\n\n` +
      `    ${auth.user_code}\n\n` +
      `It expires in ${mins} minutes. Only enter it on the Bridge site you trust, and only if you started this sign-in.`;
    if (canPrompt) {
      this.d.prompt.show(instructions);
      return (
        `A sign-in code was shown to you directly (not to me). Enter it at ${auth.verification_uri}. ` +
        "You'll be asked to confirm the agent before this machine is connected."
      );
    }
    return (
      `To connect this machine to Bridge, open ${auth.verification_uri} on any device and enter the code:\n\n` +
      `    ${auth.user_code}\n\n` +
      `It expires in ${mins} minutes. Only enter it on the Bridge site you trust. I'll report back here once it's approved.`
    );
  }

  /**
   * An installation we just enrolled but will not keep (declined / cancelled): revoke it
   * with its seq-0 state. Deliberately NOT under the installation lock: its state was
   * never written to disk, so no other process can hold or advance it — the lock guards
   * the profile's on-disk chain, which this call never touches.
   */
  private async revokeNew(meta: AuthMetadata, signer: Signer, g: EnrolGrant): Promise<void> {
    await this.tokens
      .revoke(meta, signer, { installationId: g.installation_id, joinState: g.join_state, attempt: null, scope: "installation" })
      .catch((e) => this.d.log(`bridge auth: could not revoke the unused installation ${g.installation_id}: ${e}`));
  }

  private bindQuestion(g: EnrolGrant): string {
    const who = g.agent ? (g.agent.handle ? `@${g.agent.handle} (${g.agent.name})` : g.agent.name) : "an agent";
    const where = g.workspace?.name ? ` in workspace "${g.workspace.name}"` : "";
    const replacing = this.installation() ? " This replaces this machine's current Bridge sign-in." : "";
    return `Connect this machine to Bridge as ${who}${where}?${replacing} Decline if you did not start this sign-in.`;
  }

  private loginFailed(error: string): void {
    this.pendingLogin = null;
    const why =
      error === "access_denied"
        ? "the request was denied in the browser"
        : error === "expired_token" || error === "timeout"
          ? "it was not approved in time — run /bridge:login again"
          : error === "cancelled"
            ? "cancelled"
            : `sign-in failed (${error})`;
    if (error !== "cancelled") this.d.notify(`Bridge: machine not connected — ${why}.`);
  }

  /** Write a new installation's files; the caller holds the lock and has cleared the old ones. */
  private writeEnrolment(dir: string, apiUrl: string, name: string, g: EnrolGrant, key: NewKey): void {
    store.writeKey(dir, key.privateJwk);
    store.writeState(dir, g.join_state);
    // LAST: installation.json's presence is what every reader takes as "enrolled".
    store.writeInstallation(dir, {
      apiUrl,
      installationId: g.installation_id,
      installationName: name,
      enrolledAt: Math.floor(this.now() / 1000),
      jkt: key.signer.jkt,
      keyStorage: key.signer.keyStorage,
      ...(g.agent ? { agent: g.agent } : {}),
      ...(g.workspace ? { workspace: g.workspace } : {}),
    });
    store.clearLoggedOutMarker(dir);
    store.clearUpgradeMarker(dir);
  }

  /**
   * Store the new installation, then revoke the old one — all in ONE locked section: the
   * old installation's key + state + attempt are read from disk under the lock, its files
   * replaced, and its revoke (§3.5, verified not advanced) sent with the lease's signal.
   * False (and the new installation revoked) when the login was cancelled while its code
   * was being exchanged — a logout in that window must not be undone.
   */
  private async completeLogin(
    meta: AuthMetadata,
    apiUrl: string,
    name: string,
    g: EnrolGrant,
    key: NewKey,
    cancelled: () => boolean
  ): Promise<boolean> {
    const p = this.profile!;
    const outcome = await withInstallationLock(
      p.dir,
      async ({ signal }) => {
        if (cancelled()) return { cancelled: true as const };
        const prevInst = store.readInstallation(p.dir);
        const old = prevInst
          ? { inst: prevInst, jwk: store.readKey(p.dir), state: store.readState(p.dir), attempt: store.readAttempt(p.dir) }
          : null;
        store.deleteInstallationFiles(p.dir);
        this.writeEnrolment(p.dir, apiUrl, name, g, key);
        this.pendingLogin = null;
        this.access = null;
        this.sessionBlocked = false;
        this.reconnectNext = false;
        // Reconnect on the new installation BEFORE revoking the old one, so this
        // process's own socket is already gone when the revoke closes the old grant's.
        // (Its mint waits for this lock: it runs once the old revoke is done.)
        try {
          this.d.onLoggedIn();
        } catch (e) {
          this.d.log(`bridge auth: reconnect after login failed: ${e}`);
        }
        this.d.notify(`Bridge: this machine is connected (profile ${profileLabel(p)}). Connecting…`);
        if (old && old.inst.installationId !== g.installation_id && old.jwk && old.state) {
          try {
            const oldMeta = old.inst.apiUrl === apiUrl ? meta : await this.tokens.discover(old.inst.apiUrl, signal);
            await this.tokens.revoke(
              oldMeta,
              await softwareSigner(old.jwk),
              { installationId: old.inst.installationId, joinState: old.state, attempt: old.attempt, scope: "installation" },
              { signal }
            );
          } catch (e) {
            this.d.log(`bridge auth: could not revoke the previous installation ${old.inst.installationId}: ${e}`);
            const why = isOAuthError(e) ? `${e.error}${e.description ? `/${e.description}` : ""}` : e instanceof Error ? e.message : String(e);
            this.d.notify(
              `Bridge: this machine's PREVIOUS sign-in "${old.inst.installationName ?? old.inst.installationId}" could not be revoked (${why}). Its key is gone from this machine, but it STAYS ENROLLED in Bridge until you revoke it in Settings → Agents → Machines.`
            );
          }
        }
        return { cancelled: false as const };
      },
      this.lockOpts()
    );
    if (outcome.cancelled) {
      await this.revokeNew(meta, key.signer, g);
      return false;
    }
    return true;
  }

  /**
   * Sign this profile out. The revoke runs UNDER the installation lock (§3.5): it must
   * present the state the chain is at (+ the attempt of a mint whose answer was lost),
   * and no sibling may advance it meanwhile. The files are deleted whatever the server
   * answers — logout always works locally.
   */
  async logout(local: boolean): Promise<string> {
    if ("error" in this.d.profile) return this.d.profile.error;
    const p = this.d.profile;
    this.pendingLogin?.cancel();
    this.pendingLogin = null;
    const r = await withInstallationLock(
      p.dir,
      async ({ signal }) => {
        const inst = store.readInstallation(p.dir);
        const jwk = store.readKey(p.dir);
        const state = store.readState(p.dir);
        const attempt = store.readAttempt(p.dir);
        let revoke: "revoked" | "locked" | "skipped" | { failed: string } = "skipped";
        if (inst && !local && jwk && state) {
          try {
            await this.tokens.revoke(
              await this.tokens.discover(inst.apiUrl, signal),
              await softwareSigner(jwk),
              { installationId: inst.installationId, joinState: state, attempt, scope: "installation" },
              { signal }
            );
            revoke = "revoked";
          } catch (e) {
            const a = classifyTokenError(e);
            revoke =
              a.kind === "installation_gone"
                ? // C11: nothing left to revoke server-side — but a LOCK means a copy was
                  // used elsewhere (E8), which the person must hear about, not "revoked".
                  a.reason === "installation_locked"
                  ? "locked"
                  : "revoked"
                : { failed: isOAuthError(e) ? `${e.error}${e.description ? `/${e.description}` : ""}` : e instanceof Error ? e.message : String(e) };
          }
        }
        store.deleteInstallationFiles(p.dir);
        // An enrolment key still in .env must not silently sign the machine back in at
        // the next start; /bridge:login clears this.
        store.writeLoggedOutMarker(p.dir);
        return { inst, revoke };
      },
      this.lockOpts()
    );
    this.access = null;
    this.d.onLoggedOut();
    const { inst, revoke } = r;
    if (!inst) return `Profile ${profileLabel(p)} was not signed in.`;
    const machine = inst.installationName ?? inst.installationId;
    if (local) {
      // C17.
      return `Signed out locally (profile ${profileLabel(p)}). ⚠️ This machine STAYS ENROLLED in Bridge until you revoke "${machine}" in Settings → Agents → Machines.`;
    }
    if (revoke === "revoked") return `Signed out (profile ${profileLabel(p)}); this machine's access was revoked in Bridge.`;
    if (revoke === "locked") return `Signed out (profile ${profileLabel(p)}). ${goneMessage("installation_locked")}.`;
    const why = typeof revoke === "object" ? revoke.failed : "no key on disk";
    return `Signed out locally (profile ${profileLabel(p)}), but revoking in Bridge failed (${why}). ⚠️ This machine STAYS ENROLLED in Bridge until you revoke "${machine}" in Settings → Agents → Machines.`;
  }

  /**
   * Headless enrolment: `BRIDGE_ENROLMENT_KEY` is exchanged once, when the profile has
   * no installation. Under the lock with a re-check, so of several sessions starting
   * together exactly one enrols — and ONE deadline covers discovery + enrol + C6 retry.
   */
  async enrolFromKeyIfNeeded(): Promise<void> {
    const p = this.profile;
    const enrolmentKey = this.d.enrolmentKey.trim();
    const apiUrl = this.d.envApiUrl;
    if (!p || !enrolmentKey || !apiUrl || this.installation()) return;
    if (store.hasLoggedOutMarker(p.dir)) {
      this.d.log("bridge auth: signed out with /bridge:logout — not re-enrolling from BRIDGE_ENROLMENT_KEY (run /bridge:login)");
      return;
    }
    try {
      await withInstallationLock(
        p.dir,
        async ({ signal }) => {
          if (store.readInstallation(p.dir)) return;
          const meta = await this.tokens.discover(apiUrl, signal);
          if (!supportsKeyCredentials(meta)) throw new Error(SERVER_TOO_OLD);
          const name = this.installationName();
          let key = await generateSoftwareKey();
          let g: EnrolGrant;
          try {
            g = await this.tokens.enrolWithKey(meta, key.signer, { enrolmentKey, installationName: name }, { signal });
          } catch (e) {
            // C6: once, with a fresh key.
            if (!isKeyAlreadyEnrolled(e)) throw e;
            key = await generateSoftwareKey();
            g = await this.tokens.enrolWithKey(meta, key.signer, { enrolmentKey, installationName: name }, { signal });
          }
          // Stray key/state from an enrolment that died before installation.json: not ours any more.
          store.deleteInstallationFiles(p.dir);
          this.writeEnrolment(p.dir, apiUrl, name, g, key);
          this.d.log(`bridge auth: enrolled installation ${g.installation_id} with BRIDGE_ENROLMENT_KEY`);
        },
        this.lockOpts()
      );
    } catch (e) {
      const why = isOAuthError(e) ? `${e.error}${e.description ? `/${e.description}` : ""}` : e instanceof Error ? e.message : String(e);
      this.d.notify(`Bridge: BRIDGE_ENROLMENT_KEY could not enrol this machine (${why}) — the key may be used up or expired, or Bridge did not answer in time.`);
    }
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.pendingLogin?.cancel();
  }
}

/** What the person is told when Bridge says this installation is gone for good (§3.3, §5.4). */
function goneMessage(reason: InstallationGoneReason): string {
  switch (reason) {
    case "installation_locked":
      return "credential copy detected — Bridge LOCKED this machine's sign-in: a copy of its credential was used somewhere else (or a backup / VM snapshot of it was restored). Its key was deleted here. Check this machine, rotate any other secrets on it, then run /bridge:login to re-enrol";
    case "agent_deactivated":
      return "the agent this machine acts as was deactivated in Bridge, so its sign-in was deleted — once it is reactivated, run /bridge:login";
    case "installation_revoked":
    case "installation_expired":
    case "installation_unknown":
      return `this machine's Bridge sign-in is no longer valid (${reason.replace(/_/g, " ")}) — run /bridge:login`;
    default:
      return assertNever(reason);
  }
}
