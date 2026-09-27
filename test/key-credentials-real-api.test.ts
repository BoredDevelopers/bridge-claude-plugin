/**
 * RFC-016 against the REAL Bridge API — the plugin 0.25 release gate (plan Task 9).
 *
 * Every other suite runs against test/agent-auth-stub.ts, which is written to be STRICTER
 * than the server. This file is the proof that the stub's strictness and the server agree:
 * the plugin's own code (server.ts over stdio, the CredentialManager, auth/core) against
 * a real `packages/api` process on a scratch Postgres database.
 *
 * ── HOW TO RUN IT ─────────────────────────────────────────────────────────────────────
 *   BRIDGE_API_DIR            <bridge checkout WITH the RFC-016 server slice>/packages/api
 *   BRIDGE_TEST_PG_ADMIN_URL  a Postgres 18 to create scratch databases in. Defaults to the
 *                             server repo's test container (:5433 — `docker compose -f
 *                             docker-compose.test.yml up -d` in that repo).
 *
 *   BRIDGE_API_DIR=…/bridge-wt-rfc016/packages/api bun test test/key-credentials-real-api.test.ts
 *
 * ⚠️ It SKIPS when either is missing — and then proves nothing. When they ARE set but the
 * server predates RFC-016, the first test FAILS on discovery (no client_credentials): a
 * wired-up run against the wrong server must be red, never quietly green.
 *
 * ⚠️ BRIDGE_API_URL (the plugin) MUST EQUAL BRIDGE_PUBLIC_URL (the server), origin for
 * origin: the server checks every proof's `htu` and every assertion's `aud` against its
 * PUBLIC URL, never against the request's Host. Each server below is started with
 * BRIDGE_PUBLIC_URL = the exact origin the plugin is given; the "mismatch" test pins the
 * symptom when they differ (refused at discovery, with the two origins named).
 *
 * Server env this file sets (all documented server knobs): ANON_BURST (failures are
 * charged per IP; the wire probe fails on purpose), AGENT_MAX_LIVE_SESSIONS=2 (E9 cap
 * eviction), BRIDGE_TEST_GATE_DIR (the server's own file gate — holds a mint between its
 * eviction and its commit), and for the expiry test AGENT_ACCESS_TOKEN_TTL_S +
 * WS_EXPIRY_GRACE_S.
 *
 * Seeding runs in a SUBPROCESS (fixtures/real-api-seed.ts), through the API's own modules:
 * `bun test` shares one process across files, and the API's db module binds its pool at import.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  TokenClient,
  Clock,
  generateSoftwareKey,
  softwareSigner,
  dpopProof,
  clientAssertion,
  CLIENT_ASSERTION_TYPE,
  wsHtu,
  httpHtu,
  joinStateSeq,
  supportsKeyCredentials,
  OAuthError,
  classifyTokenError,
  type Signer,
} from "../auth/core";
import { randomB64url } from "../auth/core/b64url";
import { readInstallation, readKey, readState, readAttempt, writeKey, writeState, writeInstallation } from "../auth/node/store";
import { CredentialManager } from "../auth/manager";
import { resolveProfile } from "../auth/profile";
import { PLUGIN_CLIENT_ID } from "../auth/client-id";
import { startAuthStub } from "./agent-auth-stub";

const API_DIR = process.env.BRIDGE_API_DIR ?? "";
const HAVE_SERVER = !!API_DIR && (await Bun.file(join(API_DIR, "src/index.ts")).exists().catch(() => false));
// Same default as the server repo's scripts/run-tests.ts.
const ADMIN_URL = process.env.BRIDGE_TEST_PG_ADMIN_URL ?? "postgres://bridge:bridge-test-not-a-secret@127.0.0.1:5433/bridge";
async function pgReachable(): Promise<boolean> {
  try {
    const probe = new Bun.SQL(ADMIN_URL);
    await probe`SELECT 1`;
    await probe.close();
    return true;
  } catch {
    return false;
  }
}
const HAVE_PG = HAVE_SERVER ? await pgReachable() : false;
const SERVER_TS = join(import.meta.dir, "..", "server.ts");
const SEED_TS = join(import.meta.dir, "fixtures", "real-api-seed.ts");
const AUTH_SECRET = "test-secret-at-least-32-characters-long";
const GRANT_EK = "urn:bridge:params:oauth:grant-type:enrolment-key";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── the scratch database (one per run) ─────────────────────────────────────────────────

let dbName = "";
let dbUrl = "";
let admin: InstanceType<typeof Bun.SQL> | null = null;
let sql: InstanceType<typeof Bun.SQL> | null = null;
let seed: { cookie: string; userId: string; sessionId: string; keys: string[] } = { cookie: "", userId: "", sessionId: "", keys: [] };
let keyTurn = 0;
/** An enrolment key for agent `me` (50 uses each, minted by the API's credential module). */
const enrolmentKey = () => seed.keys[keyTurn++ % seed.keys.length]!;

const q = async (text: string, params: unknown[] = []): Promise<any[]> => [...(await sql!.unsafe(text, params as any[]))];
const grantRow = async (id: string) => (await q(`SELECT * FROM agent_grants WHERE id = $1`, [id]))[0];
const sessionsOf = (installationId: string, sessionKey?: string) =>
  q(
    `SELECT id, session_key, revoked_at, revoke_reason FROM agent_grants
      WHERE parent_id = $1 AND kind = 'session' ${sessionKey ? "AND session_key = $2" : ""} ORDER BY created_at, id`,
    sessionKey ? [installationId, sessionKey] : [installationId]
  );

// ── real API processes ─────────────────────────────────────────────────────────────────

interface Api {
  url: string;
  log: () => string;
  stop: () => Promise<void>;
}
const apis = new Set<Api>();

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port!;
  s.stop(true);
  return p;
}

async function startApi(env: Record<string, string> = {}): Promise<Api> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(["bun", join(API_DIR, "src/index.ts")], {
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
      PORT: String(port),
      // THE deployment identity: proofs' htu and assertions' aud are judged against it.
      BRIDGE_PUBLIC_URL: url,
      FORGE_OIDC_CLIENT_SECRET: "x",
      BETTER_AUTH_SECRET: AUTH_SECRET,
      NODE_ENV: "test",
      ANON_BURST: "1000",
      AGENT_MAX_LIVE_SESSIONS: "2",
      OPENCLAW_GATEWAY_URL: "http://127.0.0.1:1",
      BRIDGE_SHUTDOWN_GRACE_MS: "150",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  for (const s of [proc.stdout, proc.stderr]) {
    void (async () => {
      const dec = new TextDecoder();
      for await (const c of s as any) out += dec.decode(c);
    })();
  }
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try {
      up = (await fetch(`${url}/api/health`)).ok;
    } catch {}
    if (!up) await Bun.sleep(250);
  }
  const api: Api = {
    url,
    log: () => out,
    stop: async () => {
      apis.delete(api);
      proc.kill();
      await proc.exited;
    },
  };
  apis.add(api);
  if (!up) {
    await api.stop();
    throw new Error(`bridge API did not start:\n${out.slice(-3000)}`);
  }
  return api;
}

// ── the plugin (server.ts over stdio, exactly as Claude Code runs it) ──────────────────

interface Plugin {
  client: Client;
  notices: string[];
  stderr: () => string;
  status: () => Promise<any>;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  connected: () => Promise<boolean>;
  close: () => Promise<void>;
}

async function plugin(apiUrl: string, dir: string, env: Record<string, string>): Promise<Plugin> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [SERVER_TS],
    env: {
      ...process.env,
      BRIDGE_API_URL: apiUrl,
      BRIDGE_TOKEN: "",
      BRIDGE_AUTOCONNECT: "1",
      BRIDGE_BROWSER: "none",
      BRIDGE_STATE_DIR: dir,
      CLAUDE_PLUGIN_DATA: dir,
      CLAUDE_PROJECT_DIR: dir,
      CLAUDE_CODE_SSE_PORT: "",
      BRIDGE_TEST: "1",
      ...env,
    } as Record<string, string>,
    stderr: "pipe",
  });
  let log = "";
  transport.stderr?.on("data", (b: Buffer) => {
    log += b.toString();
  });
  const client = new Client({ name: "real-api", version: "0" }, { capabilities: {} });
  const notices: string[] = [];
  client.fallbackNotificationHandler = async (n: any) => {
    if (typeof n?.params?.content === "string") notices.push(n.params.content);
  };
  await client.connect(transport);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  const status = async () => JSON.parse((await call("status")).content[0].text);
  return {
    client,
    notices,
    stderr: () => log,
    status,
    call,
    connected: async () => (await status()).websocket === "connected",
    close: () => client.close().catch(() => {}),
  };
}

/** A CredentialManager on `dir` in THIS process — a sibling Claude session on the same machine. */
function sibling(apiUrl: string, dir: string, sessionKey: string): CredentialManager {
  return new CredentialManager({
    profile: resolveProfile(dir, undefined),
    envApiUrl: apiUrl,
    staleStaticTokenPresent: false,
    enrolmentKey: "",
    sessionKey: () => sessionKey,
    sessionKeyReady: async () => {},
    platform: "test",
    clientVersion: "0.0.0",
    env: {},
    onAccessRotated: () => {},
    onLoggedIn: () => {},
    onLoggedOut: () => {},
    notify: () => {},
    log: () => {},
    prompt: { available: () => false, show: () => {}, confirm: async () => false },
  });
}

/** Enrol a profile directory through auth/core + the real store (what a completed login writes). */
async function enrolDir(apiUrl: string, dir: string): Promise<string> {
  const tc = new TokenClient({ clock: new Clock(), clientId: PLUGIN_CLIENT_ID });
  const meta = await tc.discover(apiUrl);
  const { privateJwk, signer } = await generateSoftwareKey();
  const g = await tc.enrolWithKey(meta, signer, { enrolmentKey: enrolmentKey(), installationName: "real-api test" });
  writeKey(dir, privateJwk);
  writeState(dir, g.join_state);
  writeInstallation(dir, { apiUrl, installationId: g.installation_id, jkt: signer.jkt, keyStorage: "software" });
  return g.installation_id;
}

async function until(pred: () => boolean | Promise<boolean>, ms: number, stepMs = 100): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await Bun.sleep(stepMs);
  }
  return !!(await pred());
}

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const human = (apiUrl: string, method: string, path: string, body?: unknown) =>
  fetch(`${apiUrl}${path}`, {
    method,
    headers: { Cookie: seed.cookie, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });

// ── the wire probe: the SAME requests against the stub and the server ──────────────────

interface Sock {
  frames: any[];
  closed: () => { code: number; reason: string } | null;
  send: (o: unknown) => void;
  wait: (pred: () => boolean, ms?: number) => Promise<boolean>;
  close: () => void;
}
async function openSocket(base: string): Promise<Sock> {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`);
  const frames: any[] = [];
  let closed: { code: number; reason: string } | null = null;
  ws.addEventListener("message", (e) => {
    try {
      frames.push(JSON.parse(String(e.data)));
    } catch {}
  });
  ws.addEventListener("close", (e) => {
    closed = { code: e.code, reason: e.reason };
  });
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true });
    ws.addEventListener("error", j, { once: true });
  });
  return {
    frames,
    closed: () => closed,
    send: (o) => ws.send(JSON.stringify(o)),
    wait: (pred, ms = 5000) => until(pred, ms, 20),
    close: () => ws.close(),
  };
}

/**
 * Every wire point the strict stub asserts, asked of `base` with the plugin's own proof /
 * assertion code. Answers are reduced to what a client can switch on (status, error,
 * error_description, the WWW-Authenticate error, close code + reason, error frames), so
 * the stub and the server can be compared with `toEqual`.
 */
async function probeWire(base: string, ek: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const clock = new Clock();
  const issuer = `${base}/api/agent-auth`;
  const tokenUrl = `${issuer}/token`;
  const revokeUrl = `${issuer}/revoke`;
  const post = async (url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    clock.observe(r.headers.get("date"));
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json };
  };
  const oauth = (r: { status: number; json: any }) => ({ status: r.status, error: r.json?.error ?? null, error_description: r.json?.error_description ?? null });
  const proof = (s: Signer, htu: string) => dpopProof(s, clock, { htm: "POST", htu });

  const meta = (await (await fetch(`${base}/.well-known/oauth-authorization-server/api/agent-auth`)).json()) as any;
  out.discovery = {
    issuer: meta.issuer === issuer,
    token_endpoint: meta.token_endpoint === tokenUrl,
    revocation_endpoint: meta.revocation_endpoint === revokeUrl,
    authorization_endpoint: meta.authorization_endpoint === `${issuer}/authorize`,
    device_authorization_endpoint: meta.device_authorization_endpoint === `${issuer}/device_authorization`,
    grant_types: [...meta.grant_types_supported].sort(),
    token_auth: meta.token_endpoint_auth_methods_supported,
    token_auth_algs: meta.token_endpoint_auth_signing_alg_values_supported,
    revoke_auth: meta.revocation_endpoint_auth_methods_supported,
    dpop_algs: meta.dpop_signing_alg_values_supported,
    done_uri: typeof meta.bridge_connect_done_uri === "string",
  };

  // ── enrolment (§3.2) ──
  const enrolBody = (extra: Record<string, unknown> = {}) => ({ grant_type: GRANT_EK, enrolment_key: ek, installation_name: "wire probe", ...extra });
  const k1 = await generateSoftwareKey();
  out.enrol_without_proof = oauth(await post(tokenUrl, enrolBody()));
  out.enrol_bad_key_storage = oauth(await post(tokenUrl, enrolBody({ key_storage: "tpm" }), { DPoP: await proof(k1.signer, tokenUrl) }));
  out.enrol_proof_wrong_htu = oauth(await post(tokenUrl, enrolBody(), { DPoP: await proof(k1.signer, revokeUrl) }));
  out.enrol_bad_enrolment_key = oauth(
    await post(tokenUrl, enrolBody({ enrolment_key: "brg_ek_nope" }), { DPoP: await proof(k1.signer, tokenUrl) })
  );
  const e1 = await post(tokenUrl, enrolBody({ key_storage: "software" }), { DPoP: await proof(k1.signer, tokenUrl) });
  out.enrol = {
    status: e1.status,
    installation_id: UUID.test(e1.json?.installation_id ?? ""),
    join_state_seq: joinStateSeq(e1.json?.join_state ?? ""),
    agent: typeof e1.json?.agent?.id === "string" && typeof e1.json?.agent?.name === "string",
    workspace: typeof e1.json?.workspace?.id === "string",
  };
  out.enrol_key_already_enrolled = oauth(await post(tokenUrl, enrolBody(), { DPoP: await proof(k1.signer, tokenUrl) }));
  const inst: string = e1.json.installation_id;
  const S0: string = e1.json.join_state;

  // ── mint (§3.3) ──
  type M = { signer?: Signer; state?: string; attempt?: string | null; sessionKey?: string; aud?: string; proofHtu?: string; proofBy?: Signer; reconnect?: boolean; clientId?: string };
  const mint = async (o: M = {}) => {
    const signer = o.signer ?? k1.signer;
    const body: Record<string, unknown> = {
      grant_type: "client_credentials",
      client_id: o.clientId ?? inst,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(signer, clock, inst, o.aud ?? issuer),
      join_state: o.state ?? S0,
      session_key: o.sessionKey ?? "wire-s1",
      ...(o.reconnect ? { reconnect: "true" } : {}),
    };
    if (o.attempt !== null) body.attempt = o.attempt ?? randomB64url(32);
    return post(tokenUrl, body, { DPoP: await proof(o.proofBy ?? signer, o.proofHtu ?? tokenUrl) });
  };
  const flip = (s: string) => s.slice(0, -1) + (s.endsWith("A") ? "B" : "A");
  out.mint_corrupt_state = oauth(await mint({ state: flip(S0) }));
  out.mint_attempt_missing = oauth(await mint({ attempt: null }));
  out.mint_attempt_malformed = oauth(await mint({ attempt: "short" }));
  out.mint_session_key_invalid = oauth(await mint({ sessionKey: "not a key!" }));
  out.mint_unknown_client = oauth(await mint({ clientId: crypto.randomUUID() }));
  out.mint_assertion_wrong_aud = oauth(await mint({ aud: tokenUrl }));
  out.mint_proof_wrong_htu = oauth(await mint({ proofHtu: revokeUrl }));
  const other = await generateSoftwareKey();
  out.mint_proof_by_another_key = oauth(await mint({ proofBy: other.signer }));
  const A = randomB64url(32);
  const m1 = await mint({ attempt: A });
  out.mint = {
    status: m1.status,
    token_type: m1.json?.token_type,
    expires_in: typeof m1.json?.expires_in === "number" && m1.json.expires_in > 0,
    access_token: /^brg_at_/.test(m1.json?.access_token ?? ""),
    join_state_seq: joinStateSeq(m1.json?.join_state ?? ""),
    session_id: UUID.test(m1.json?.session_id ?? ""),
  };
  const replay = await mint({ attempt: A });
  out.mint_replay_same_attempt = {
    status: replay.status,
    same_successor: replay.json?.join_state === m1.json?.join_state,
    same_session: replay.json?.session_id === m1.json?.session_id,
  };
  const S1: string = m1.json.join_state;
  const m2 = await mint({ state: S1 });
  out.mint_advance = { status: m2.status, join_state_seq: joinStateSeq(m2.json?.join_state ?? ""), same_session: m2.json?.session_id === m1.json?.session_id };
  const S2: string = m2.json.join_state;
  const at: string = m2.json.access_token;

  // ── the resource server (§3.4, C16) ──
  const get = async (path: string, headers: Record<string, string>) => {
    const r = await fetch(`${base}${path}`, { headers });
    clock.observe(r.headers.get("date"));
    await r.arrayBuffer();
    const www = r.headers.get("www-authenticate");
    return { status: r.status, www: www ? (/^DPoP\b/.test(www) ? (/error="([^"]+)"/.exec(www)?.[1] ?? "DPoP") : "other") : null };
  };
  const resProof = (htm: string, path: string, token = at) => dpopProof(k1.signer, clock, { htm, htu: httpHtu(base, path), accessToken: token });
  const okProof = await resProof("GET", "/api/channels");
  out.resource_ok = await get("/api/channels", { Authorization: `DPoP ${at}`, DPoP: okProof });
  out.resource_proof_replayed = await get("/api/channels", { Authorization: `DPoP ${at}`, DPoP: okProof });
  out.resource_query_not_signed = await get("/api/channels?limit=5", { Authorization: `DPoP ${at}`, DPoP: await resProof("GET", "/api/channels?limit=5") });
  out.resource_bearer_scheme = await get("/api/channels", { Authorization: `Bearer ${at}`, DPoP: await resProof("GET", "/api/channels") });
  out.resource_no_proof = await get("/api/channels", { Authorization: `DPoP ${at}` });
  out.resource_wrong_htu = await get("/api/channels", { Authorization: `DPoP ${at}`, DPoP: await resProof("GET", "/api/agents") });
  out.resource_wrong_htm = await get("/api/channels", { Authorization: `DPoP ${at}`, DPoP: await resProof("POST", "/api/channels") });
  out.resource_wrong_ath = await get("/api/channels", {
    Authorization: `DPoP ${at}`,
    DPoP: await dpopProof(k1.signer, clock, { htm: "GET", htu: httpHtu(base, "/api/channels"), accessToken: m1.json.access_token }),
  });

  // ── the WebSocket (E11, C15) ──
  const wsProof = (token: string, htu = wsHtu(base)) => dpopProof(k1.signer, clock, { htm: "GET", htu, accessToken: token });
  const errors = (s: Sock) => s.frames.filter((f) => f.type === "error").map((f) => f.data?.message ?? f.message ?? null);
  const s1 = await openSocket(base);
  s1.send({ type: "auth", token: at, dpop: await wsProof(at) });
  await s1.wait(() => s1.frames.some((f) => f.type === "authenticated") || s1.closed() !== null);
  out.ws_auth = { authenticated: s1.frames.some((f) => f.type === "authenticated"), closed: s1.closed() };
  const m3 = await mint({ state: S2 });
  const S3: string = m3.json.join_state;
  s1.send({ type: "reauth", token: m3.json.access_token, dpop: await wsProof(m3.json.access_token) });
  await s1.wait(() => s1.frames.some((f) => f.type === "reauthenticated") || s1.closed() !== null);
  out.ws_reauth = { reauthenticated: s1.frames.some((f) => f.type === "reauthenticated"), closed: s1.closed() };
  for (const [name, frame] of [
    ["ws_auth_no_proof", { type: "auth", token: m3.json.access_token }],
    ["ws_auth_wrong_htu", { type: "auth", token: m3.json.access_token, dpop: await wsProof(m3.json.access_token, `${base}/api/ws`) }],
    ["ws_auth_http_proof", { type: "auth", token: m3.json.access_token, dpop: await resProof("GET", "/api/channels", m3.json.access_token) }],
  ] as const) {
    const s = await openSocket(base);
    s.send(frame);
    await s.wait(() => s.closed() !== null);
    out[name] = { errors: errors(s), closed: s.closed() };
  }
  const s2 = await openSocket(base);
  s2.send({ type: "auth", token: m3.json.access_token, dpop: await wsProof(m3.json.access_token) });
  await s2.wait(() => s2.frames.some((f) => f.type === "authenticated") || s2.closed() !== null);
  s2.send({ type: "reauth", token: m3.json.access_token, dpop: await wsProof(m3.json.access_token, `${base}/api/ws`) });
  await s2.wait(() => s2.closed() !== null);
  out.ws_reauth_bad_proof = { errors: errors(s2), closed: s2.closed() };

  // ── client revoke (§3.5, C11) ──
  const revoke = async (b: Record<string, unknown>) =>
    post(
      revokeUrl,
      {
        client_id: inst,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: await clientAssertion(k1.signer, clock, inst, issuer),
        join_state: S3,
        ...b,
      },
      { DPoP: await proof(k1.signer, revokeUrl) }
    );
  out.revoke_scope_invalid = oauth(await revoke({ scope: "everything" }));
  out.revoke_session_key_invalid = oauth(await revoke({ scope: "session", session_key: "no way!" }));
  const rs = await revoke({ scope: "session", session_key: "wire-s1" });
  await s1.wait(() => s1.closed() !== null);
  out.revoke_session = { status: rs.status, body: rs.json, socket: s1.closed(), socket_errors: errors(s1) };
  const ru = await revoke({ scope: "session", session_key: "never-used" });
  out.revoke_unknown_session = { status: ru.status, body: ru.json };
  const after = await mint({ state: S3 });
  out.mint_after_client_session_revoke = { status: after.status, new_session: !!after.json?.session_id && after.json.session_id !== m1.json.session_id };
  const S4: string = after.json.join_state;

  // ── retired / unknown grants (E13) ──
  out.grant_refresh_token = oauth(await post(tokenUrl, { grant_type: "refresh_token", refresh_token: "brg_rt_x" }));
  out.grant_rfc014_session = oauth(await post(tokenUrl, { grant_type: "urn:bridge:params:oauth:grant-type:session", installation_token: "brg_it_x" }));
  out.grant_unknown = oauth(await post(tokenUrl, { grant_type: "urn:example:nope" }));

  // ── a copy: a stale state LOCKS (E6d/E8) ──
  const s3 = await openSocket(base);
  s3.send({ type: "auth", token: after.json.access_token, dpop: await wsProof(after.json.access_token) });
  await s3.wait(() => s3.frames.some((f) => f.type === "authenticated") || s3.closed() !== null);
  out.mint_stale_state_locks = oauth(await mint({ state: S1 }));
  await s3.wait(() => s3.closed() !== null);
  out.lock_closes_sockets = { socket: s3.closed(), socket_errors: errors(s3) };
  out.mint_after_lock = oauth(await mint({ state: S4 }));
  out.revoke_after_lock = oauth(await post(
    revokeUrl,
    {
      client_id: inst,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(k1.signer, clock, inst, issuer),
      join_state: S4,
      scope: "installation",
    },
    { DPoP: await proof(k1.signer, revokeUrl) }
  ));
  out.resource_after_lock = await get("/api/channels", { Authorization: `DPoP ${after.json.access_token}`, DPoP: await resProof("GET", "/api/channels", after.json.access_token) });

  // ── an installation revoked by its own client ──
  const k2 = await generateSoftwareKey();
  const e2 = await post(tokenUrl, enrolBody(), { DPoP: await proof(k2.signer, tokenUrl) });
  const inst2: string = e2.json.installation_id;
  const ri = await post(
    revokeUrl,
    {
      client_id: inst2,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(k2.signer, clock, inst2, issuer),
      join_state: e2.json.join_state,
      scope: "installation",
    },
    { DPoP: await proof(k2.signer, revokeUrl) }
  );
  out.revoke_installation = { status: ri.status, body: ri.json };
  const m4 = await post(
    tokenUrl,
    {
      grant_type: "client_credentials",
      client_id: inst2,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(k2.signer, clock, inst2, issuer),
      join_state: e2.json.join_state,
      attempt: randomB64url(32),
      session_key: "wire-s9",
    },
    { DPoP: await proof(k2.signer, tokenUrl) }
  );
  out.mint_after_installation_revoke = oauth(m4);
  for (const s of [s1, s2, s3]) s.close();
  return out;
}

// ── the suite ──────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAVE_SERVER || !HAVE_PG)("RFC-016 against the real API", () => {
  let api: Api;
  /** The server's test gate (src/test-hooks.ts __testGate): `<label>.armed` / `.entered` / `.release` files. */
  let gateDir = "";

  beforeAll(async () => {
    gateDir = tmp("keys-gate-");
    dbName = `bridge_plugin_keys_${Date.now()}_${process.pid}`;
    admin = new Bun.SQL(ADMIN_URL);
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    dbUrl = ADMIN_URL.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    const r = Bun.spawnSync(["bun", SEED_TS, API_DIR, AUTH_SECRET], { env: { ...process.env, DATABASE_URL: dbUrl } });
    if (r.exitCode !== 0) throw new Error(`seed failed:\n${r.stderr.toString().slice(-3000)}`);
    seed = JSON.parse(r.stdout.toString().trim().split("\n").pop()!);
    sql = new Bun.SQL(dbUrl);
    api = await startApi({ BRIDGE_TEST_GATE_DIR: gateDir });
  }, 60_000);

  afterAll(async () => {
    for (const a of [...apis]) await a.stop().catch(() => {});
    await sql?.close().catch(() => {});
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
      await admin.close().catch(() => {});
    }
    if (gateDir) rmSync(gateDir, { recursive: true, force: true });
  }, 30_000);

  const arm = (label: string) => writeFileSync(join(gateDir, `${label}.armed`), "");
  const entered = (label: string) => until(() => existsSync(join(gateDir, `${label}.entered`)), 10_000, 5);
  const release = (label: string) => writeFileSync(join(gateDir, `${label}.release`), "");

  test("the server speaks RFC-016 (discovery advertises client_credentials) — a pre-RFC-016 server is RED here, never a skip", async () => {
    const tc = new TokenClient({ clock: new Clock(), clientId: PLUGIN_CLIENT_ID });
    expect(supportsKeyCredentials(await tc.discover(api.url)), "server predates RFC-016 (no client_credentials)").toBe(true);
  });

  test("wire drift: the strict stub and the real server give the SAME answer at every point the stub asserts", async () => {
    const stub = startAuthStub();
    try {
      const fromStub = await probeWire(stub.url, stub.mintEnrolmentKey(10));
      const fromServer = await probeWire(api.url, enrolmentKey());
      const rows = Object.keys({ ...fromStub, ...fromServer }).map((k) => {
        const a = JSON.stringify(fromStub[k]);
        const b = JSON.stringify(fromServer[k]);
        return `${a === b ? "same " : "DRIFT"} ${k}\n      stub:   ${a}\n      server: ${b}`;
      });
      process.stderr.write(`\n── wire drift (stub vs ${api.url}) ──\n${rows.join("\n")}\n`);
      expect(fromServer).toEqual(fromStub);
    } finally {
      stub.stop();
    }
  }, 60_000);

  test("enrolment key → mint (private_key_jwt + DPoP) → WS auth with a proof → HTTP with a proof; the session is reused per session_key across a restart", async () => {
    const dir = tmp("keys-real-enrol-");
    const p1 = await plugin(api.url, dir, { BRIDGE_ENROLMENT_KEY: enrolmentKey(), BRIDGE_SESSION_KEY: "enrol-s1" });
    try {
      expect(await until(p1.connected, 20_000), `never authenticated:\n${p1.stderr()}`).toBe(true);
      const inst = readInstallation(dir)!;
      const row = await grantRow(inst.installationId);
      expect(row.kind).toBe("installation");
      expect(row.enrolled_via).toBe("enrolment_key");
      expect(row.jkt).toBe(inst.jkt);
      expect(row.revoked_at).toBeNull();
      expect(Number(row.js_seq)).toBe(joinStateSeq(readState(dir)!)!);
      expect(Number(row.js_seq)).toBe(1);
      expect(readAttempt(dir)).toBeNull();
      // HTTP with a proof, through the plugin's apiFetch.
      const lc = await p1.call("list_channels");
      expect(lc.isError, JSON.stringify(lc.content)).not.toBe(true);
      const first = await sessionsOf(inst.installationId, "enrol-s1");
      expect(first).toHaveLength(1);
    } finally {
      await p1.close();
    }
    // Same machine, same session key, new process: a mint REUSES the session (E9).
    const p2 = await plugin(api.url, dir, { BRIDGE_SESSION_KEY: "enrol-s1" });
    try {
      expect(await until(p2.connected, 20_000), p2.stderr()).toBe(true);
      const inst = readInstallation(dir)!;
      const rows = await sessionsOf(inst.installationId, "enrol-s1");
      expect(rows).toHaveLength(1);
      expect(rows[0].revoked_at).toBeNull();
      expect(Number((await grantRow(inst.installationId)).js_seq)).toBe(2);
      expect(joinStateSeq(readState(dir)!)).toBe(2);
    } finally {
      await p2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  test("loopback login: the authorize URL carries dpop_jkt, the owner approves, the code is exchanged with a proof by THAT key", async () => {
    const dir = tmp("keys-real-loopback-");
    const p = await plugin(api.url, dir, { BRIDGE_SESSION_KEY: "loopback-s1" });
    try {
      const out = (await p.call("login", { mode: "browser" })).content[0].text as string;
      const authorizeUrl = /(http:\/\/\S+\/api\/agent-auth\/authorize\?\S+)/.exec(out)?.[1];
      expect(authorizeUrl, out).toBeTruthy();
      const jkt = new URL(authorizeUrl!).searchParams.get("dpop_jkt");
      expect(jkt).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // The browser: /authorize → the consent page (web origin) with the request id.
      const az = await fetch(authorizeUrl!, { redirect: "manual" });
      expect(az.status).toBe(302);
      const requestId = new URL(az.headers.get("location")!).pathname.split("/").pop()!;
      const ap = await human(api.url, "POST", `/api/agent-auth/requests/${requestId}/approve`, { agentId: "me" });
      expect(ap.status).toBe(200);
      const back = ((await ap.json()) as any).redirect as string;
      expect(back.startsWith("http://127.0.0.1:")).toBe(true);
      // The browser follows the redirect to the plugin's loopback listener, which holds it
      // until the code is exchanged, then sends it to Bridge's /connect/done.
      const done = await fetch(back, { redirect: "manual" });
      expect(done.headers.get("location") ?? "").toContain("result=connected");
      expect(await until(p.connected, 20_000), p.stderr()).toBe(true);
      const inst = readInstallation(dir)!;
      expect(inst.jkt).toBe(jkt!);
      const row = await grantRow(inst.installationId);
      expect(row.enrolled_via).toBe("loopback");
      expect(row.jkt).toBe(jkt);
      expect(Number(row.js_seq)).toBe(joinStateSeq(readState(dir)!)!);
      expect(p.notices.some((n) => /this machine is connected/.test(n))).toBe(true);
    } finally {
      await p.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("device code: the owner enters the user code and approves; the plugin's next poll (with a proof) collects the installation", async () => {
    const dir = tmp("keys-real-device-");
    const p = await plugin(api.url, dir, { BRIDGE_SESSION_KEY: "device-s1" });
    try {
      const out = (await p.call("login", { mode: "device" })).content[0].text as string;
      const userCode = /\b([B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4})\b/.exec(out)?.[1];
      expect(userCode, out).toBeTruthy();
      const look = await human(api.url, "POST", "/api/agent-auth/device/lookup", { user_code: userCode });
      expect(look.status).toBe(200);
      const { requestId } = (await look.json()) as any;
      const ap = await human(api.url, "POST", `/api/agent-auth/requests/${requestId}/approve`, { agentId: "me" });
      expect(ap.status).toBe(200);
      // RFC 8628 interval: the server says 5 s.
      expect(await until(p.connected, 30_000), p.stderr()).toBe(true);
      const inst = readInstallation(dir)!;
      const row = await grantRow(inst.installationId);
      expect(row.enrolled_via).toBe("device");
      expect(row.jkt).toBe(inst.jkt);
      expect(Number(row.js_seq)).toBe(joinStateSeq(readState(dir)!)!);
    } finally {
      await p.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  /**
   * Measured with the lock bypassed: nothing locks — the four read the same state AND the same
   * attempt file, so the server answers three of them as replays (E6b) — but the chain advances
   * ONCE (js_seq 1). The lock is what makes each mint a step of its own; js_seq is the guard.
   */
  test("four sessions of ONE machine minting at once serialize on the installation lock: each advances the real chain once (js_seq 4), none locks", async () => {
    const dir = tmp("keys-real-race-");
    try {
      const inst = await enrolDir(api.url, dir);
      const ms = [1, 2, 3, 4].map((i) => sibling(api.url, dir, `race-s${i}`));
      const tokens = await Promise.all(ms.map((m) => m.accessToken()));
      for (const m of ms) m.stop();
      expect(new Set(tokens).size).toBe(4);
      const row = await grantRow(inst);
      expect(row.revoked_at).toBeNull();
      expect(Number(row.js_seq)).toBe(4);
      expect(joinStateSeq(readState(dir)!)).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a mint whose answer is lost is retried with the SAME attempt: the server replays (same successor, chain not advanced twice, no lock)", async () => {
    const dir = tmp("keys-real-replay-");
    const realFetch = globalThis.fetch;
    let lost = 0;
    try {
      const inst = await enrolDir(api.url, dir);
      // The answer to the first mint is lost AFTER the server committed it (a proxy 502).
      globalThis.fetch = (async (input: any, init?: any) => {
        const res = await realFetch(input, init);
        if (lost === 0 && String(input).endsWith("/api/agent-auth/token") && String(init?.body ?? "").includes('"client_credentials"')) {
          lost++;
          await res.arrayBuffer();
          return new Response("bad gateway", { status: 502 });
        }
        return res;
      }) as typeof fetch;
      const m = sibling(api.url, dir, "replay-s1");
      await expect(m.accessToken()).rejects.toThrow();
      expect(lost).toBe(1);
      const attempt = readAttempt(dir);
      expect(attempt, "the attempt must stay on disk for the replay").not.toBeNull();
      expect(Number((await grantRow(inst)).js_seq)).toBe(1); // the server DID advance
      expect(joinStateSeq(readState(dir)!)).toBe(0); // …the machine never heard
      const tok = await m.accessToken();
      m.stop();
      expect(tok).toMatch(/^brg_at_/);
      const row = await grantRow(inst);
      expect(row.revoked_at).toBeNull();
      expect(Number(row.js_seq)).toBe(1); // replayed, not advanced again
      expect(readState(dir)).toBe(row.js_current);
      expect(readAttempt(dir)).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a copied key + state used on a second machine LOCKS the installation: this machine gets 4008 \"installation locked\", deletes its key, and is told", async () => {
    const dir = tmp("keys-real-lock-");
    const p1 = await plugin(api.url, dir, { BRIDGE_ENROLMENT_KEY: enrolmentKey(), BRIDGE_SESSION_KEY: "lock-s1" });
    try {
      expect(await until(p1.connected, 20_000), p1.stderr()).toBe(true);
      const inst = readInstallation(dir)!.installationId;
      // The thief: a byte-for-byte copy of the profile, used first — it advances the chain.
      // `stale` is the same bytes as the legitimate machine still holds them.
      const loot = tmp("keys-real-loot-");
      const stale = tmp("keys-real-stale-");
      const tc = new TokenClient({ clock: new Clock(), clientId: PLUGIN_CLIENT_ID });
      const meta = await tc.discover(api.url);
      const mintFrom = async (d: string, sessionKey: string) =>
        tc.mint(meta, await softwareSigner(readKey(d)!), {
          installationId: inst,
          joinState: readState(d)!,
          attempt: randomB64url(32),
          sessionKey,
          reconnect: false,
        });
      try {
        cpSync(dir, loot, { recursive: true });
        cpSync(dir, stale, { recursive: true });
        expect((await mintFrom(loot, "thief")).token_type).toBe("DPoP");
        // The legitimate machine's next mint presents the now-stale state: refused AND locked.
        // (Minted from a copy, not by a second plugin process: that process would delete the
        // files itself on the refusal, and the socket's 4008 handling would go unproven.)
        const refused = await mintFrom(stale, "lock-s2").catch((e) => e);
        expect(classifyTokenError(refused)).toEqual({ kind: "installation_gone", reason: "installation_locked" });
      } finally {
        rmSync(loot, { recursive: true, force: true });
        rmSync(stale, { recursive: true, force: true });
      }
      const row = await grantRow(inst);
      expect(row.revoked_at, "copy was not detected").not.toBeNull();
      expect(row.revoke_reason).toBe("reuse_detected");
      // THIS machine: its live socket is closed 4008 "installation locked" — it deletes its key and says so.
      expect(await until(() => p1.stderr().includes("WebSocket closed (4008 installation locked)"), 10_000), p1.stderr()).toBe(true);
      expect(await until(() => p1.notices.some((n) => /locked/i.test(n)), 10_000), "p1 not told about the lock").toBe(true);
      expect(await until(() => !existsSync(join(dir, "key.json")), 5_000), "p1 kept the key of a locked installation").toBe(true);
      expect(existsSync(join(dir, "installation.json"))).toBe(false);
      expect(existsSync(join(dir, "state"))).toBe(false);
      expect(await p1.connected()).toBe(false);
    } finally {
      await p1.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  test("an owner revokes the session: 4008 \"session revoked\" → no mint of its own → /bridge:connect mints with reconnect=true and opens a NEW session", async () => {
    const dir = tmp("keys-real-revoke-");
    const p = await plugin(api.url, dir, { BRIDGE_ENROLMENT_KEY: enrolmentKey(), BRIDGE_SESSION_KEY: "revoke-s1" });
    try {
      expect(await until(p.connected, 20_000), p.stderr()).toBe(true);
      const inst = readInstallation(dir)!.installationId;
      const [s] = await sessionsOf(inst, "revoke-s1");
      const del = await human(api.url, "DELETE", `/api/agents/me/installations/${inst}/sessions/${s.id}`);
      expect(del.status).toBe(200);
      expect(await until(() => p.stderr().includes("WebSocket closed (4008 session revoked)"), 10_000), p.stderr()).toBe(true);
      expect(await until(() => p.notices.some((n) => n.includes("/bridge:connect")), 10_000), JSON.stringify(p.notices)).toBe(true);
      // Blocked: nothing re-opens the session on its own.
      await Bun.sleep(3000);
      expect(await p.connected()).toBe(false);
      expect(await sessionsOf(inst, "revoke-s1")).toHaveLength(1);
      expect((await p.status()).auth.session).toMatch(/revoked/);
      // The person reconnects: reconnect=true — the server opens a new session for the key.
      await p.call("connect");
      expect(await until(p.connected, 20_000), `reconnect=true did not open a new session:\n${p.stderr()}`).toBe(true);
      const rows = await sessionsOf(inst, "revoke-s1");
      expect(rows).toHaveLength(2);
      expect(rows[0].revoke_reason).toBe("manual");
      expect(rows[1].revoked_at).toBeNull();
    } finally {
      await p.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  test("the live-session cap evicts this session (AGENT_MAX_LIVE_SESSIONS=2): 4008 \"session evicted\" → a new session at once, no block, nothing told to the model", async () => {
    const dir = tmp("keys-real-evict-");
    const p = await plugin(api.url, dir, { BRIDGE_ENROLMENT_KEY: enrolmentKey(), BRIDGE_SESSION_KEY: "evict-s1" });
    const sibs: CredentialManager[] = [];
    try {
      expect(await until(p.connected, 20_000), p.stderr()).toBe(true);
      const inst = readInstallation(dir)!.installationId;
      // Socketless (the victim must have no live socket when the server chooses it) —
      // the process keeps its access token in memory.
      await p.call("disconnect");
      expect(await until(async () => !(await p.connected()), 5_000)).toBe(true);
      const s2 = sibling(api.url, dir, "evict-s2");
      sibs.push(s2);
      await s2.accessToken(); // live: s1, s2 (= the cap)
      // The third session evicts the LRU socketless one (s1). The server's gate holds that
      // mint between the eviction and its commit — the plugin's socket registers under s1
      // meanwhile, so the commit's close reaches it (the server's own C20 test shape).
      const s3 = sibling(api.url, dir, "evict-s3");
      sibs.push(s3);
      arm("evict");
      const minting = s3.accessToken();
      expect(await entered("evict"), "the eviction gate was never reached").toBe(true);
      await p.call("connect");
      expect(await until(p.connected, 8_000), p.stderr()).toBe(true);
      release("evict");
      await minting;
      expect(await until(() => p.stderr().includes("WebSocket closed (4008 session evicted)"), 10_000), p.stderr()).toBe(true);
      // Minted again on its own: a NEW session for the same key, reconnected.
      expect(
        await until(async () => (await sessionsOf(inst, "evict-s1")).some((r: any) => r.revoked_at === null) && (await p.connected()), 20_000),
        p.stderr()
      ).toBe(true);
      const rows = await sessionsOf(inst, "evict-s1");
      expect(rows[0].revoke_reason).toBe("evicted");
      expect(rows.at(-1).revoked_at).toBeNull();
      expect(p.notices.filter((n) => /evict|revoked|bridge:connect/i.test(n))).toEqual([]);
      expect((await p.status()).auth.session).toBeUndefined();
    } finally {
      for (const m of sibs) m.stop();
      await p.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  test("logout: the client revoke answers {\"ok\":true}, the installation is gone server-side, the chain is verified NOT advanced", async () => {
    const dir = tmp("keys-real-logout-");
    const p = await plugin(api.url, dir, { BRIDGE_ENROLMENT_KEY: enrolmentKey(), BRIDGE_SESSION_KEY: "logout-s1" });
    try {
      expect(await until(p.connected, 20_000), p.stderr()).toBe(true);
      const inst = readInstallation(dir)!.installationId;
      const seqBefore = Number((await grantRow(inst)).js_seq);
      const out = (await p.call("logout")).content[0].text as string;
      // manager.logout → TokenClient.revoke, which throws unless the body is exactly {"ok":true} (C11).
      expect(out).toMatch(/revoked in Bridge/);
      const row = await grantRow(inst);
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoke_reason).toBe("client_revoked");
      expect(Number(row.js_seq)).toBe(seqBefore);
      expect(existsSync(join(dir, "key.json"))).toBe(false);
      const list = (await (await human(api.url, "GET", "/api/agents/me/installations")).json()) as any;
      expect(list.installations.map((i: any) => i.id)).not.toContain(inst);
      expect(await until(async () => !(await p.connected()), 10_000)).toBe(true);
    } finally {
      await p.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("retired RFC-014 grants answer invalid_grant rfc014_retired, which the plugin classifies update_required", async () => {
    for (const body of [
      { grant_type: "refresh_token", refresh_token: "brg_rt_x" },
      { grant_type: "urn:bridge:params:oauth:grant-type:session", installation_token: "brg_it_x", session_key: "x" },
    ]) {
      const r = await fetch(`${api.url}/api/agent-auth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await r.json()) as any;
      expect(r.status).toBe(400);
      expect(j.error).toBe("invalid_grant");
      expect(j.error_description).toStartWith("rfc014_retired:");
      expect(classifyTokenError(new OAuthError({ error: j.error, status: r.status, description: j.error_description }))).toEqual({ kind: "update_required" });
    }
  });

  test("BRIDGE_API_URL ≠ the server's BRIDGE_PUBLIC_URL: refused at discovery, naming both origins — the enrolment key is not spent", async () => {
    const port = new URL(api.url).port;
    const dir = tmp("keys-real-mismatch-");
    const key = enrolmentKey();
    const usesBefore = await q(`SELECT uses FROM agent_enrolment_keys WHERE key_hash IS NOT NULL ORDER BY id`);
    const p = await plugin(`http://localhost:${port}`, dir, { BRIDGE_ENROLMENT_KEY: key, BRIDGE_SESSION_KEY: "mismatch-s1" });
    try {
      expect(await until(() => p.notices.some((n) => /could not enrol/.test(n)), 15_000), p.stderr()).toBe(true);
      const n = p.notices.find((x) => /could not enrol/.test(x))!;
      expect(n).toContain(`does not match http://localhost:${port}`);
      expect(n).toContain(api.url);
      expect(readInstallation(dir)).toBeNull();
      expect(await q(`SELECT uses FROM agent_enrolment_keys WHERE key_hash IS NOT NULL ORDER BY id`)).toEqual(usesBefore);
    } finally {
      await p.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  describe("a short access-token life (AGENT_ACCESS_TOKEN_TTL_S=20, WS_EXPIRY_GRACE_S=2)", () => {
    test("an HTTP use re-mints and reauths the socket IN-BAND (the server re-arms its expiry timer); a token that runs out closes 4009 and the plugin reconnects on a fresh one, same session", async () => {
      const short = await startApi({ AGENT_ACCESS_TOKEN_TTL_S: "20", WS_EXPIRY_GRACE_S: "2" });
      const dir = tmp("keys-real-ttl-");
      const p = await plugin(short.url, dir, { BRIDGE_ENROLMENT_KEY: enrolmentKey(), BRIDGE_SESSION_KEY: "ttl-s1" });
      try {
        expect(await until(p.connected, 20_000), p.stderr()).toBe(true);
        const T = Date.now(); // token 1 was minted just before this: its 4009 is due by T + 22 s
        await Bun.sleep(4_000);
        // Inside the 60 s expiry slack every use mints; the live socket gets the new token by `reauth`.
        const lc = await p.call("list_channels");
        expect(lc.isError, JSON.stringify(lc.content)).not.toBe(true);
        const mints = () => (p.stderr().match(/bridge auth: minted for session/g) ?? []).length;
        expect(mints()).toBeGreaterThanOrEqual(2);
        // Past token 1's 4009: had the reauth been refused (4001) or ignored (4009 on token 1), the socket would be closed.
        await Bun.sleep(Math.max(0, T + 23_500 - Date.now()));
        expect(p.stderr()).not.toContain("WebSocket closed");
        expect(await p.connected()).toBe(true);
        // Token 2 (minted ≈ T+4 s) runs out at ≈ T+26 s — before the plugin's 15 s ticker (≥ T+29.5 s) renews it.
        expect(await until(() => p.stderr().includes("WebSocket closed (4009 token expired)"), 15_000), p.stderr()).toBe(true);
        expect(await until(p.connected, 15_000), p.stderr()).toBe(true);
        const inst = readInstallation(dir)!.installationId;
        const rows = await sessionsOf(inst, "ttl-s1");
        expect(rows).toHaveLength(1);
        expect(rows[0].revoked_at).toBeNull();
        expect(p.notices).toEqual([]);
      } finally {
        await p.close();
        await short.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 90_000);
  });
});
