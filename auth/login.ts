/**
 * Sign-in for this Claude session (RFC-016), on the SDK's `AgentClient` + `fileStore`
 * (RFC-027 T4b). The credential itself — mint under the installation lock, the
 * write-ahead attempt, the join-state chain, rotation, enrolment, revoke — is the
 * SDK's. What stays here is what only a Claude plugin has:
 *
 * - the profile directory, `EINWEAVE_API_URL`, and the problem text the model is shown
 *   (`configError`, `describeCredential`);
 * - login UX: the loopback + browser flow (the key is generated FIRST, so the
 *   `dpop_jkt` in the authorize URL is the key that exchanges the code, C7), the device
 *   flow whose code and "bind this machine to @agent?" question go to the PERSON through
 *   MCP elicitation, never the model;
 * - the `logged-out` marker (an enrolment key in .env must not sign a logged-out machine
 *   back in), and D8's "a newer plugin wrote this" refusal;
 * - stop-lift: a stop-class refusal is about ONE installation — a login in another
 *   window (a different installation on disk) lifts it.
 */
import { hostname } from "os";
import { join } from "path";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import {
  AgentClient,
  AgentClientError,
  isAgentClientError,
  isTerminalCredentialError,
  type AgentClientErrorCode,
  type EnrolOptions,
  type Installation,
  type Runtime,
  type SessionClient,
} from "../vendor/bridge-agent-sdk/index.js";
import { fileStore, readVersioned, sweepOrphanTemps, sweepLockTombstones } from "../vendor/bridge-agent-sdk/node.js";
import {
  TokenClient,
  Clock,
  KNOWN_FORMAT,
  apiOrigin,
  assertNever,
  generateSoftwareKey,
  isOAuthError,
  supportsKeyCredentials,
  type AuthMetadata,
  type EnrolGrant,
  type InstallationGoneReason,
} from "../vendor/bridge-agent-sdk/core/index.js";
import { PLUGIN_CLIENT_ID } from "./client-id";
import { startLoopback, type LoopbackLogin } from "./loopback";
import { isHeadless, browserDisabled, openBrowser } from "./browser";
import { profileLabel, type Profile } from "./profile";

const SERVER_TOO_OLD = "this Bridge server does not support key credentials yet (no client_credentials grant, RFC-016) — it must be upgraded before this plugin can sign in";

const UPDATE_REQUIRED =
  "Bridge refused this plugin's sign-in protocol — the plugin and the Bridge server disagree on it; update the plugin (/plugin update bridge), then run /bridge:login";

const SESSION_REVOKED = "this session was revoked in Bridge — /bridge:connect starts a new one";

/** D8 (RFC-017 P1 gap): a newer plugin's installation.json — never "not signed in". */
const NEWER_INSTALLATION_MESSAGE = "this profile was signed in by a newer Bridge plugin — /reload-plugins to use it";

/** Longest a logout waits for a login's in-flight exchange to land before signing out of it. */
const LANDING_WAIT_MS = 30_000;

/**
 * Marks the session client's own refusal "no usable sign-in on disk" (`configError`) —
 * terminal for the Session, and what the credential watch waits on is new FILES.
 */
const NO_SIGN_IN = Symbol("no sign-in");

export interface SignInDeps {
  rt: Runtime;
  profile: Profile | { error: string };
  /** EINWEAVE_API_URL from the environment / .env, trailing slashes stripped ("" = unset). */
  envApiUrl: string;
  enrolmentKey: string;
  /** Resolves with this session's final key — a session keyed by a provisional one would be orphaned. */
  sessionKey: () => Promise<string>;
  clientVersion: string;
  env: Record<string, string | undefined>;
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
}

/** What the person is told for a credential failure — the SDK's codes, in this plugin's words. */
export function describeCredential(e: unknown, clientVersion: string): string {
  if (!isAgentClientError(e)) return `Bridge sign-in unreachable: ${errDetail(e)}`;
  if (e.cause === NO_SIGN_IN) return e.message;
  const detail = errDetail(e.cause ?? e);
  switch (e.code) {
    case "not_enrolled":
      return "signed out of Bridge — run /bridge:login";
    case "installation_gone":
      return goneMessage(e.reason ?? "installation_unknown");
    case "clock":
      return "Bridge refused this machine's signature (assertion_invalid) even after correcting for clock skew — check the system clock, then /bridge:connect";
    case "session_revoked":
      return SESSION_REVOKED;
    case "session_limit":
      return "this agent has too many live sessions in Bridge (session_limit) — close one, then /bridge:connect";
    case "corrupt_state":
      return "this machine's Bridge state file is damaged (corrupt_state) — run /bridge:login to re-enrol";
    case "update_required":
      return `${UPDATE_REQUIRED} (${detail})`;
    case "rate_limited":
      return `Bridge sign-in is rate-limited — retrying in ${e.retryAfterS ?? "a few "}s`;
    case "too_old":
      return `this plugin (${clientVersion}) is older than Bridge accepts${e.minimum ? ` (>= ${e.minimum})` : ""} — /plugin update bridge, then /reload-plugins`;
    case "refused":
      // The SDK's own refusals carry no OAuth cause: a server that cannot mint for a key, a
      // key that does not match its installation.
      if (!isOAuthError(e.cause)) return /key credentials/.test(e.message) ? SERVER_TOO_OLD : `Bridge sign-in stopped: ${e.message} — run /bridge:login`;
      return `Bridge refused this machine's sign-in (${detail})`;
    case "server_mismatch":
      return `${e.message} — run /bridge:login`;
    case "network":
      return `Bridge sign-in unreachable: ${detail}`;
    case "aborted":
      return `Bridge sign-in was cancelled (${detail})`;
    case "declined":
      return "the sign-in was declined";
    default:
      return assertNever(e.code);
  }
}

/**
 * What a session STOPPED by this credential failure waits for (server.ts's credential watch):
 * - "files": no usable sign-in on disk — a login in ANOTHER window writes the files;
 * - "stop-lift": a refusal retrying will not fix; the files are still there, so it waits for
 *   a different installation on disk (`SignIn.refreshStop`) or /bridge:connect;
 * - null: nothing the watch can see ends it (a revoked session, E9: /bridge:connect), or not
 *   terminal at all (retried by the Session's own schedule).
 * Exhaustive over the SDK's codes — a new one must decide here.
 */
export function waitFor(e: unknown): null | "files" | "stop-lift" {
  if (!isAgentClientError(e)) return null;
  if (e.cause === NO_SIGN_IN) return "files";
  const code: AgentClientErrorCode = e.code;
  switch (code) {
    case "not_enrolled":
    case "installation_gone":
    case "server_mismatch":
      return "files";
    case "refused":
    case "session_limit":
    case "too_old":
    case "corrupt_state":
    case "update_required":
    case "clock":
      return "stop-lift";
    case "session_revoked":
    case "network":
    case "rate_limited":
    case "aborted":
    case "declined":
      return null;
    default:
      return assertNever(code);
  }
}

export class SignIn {
  /** One AgentClient per API URL (the URL can only change while signed out). */
  private live: { apiUrl: string; client: Promise<AgentClient> } | null = null;
  /**
   * The ONE login in progress. Each flow owns its object and only ever clears the slot
   * while it still holds it (endLogin): a stale flow finishing late must never
   * unregister its successor, or a logout could not cancel it.
   */
  private pendingLogin: { cancel: () => void; cancelled: () => boolean } | null = null;
  /** A login's exchange that may still write an installation (a logout waits for it). */
  private landing: Promise<unknown> | null = null;
  /** A cancelled login's exchange wrote an installation anyway: nobody asked for it, so the logout revokes it even when local. */
  private landedAfterCancel = false;
  /** The installation a stop-class refusal was about (stop-lift). */
  private stoppedOn: string | null = null;
  private sessionBlocked = false;
  private lastToken: string | null = null;
  private readonly discovery: TokenClient;

  constructor(private readonly d: SignInDeps) {
    this.discovery = new TokenClient({ clock: new Clock(() => d.rt.clock.now()), clientId: PLUGIN_CLIENT_ID, softwareId: PLUGIN_CLIENT_ID, softwareVersion: d.clientVersion });
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
      const n = sweepOrphanTemps(p.dir) + sweepLockTombstones(p.dir);
      if (n > 0) this.d.log(`bridge auth: removed ${n} leftover file(s) from an earlier crash in ${p.dir}`);
    } catch (e) {
      this.d.log(`bridge auth: could not sweep ${p.dir}: ${errDetail(e)}`);
    }
  }

  /** installation.json as it is on disk now (null: none, unreadable, or a newer format). */
  private installation(): Installation | null {
    const p = this.profile;
    if (!p) return null;
    const v = readVersioned<Installation>(join(p.dir, "installation.json"), KNOWN_FORMAT);
    if (v.kind !== "ok") return null;
    const c = v.data;
    return typeof c.apiUrl === "string" && typeof c.installationId === "string" && typeof c.jkt === "string" ? c : null;
  }

  /** D8: installation.json was written by a plugin newer than this one knows. */
  private newerInstallation(): boolean {
    const p = this.profile;
    return !!p && readVersioned(join(p.dir, "installation.json"), KNOWN_FORMAT).kind === "newer";
  }

  source(): "installation" | "none" {
    return this.installation() ? "installation" : "none";
  }

  /** The API this process talks to: the environment's, else the profile's own. */
  apiUrl(): string {
    return this.d.envApiUrl || this.installation()?.apiUrl || "";
  }

  /** A configuration problem that no amount of retrying fixes, or null. */
  configError(): string | null {
    if ("error" in this.d.profile) return this.d.profile.error;
    const p = this.d.profile;
    const inst = this.installation();
    if (inst && this.d.envApiUrl && inst.apiUrl !== this.d.envApiUrl) {
      return `profile "${profileLabel(p)}" is signed in to ${inst.apiUrl}, but EINWEAVE_API_URL is ${this.d.envApiUrl} — its key is never used anywhere else. Run /bridge:login to sign in to ${this.d.envApiUrl}.`;
    }
    // Login needs the API URL, so that hint comes first.
    if (!this.apiUrl()) return "EINWEAVE_API_URL is not set — run /bridge:configure, then /bridge:login";
    try {
      // Proofs sign the API ORIGIN (§3.4, C16): a URL with a path could never be accepted.
      apiOrigin(this.apiUrl());
    } catch (e) {
      return `EINWEAVE_API_URL is unusable: ${errDetail(e)} — fix it with /bridge:configure`;
    }
    if (!inst) {
      // `installation()` also reads null for a NEWER plugin's installation.json — never "not
      // signed in" for that, or a headless enrolment / a stale-window login would overwrite it.
      if (this.newerInstallation()) return NEWER_INSTALLATION_MESSAGE;
      return p.name ? `profile "${p.name}" is not signed in — run /bridge:login` : "this machine is not signed in to Bridge — run /bridge:login";
    }
    return null;
  }

  /** The AgentClient for the current API URL, or null when there is none to use. */
  async client(): Promise<AgentClient | null> {
    const p = this.profile;
    const apiUrl = this.apiUrl();
    if (!p || !apiUrl) return null;
    try {
      apiOrigin(apiUrl);
    } catch {
      return null;
    }
    if (this.live?.apiUrl !== apiUrl) {
      const prev = this.live;
      const sessionKey = await this.d.sessionKey();
      // Re-checked after the await: a concurrent caller may have opened it meanwhile.
      if (this.live === prev) {
        void prev?.client.then((c) => c.stop(), () => {});
        this.live = {
          apiUrl,
          client: AgentClient.open(this.d.rt, { apiUrl, store: fileStore(p.dir), softwareId: PLUGIN_CLIENT_ID, softwareVersion: this.d.clientVersion, sessionKey }),
        };
      }
    }
    return this.live!.client;
  }

  /** `Authorization: DPoP …` + a proof for ONE HTTP request (§3.4, C16). Throws the person's text. */
  async httpAuth(method: string, path: string): Promise<{ client: AgentClient; token: string; headers: { Authorization: string; DPoP: string } }> {
    const problem = this.configError();
    if (problem) throw new Error(problem);
    const c = await this.client();
    if (!c) throw new Error("this machine is not signed in to Bridge — run /bridge:login");
    try {
      const a = await c.httpAuth(method, path);
      this.minted(c, a.token);
      return { client: c, ...a };
    } catch (e) {
      throw new Error(describeCredential(this.failed(e), this.d.clientVersion));
    }
  }

  /** The Session's client: the AgentClient, its failures through `failed`. */
  async sessionClient(): Promise<SessionClient | null> {
    const c = await this.client();
    if (!c) return null;
    return {
      apiUrl: () => c.apiUrl(),
      sessionKey: () => c.sessionKey(),
      softwareId: () => c.softwareId(),
      softwareVersion: () => c.softwareVersion(),
      wsAuth: async () => {
        try {
          const a = await c.wsAuth();
          this.minted(c, a.token);
          return a;
        } catch (e) {
          throw this.failed(e);
        }
      },
      grant: () => c.grant(),
      invalidateAccess: (token) => c.invalidateAccess(token),
      sessionRevoked: (id) => {
        if (id === null || id === c.grant()?.sessionId) this.sessionBlocked = true;
        c.sessionRevoked(id);
      },
      installationRevoked: (id) => c.installationRevoked(id),
      onAccessRotated: (cb) => c.onAccessRotated(cb),
      api: c.api,
    };
  }

  private minted(c: AgentClient, token: string): void {
    if (token === this.lastToken) return;
    this.lastToken = token;
    this.sessionBlocked = false;
    this.d.log(`bridge auth: minted for session ${c.grant()?.sessionId ?? "?"}`);
  }

  /**
   * Bookkeeping for a credential failure; returns it. No usable sign-in on disk (none, half
   * of one, a newer plugin's, one for another API) becomes TERMINAL with the configError
   * text: the Session stops and the credential watch waits for files, where the SDK alone
   * would retry `not_enrolled` forever.
   */
  private failed(e: unknown): unknown {
    if (isAgentClientError(e) && (e.code === "not_enrolled" || e.code === "server_mismatch")) {
      return new AgentClientError({ code: "refused", message: this.configError() ?? "signed out of Bridge — run /bridge:login", cause: NO_SIGN_IN });
    }
    if (isAgentClientError(e) && e.code === "session_revoked") this.sessionBlocked = true;
    if (isTerminalCredentialError(e)) this.stoppedOn = this.installation()?.installationId ?? null;
    return e;
  }

  /**
   * The stop-class refusal that halts minting, or null. NOT a pure getter — a stop is about
   * ONE installation, so once the profile holds another (a /bridge:login in another window)
   * it no longer stands and is CLEARED here. server.ts's credential watch polls this.
   */
  async refreshStop(): Promise<AgentClientError | null> {
    const c = this.live ? await this.live.client : null;
    const stop = c?.refreshStop() ?? null;
    if (stop && (this.installation()?.installationId ?? null) !== this.stoppedOn) {
      c!.requestSessionReconnect();
      return null;
    }
    return stop;
  }

  /**
   * E9: after a session revoke, only an EXPLICIT user reconnect mints again, and it says so
   * (`reconnect=true`). Also lifts a stop. Called by the `connect` tool.
   */
  async requestSessionReconnect(): Promise<void> {
    (await this.client())?.requestSessionReconnect();
  }

  status(): Record<string, unknown> {
    const p = this.profile;
    const inst = this.installation();
    const problem = this.configError();
    return {
      profile: p ? profileLabel(p) : null,
      credential: this.source(),
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
      ...(this.sessionBlocked ? { session: "revoked — /bridge:connect starts a new one" } : {}),
      ...(problem ? { problem } : {}),
      ...(this.pendingLogin ? { login: "waiting for approval" } : {}),
    };
  }

  private installationName(): string {
    const p = this.profile;
    // The first DNS label: "Mac.lan" / "box.corp.example" name the machine, not the network.
    const host = hostname().split(".")[0] || "machine";
    return p?.name ? `${host} (${p.name})` : host;
  }

  /**
   * Start a login and return what to tell the person. Completion (or failure) is reported
   * later through `notify` — the browser step can take minutes.
   */
  async login(mode: "auto" | "browser" | "device" = "auto"): Promise<string> {
    if ("error" in this.d.profile) return this.d.profile.error;
    const apiUrl = this.apiUrl();
    if (!apiUrl) return "EINWEAVE_API_URL is not set — run /bridge:configure first.";
    // D8: a newer plugin's sign-in can never be replaced from this window — say so before
    // the person approves anything.
    if (this.newerInstallation()) return NEWER_INSTALLATION_MESSAGE;
    let meta: AuthMetadata;
    try {
      apiOrigin(apiUrl);
      meta = await this.discovery.discover(apiUrl);
    } catch (e) {
      return errDetail(e);
    }
    if (!supportsKeyCredentials(meta)) return `Cannot sign in: ${SERVER_TOO_OLD}.`;
    const client = (await this.client())!;
    this.pendingLogin?.cancel();
    this.pendingLogin = null;
    const name = this.installationName();

    const device = mode === "device" || (mode === "auto" && isHeadless(this.d.env));
    if (device) return this.startDevice(client, name);
    // C7: the code is bound to the key whose thumbprint is in the authorize URL — so the
    // key is made FIRST and handed to the exchange; any other key burns the code.
    const key = await generateSoftwareKey();
    let lb: LoopbackLogin;
    try {
      lb = await startLoopback(meta, name, { dpopJkt: key.signer.jkt });
    } catch (e) {
      this.d.log(`bridge auth: loopback listener failed (${e}); using a device code`);
      return this.startDevice(client, name);
    }
    let opened = false;
    if (!browserDisabled(this.d.env)) opened = await openBrowser(lb.authorizeUrl);
    if (!opened && !browserDisabled(this.d.env) && mode === "auto") {
      lb.close();
      return this.startDevice(client, name);
    }
    let cancelled = false;
    const mine = { cancel: () => ((cancelled = true), lb.close()), cancelled: () => cancelled };
    this.pendingLogin = mine;
    this.landing = (async () => {
      const a = await lb.answer;
      if (cancelled) return;
      if ("error" in a) {
        lb.finish(a.error === "access_denied" ? "denied" : "error");
        return this.loginFailed(a.error, mine);
      }
      try {
        await client.enrolWithAuthorizationCode({ code: a.code, verifier: lb.verifier, redirectUri: lb.redirectUri }, name, { key, ...this.enrolHooks(mine) });
        lb.finish("connected");
      } catch (e) {
        lb.finish("error");
        this.enrolFailed(e, mine);
      }
    })();
    return opened
      ? `Opened your browser to connect this machine to Bridge. Approve it there — I'll report back here.\nIf the browser didn't open: ${lb.authorizeUrl}`
      : `Open this URL in a browser on this machine to connect it to Bridge:\n${lb.authorizeUrl}`;
  }

  private async startDevice(client: AgentClient, name: string): Promise<string> {
    const canPrompt = this.d.prompt.available();
    // Without a direct line to the person, a device code in the tool result is readable
    // (and relayable) by the model. Tolerable only when there is no sign-in to lose.
    if (!canPrompt && this.installation()) {
      return "Device sign-in needs to show its code to you directly, and this client can't prompt you. Use /bridge:login in a session with a browser, or /bridge:logout first.";
    }
    const ac = new AbortController();
    const mine = { cancel: () => ac.abort(), cancelled: () => ac.signal.aborted };
    let flow;
    try {
      flow = await client.deviceAuthorization(name, {
        // Asked BEFORE anything is written; false → the SDK revokes the new installation.
        // A login cancelled meanwhile (a logout, a newer login) declines too.
        confirm: async (g) => {
          if (ac.signal.aborted) return false;
          if (canPrompt && !(await this.d.prompt.confirm(this.bindQuestion(g)))) return false;
          return !ac.signal.aborted;
        },
        ...this.enrolHooks(mine),
      });
    } catch (e) {
      return `Could not start a device sign-in: ${errDetail(isAgentClientError(e) ? (e.cause ?? e) : e)}`;
    }
    this.pendingLogin = mine;
    this.landing = flow.complete({ signal: ac.signal }).then(
      () => {},
      (e) => {
        if (ac.signal.aborted) return; // cancelled: the SDK revoked whatever it enrolled
        if (isAgentClientError(e) && e.code === "declined") {
          this.endLogin(mine);
          this.d.notify("Bridge: machine not connected — the sign-in was declined in the terminal.");
          return;
        }
        this.enrolFailed(e, mine);
      }
    );
    const { auth } = flow;
    const mins = Math.round(auth.expires_in / 60);
    if (canPrompt) {
      this.d.prompt.show(
        `To connect this machine to Bridge, open ${auth.verification_uri} on any device and enter the code:\n\n` +
          `    ${auth.user_code}\n\n` +
          `It expires in ${mins} minutes. Only enter it on the Bridge site you trust, and only if you started this sign-in.`
      );
      return `A sign-in code was shown to you directly (not to me). Enter it at ${auth.verification_uri}. You'll be asked to confirm the agent before this machine is connected.`;
    }
    return (
      `To connect this machine to Bridge, open ${auth.verification_uri} on any device and enter the code:\n\n` +
      `    ${auth.user_code}\n\n` +
      `It expires in ${mins} minutes. Only enter it on the Bridge site you trust. I'll report back here once it's approved.`
    );
  }

  private bindQuestion(g: EnrolGrant): string {
    const who = g.agent ? (g.agent.handle ? `@${g.agent.handle} (${g.agent.name})` : g.agent.name) : "an agent";
    const where = g.workspace?.name ? ` in workspace "${g.workspace.name}"` : "";
    const replacing = this.installation() ? " This replaces this machine's current Bridge sign-in." : "";
    return `Connect this machine to Bridge as ${who}${where}?${replacing} Decline if you did not start this sign-in.`;
  }

  /** The new installation is on disk: connect on it (before the old one is revoked), say so. */
  private enrolHooks(mine: { cancelled: () => boolean; unrevoked?: string[] }): EnrolOptions {
    return {
      // A write that failed, with revokes that failed too: named in the failure notice.
      onUnrevoked: (left) => void (mine.unrevoked = left.map((i) => i.installationName ?? i.installationId)),
      onWritten: () => {
        this.clearLoggedOut();
        this.forgetInstallationState();
        this.endLogin(mine);
        // Cancelled while its code was being exchanged: the logout waiting on this landing
        // signs out of it (and revokes it) next — no reconnect, no "connected".
        if (mine.cancelled()) return void (this.landedAfterCancel = true);
        try {
          this.d.onLoggedIn();
        } catch (e) {
          this.d.log(`bridge auth: reconnect after login failed: ${e}`);
        }
        this.d.notify(`Bridge: this machine is connected (profile ${profileLabel(this.profile!)}). Connecting…`);
      },
      onPreviousRevokeFailed: (prev, e) => {
        this.d.log(`bridge auth: could not revoke the previous installation ${prev.installationId}: ${errDetail(e)}`);
        this.d.notify(
          `Bridge: this machine's PREVIOUS sign-in "${prev.installationName ?? prev.installationId}" could not be revoked (${errDetail(e)}). Its key is gone from this machine, but it STAYS ENROLLED in Bridge until you revoke it in Settings → Agents → Machines.`
        );
      },
    };
  }

  /** Unregister a finished login — only if it is still THE login in progress. */
  private endLogin(mine: object): void {
    if (this.pendingLogin === mine) this.pendingLogin = null;
  }

  private loginFailed(error: string, mine: object): void {
    this.endLogin(mine);
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

  /** An enrolment that did not land. The SDK has already revoked the new installation if it was issued. */
  private enrolFailed(e: unknown, mine: { cancelled: () => boolean; unrevoked?: string[] }): void {
    if (mine.cancelled()) return void this.endLogin(mine);
    if (this.newerInstallation()) {
      this.endLogin(mine);
      return this.d.notify(`Bridge: ${NEWER_INSTALLATION_MESSAGE}`);
    }
    if (!isAgentClientError(e)) {
      // Not a refusal: the write itself failed (full disk, EACCES). The old files are gone
      // and both installations were revoked best-effort.
      this.endLogin(mine);
      return this.d.notify(
        `Bridge: machine not connected — its new sign-in could not be saved on this machine (${errDetail(e)}), so it is signed out now; fix the disk problem and run /bridge:login again.${stillEnrolled(mine.unrevoked ?? [])}`
      );
    }
    this.loginFailed(isOAuthError(e.cause) ? e.cause.error : e.message, mine);
  }

  /** Per-installation state that must not outlive it (logout, a new enrolment). */
  private forgetInstallationState(): void {
    this.stoppedOn = null;
    this.sessionBlocked = false;
    this.lastToken = null;
  }

  /**
   * Sign this profile out. The revoke runs under the installation lock (§3.5); the files
   * are deleted whatever the server answers — logout always works locally. A login whose
   * exchange is still in flight is cancelled and AWAITED first: whatever it writes is then
   * signed out of (and revoked) here, never left to undo this logout.
   */
  async logout(local: boolean): Promise<string> {
    if ("error" in this.d.profile) return this.d.profile.error;
    const p = this.d.profile;
    this.pendingLogin?.cancel();
    this.pendingLogin = null;
    if (this.landing) await Promise.race([this.landing.catch(() => {}), new Promise((r) => setTimeout(r, LANDING_WAIT_MS))]);
    const unasked = this.landedAfterCancel;
    this.landedAfterCancel = false;
    const client = await this.client();
    const r = client ? await client.logout({ revoke: !local || unasked }) : { installation: null, revoke: "skipped" as const };
    // An enrolment key still in .env must not silently sign the machine back in at the
    // next start; a login clears this.
    this.writeLoggedOut();
    this.forgetInstallationState();
    this.d.onLoggedOut();
    const inst = r.installation;
    if (!inst) return `Profile ${profileLabel(p)} was not signed in.`;
    const machine = inst.installationName ?? inst.installationId;
    // C17.
    if (local && !unasked) return `Signed out locally (profile ${profileLabel(p)}). ⚠️ This machine STAYS ENROLLED in Bridge until you revoke "${machine}" in Settings → Agents → Machines.`;
    const revoke = r.revoke;
    if (revoke === "revoked") return `Signed out (profile ${profileLabel(p)}); this machine's access was revoked in Bridge.`;
    if (revoke === "locked") return `Signed out (profile ${profileLabel(p)}). ${goneMessage("installation_locked")}.`;
    const why = typeof revoke === "object" ? revoke.failed : "no key on disk";
    return `Signed out locally (profile ${profileLabel(p)}), but revoking in Bridge failed (${why}). ⚠️ This machine STAYS ENROLLED in Bridge until you revoke "${machine}" in Settings → Agents → Machines.`;
  }

  /**
   * Headless enrolment: `EINWEAVE_ENROLMENT_KEY` is exchanged once, when the profile has no
   * installation. The SDK re-checks under the lock, so of several sessions starting
   * together exactly one spends the key.
   */
  async enrolFromKeyIfNeeded(): Promise<void> {
    const p = this.profile;
    const enrolmentKey = this.d.enrolmentKey.trim();
    if (!p || !enrolmentKey || !this.d.envApiUrl || this.installation()) return;
    // D8: never spend the key over a newer plugin's installation (the store would refuse
    // the write AFTER the key was used). Never through chat: log only.
    if (this.newerInstallation()) return this.d.log(`bridge auth: not enrolling with EINWEAVE_ENROLMENT_KEY — ${NEWER_INSTALLATION_MESSAGE}`);
    if (this.loggedOut()) return this.d.log("bridge auth: signed out with /bridge:logout — not re-enrolling from EINWEAVE_ENROLMENT_KEY (run /bridge:login)");
    const client = await this.client();
    if (!client) return;
    let unrevoked: string[] = [];
    try {
      const g = await client.enrolWithKey(enrolmentKey, this.installationName(), {
        onWritten: () => this.clearLoggedOut(),
        onUnrevoked: (left) => void (unrevoked = left.map((i) => i.installationName ?? i.installationId)),
      });
      if (g) this.d.log(`bridge auth: enrolled installation ${g.installation_id} with EINWEAVE_ENROLMENT_KEY`);
    } catch (e) {
      if (!isAgentClientError(e)) {
        // Bridge enrolled it, but the files could not be written (the SDK revoked it).
        return this.d.notify(
          `Bridge: EINWEAVE_ENROLMENT_KEY enrolled this machine, but its sign-in could not be saved on this machine (${errDetail(e)}). The key's use is spent; fix the disk problem, then run /bridge:login (or set a new enrolment key).${stillEnrolled(unrevoked)}`
        );
      }
      this.d.notify(
        `Bridge: EINWEAVE_ENROLMENT_KEY could not enrol this machine (${errDetail(e.cause ?? e)}) — the key may be used up or expired, or Bridge did not answer in time.`
      );
    }
  }

  private loggedOutFile(): string | null {
    return this.profile ? join(this.profile.dir, "logged-out") : null;
  }
  private loggedOut(): boolean {
    const f = this.loggedOutFile();
    return !!f && existsSync(f);
  }
  private writeLoggedOut(): void {
    const f = this.loggedOutFile();
    if (f) writeFileSync(f, `${new Date().toISOString()}\n`, { mode: 0o600 });
  }
  private clearLoggedOut(): void {
    const f = this.loggedOutFile();
    try {
      if (f) unlinkSync(f);
    } catch {}
  }

  stop(): void {
    this.pendingLogin?.cancel();
    void this.live?.client.then((c) => c.stop(), () => {});
  }
}

/** An error as the person should see it: the OAuth code (+ description token), else the message. */
function errDetail(e: unknown): string {
  return isOAuthError(e) ? `${e.error}${e.description ? `/${e.description}` : ""}` : e instanceof Error ? e.message : String(e);
}

/** The warning for installations that could not be revoked from here ("" when none). */
function stillEnrolled(labels: string[]): string {
  if (labels.length === 0) return "";
  const [verb, pronoun] = labels.length === 1 ? ["STAYS", "it"] : ["STAY", "them"];
  return ` ⚠️ ${labels.map((l) => `"${l}"`).join(" and ")} ${verb} ENROLLED in Bridge until you revoke ${pronoun} in Settings → Agents → Machines.`;
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
