/**
 * A stub of Bridge's agent authorization server + just enough API/WS for the plugin
 * (RFC-016). STRICTER than the real server on purpose, so a client that is merely
 * "accepted by today's server" still fails here:
 *   - every signature is verified with node:crypto, raw r‖s only (test/dpop-verify.ts);
 *   - every DPoP proof: typ, alg, PUBLIC jwk only, htm, EXACT normalised htu, iat ±300 s
 *     of the STUB's clock (`clockSkewS`), single-use jti, `ath` on resource/WS use, the
 *     token's jkt; a nonce when `requireNonce`;
 *   - every assertion: typ, kid = jkt, iss = sub = client_id, aud = issuer as a STRING
 *     (C2 also allows a one-element array; the plugin always sends the string, so the
 *     stub refuses arrays to pin that),
 *     exp ≤ iat + 300, jti shared with the proofs' replay set;
 *   - request validation BEFORE client authentication, in the server's order (§3.1: the
 *     CRC is checked before any database read): corrupt_state, attempt_invalid,
 *     session_key_invalid (mint); scope_invalid, corrupt_state, attempt_invalid,
 *     session_key_invalid (revoke);
 *   - every secret (`brg_ek_` / `brg_ac_` / `brg_dc_`) in the server's format with its CRC,
 *     judged (invalid_grant) BEFORE key_storage and the proof, as agent-credentials.ts does;
 *     an authorization code is burnt by ANY mismatch; the device grant checks client_id,
 *     paces polls (`interval`, default the server's 5 s ⇒ `slow_down`), and answers
 *     access_denied / expired_token;
 *   - a client's session revoke is `client_revoked`: a later mint with that session_key
 *     opens a NEW session (E9 blocks only a `manual` revoke without reconnect);
 *   - every response carries the stub clock's `Date` (skewed when `clockSkewS`), 502s and
 *     redirects included;
 *   - the join-state chain exactly as E6: current ⇒ advance; previous + SAME attempt ⇒
 *     replay (no time bound); anything else ⇒ LOCK (4008 "installation locked");
 *   - a revoke verifies the state and NEVER advances it;
 *   - the RFC-014 grants (`refresh_token`, the session URN) answer `invalid_grant`
 *     `rfc014_retired: …`, as the server does (E13 — 0.24 stops only on invalid_grant);
 *   - client authentication in the SERVER's order (agent-credentials.ts authenticateClient):
 *     assertion type → client_id → proof → registered key (unknown ⇒ `assertion_invalid`,
 *     never `installation_unknown`: no enumeration oracle) → assertion → proof jkt = key;
 *   - no `crit` header, canonical 32-byte x/y, like the server's es256.ts.
 * Where the plan's stub and the server (bridge PR #209) differed, the server won.
 * A client that re-presents a stale state, drops its attempt, reuses a jti or signs
 * with the wrong key fails loudly — and `stats` says which.
 */
import { parseJws, verifyEs256, isPublicP256, thumbprint, sha256b64u, normHtu, randomBase62, makeJoinState, joinStateCrcOk as crcOk, crc32, base62 } from "./dpop-verify";

export interface StubOptions {
  accessTtlS?: number;
  /** Device polls answered `authorization_pending` before the request is approved. */
  devicePending?: number;
  /** RFC 8628 `interval` (s) — a faster poll is `slow_down`. Default the server's DEVICE_POLL_INTERVAL_S = 5. */
  deviceIntervalS?: number;
  /** The human denies the device request (`access_denied`). */
  deviceDeny?: boolean;
  /** The device request expires before approval (`expired_token`). */
  deviceExpire?: boolean;
  /** `/authorize` answers with `error=access_denied`. */
  deny?: boolean;
  agentId?: string;
  /** The first N discovery requests answer 502 (a deploy in progress). */
  discoveryFail?: number;
  /** Discovery without `client_credentials` — a pre-RFC-016 server. */
  legacyServer?: boolean;
  /** Delay the authorization_code exchange (ms). */
  codeDelayMs?: number;
  /** Delay every discovery answer (ms). */
  discoveryDelayMs?: number;
  /** Delay every enrolment-key request (ms), before it is judged. */
  enrolDelayMs?: number;
  /** Delay every device-code poll (ms), before it is judged. */
  devicePollDelayMs?: number;
  /** Delay every mint (ms). */
  mintDelayMs?: number;
  /** Every /api/* request answers 401. */
  always401?: boolean;
  /** The stub's clock runs this many seconds ahead of the machine's (and its `Date` says so). */
  clockSkewS?: number;
  /** Token endpoint, revoke and /api/* demand a server nonce (RFC 9449 §8/§9). */
  requireNonce?: boolean;
  /** The first N mints answer 429 Retry-After: 1 WITHOUT touching the chain. */
  rateLimitMints?: number;
  /** The first N mints ADVANCE the chain, then answer 502 (the response is "lost"). */
  loseMintResponses?: number;
  /** Live sessions per installation before E9's cap applies. */
  sessionCap?: number;
  /** Answer mints with this token_type instead of "DPoP" (a misbehaving server). */
  mintTokenType?: string;
  /** The first N enrolment requests answer `invalid_dpop_proof` `key_already_enrolled` (C6), whatever the key. */
  keyAlreadyEnrolled?: number;
  /** Every assertion is refused `assertion_invalid` (a clock the client cannot fix, C13). */
  rejectAssertions?: boolean;
  /** Revoke answers `{}` instead of C11's `{"ok":true}`. */
  revokeBodyEmpty?: boolean;
}

type Revoked = null | "installation_revoked" | "installation_locked" | "agent_deactivated";
type Inst = {
  id: string;
  agentId: string;
  jwk: any;
  jkt: string;
  keyStorage: string | null;
  revoked: Revoked;
  seq: number;
  current: string;
  prev: { state: string; attemptHash: string } | null;
};
type Sess = { id: string; instId: string; key: string; revoked: null | "manual" | "evicted" | "client_revoked"; lastUsed: number };

const GRANT_ENROLMENT_KEY = "urn:bridge:params:oauth:grant-type:enrolment-key";
const GRANT_DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const SKEW_S = 300;
const UPDATE_PLUGIN_HINT = "update the Bridge plugin and run /bridge:login";
const RETIRED_RFC014_GRANTS = new Set(["refresh_token", "urn:bridge:params:oauth:grant-type:session"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** C4. */
const ATTEMPT_RE = /^[A-Za-z0-9_-]{22,128}$/;
const SESSION_KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** The plugin's public client (AGENT_AUTH_CLIENTS). */
export const STUB_CLIENT_ID = "bridge-claude-plugin";
/** RFC 7636 §4.1. */
const PKCE_VALUE_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const JKT_RE = /^[A-Za-z0-9_-]{43}$/;

/** The server's secret format (agent-tokens.ts): `brg_<kind>_<43 base62><6 base62 CRC32>`. */
export function mintAgentToken(kind: "at" | "ek" | "ac" | "dc"): string {
  const head = `brg_${kind}_${randomBase62(43)}`;
  return head + base62(crc32(head), 6);
}
export function isAgentToken(kind: string, s: unknown): boolean {
  if (typeof s !== "string") return false;
  const m = /^(brg_(at|ek|ac|dc)_[0-9A-Za-z]{43})([0-9A-Za-z]{6})$/.exec(s);
  return !!m && m[2] === kind && base62(crc32(m[1]!), 6) === m[3];
}


export function createAuthCore(opts: StubOptions = {}) {
  const accessTtlS = opts.accessTtlS ?? 3600;
  const deviceIntervalS = opts.deviceIntervalS ?? 5;
  const insts = new Map<string, Inst>();
  const byJkt = new Map<string, string>();
  const sessions = new Map<string, Sess>();
  const access = new Map<string, { session: string; instId: string; jkt: string; exp: number }>();
  const codes = new Map<string, { clientId: string; challenge: string; redirect: string; used: boolean; dpopJkt: string | null; instId?: string }>();
  const devices = new Map<string, { clientId: string; pendingLeft: number; lastPolledS: number | null; expiresS: number; consumed: boolean }>();
  const enrolmentKeys = new Map<string, number>();
  const usedJti = new Set<string>();
  let nonce = `n-${randomBase62(16)}`;
  const stats = {
    enrols: 0,
    mints: 0,
    replays: 0,
    locks: 0,
    revokes: [] as { id: string; scope: string }[],
    mintBodies: [] as Record<string, string>[],
    authTokens: [] as string[],
    reauths: 0,
    /** WebSocket upgrades accepted — a socket opened, whatever its auth frame then carried. */
    wsOpens: 0,
    /** The token of every ACCEPTED `reauth` frame. */
    reauthTokens: [] as string[],
    discoveryHits: 0,
    /** Token-endpoint requests per grant_type, counted on ARRIVAL (before any configured delay). */
    tokenRequests: {} as Record<string, number>,
    apiHits: 0,
    /** Every refusal, as `<where>:<reason>` — the first thing to read when a test fails. */
    refusals: [] as string[],
  };
  const mint = mintAgentToken;
  const sockets = new Set<any>();
  /** Forced closes for the next `auth` frames, in order (rejectNextWsAuths). */
  const forcedAuthCloses: { code: number; reason: string }[] = [];
  const nowS = () => Math.floor(Date.now() / 1000) + (opts.clockSkewS ?? 0);
  const dateHeader = () => new Date(nowS() * 1000).toUTCString();

  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", Date: dateHeader(), ...extra } });
  const refuse = (where: string, error: string, description?: string, status = 400, extra: Record<string, string> = {}) => {
    stats.refusals.push(`${where}:${description ?? error}`);
    return json(description ? { error, error_description: description } : { error }, status, extra);
  };
  /** A refusal the server answers WITHOUT a description; `why` goes to stats only. */
  const refuseBare = (where: string, error: string, why: string) => {
    stats.refusals.push(`${where}:${why}`);
    return json({ error }, 400);
  };
  /** Every answer carries the stub clock's Date — a redirect and a 502 too. */
  const withDate = (r: Response) => {
    const headers = new Headers(r.headers);
    headers.set("Date", dateHeader());
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
  };

  function closeWhere(pred: (s: Sess) => boolean, reason: string) {
    for (const ws of sockets) {
      const s = sessions.get(ws.data.session);
      if (s && pred(s)) ws.close(4008, reason);
    }
  }

  /**
   * Close like the server (ws.ts closeDeadGrant / runAuthenticateWs / the 4009 timer):
   * 4001, 1011 and 4009 are preceded by an `error` frame; a revoke's 4008 is not.
   */
  function closeLikeServer(ws: any, code: number, reason: string) {
    const frame: Record<number, string> = { 4001: "Invalid token", 1011: "grant check failed", 4009: "Access token expired" };
    if (frame[code]) {
      try {
        ws.send(JSON.stringify({ type: "error", data: { message: frame[code] } }));
      } catch {}
    }
    ws.close(code, reason);
  }

  function newInstallation(jwk: any, keyStorage: string | null = null) {
    const id = crypto.randomUUID();
    const jkt = thumbprint(jwk);
    const current = makeJoinState(0);
    insts.set(id, { id, agentId: opts.agentId ?? "agent-1", jwk, jkt, keyStorage, revoked: null, seq: 0, current, prev: null });
    byJkt.set(jkt, id);
    stats.enrols++;
    return {
      installation_id: id,
      join_state: current,
      agent: { id: opts.agentId ?? "agent-1", handle: "agent-one", name: "Agent One" },
      workspace: { id: "t1", name: "Acme" },
    };
  }

  /**
   * One DPoP proof. `bound`: the jkt the proof must be by (token / installation);
   * `ath`: the access token it must hash. Returns the proof's jwk or a refusal reason.
   */
  function checkProof(
    header: string | null,
    htm: string,
    htu: string,
    bound: string | null,
    at: string | null,
    where: string,
    nonceApplies = true
  ): { jwk: any } | { reason: string; nonce?: true } {
    const p = parseJws(header);
    if (!p) return { reason: "no_proof" };
    if ("crit" in p.header) return { reason: "crit" };
    if (p.header.typ !== "dpop+jwt") return { reason: "typ" };
    if (!isPublicP256(p.header.jwk)) return { reason: "jwk" };
    if (!verifyEs256(p, p.header.jwk)) return { reason: "signature" };
    const c = p.claims;
    if (c.htm !== htm) return { reason: `htm ${c.htm}` };
    if (c.htu !== normHtu(htu)) return { reason: `htu ${c.htu} != ${normHtu(htu)}` };
    if (typeof c.iat !== "number" || Math.abs(c.iat - nowS()) > SKEW_S) return { reason: "iat" };
    if (typeof c.jti !== "string" || c.jti.length < 16 || usedJti.has(c.jti)) return { reason: "jti" };
    if (at !== null ? c.ath !== sha256b64u(at) : c.ath !== undefined) return { reason: "ath" };
    if (bound !== null && thumbprint(p.header.jwk) !== bound) return { reason: "jkt" };
    if (opts.requireNonce && nonceApplies && c.nonce !== nonce) return { reason: "nonce", nonce: true };
    usedJti.add(c.jti);
    void where;
    return { jwk: p.header.jwk };
  }

  function checkAssertion(b: any, inst: Inst, issuer: string): string | null {
    if (b.client_assertion_type !== ASSERTION_TYPE) return "assertion_type";
    const a = parseJws(b.client_assertion);
    if (!a) return "assertion_parse";
    if ("crit" in a.header || a.header.typ !== "client-authentication+jwt" || a.header.kid !== inst.jkt) return "assertion_header";
    if (!verifyEs256(a, inst.jwk)) return "assertion_signature";
    const c = a.claims;
    if (c.iss !== inst.id || c.sub !== inst.id) return "assertion_iss";
    if (c.aud !== issuer) return "assertion_aud"; // a STRING, the issuer, nothing else (rfc7523bis)
    if (typeof c.iat !== "number" || Math.abs(c.iat - nowS()) > SKEW_S) return "assertion_iat";
    if (typeof c.exp !== "number" || c.exp <= nowS() || c.exp > c.iat + 300) return "assertion_exp";
    if (typeof c.jti !== "string" || usedJti.has(c.jti)) return "assertion_jti";
    usedJti.add(c.jti);
    return null;
  }

  const nonceHeaders = (): Record<string, string> => (opts.requireNonce ? { "DPoP-Nonce": nonce } : {});

  function liveAccess(at: string | null) {
    if (!at) return null;
    const a = access.get(at);
    if (!a || a.exp < Date.now()) return null;
    const s = sessions.get(a.session);
    const i = insts.get(a.instId);
    if (!s || s.revoked || !i || i.revoked) return null;
    s.lastUsed = Date.now();
    return a;
  }

  /** The E6 chain step, without committing: what the installation would become. */
  function chainStep(inst: Inst, state: string, attempt: string): { kind: "advance" | "replay" } | { kind: "lock" } {
    if (state === inst.current) return { kind: "advance" };
    if (inst.prev && state === inst.prev.state && sha256b64u(attempt) === inst.prev.attemptHash) return { kind: "replay" };
    return { kind: "lock" };
  }

  function lock(inst: Inst) {
    inst.revoked = "installation_locked";
    stats.locks++;
    closeWhere((s) => s.instId === inst.id, "installation locked");
  }

  /**
   * The client-authenticated endpoints' common front half (§3.3 step 1–2), in the server's
   * order (agent-credentials.ts authenticateClient): assertion type → client_id → proof
   * (unbound) → the registered key → assertion → proof jkt = key → revoked.
   */
  function authenticateClient(req: Request, b: any, url: URL, issuer: string, where: string): Inst | Response {
    if (b.client_assertion_type !== ASSERTION_TYPE || typeof b.client_assertion !== "string") {
      stats.refusals.push(`${where}:assertion_type`);
      return refuse(where, "invalid_client", "assertion_invalid");
    }
    // No enumeration oracle: an unknown or malformed client_id answers like a bad assertion.
    if (typeof b.client_id !== "string" || !UUID_RE.test(b.client_id)) {
      stats.refusals.push(`${where}:client_id`);
      return refuse(where, "invalid_client", "assertion_invalid");
    }
    const proof = checkProof(req.headers.get("dpop"), "POST", `${url.origin}${url.pathname}`, null, null, where);
    if ("reason" in proof) {
      if (proof.nonce) return refuse(where, "use_dpop_nonce", undefined, 400, nonceHeaders());
      return refuse(where, "invalid_dpop_proof", proof.reason);
    }
    const inst = insts.get(b.client_id);
    if (!inst) {
      stats.refusals.push(`${where}:unknown_client`);
      return refuse(where, "invalid_client", "assertion_invalid");
    }
    const bad = opts.rejectAssertions ? "assertion_forced" : checkAssertion(b, inst, issuer);
    if (bad) {
      stats.refusals.push(`${where}:${bad}`);
      return refuse(where, "invalid_client", "assertion_invalid");
    }
    if (thumbprint(proof.jwk) !== inst.jkt) return refuse(where, "invalid_dpop_proof", "jkt");
    if (inst.revoked) return refuse(where, "invalid_client", inst.revoked);
    return inst;
  }

  async function handleAuth(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const issuer = `${url.origin}/api/agent-auth`;
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server/api/agent-auth") {
      if (opts.discoveryDelayMs) await Bun.sleep(opts.discoveryDelayMs);
      if (stats.discoveryHits++ < (opts.discoveryFail ?? 0)) return new Response("bad gateway", { status: 502 });
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        device_authorization_endpoint: `${issuer}/device_authorization`,
        token_endpoint: `${issuer}/token`,
        revocation_endpoint: `${issuer}/revoke`,
        grant_types_supported: opts.legacyServer
          ? ["authorization_code", GRANT_DEVICE_CODE, GRANT_ENROLMENT_KEY, "urn:bridge:params:oauth:grant-type:session", "refresh_token"]
          : ["authorization_code", GRANT_DEVICE_CODE, GRANT_ENROLMENT_KEY, "client_credentials"],
        token_endpoint_auth_methods_supported: ["private_key_jwt", "none"],
        token_endpoint_auth_signing_alg_values_supported: ["ES256"],
        revocation_endpoint_auth_methods_supported: ["private_key_jwt"],
        dpop_signing_alg_values_supported: ["ES256"],
        bridge_connect_done_uri: `${url.origin}/connect/done`,
      });
    }
    if (url.pathname === "/api/agent-auth/authorize") {
      const q = url.searchParams;
      // The server's createLoopbackRequest: unknown client / non-loopback redirect are answered HERE (never redirected).
      if (q.get("client_id") !== STUB_CLIENT_ID) return new Response("Bridge could not start this sign-in: unknown client_id.", { status: 400 });
      const redirect = q.get("redirect_uri") ?? "";
      if (!/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+\//.test(redirect)) return new Response("Bridge could not start this sign-in: redirect_uri.", { status: 400 });
      const back = new URL(redirect);
      const jktQ = q.get("dpop_jkt");
      if (
        q.get("response_type") !== "code" ||
        q.get("code_challenge_method") !== "S256" ||
        !PKCE_VALUE_RE.test(q.get("code_challenge") ?? "") ||
        !(q.get("state") ?? "") ||
        (jktQ !== null && !JKT_RE.test(jktQ))
      ) {
        back.searchParams.set("error", "invalid_request");
        if (q.get("state")) back.searchParams.set("state", q.get("state")!);
        return Response.redirect(back.toString(), 302);
      }
      back.searchParams.set("state", q.get("state")!);
      back.searchParams.set("iss", issuer);
      if (opts.deny) back.searchParams.set("error", "access_denied");
      else {
        const code = mint("ac");
        codes.set(code, { clientId: q.get("client_id")!, challenge: q.get("code_challenge")!, redirect, used: false, dpopJkt: jktQ });
        back.searchParams.set("code", code);
      }
      return Response.redirect(back.toString(), 302);
    }
    if (!url.pathname.startsWith("/api/agent-auth/")) return null;
    const b = req.method === "POST" ? ((await req.json().catch(() => ({}))) as any) : {};

    if (url.pathname === "/api/agent-auth/device_authorization") {
      if (b.client_id !== STUB_CLIENT_ID) return refuse("device_authorization", "invalid_client");
      const dc = mint("dc");
      devices.set(dc, { clientId: b.client_id, pendingLeft: opts.devicePending ?? 0, lastPolledS: null, expiresS: nowS() + 600, consumed: false });
      return json({ device_code: dc, user_code: "BCDF-GHJK", verification_uri: `${url.origin}/connect`, expires_in: 600, interval: deviceIntervalS });
    }

    if (url.pathname === "/api/agent-auth/token") {
      const where = `token/${b.grant_type}`;
      stats.tokenRequests[String(b.grant_type)] = (stats.tokenRequests[String(b.grant_type)] ?? 0) + 1;
      // §3.2: every enrolment carries a proof whose jwk IS the new installation key.
      const enrolProof = () => {
        const ks = b.key_storage;
        if (ks !== undefined && ks !== null && ks !== "" && ks !== "software" && ks !== "hardware") return refuse(where, "invalid_request", "key_storage_invalid");
        if (req.headers.get("dpop") === null) return refuse(where, "invalid_dpop_proof", `dpop_proof_required: ${UPDATE_PLUGIN_HINT}`);
        const r = checkProof(req.headers.get("dpop"), "POST", `${url.origin}${url.pathname}`, null, null, where);
        if ("reason" in r) return r.nonce ? refuse(where, "use_dpop_nonce", undefined, 400, nonceHeaders()) : refuse(where, "invalid_dpop_proof", r.reason);
        return r.jwk;
      };
      /**
       * At REGISTRATION (the server's UNIQUE index on jkt, hit after the secret is claimed —
       * the whole transaction rolls back, so the secret is NOT consumed). C6: the client
       * answers with a FRESH key, once.
       */
      const keyTaken = (jwk: any): Response | null => {
        if ((opts.keyAlreadyEnrolled ?? 0) > 0) {
          opts.keyAlreadyEnrolled!--;
          return refuse(where, "invalid_dpop_proof", "key_already_enrolled");
        }
        if (byJkt.has(thumbprint(jwk))) return refuse(where, "invalid_dpop_proof", "key_already_enrolled");
        return null;
      };
      switch (b.grant_type) {
        case GRANT_ENROLMENT_KEY: {
          if (opts.enrolDelayMs) await Bun.sleep(opts.enrolDelayMs);
          // The server's order: the secret's format (requireKind) → key_storage → proof → claim → register.
          if (!isAgentToken("ek", b.enrolment_key)) return refuseBare(where, "invalid_grant", "enrolment_key_format");
          const jwk = enrolProof();
          if (jwk instanceof Response) return jwk;
          const left = enrolmentKeys.get(b.enrolment_key) ?? 0;
          if (left <= 0) return refuseBare(where, "invalid_grant", "enrolment_key_unknown");
          const taken = keyTaken(jwk);
          if (taken) return taken;
          enrolmentKeys.set(b.enrolment_key, left - 1);
          return json(newInstallation(jwk, b.key_storage ?? null));
        }
        case "authorization_code": {
          if (opts.codeDelayMs) await Bun.sleep(opts.codeDelayMs);
          if (!isAgentToken("ac", b.code)) return refuseBare(where, "invalid_grant", "code_format");
          const jwk = enrolProof();
          if (jwk instanceof Response) return jwk;
          const c = codes.get(b.code);
          if (!c) return refuseBare(where, "invalid_grant", "code_unknown");
          if (c.used) {
            // C9: a replayed code is a copy signal — lock what it enrolled.
            const replayed = c.instId ? insts.get(c.instId) : undefined;
            if (replayed && !replayed.revoked) lock(replayed);
            return refuseBare(where, "invalid_grant", "code_replayed");
          }
          // The server consumes the code BEFORE any check: ANY mismatch leaves it burnt (one try).
          const verifier = typeof b.code_verifier === "string" ? b.code_verifier : "";
          const why =
            b.client_id !== c.clientId
              ? "client_id"
              : b.redirect_uri !== c.redirect
                ? "redirect_uri"
                : !PKCE_VALUE_RE.test(verifier) || new Bun.CryptoHasher("sha256").update(verifier).digest("base64url") !== c.challenge
                  ? "pkce"
                  : c.dpopJkt !== null && c.dpopJkt !== thumbprint(jwk)
                    ? "dpop_jkt_mismatch" // C7
                    : null;
          if (why) {
            c.used = true;
            return refuseBare(where, "invalid_grant", why);
          }
          const taken = keyTaken(jwk);
          if (taken) return taken; // rolled back server-side: the code is NOT consumed
          c.used = true;
          const enrolled = newInstallation(jwk, b.key_storage ?? null);
          c.instId = enrolled.installation_id;
          return json(enrolled);
        }
        case GRANT_DEVICE_CODE: {
          if (opts.devicePollDelayMs) await Bun.sleep(opts.devicePollDelayMs);
          if (!isAgentToken("dc", b.device_code)) return refuseBare(where, "invalid_grant", "device_code_format");
          // Every poll proves the key (and declares key_storage), pending ones too — as the server's.
          const jwk = enrolProof();
          if (jwk instanceof Response) return jwk;
          const d = devices.get(b.device_code);
          if (!d || d.clientId !== b.client_id) return refuseBare(where, "invalid_grant", "device_code_unknown");
          if (opts.deviceDeny) return refuseBare(where, "access_denied", "denied");
          if (d.consumed) return refuseBare(where, "invalid_grant", "device_code_consumed");
          const now = nowS();
          if (opts.deviceExpire || d.expiresS <= now) return refuseBare(where, "expired_token", "expired");
          const tooFast = d.lastPolledS !== null && now - d.lastPolledS < deviceIntervalS;
          const polledBefore = d.lastPolledS;
          d.lastPolledS = now;
          if (tooFast) return refuseBare(where, "slow_down", "slow_down");
          if (d.pendingLeft > 0) {
            d.pendingLeft--;
            return refuseBare(where, "authorization_pending", "pending");
          }
          const taken = keyTaken(jwk);
          if (taken) {
            // The server's registration fails INSIDE the poll's transaction (pollDeviceCode →
            // issueInstallation, unique jkt): the whole poll rolls back — its poll stamp too,
            // so the C6 fresh-key retry right after it is not "too fast".
            d.lastPolledS = polledBefore;
            return taken;
          }
          d.consumed = true;
          return json(newInstallation(jwk, b.key_storage ?? null));
        }
        case "client_credentials": {
          if (opts.mintDelayMs) await Bun.sleep(opts.mintDelayMs);
          stats.mintBodies.push({ ...b, client_assertion: "…" });
          if ((opts.rateLimitMints ?? 0) > 0) {
            opts.rateLimitMints!--;
            return refuse(where, "rate_limited", undefined, 429, { "Retry-After": "1" });
          }
          // The server's order: the request is validated BEFORE the client is authenticated
          // (§3.1 — the CRC is checked before any database read).
          if (typeof b.join_state !== "string" || !crcOk(b.join_state)) return refuse(where, "invalid_request", "corrupt_state");
          // C4: malformed or missing attempt ⇒ attempt_invalid, NO lock.
          if (typeof b.attempt !== "string" || !ATTEMPT_RE.test(b.attempt)) return refuse(where, "invalid_request", "attempt_invalid");
          if (typeof b.session_key !== "string" || !SESSION_KEY_RE.test(b.session_key)) return refuse(where, "invalid_request", "session_key_invalid");
          const inst = authenticateClient(req, b, url, issuer, where);
          if (inst instanceof Response) return inst;
          const step = chainStep(inst, b.join_state, b.attempt);
          if (step.kind === "lock") {
            lock(inst);
            return refuse(where, "invalid_client", "installation_locked");
          }
          // E9 — resolved BEFORE committing the chain step (one transaction server-side).
          const mine = [...sessions.values()].filter((s) => s.instId === inst.id && s.key === b.session_key);
          const latest = mine[mine.length - 1];
          let sess: Sess;
          if (latest && !latest.revoked) sess = latest;
          else if (latest?.revoked === "manual" && b.reconnect !== "true") return refuse(where, "invalid_grant", "session_revoked");
          else {
            const live = [...sessions.values()].filter((s) => s.instId === inst.id && !s.revoked);
            if (live.length >= (opts.sessionCap ?? 64)) {
              const socketless = live.filter((s) => ![...sockets].some((w) => w.data.session === s.id)).sort((a, c) => a.lastUsed - c.lastUsed)[0];
              if (!socketless) return refuse(where, "invalid_grant", "session_limit");
              socketless.revoked = "evicted";
              // bridge#209: a socket that registered meanwhile is closed as EVICTED, not revoked.
              closeWhere((s) => s.id === socketless.id, "session evicted");
            }
            sess = { id: crypto.randomUUID(), instId: inst.id, key: b.session_key, revoked: null, lastUsed: Date.now() };
            sessions.set(sess.id, sess);
          }
          if (step.kind === "advance") {
            inst.prev = { state: b.join_state, attemptHash: sha256b64u(b.attempt) };
            inst.seq++;
            inst.current = makeJoinState(inst.seq);
          } else stats.replays++;
          stats.mints++;
          const at = mint("at");
          access.set(at, { session: sess.id, instId: inst.id, jkt: inst.jkt, exp: Date.now() + accessTtlS * 1000 });
          if ((opts.loseMintResponses ?? 0) > 0) {
            opts.loseMintResponses!--;
            return new Response("bad gateway", { status: 502 });
          }
          return json({ access_token: at, token_type: opts.mintTokenType ?? "DPoP", expires_in: accessTtlS, join_state: inst.current, session_id: sess.id });
        }
      }
      if (RETIRED_RFC014_GRANTS.has(b.grant_type)) return refuse(where, "invalid_grant", `rfc014_retired: ${UPDATE_PLUGIN_HINT}`);
      return refuse(where, "unsupported_grant_type");
    }

    if (url.pathname === "/api/agent-auth/revoke") {
      // Validated before authentication, in the server's order (revokeByClient +
      // authenticateWithState): scope → corrupt_state → attempt_invalid → session_key_invalid.
      if (b.scope !== "installation" && b.scope !== "session") return refuse("revoke", "invalid_request", "scope_invalid");
      if (typeof b.join_state !== "string" || !crcOk(b.join_state)) return refuse("revoke", "invalid_request", "corrupt_state");
      if (b.attempt !== undefined && b.attempt !== null && (typeof b.attempt !== "string" || !ATTEMPT_RE.test(b.attempt))) {
        return refuse("revoke", "invalid_request", "attempt_invalid");
      }
      if (b.scope === "session" && (typeof b.session_key !== "string" || !SESSION_KEY_RE.test(b.session_key))) {
        return refuse("revoke", "invalid_request", "session_key_invalid");
      }
      const inst = authenticateClient(req, b, url, issuer, "revoke");
      if (inst instanceof Response) return inst;
      // §3.5: verified, NOT advanced. A stale state locks — a thief cannot revoke to hide.
      const verified = b.join_state === inst.current || (inst.prev && b.join_state === inst.prev.state && typeof b.attempt === "string" && sha256b64u(b.attempt) === inst.prev.attemptHash);
      if (!verified) {
        lock(inst);
        return refuse("revoke", "invalid_client", "installation_locked");
      }
      stats.revokes.push({ id: inst.id, scope: b.scope });
      if (b.scope === "session") {
        // An unknown or already-dead session key is a no-op — still `{"ok":true}` (C11).
        for (const s of sessions.values()) if (s.instId === inst.id && s.key === b.session_key && !s.revoked) s.revoked = "client_revoked";
        closeWhere((s) => s.instId === inst.id && s.key === b.session_key, "session revoked");
      } else {
        inst.revoked = "installation_revoked";
        closeWhere((s) => s.instId === inst.id, "installation revoked");
      }
      return json(opts.revokeBodyEmpty ? {} : { ok: true }); // C11
    }
    return refuse(url.pathname, "not_found", undefined, 404);
  }

  /** /api/* as a resource server (§3.4). Returns null when the request is authorized. */
  function checkResource(req: Request): Response | null {
    stats.apiHits++;
    const url = new URL(req.url);
    const authz = req.headers.get("authorization") ?? "";
    const www = (e: string) => ({ "WWW-Authenticate": `DPoP error="${e}", algs="ES256"` });
    if (!authz.startsWith("DPoP ")) return refuse("api", "invalid_token", "not DPoP", 401, www("invalid_token"));
    const at = authz.slice(5);
    const a = liveAccess(at);
    if (opts.always401 || !a) return refuse("api", "invalid_token", undefined, 401, www("invalid_token"));
    const proof = checkProof(req.headers.get("dpop"), req.method, `${url.origin}${url.pathname}`, a.jkt, at, "api");
    if ("reason" in proof) {
      if (proof.nonce) return refuse("api", "use_dpop_nonce", undefined, 401, { ...www("use_dpop_nonce"), ...nonceHeaders() });
      return refuse("api", "invalid_dpop_proof", proof.reason, 401, www("invalid_dpop_proof"));
    }
    return null;
  }

  /** WS `auth` / `reauth` frames (E11): `{token, dpop}`, htm GET, htu = origin + /ws. */
  function wsCheck(origin: string, f: any) {
    const a = liveAccess(typeof f.token === "string" ? f.token : null);
    if (!a) return null;
    // RFC-016 C15: nonces are token-endpoint/HTTP only — never on WS frames.
    const p = checkProof(f.dpop ?? null, "GET", `${origin}/ws`, a.jkt, f.token, "ws", false);
    if ("reason" in p) {
      stats.refusals.push(`ws:${p.reason}`);
      return null;
    }
    // Stricter than the server (which ignores it): a WS proof is bound by iat + jti
    // alone, so a client that puts the HTTP nonce on it has mixed the two up (C15).
    if (parseJws(f.dpop)?.claims.nonce !== undefined) {
      stats.refusals.push("ws:nonce_on_ws");
      return null;
    }
    return a;
  }

  return {
    /** Every answer, a redirect or a 502 included, carries the stub clock's Date. */
    handleAuth: async (req: Request) => {
      const r = await handleAuth(req);
      return r && withDate(r);
    },
    checkResource: (req: Request) => {
      const r = checkResource(req);
      return r && withDate(r);
    },
    withDate,
    wsCheck,
    stats,
    sockets,
    sessions,
    /** A fresh enrolment key in the server's format, redeemable `uses` times. */
    mintEnrolmentKey(uses = 1): string {
      const key = mintAgentToken("ek");
      enrolmentKeys.set(key, uses);
      return key;
    },
    /** Register a specific key; it must be in the server's format (`brg_ek_…` + CRC) or it could never be redeemed. */
    addEnrolmentKey(key: string, uses = 1) {
      if (!isAgentToken("ek", key)) throw new Error(`stub: ${key} is not a well-formed enrolment key (use mintEnrolmentKey())`);
      enrolmentKeys.set(key, uses);
    },
    /** Register a key directly, as if a login had happened (the test holds the private half). */
    enrolDirect: (publicJwk: any) => newInstallation(publicJwk),
    installation: (id: string) => insts.get(id),
    isRevoked: (id: string) => insts.get(id)?.revoked ?? null,
    revokeInstallation(id: string) {
      insts.get(id)!.revoked = "installation_revoked";
      closeWhere((s) => s.instId === id, "installation revoked");
    },
    deactivateAgent(id: string) {
      insts.get(id)!.revoked = "agent_deactivated";
      closeWhere((s) => s.instId === id, "installation revoked");
    },
    revokeSession(sid: string) {
      sessions.get(sid)!.revoked = "manual";
      closeWhere((s) => s.id === sid, "session revoked");
    },
    /** The next N WS `auth` frames are closed `code` (default 4001 "Invalid token"), whatever they carry. Queued. */
    rejectNextWsAuths(n: number, code = 4001, reason = "Invalid token") {
      for (let i = 0; i < n; i++) forcedAuthCloses.push({ code, reason });
    },
    /** The forced close for this `auth` frame, if one is queued. */
    takeForcedAuthClose: () => forcedAuthCloses.shift() ?? null,
    closeLikeServer,
    /** bridge#209: the session was evicted at the live-session cap — its sockets close 4008 "session evicted". */
    evictSession(sid: string) {
      sessions.get(sid)!.revoked = "evicted";
      closeWhere((s) => s.id === sid, "session evicted");
    },
    rotateNonce() {
      nonce = `n-${randomBase62(16)}`;
    },
    closeAll(code: number, reason: string) {
      for (const ws of sockets) closeLikeServer(ws, code, reason);
    },
    expireAccess: () => access.clear(),
    sessionsFor: (instId: string) => [...sessions.values()].filter((s) => s.instId === instId),
  };
}

export type AuthCore = ReturnType<typeof createAuthCore>;

export function startAuthStub(opts: StubOptions = {}) {
  const core = createAuthCore(opts);
  const server = Bun.serve<{ session: string }>({
    // 127.0.0.1, never the wildcard default — see stub-loopback-bind.test.ts.
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws" && srv.upgrade(req, { data: { session: "" } })) return;
      const auth = await core.handleAuth(req);
      if (auth) return auth;
      if (url.pathname.startsWith("/api/")) return core.checkResource(req) ?? core.withDate(Response.json([]));
      return core.withDate(new Response("not found", { status: 404 }));
    },
    websocket: {
      open(ws: any) {
        core.stats.wsOpens++;
        core.sockets.add(ws);
      },
      close(ws: any) {
        core.sockets.delete(ws);
      },
      message(ws: any, raw) {
        let f: any = {};
        try {
          f = JSON.parse(String(raw));
        } catch {
          return;
        }
        const origin = `http://127.0.0.1:${server.port}`;
        if (f.type === "auth") {
          core.stats.authTokens.push(f.token);
          const forced = core.takeForcedAuthClose();
          if (forced) {
            core.stats.refusals.push(`ws:forced ${forced.code}`);
            return core.closeLikeServer(ws, forced.code, forced.reason);
          }
          const a = core.wsCheck(origin, f);
          if (!a) return core.closeLikeServer(ws, 4001, "Invalid token");
          ws.data.session = a.session;
          const s = core.sessions.get(a.session)!;
          ws.send(JSON.stringify({ type: "authenticated", data: { agentId: "agent-1", agentName: "Agent", contextId: s.key } }));
        } else if (f.type === "reauth") {
          const a = core.wsCheck(origin, f);
          if (!a) return core.closeLikeServer(ws, 4001, "Invalid token");
          core.stats.reauths++;
          core.stats.reauthTokens.push(f.token);
          ws.data.session = a.session;
          ws.send(JSON.stringify({ type: "reauthenticated", data: { expiresAt: a.exp } }));
        }
      },
    },
  });
  return {
    ...core,
    url: `http://127.0.0.1:${server.port}`,
    issuer: `http://127.0.0.1:${server.port}/api/agent-auth`,
    liveSockets: () => core.sockets.size,
    stop: () => server.stop(true),
  };
}
