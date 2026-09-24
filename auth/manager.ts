/**
 * The credential manager (RFC-014 §7.2): turns a profile's files into a bearer
 * for this Claude session, keeps it fresh, and runs login / logout.
 *
 * ⚠️ EVERY CHAIN TOKEN IS READ FROM DISK UNDER THE PROFILE LOCK, never from memory.
 * The installation token is shared by every session on the machine, and a session's
 * refresh token can be touched by a duplicate process of the same session (a
 * standby that answers a tool call). Presenting a token that someone else already
 * rotated is REUSE, and the server revokes the whole grant for it. Only the 1 h
 * access token lives in memory.
 */
import { hostname } from "os";
import { withProfileLock } from "./lock";
import {
  readInstallation,
  writeInstallation,
  readSession,
  writeSession,
  deleteSession,
  deleteProfileCredentials,
  type InstallationCredentials,
} from "./store";
import { discover, token, revoke, deviceAuthorization, OAuthError, type AuthMetadata, type InstallationGrant } from "./oauth";
import { startLoopback, type LoopbackLogin } from "./loopback";
import { pollDevice } from "./device";
import { isHeadless, browserDisabled, openBrowser } from "./browser";
import { profileLabel, type Profile } from "./profile";

export type CredentialSource = "installation" | "legacy" | "none";

/** Why no bearer can be produced — the text is shown to the model as-is. */
export class CredentialError extends Error {
  constructor(
    readonly kind: "not_logged_in" | "profile" | "api_url" | "logged_out" | "network",
    message: string
  ) {
    super(message);
  }
}

export interface ManagerDeps {
  profile: Profile | { error: string };
  /** BRIDGE_API_URL from the environment / .env, trailing slashes stripped ("" = unset). */
  envApiUrl: string;
  /** BRIDGE_TOKEN — the legacy static token, honoured only by the default profile. */
  legacyToken: string;
  enrolmentKey: string;
  sessionKey: () => string;
  /** Resolves once sessionKey() is final — a grant keyed by a provisional key would be orphaned. */
  sessionKeyReady: () => Promise<unknown>;
  platform: string;
  clientVersion: string;
  env: Record<string, string | undefined>;
  /** A fresh access token replaced the one the live socket authenticated with. */
  onAccessRotated: (accessToken: string) => void;
  /** This process now holds a new installation (login): reconnect on it. */
  onLoggedIn: () => void;
  onLoggedOut: () => void;
  notify: (text: string) => void;
  log: (text: string) => void;
  /** Injected for tests. */
  random?: () => number;
  now?: () => number;
  tickMs?: number;
}

interface Access {
  token: string;
  expiresAt: number;
  refreshAt: number;
  sessionId: string;
  installationId: string;
}

const EXPIRY_SLACK_MS = 60_000;

export class CredentialManager {
  private access: Access | null = null;
  private inflight: Promise<string> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private pendingLogin: { cancel: () => void } | null = null;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly d: ManagerDeps) {
    this.now = d.now ?? Date.now;
    this.random = d.random ?? Math.random;
  }

  private get profile(): Profile | null {
    return "error" in this.d.profile ? null : this.d.profile;
  }

  private installation(): InstallationCredentials | null {
    const p = this.profile;
    return p ? readInstallation(p.dir) : null;
  }

  /** Where credentials come from right now. */
  source(): CredentialSource {
    if (!this.profile) return "none";
    if (this.installation()) return "installation";
    // A NAMED profile never falls back to the machine's legacy token: selecting a
    // profile that has no credentials is an error, not "use whatever is there".
    if (this.profile.name === null && this.d.legacyToken) return "legacy";
    return "none";
  }

  /** The API this process talks to: the environment's, else the profile's own. */
  apiUrl(): string {
    return this.d.envApiUrl || this.installation()?.apiUrl || "";
  }

  /** A configuration problem that no amount of retrying fixes, or null. */
  configError(): string | null {
    if ("error" in this.d.profile) return this.d.profile.error;
    const inst = this.installation();
    if (inst && this.d.envApiUrl && inst.apiUrl !== this.d.envApiUrl) {
      return `profile "${profileLabel(this.profile!)}" is signed in to ${inst.apiUrl}, but BRIDGE_API_URL is ${this.d.envApiUrl} — its tokens are never sent anywhere else. Run /bridge:login to sign in to ${this.d.envApiUrl}.`;
    }
    // Login needs the API URL, so that hint comes first.
    if (!this.apiUrl()) return "BRIDGE_API_URL is not set — run /bridge:configure, then /bridge:login";
    if (this.source() === "none") {
      return this.profile!.name
        ? `profile "${this.profile!.name}" is not signed in — run /bridge:login`
        : "this machine is not signed in to Bridge — run /bridge:login";
    }
    return null;
  }

  /** The bearer for the next request. Throws CredentialError when there is none. */
  async bearer(): Promise<string> {
    const err = this.configError();
    if (err) throw new CredentialError(this.source() === "none" ? "not_logged_in" : "profile", err);
    if (this.source() === "legacy") return this.d.legacyToken;
    const a = this.access;
    if (a && this.now() < a.expiresAt - EXPIRY_SLACK_MS) return a.token;
    return this.renew("expiring");
  }

  /** Forget the in-memory access token (a 401 or a 4009): the next bearer() renews. */
  invalidateAccess(): void {
    this.access = null;
  }

  /** Refresh (or start a session) now. Single-flight across callers in this process. */
  renew(reason: string): Promise<string> {
    if (!this.inflight) {
      const hadAccess = this.access !== null;
      this.inflight = this.renewUnderLock(reason)
        .then((a) => {
          this.access = a;
          this.armTicker();
          if (hadAccess) this.d.onAccessRotated(a.token);
          return a.token;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  private async renewUnderLock(reason: string): Promise<Access> {
    const profile = this.profile!;
    await this.d.sessionKeyReady();
    return withProfileLock(profile.dir, async () => {
      const inst = readInstallation(profile.dir);
      if (!inst) throw new CredentialError("logged_out", "signed out of Bridge — run /bridge:login");
      const meta = await this.meta(inst.apiUrl);
      const key = this.d.sessionKey();
      const sess = readSession(profile.dir, key);

      if (sess && sess.installationId === inst.installationId) {
        try {
          const g = await token.refresh(meta, sess.refreshToken);
          writeSession(profile.dir, key, { ...sess, refreshToken: g.refresh_token });
          this.d.log(`bridge auth: refreshed session ${sess.sessionId} (${reason})`);
          return this.toAccess(g.access_token, g.expires_in, sess.sessionId, inst.installationId);
        } catch (e) {
          // We hold the lock and read this token from disk, so nobody else rotated it:
          // invalid_grant means the session itself is gone (idle, revoked, reused).
          // Start a new one on the installation. Anything else (network) keeps the file.
          if (!(e instanceof OAuthError && e.error === "invalid_grant")) throw this.networkError(e);
          deleteSession(profile.dir, key);
          this.d.log(`bridge auth: session ${sess.sessionId} is no longer valid — starting a new one`);
        }
      }

      let g;
      try {
        g = await token.session(meta, inst.installationToken, key, {
          platform: this.d.platform,
          clientVersion: this.d.clientVersion,
        });
      } catch (e) {
        if (e instanceof OAuthError && e.error === "invalid_grant") {
          deleteProfileCredentials(profile.dir);
          throw new CredentialError(
            "logged_out",
            "this machine's Bridge sign-in is no longer valid (revoked or expired) — run /bridge:login"
          );
        }
        throw this.networkError(e);
      }
      // The rotated installation token first: it is the one every session shares.
      writeInstallation(profile.dir, { ...inst, installationToken: g.installation_token });
      writeSession(profile.dir, key, { sessionId: g.session_id, refreshToken: g.refresh_token, installationId: inst.installationId });
      this.d.log(`bridge auth: started session ${g.session_id} (${reason})`);
      return this.toAccess(g.access_token, g.expires_in, g.session_id, inst.installationId);
    });
  }

  private networkError(e: unknown): Error {
    if (e instanceof CredentialError) return e;
    if (e instanceof OAuthError) return new CredentialError("network", `Bridge sign-in failed: ${e.error} (${e.status})`);
    return new CredentialError("network", `Bridge sign-in unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }

  private toAccess(tok: string, expiresInS: number, sessionId: string, installationId: string): Access {
    const now = this.now();
    const lifeMs = Math.max(1, expiresInS) * 1000;
    // Refresh ahead: 10 min for a 1 h token (a sixth of any shorter one), minus a
    // per-process random share so a machine's sessions do not all refresh together.
    const marginMs = Math.min(600_000, lifeMs / 6);
    const jitterMs = this.random() * Math.min(120_000, marginMs / 2);
    return { token: tok, expiresAt: now + lifeMs, refreshAt: now + lifeMs - marginMs - jitterMs, sessionId, installationId };
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
      const go = () => this.renew("scheduled").catch((e) => this.d.log(`bridge auth: scheduled refresh failed: ${e.message}`));
      if (late) setTimeout(go, this.random() * 30_000).unref?.();
      else void go();
    }, this.d.tickMs ?? 15_000);
    this.ticker.unref?.();
  }

  private meta(apiUrl: string): Promise<AuthMetadata> {
    return discover(apiUrl);
  }

  /** 4008 "session revoked": this session is over; the next connect starts a new one. */
  sessionRevoked(): void {
    this.access = null;
    const p = this.profile;
    if (p) deleteSession(p.dir, this.d.sessionKey());
  }

  /**
   * 4008 "installation revoked". If the profile now holds a DIFFERENT installation
   * (the machine was re-logged-in, which revokes the old one), switch to it quietly.
   * Only if the revoked one is still on disk is this machine actually signed out.
   */
  async installationRevoked(): Promise<"switched" | "logged_out"> {
    const revokedId = this.access?.installationId ?? null;
    this.access = null;
    const p = this.profile;
    if (!p) return "logged_out";
    return withProfileLock(p.dir, async () => {
      const inst = readInstallation(p.dir);
      if (inst && revokedId && inst.installationId !== revokedId) return "switched";
      if (inst && inst.installationId === revokedId) deleteProfileCredentials(p.dir);
      return "logged_out";
    });
  }

  status(): Record<string, unknown> {
    const p = this.profile;
    const inst = this.installation();
    const src = this.source();
    return {
      profile: p ? profileLabel(p) : null,
      credential: src,
      storage: p?.dir ?? null,
      api_url: this.apiUrl() || null,
      ...(inst ? { installation_id: inst.installationId, installation_name: inst.installationName ?? null } : {}),
      ...(this.access ? { access_token_expires_at: new Date(this.access.expiresAt).toISOString() } : {}),
      ...(src === "legacy" ? { hint: "using the legacy BRIDGE_TOKEN — run /bridge:login to switch to a per-machine sign-in" } : {}),
      ...(this.configError() ? { problem: this.configError() } : {}),
      ...(this.pendingLogin ? { login: "waiting for approval in the browser" } : {}),
    };
  }

  private installationName(): string {
    const p = this.profile;
    const host = hostname().replace(/\.local$/, "");
    return p?.name ? `${host} (${p.name})` : host;
  }

  /**
   * Start a login and return what to tell the person. Completion (or failure) is
   * reported later through `notify` — the browser step can take minutes.
   */
  async login(mode: "auto" | "browser" | "device" = "auto"): Promise<string> {
    if ("error" in this.d.profile) return this.d.profile.error;
    const apiUrl = this.d.envApiUrl || this.installation()?.apiUrl || "";
    if (!apiUrl) return "BRIDGE_API_URL is not set — run /bridge:configure first.";
    let meta: AuthMetadata;
    try {
      meta = await this.meta(apiUrl);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    this.pendingLogin?.cancel();
    this.pendingLogin = null;
    const name = this.installationName();

    const device = mode === "device" || (mode === "auto" && isHeadless(this.d.env));
    if (!device) {
      let lb: LoopbackLogin;
      try {
        lb = await startLoopback(meta, name);
      } catch (e) {
        this.d.log(`bridge auth: loopback listener failed (${e}); using a device code`);
        return this.startDevice(meta, apiUrl, name);
      }
      let opened = false;
      if (!browserDisabled(this.d.env)) opened = await openBrowser(lb.authorizeUrl);
      if (!opened && !browserDisabled(this.d.env) && mode === "auto") {
        lb.close();
        return this.startDevice(meta, apiUrl, name);
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
          const g = await token.authorizationCode(meta, a.code, lb.verifier, lb.redirectUri);
          await this.completeLogin(meta, apiUrl, name, g);
          lb.finish("connected");
        } catch (e) {
          lb.finish("error");
          this.loginFailed(e instanceof OAuthError ? e.error : String(e));
        }
      })();
      return opened
        ? `Opened your browser to connect this machine to Bridge. Approve it there — I'll report back here.\nIf the browser didn't open: ${lb.authorizeUrl}`
        : `Open this URL in a browser on this machine to connect it to Bridge:\n${lb.authorizeUrl}`;
    }
    return this.startDevice(meta, apiUrl, name);
  }

  private async startDevice(meta: AuthMetadata, apiUrl: string, name: string): Promise<string> {
    let auth;
    try {
      auth = await deviceAuthorization(meta, name);
    } catch (e) {
      return `Could not start a device sign-in: ${e instanceof OAuthError ? e.error : String(e)}`;
    }
    const ac = new AbortController();
    this.pendingLogin = { cancel: () => ac.abort() };
    void (async () => {
      const r = await pollDevice(meta, auth, { signal: ac.signal });
      if (ac.signal.aborted) return;
      if (!r.ok) return this.loginFailed(r.error);
      try {
        await this.completeLogin(meta, apiUrl, name, r.grant);
      } catch (e) {
        this.loginFailed(String(e));
      }
    })();
    const mins = Math.round(auth.expires_in / 60);
    return (
      `To connect this machine to Bridge, open ${auth.verification_uri} on any device and enter the code:\n\n` +
      `    ${auth.user_code}\n\n` +
      `It expires in ${mins} minutes. Only enter it on the Bridge site you trust. I'll report back here once it's approved.`
    );
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

  /** Store the new installation, drop the old one's sessions, then revoke the old one. */
  private async completeLogin(meta: AuthMetadata, apiUrl: string, name: string, g: InstallationGrant): Promise<void> {
    const p = this.profile!;
    const old = await withProfileLock(p.dir, async () => {
      const prev = readInstallation(p.dir);
      // Replacing: every session file belongs to the old installation.
      deleteProfileCredentials(p.dir);
      writeInstallation(p.dir, {
        apiUrl,
        installationId: g.installation_id,
        installationToken: g.installation_token,
        installationName: name,
        enrolledAt: Math.floor(this.now() / 1000),
      });
      return prev;
    });
    this.pendingLogin = null;
    this.access = null;
    // Reconnect on the new installation BEFORE revoking the old one, so this
    // process's own socket is already gone when the revoke closes the old grant's.
    this.d.onLoggedIn();
    this.d.notify(`Bridge: this machine is connected (profile ${profileLabel(p)}). Connecting…`);
    if (old && old.installationId !== g.installation_id) {
      try {
        const oldMeta = old.apiUrl === apiUrl ? meta : await this.meta(old.apiUrl);
        await revoke(oldMeta, old.installationToken);
      } catch (e) {
        this.d.log(`bridge auth: could not revoke the previous installation ${old.installationId}: ${e}`);
      }
    }
  }

  /** Sign this profile out: delete its files, then (unless local) revoke on the server. */
  async logout(local: boolean): Promise<string> {
    if ("error" in this.d.profile) return this.d.profile.error;
    const p = this.d.profile;
    this.pendingLogin?.cancel();
    this.pendingLogin = null;
    const inst = await withProfileLock(p.dir, async () => {
      const i = readInstallation(p.dir);
      deleteProfileCredentials(p.dir);
      return i;
    });
    this.access = null;
    this.d.onLoggedOut();
    if (!inst) return `Profile ${profileLabel(p)} was not signed in.`;
    if (local) return `Signed out locally (profile ${profileLabel(p)}). The machine is still listed in Bridge until it expires or is revoked there.`;
    try {
      await revoke(await this.meta(inst.apiUrl), inst.installationToken);
      return `Signed out (profile ${profileLabel(p)}); this machine's access was revoked in Bridge.`;
    } catch (e) {
      return `Signed out locally (profile ${profileLabel(p)}), but revoking in Bridge failed (${e instanceof Error ? e.message : e}). Revoke "${inst.installationName ?? inst.installationId}" from the agent's settings in Bridge.`;
    }
  }

  /**
   * Headless enrolment: `BRIDGE_ENROLMENT_KEY` is exchanged once, when the profile
   * has no installation. Under the lock with a re-check, so of several sessions
   * starting together exactly one enrols.
   */
  async enrolFromKeyIfNeeded(): Promise<void> {
    const p = this.profile;
    const key = this.d.enrolmentKey.trim();
    const apiUrl = this.d.envApiUrl;
    if (!p || !key || !apiUrl || this.installation()) return;
    try {
      await withProfileLock(p.dir, async () => {
        if (readInstallation(p.dir)) return;
        const name = this.installationName();
        const g = await token.enrol(await this.meta(apiUrl), key, name);
        writeInstallation(p.dir, {
          apiUrl,
          installationId: g.installation_id,
          installationToken: g.installation_token,
          installationName: name,
          enrolledAt: Math.floor(this.now() / 1000),
        });
        this.d.log(`bridge auth: enrolled installation ${g.installation_id} with BRIDGE_ENROLMENT_KEY`);
      });
    } catch (e) {
      const why = e instanceof OAuthError ? e.error : String(e);
      this.d.notify(`Bridge: BRIDGE_ENROLMENT_KEY could not enrol this machine (${why}) — the key may be used up or expired.`);
    }
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.pendingLogin?.cancel();
  }
}
