/**
 * RFC-016 through the real MCP server (server.ts over stdio) against the strict
 * agent-auth stub: the socket authenticates with a DPoP token + proof, 4009 mints
 * again, a scheduled mint reauths in-band with a proof, 4008 stops per reason, an
 * HTTP 401 mints once, every HTTP request is proven, and /bridge:login switches the
 * live connection.
 *
 * Task 7 ports the RFC-014 suite scenario for scenario (same names where the
 * behaviour is the same); Task 8 adds the RFC-016-only behaviour (C14 4001 re-mint,
 * "installation locked", 0.23 retirement at boot, …).
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, cpSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { startAuthStub, type StubOptions } from "./agent-auth-stub";
import { readInstallation, readState } from "../auth/node/store";
import { joinStateSeq } from "../auth/core/join-state";
import { enrolledProfile } from "./key-fixtures";
import { CredentialManager } from "../auth/manager";
import { resolveProfile } from "../auth/profile";

const SERVER = new URL("../server.ts", import.meta.url).pathname;
const SESSION = "11111111-2222-3333-4444-555555555555";

async function withPlugin<T>(
  stub: ReturnType<typeof startAuthStub>,
  env: Record<string, string>,
  fn: (client: Client, dir: string, notices: () => string[], prompts: string[], stderr: () => string) => Promise<T>,
  preset?: (dir: string) => void | Promise<void>,
  /** When set, the client supports elicitation and answers every prompt this way. */
  answer?: "accept" | "decline"
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "login-e2e-"));
  await preset?.(dir);
  const transport = new StdioClientTransport({
    command: "bun",
    args: [SERVER],
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dir,
      BRIDGE_STATE_DIR: dir,
      BRIDGE_API_URL: stub.url,
      BRIDGE_TOKEN: "",
      BRIDGE_AUTOCONNECT: "1",
      BRIDGE_BROWSER: "none",
      CLAUDE_CODE_SESSION_ID: SESSION,
      CLAUDE_CODE_SSE_PORT: "",
      // Enables the BRIDGE_TEST_* timing knobs (server.ts testKnob); a test that proves
      // they are ignored in production overrides it.
      BRIDGE_TEST: "1",
      ...env,
    } as Record<string, string>,
    stderr: "pipe",
  });
  let log = "";
  transport.stderr?.on("data", (b: Buffer) => {
    log += b.toString();
  });
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: answer ? { elicitation: {} } : {} });
  const prompts: string[] = [];
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (req: any) => {
      prompts.push(req.params.message);
      return { action: answer, content: {} };
    });
  }
  const seen: string[] = [];
  client.fallbackNotificationHandler = async (n: any) => {
    if (typeof n?.params?.content === "string") seen.push(n.params.content);
  };
  try {
    await client.connect(transport);
    return await fn(client, dir, () => seen, prompts, () => log);
  } finally {
    await client.close().catch(() => {});
    stub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const enrolledIn = (stub: ReturnType<typeof startAuthStub>) => async (dir: string) => {
  await enrolledProfile(stub, dir);
};

/** Another holder of a profile directory: a thief's copy, or a sibling session on this machine. */
function otherManager(stub: ReturnType<typeof startAuthStub>, dir: string, sessionKey: string): CredentialManager {
  return new CredentialManager({
    profile: resolveProfile(dir, undefined),
    envApiUrl: stub.url,
    staleStaticTokenPresent: false,
    enrolmentKey: "",
    sessionKey: () => sessionKey,
    sessionKeyReady: async () => {},
    platform: "x",
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

async function status(client: Client): Promise<any> {
  const r: any = await client.callTool({ name: "status", arguments: {} });
  return JSON.parse(r.content[0].text);
}

async function until(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await Bun.sleep(25);
  }
  return pred();
}

describe("plugin on key credentials (RFC-016)", () => {
  test("BRIDGE_ENROLMENT_KEY enrols at boot; the socket authenticates with a DPoP token + a proof for GET /ws", async () => {
    const stub = startAuthStub();
    const ek = stub.mintEnrolmentKey();
    await withPlugin(stub, { BRIDGE_ENROLMENT_KEY: ek }, async (client, dir) => {
      expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
      expect(stub.stats.authTokens[0]).toStartWith("brg_at_");
      expect(stub.stats.refusals.filter((r) => r.startsWith("ws:"))).toEqual([]);
      expect(stub.stats.enrols).toBe(1);
      expect(joinStateSeq(readState(dir)!)).toBe(1);
      expect(existsSync(join(dir, "sessions", `${SESSION}.json`))).toBe(false); // no RFC-014 session file any more
      const s = await status(client);
      expect(s.websocket).toBe("connected");
      expect(s.auth).toMatchObject({ profile: "default", credential: "installation", key_storage: "software" });
      expect(stub.stats.mintBodies[0]!.client_version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(stub.stats.mintBodies[0]!.session_key).toBe(SESSION);
    });
  }, 30_000);

  test("4009 (expired): reconnects with a freshly minted token, same session, no lock", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (_c, dir) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        stub.closeAll(4009, "token expired");
        expect(await until(() => stub.stats.authTokens.length >= 2, 10_000)).toBe(true);
        expect(stub.stats.authTokens[1]).not.toBe(stub.stats.authTokens[0]);
        expect(stub.sessionsFor(readInstallation(dir)!.installationId)).toHaveLength(1);
        expect(stub.stats).toMatchObject({ mints: 2, locks: 0 });
        expect(stub.stats.refusals.filter((r) => r.startsWith("ws:"))).toEqual([]);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test('1011 "grant check failed" (a server DB hiccup): reconnects soon with the SAME token — no mint', async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (client) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        stub.closeAll(1011, "grant check failed");
        // Transient curve: the first retry is ≤ 1 s away (never the ≥ 30 s credential step).
        expect(await until(() => stub.stats.authTokens.length >= 2, 3_000)).toBe(true);
        expect(stub.stats.authTokens[1]).toBe(stub.stats.authTokens[0]);
        expect(stub.stats.mints).toBe(1);
        expect(await until(() => stub.liveSockets() === 1, 3_000)).toBe(true);
        expect((await status(client)).websocket).toBe("connected");
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("the error frame the server sends before a 4001 / 1011 / 4009 is not told to the model — the close handler owns those (a recovered 4001, a 1011 and a 4009 are silent)", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (client, _dir, notices) => {
        const connected = async () => (await status(client)).websocket === "connected";
        expect(await until(connected, 5_000)).toBe(true);
        stub.closeAll(4001, "Invalid token");
        expect(await until(() => stub.stats.authTokens.length >= 2, 5_000)).toBe(true);
        expect(await until(connected, 5_000)).toBe(true);
        stub.closeAll(1011, "grant check failed");
        expect(await until(() => stub.stats.authTokens.length >= 3, 5_000)).toBe(true);
        expect(await until(connected, 5_000)).toBe(true);
        stub.closeAll(4009, "token expired");
        expect(await until(() => stub.stats.authTokens.length >= 4, 5_000)).toBe(true);
        expect(await until(connected, 5_000)).toBe(true);
        expect(notices()).toEqual([]);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("C14: 4001 drops the token and re-mints ONCE immediately; a second 4001 in a row takes the slow backoff (from its FIRST step) and says /bridge:login once; /bridge:connect re-arms", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (client, _dir, notices) => {
        const connected = async () => (await status(client)).websocket === "connected";
        const refusedNotices = () => notices().filter((n) => n.includes("Bridge refused this session's access token"));
        expect(await until(connected, 5_000)).toBe(true);
        stub.rejectNextWsAuths(1); // the immediate retry is refused too
        stub.closeAll(4001, "Invalid token");
        // Immediate: well inside the credential class's ≥ 30 s first step (the transient ≥ 0.5 s is not used either).
        expect(await until(() => stub.stats.authTokens.length >= 2, 2_000)).toBe(true);
        expect(stub.stats.authTokens[1]).not.toBe(stub.stats.authTokens[0]);
        expect(stub.stats.mints).toBe(2);
        // The second 4001 (before any `authenticated`): slow, and the model is told once.
        expect(await until(() => refusedNotices().length === 1, 5_000)).toBe(true);
        expect(refusedNotices()[0]).toContain("/bridge:login");
        // C1: the immediate re-mint did not spend attempt 1 — the slow retry is the 30–60 s step.
        const ws = String((await status(client)).websocket);
        expect(ws).toContain("4001");
        expect(ws).toContain("reconnect attempt 1,");
        const inS = Number(/in (\d+)s/.exec(ws)?.[1]);
        expect(inS).toBeGreaterThanOrEqual(25);
        expect(inS).toBeLessThanOrEqual(60);
        await Bun.sleep(1_000); // a negative: nothing inside the slow step
        expect(stub.stats.authTokens).toHaveLength(2);
        expect(refusedNotices()).toHaveLength(1);
        // The person acts: /bridge:connect re-arms the one immediate re-mint.
        await client.callTool({ name: "connect", arguments: {} });
        expect(await until(connected, 5_000)).toBe(true);
        stub.closeAll(4001, "Invalid token");
        expect(await until(() => stub.stats.authTokens.length >= 4, 2_000)).toBe(true);
        expect(stub.stats.authTokens[3]).not.toBe(stub.stats.authTokens[2]);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("C14 flap guard: a 4001 soon after the immediate re-mint's auth is NOT immediate again; one after the socket stayed up long enough is", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      { BRIDGE_TEST_REMINT_REARM_MS: "1500" },
      async (client) => {
        const connected = async () => (await status(client)).websocket === "connected";
        expect(await until(connected, 5_000)).toBe(true);
        stub.closeAll(4001, "Invalid token");
        expect(await until(() => stub.stats.authTokens.length >= 2, 2_000)).toBe(true);
        expect(await until(connected, 5_000)).toBe(true);
        // Straight away (well under the re-arm window): slow.
        stub.closeAll(4001, "Invalid token");
        await Bun.sleep(1_000); // a negative: no immediate reconnect
        expect(stub.stats.authTokens).toHaveLength(2);
        await client.callTool({ name: "connect", arguments: {} }); // back up (and re-armed)
        expect(await until(connected, 5_000)).toBe(true);
        stub.closeAll(4001, "Invalid token"); // spends the re-armed immediate re-mint
        expect(await until(() => stub.stats.authTokens.length >= 4, 2_000)).toBe(true);
        expect(await until(connected, 5_000)).toBe(true);
        await Bun.sleep(1_800); // stable past the (test) re-arm window: re-armed without anyone acting
        stub.closeAll(4001, "Invalid token");
        expect(await until(() => stub.stats.authTokens.length >= 5, 2_000)).toBe(true);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("C14 re-arm is per socket: a long-lived socket the liveness watchdog detached does not lend its uptime to the next socket's pre-auth 4001", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      { BRIDGE_TEST_REMINT_REARM_MS: "1500", BRIDGE_TEST_LIVENESS_MS: "3000" },
      async (client) => {
        const connected = async () => (await status(client)).websocket === "connected";
        expect(await until(connected, 5_000)).toBe(true);
        stub.closeAll(4001, "Invalid token"); // spends the one immediate re-mint
        expect(await until(() => stub.stats.authTokens.length >= 2, 2_000)).toBe(true);
        expect(await until(connected, 5_000)).toBe(true);
        const opens = stub.stats.wsOpens;
        // The stub sends nothing after `authenticated`: the watchdog detaches this socket
        // (> 1.5 s up) after ~3 s of silence and reconnects. That reconnect's auth is refused 4001.
        stub.rejectNextWsAuths(1);
        expect(await until(() => stub.stats.wsOpens > opens, 8_000)).toBe(true);
        expect(await until(() => stub.stats.authTokens.length >= 3, 5_000)).toBe(true);
        // Not re-armed (this socket was never authenticated): the slow step, not an immediate re-mint.
        await Bun.sleep(1_000); // a negative
        expect(stub.stats.authTokens).toHaveLength(3);
        expect(String((await status(client)).websocket)).toContain("4001");
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("a 4008 on the AUTH path (the server's grant re-check): its error frame is not told as a server error; the lock notice is told exactly once", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (client, dir, notices) => {
        expect(await until(async () => (await status(client)).websocket === "connected", 5_000)).toBe(true);
        stub.rejectNextWsAuths(1, 4008, "installation locked");
        stub.closeAll(1011, "grant check failed"); // the reconnect's auth meets the lock
        expect(await until(() => notices().some((n) => n.includes("credential copy detected")), 5_000)).toBe(true);
        expect(await until(() => readInstallation(dir) === null, 5_000)).toBe(true);
        await Bun.sleep(500); // a negative: nothing else arrives
        expect(notices().filter((n) => n.includes("credential copy detected"))).toHaveLength(1);
        expect(notices().filter((n) => n.includes("server error"))).toEqual([]);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("C14 after an in-band reauth: a 4001 drops the REAUTHED token and mints — it never re-presents it", async () => {
    // 62 s tokens sit inside the 60 s expiry slack after 2 s, so a tool call then mints
    // and reauths in-band. The reauthed token is itself fresh for 2 s — the immediate
    // reconnect lands well inside that: re-presenting it would be ACCEPTED here, so only
    // the mint count can tell.
    const stub = startAuthStub({ accessTtlS: 62 });
    await withPlugin(
      stub,
      {},
      async (client) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        await Bun.sleep(2_300); // time itself is the precondition: the token must enter the expiry slack
        await client.callTool({ name: "list_channels", arguments: {} });
        expect(await until(() => stub.stats.reauthTokens.length >= 1, 3_000)).toBe(true);
        const reauthed = stub.stats.reauthTokens[0]!;
        const mints = stub.stats.mints;
        stub.closeAll(4001, "Invalid token");
        expect(await until(() => stub.stats.authTokens.length >= 2, 3_000)).toBe(true);
        expect(stub.stats.authTokens[1]).not.toBe(reauthed);
        expect(stub.stats.mints).toBe(mints + 1);
      },
      enrolledIn(stub)
    );
  }, 40_000);

  test("a scheduled mint hands the live socket the new token in-band (reauth + proof), no reconnect", async () => {
    const stub = startAuthStub({ accessTtlS: 8 });
    await withPlugin(
      stub,
      {},
      async () => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        expect(await until(() => stub.stats.reauths >= 1, 25_000)).toBe(true);
        expect(stub.stats.authTokens).toHaveLength(1);
      },
      enrolledIn(stub)
    );
  }, 40_000);

  test("4008 session revoked: stops, says /bridge:connect, and connect mints with reconnect=true into a new session", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (client, dir, notices) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        const inst = readInstallation(dir)!.installationId;
        stub.revokeSession(stub.sessionsFor(inst)[0]!.id);
        expect(await until(() => notices().some((n) => n.includes("/bridge:connect starts a new session")), 5_000)).toBe(true);
        await Bun.sleep(1_000); // a negative
        expect(stub.stats.authTokens).toHaveLength(1);
        // A tool call in between must not sneak a mint through.
        await client.callTool({ name: "list_channels", arguments: {} });
        expect(stub.stats.mintBodies).toHaveLength(1);
        await client.callTool({ name: "connect", arguments: {} });
        expect(await until(() => stub.stats.authTokens.length >= 2, 10_000)).toBe(true);
        expect(stub.stats.mintBodies.at(-1)!.reconnect).toBe("true");
        expect(stub.sessionsFor(inst)).toHaveLength(2);
        expect(stub.stats.locks).toBe(0);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("4008 session evicted (the agent hit its live-session cap): drops the token, mints a NEW session without reconnect=true, reconnects at once — no block, no notice", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (client, dir, notices) => {
        expect(await until(async () => (await status(client)).websocket === "connected", 5_000)).toBe(true);
        const inst = readInstallation(dir)!.installationId;
        stub.evictSession(stub.sessionsFor(inst)[0]!.id);
        expect(await until(() => stub.stats.authTokens.length >= 2, 5_000)).toBe(true);
        expect(stub.stats.authTokens[1]).not.toBe(stub.stats.authTokens[0]);
        expect(stub.stats.mintBodies).toHaveLength(2);
        expect(stub.stats.mintBodies[1]!.reconnect).toBeUndefined();
        expect(stub.sessionsFor(inst)).toHaveLength(2);
        expect(await until(async () => (await status(client)).websocket === "connected", 5_000)).toBe(true);
        expect(notices()).toEqual([]);
        // Not blocked: a tool call works without /bridge:connect.
        const r: any = await client.callTool({ name: "list_channels", arguments: {} });
        expect(r.isError).not.toBe(true);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("4008 installation revoked: key + state deleted, told to run /bridge:login, no reconnect", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (client, dir, notices) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        stub.revokeInstallation(readInstallation(dir)!.installationId);
        expect(await until(() => notices().some((n) => n.includes("/bridge:login")), 5_000)).toBe(true);
        expect(readInstallation(dir)).toBeNull();
        expect(existsSync(join(dir, "key.json"))).toBe(false);
        await Bun.sleep(1_000); // a negative
        expect(stub.stats.authTokens).toHaveLength(1);
        expect((await status(client)).configured).toBe(false);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("a COPY of the credential is used elsewhere first: this machine's next mint is locked, its socket closes 4008 'installation locked', the key is deleted, the person told", async () => {
    const stub = startAuthStub();
    const loot = mkdtempSync(join(tmpdir(), "loot-"));
    try {
      await withPlugin(
        stub,
        {},
        async (client, dir, notices) => {
          expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
          cpSync(dir, loot, { recursive: true });
          const thief = otherManager(stub, loot, "thief");
          await thief.accessToken();
          thief.stop();
          stub.expireAccess(); // the plugin's next request must mint — with its now-stale state
          await client.callTool({ name: "list_channels", arguments: {} });
          expect(await until(() => notices().some((n) => n.includes("credential copy detected")), 5_000)).toBe(true);
          // The mint's refusal deleted the key (the tool call said so); the 4008 that
          // followed found nothing left, so its notice does not claim a deletion.
          expect(notices().find((n) => n.includes("credential copy detected"))).not.toContain("deleted here");
          expect(stub.stats.locks).toBe(1);
          expect(existsSync(join(dir, "key.json"))).toBe(false);
          expect(existsSync(join(dir, "state"))).toBe(false);
          await Bun.sleep(1_000); // a negative: no reconnect may follow
          expect(stub.stats.authTokens).toHaveLength(1);
          expect((await status(client)).configured).toBe(false);
        },
        enrolledIn(stub)
      );
    } finally {
      rmSync(loot, { recursive: true, force: true });
    }
  }, 30_000);

  test("a STALE copy minting elsewhere locks the installation: the 4008 'installation locked' alone deletes this machine's files (§5.4) and says so — no reconnect", async () => {
    const stub = startAuthStub();
    const loot = mkdtempSync(join(tmpdir(), "loot-"));
    try {
      await withPlugin(
        stub,
        {},
        async (client, dir, notices) => {
          expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
          cpSync(dir, loot, { recursive: true }); // the copy: state at seq 1
          stub.expireAccess();
          await client.callTool({ name: "list_channels", arguments: {} }); // this machine moves on to seq 2
          expect(stub.stats.mints).toBe(2);
          const thief = otherManager(stub, loot, "thief");
          await thief.accessToken().catch(() => {}); // seq 1 again, another attempt ⇒ E6d lock
          thief.stop();
          expect(stub.stats.locks).toBe(1);
          expect(await until(() => notices().some((n) => n.includes("credential copy detected")), 5_000)).toBe(true);
          expect(notices().find((n) => n.includes("credential copy detected"))).toContain("its key was deleted here");
          expect(await until(() => !existsSync(join(dir, "key.json")), 5_000)).toBe(true);
          expect(readInstallation(dir)).toBeNull();
          expect(existsSync(join(dir, "state"))).toBe(false);
          await Bun.sleep(1_000); // a negative: no reconnect may follow
          expect(stub.stats.authTokens).toHaveLength(1);
          expect((await status(client)).configured).toBe(false);
        },
        enrolledIn(stub)
      );
    } finally {
      rmSync(loot, { recursive: true, force: true });
    }
  }, 30_000);

  test("locked by ANOTHER process of this machine: the 4008 'installation locked' alone signs this one out, and a later /bridge:login elsewhere is picked up", async () => {
    const stub = startAuthStub();
    const loot = mkdtempSync(join(tmpdir(), "loot2-"));
    try {
      await withPlugin(
        stub,
        { BRIDGE_TEST_CREDENTIAL_WATCH_MS: "200" },
        async (client, dir, notices) => {
          expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
          cpSync(dir, loot, { recursive: true });
          const thief = otherManager(stub, loot, "thief");
          await thief.accessToken();
          thief.stop();
          const sibling = otherManager(stub, dir, "sibling"); // another Claude session on this machine
          await sibling.accessToken().catch(() => {});
          sibling.stop();
          expect(stub.stats.locks).toBe(1);
          expect(await until(() => notices().some((n) => n.includes("credential copy detected")), 5_000)).toBe(true);
          expect((await status(client)).configured).toBe(false);
          // The person re-enrols in another session; this one follows without /bridge:connect.
          await enrolledProfile(stub, dir);
          expect(await until(() => stub.stats.authTokens.length >= 2, 5_000)).toBe(true);
        },
        enrolledIn(stub)
      );
    } finally {
      rmSync(loot, { recursive: true, force: true });
    }
  }, 40_000);

  test("an HTTP 401 mints once and retries, with a DPoP proof on each request", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (client) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        stub.expireAccess();
        const r: any = await client.callTool({ name: "list_channels", arguments: {} });
        expect(r.isError).not.toBe(true);
        expect(stub.stats.mints).toBe(2);
        // The only API refusal is the expired token itself — never a proof problem.
        expect(stub.stats.refusals.filter((x) => x.startsWith("api:") && x !== "api:invalid_token")).toEqual([]);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("a POST tool (reply) is proven for POST + its exact URL — no proof refusals", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (client) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        const before = stub.stats.apiHits;
        await client.callTool({ name: "reply", arguments: { channel_id: "c1", text: "hi" } });
        expect(stub.stats.apiHits).toBeGreaterThan(before);
        expect(stub.stats.refusals.filter((x) => x.startsWith("api:"))).toEqual([]);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("a resource proof refused for its clock (401 invalid_dpop_proof) is retried once on the answer's Date — not a mint", async () => {
    const opts: StubOptions = {};
    const stub = startAuthStub(opts);
    await withPlugin(
      stub,
      {},
      async (client) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        const mints = stub.stats.mints;
        opts.clockSkewS = 400; // the server's clock jumps past the ±300 s window
        const r: any = await client.callTool({ name: "list_channels", arguments: {} });
        expect(r.isError).not.toBe(true);
        expect(stub.stats.mints).toBe(mints);
        expect(stub.stats.refusals.some((x) => x === "api:iat")).toBe(true);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("a resource nonce (401 use_dpop_nonce) is retried with the nonce — not a mint", async () => {
    const stub = startAuthStub({ requireNonce: true });
    await withPlugin(
      stub,
      {},
      async (client) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        const mints = stub.stats.mints;
        stub.rotateNonce();
        const r: any = await client.callTool({ name: "list_channels", arguments: {} });
        expect(r.isError).not.toBe(true);
        expect(stub.stats.mints).toBe(mints);
        expect(stub.stats.refusals.some((x) => x === "api:use_dpop_nonce")).toBe(true);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("C15: once the API has handed out a nonce, WS proofs still carry none (auth after a 4009, and an in-band reauth)", async () => {
    const stub = startAuthStub({ requireNonce: true });
    await withPlugin(
      stub,
      {},
      async (client) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        stub.rotateNonce();
        await client.callTool({ name: "list_channels", arguments: {} }); // learns the nonce
        expect(stub.stats.refusals).toContain("api:use_dpop_nonce");
        stub.expireAccess(); // the next request mints and reauths the socket in-band
        await client.callTool({ name: "list_channels", arguments: {} });
        expect(await until(() => stub.stats.reauthTokens.length >= 1, 5_000)).toBe(true);
        stub.closeAll(4009, "token expired");
        expect(await until(() => stub.stats.authTokens.length >= 2, 10_000)).toBe(true);
        expect(await until(() => stub.liveSockets() === 1, 3_000)).toBe(true);
        expect(stub.stats.refusals.filter((r) => r.startsWith("ws:"))).toEqual([]);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("/bridge:login on an unconfigured machine: URL returned, approval connects the session", async () => {
    const stub = startAuthStub();
    await withPlugin(stub, {}, async (client, dir, notices) => {
      expect((await status(client)).configured).toBe(false);
      const r: any = await client.callTool({ name: "login", arguments: { mode: "browser" } });
      const url = (r.content[0].text as string).match(/https?:\/\/\S+/)![0];
      expect(new URL(url).searchParams.get("dpop_jkt")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const cb = (await fetch(url, { redirect: "manual" })).headers.get("location")!;
      const done = await fetch(cb, { redirect: "manual" });
      expect(done.headers.get("location")).toBe(`${stub.url}/connect/done?result=connected`);
      expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
      expect(readInstallation(dir)).not.toBeNull();
      expect(notices().some((n) => n.includes("machine is connected"))).toBe(true);
    });
  }, 30_000);

  test("installation revoked because the machine re-logged-in elsewhere: switches to the new one silently", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (_client, dir, notices) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        const old = readInstallation(dir)!.installationId;
        const fresh = await enrolledProfile(stub, dir); // another session logged in again…
        stub.revokeInstallation(old); // …and revoked the old one.
        expect(await until(() => stub.stats.authTokens.length >= 2, 10_000)).toBe(true);
        expect(stub.sessionsFor(fresh)).toHaveLength(1);
        expect(notices().some((n) => n.includes("/bridge:login"))).toBe(false);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("…and when this process already minted on the new installation (a 401), the live socket follows it in-band: the old one's revoke does not touch it", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (client, dir, notices) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        const old = readInstallation(dir)!.installationId;
        const fresh = await enrolledProfile(stub, dir);
        stub.expireAccess(); // a 401 makes this process mint — on the NEW installation on disk
        await client.callTool({ name: "list_channels", arguments: {} });
        expect(stub.sessionsFor(fresh)).toHaveLength(1);
        // The re-mint reached the live socket (`reauth` + proof): it now rides the NEW
        // installation, as the server's reauth swaps the socket's credential.
        expect(await until(() => stub.stats.reauthTokens.length >= 1, 5_000)).toBe(true);
        stub.revokeInstallation(old); // closes only sockets still on the old installation: none
        await Bun.sleep(1_000);
        expect(stub.stats.authTokens).toHaveLength(1); // no reconnect needed
        expect((await status(client)).websocket).toBe("connected");
        expect(readInstallation(dir)?.installationId).toBe(fresh);
        expect(notices().some((n) => n.includes("/bridge:login"))).toBe(false);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("after an in-band reauth onto a NEW session, a 4008 'session revoked' for that session blocks it (the socket's grant followed the reauth)", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (client, dir, notices) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        const fresh = await enrolledProfile(stub, dir); // a new installation ⇒ a new session
        stub.expireAccess();
        await client.callTool({ name: "list_channels", arguments: {} });
        expect(await until(() => stub.stats.reauthTokens.length >= 1, 5_000)).toBe(true);
        const session = stub.sessionsFor(fresh)[0]!;
        stub.revokeSession(session.id); // closes this socket 4008 "session revoked"
        expect(await until(() => notices().some((n) => n.includes("/bridge:connect starts a new session")), 5_000)).toBe(true);
        const mints = stub.stats.mintBodies.length;
        // Blocked HERE, without asking the server: a tool call sends no mint.
        await client.callTool({ name: "list_channels", arguments: {} });
        expect(stub.stats.mintBodies.length).toBe(mints);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("a persistent 401 mints exactly once, then reports the error (no loop)", async () => {
    const stub = startAuthStub({ always401: true });
    await withPlugin(
      stub,
      {},
      async (client) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        const before = stub.stats.apiHits;
        const mints = stub.stats.mints;
        const r: any = await client.callTool({ name: "list_channels", arguments: {} });
        expect(JSON.stringify(r.content)).toMatch(/401/);
        // list_channels makes two parallel requests: each is tried, re-minted once, retried once…
        expect(stub.stats.apiHits - before).toBe(4);
        // …and the two 401s share ONE mint (the second must not drop the fresh token).
        expect(stub.stats.mints - mints).toBe(1);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("discovery failing during a deploy is retried, not treated as signed out", async () => {
    const stub = startAuthStub({ discoveryFail: 2 });
    await withPlugin(
      stub,
      {},
      async (_client, _dir, notices) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 15_000)).toBe(true);
        expect(stub.stats.discoveryHits).toBeGreaterThanOrEqual(3);
        expect(notices().some((n) => n.includes("⚠️"))).toBe(false);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("a login done in ANOTHER session is picked up without /bridge:connect here", async () => {
    const stub = startAuthStub();
    await withPlugin(stub, { BRIDGE_TEST_CREDENTIAL_WATCH_MS: "200" }, async (client, dir, _n, _p, stderr) => {
      expect((await status(client)).configured).toBe(false);
      // Past startup (session-key resolution, then the boot's own connect decision): from
      // here only the credential watch can notice the new files.
      expect(await until(() => stderr().includes("is not signed in"), 10_000)).toBe(true);
      expect(stub.stats.authTokens).toHaveLength(0);
      await enrolledProfile(stub, dir);
      expect(await until(() => stub.stats.authTokens.length >= 1, 5_000)).toBe(true);
    });
  }, 30_000);

  test("device login through a prompting client: code shown to the person only, confirmed, connected", async () => {
    const stub = startAuthStub({ deviceIntervalS: 1 });
    await withPlugin(
      stub,
      {},
      async (client, dir, _notices, prompts) => {
        const r: any = await client.callTool({ name: "login", arguments: { mode: "device" } });
        expect(r.content[0].text).not.toContain("BCDF-GHJK");
        expect(await until(() => stub.stats.authTokens.length >= 1, 15_000)).toBe(true);
        expect(prompts[0]).toContain("BCDF-GHJK");
        expect(prompts.some((p) => p.includes('@agent-one (Agent One) in workspace "Acme"'))).toBe(true);
        expect(readInstallation(dir)).not.toBeNull();
      },
      undefined,
      "accept"
    );
  }, 30_000);

  test("device login declined at the terminal prompt: not connected, nothing stored, the new installation revoked", async () => {
    const stub = startAuthStub({ deviceIntervalS: 1 });
    await withPlugin(
      stub,
      {},
      async (client, dir, notices, prompts) => {
        await client.callTool({ name: "login", arguments: { mode: "device" } });
        expect(await until(() => notices().some((n) => n.includes("declined")), 15_000)).toBe(true);
        expect(prompts.some((p) => p.includes("@agent-one"))).toBe(true);
        expect(readInstallation(dir)).toBeNull();
        expect(stub.stats.authTokens).toHaveLength(0);
        expect(stub.stats.revokes).toHaveLength(1);
      },
      undefined,
      "decline"
    );
  }, 30_000);

  test("a stop-class refusal (a pre-RFC-016 server): told once — the credential watch neither reopens the socket nor re-mints; a new installation on disk, or /bridge:connect, tries again", async () => {
    const stub = startAuthStub({ legacyServer: true });
    const told = (notices: () => string[]) => notices().filter((n) => n.includes("must be upgraded")).length;
    await withPlugin(
      stub,
      { BRIDGE_TEST_CREDENTIAL_WATCH_MS: "200" },
      async (client, dir, notices) => {
        expect(await until(() => told(notices) === 1, 5_000)).toBe(true);
        const opens = stub.stats.wsOpens;
        await Bun.sleep(1_000); // a negative across five credential-watch ticks
        expect(told(notices)).toBe(1);
        expect(stub.stats.wsOpens).toBe(opens);
        expect(stub.stats.mintBodies).toHaveLength(0);
        // A login in ANOTHER session: the refusal was about the old installation — the
        // new one is tried (a new episode: refused again, so told again).
        await enrolledProfile(stub, dir);
        expect(await until(() => stub.stats.wsOpens > opens, 5_000)).toBe(true);
        expect(await until(() => told(notices) === 2, 5_000)).toBe(true);
        // …and then it stops again: no retry loop on the new installation either.
        const opens2 = stub.stats.wsOpens;
        await Bun.sleep(1_000);
        expect(stub.stats.wsOpens).toBe(opens2);
        expect(told(notices)).toBe(2);
        // The person asks explicitly: tried again, and answered.
        await client.callTool({ name: "connect", arguments: {} });
        expect(await until(() => stub.stats.wsOpens > opens2, 5_000)).toBe(true);
        expect(await until(() => told(notices) === 3, 5_000)).toBe(true);
        expect(stub.stats.mintBodies).toHaveLength(0);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("upgrading from 0.23: the old files are retired at startup and status says to run /bridge:login", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (client, dir) => {
        const s = await status(client);
        expect(s.configured).toBe(false);
        expect(s.auth.problem).toMatch(/plugin 0\.25 .* run \/bridge:login/);
        // Retired once startup settles the session key.
        expect(await until(() => !existsSync(join(dir, "credentials.json")), 10_000)).toBe(true);
        expect((await status(client)).auth.problem).toMatch(/plugin 0\.25 .* run \/bridge:login/);
        expect(existsSync(join(dir, "sessions", `${SESSION}.json`))).toBe(false);
        // hooks/session-map.ts's file in the same directory is not an RFC-014 credential: kept.
        expect(readFileSync(join(dir, "sessions", "pid-4242.json"), "utf8")).toBe("{}");
        expect(stub.stats.mintBodies).toHaveLength(0);
      },
      (dir) => {
        writeFileSync(join(dir, "credentials.json"), JSON.stringify({ apiUrl: stub.url, installationId: "old", installationToken: "brg_it_old" }));
        mkdirSync(join(dir, "sessions"), { recursive: true });
        writeFileSync(join(dir, "sessions", `${SESSION}.json`), JSON.stringify({ sessionId: "s", refreshToken: "brg_rt_old", installationId: "old" }));
        writeFileSync(join(dir, "sessions", "pid-4242.json"), "{}");
      }
    );
  }, 30_000);

  test("startup retirement never touches a 0.25 sign-in: an enrolled profile next to a stray 0.23 file keeps its key and connects", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (_client, dir) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        expect(existsSync(join(dir, "credentials.json"))).toBe(false); // the 0.23 file retired…
        expect(readInstallation(dir)).not.toBeNull(); // …the 0.25 one untouched
        expect(existsSync(join(dir, "key.json"))).toBe(true);
        expect(stub.stats.refusals).toEqual([]);
      },
      async (dir) => {
        await enrolledProfile(stub, dir);
        writeFileSync(join(dir, "credentials.json"), JSON.stringify({ apiUrl: stub.url, installationId: "old", installationToken: "brg_it_old" }));
      }
    );
  }, 30_000);

  test("a 0.23 retirement that throws (any fs error) does not abort startup: the session still connects", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (_client, dir) => {
        // The rest of the boot sequence (enrolment key, connect) still ran.
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        expect(existsSync(join(dir, "credentials.json"))).toBe(true); // it really could not retire
      },
      async (dir) => {
        await enrolledProfile(stub, dir);
        writeFileSync(join(dir, "credentials.json"), JSON.stringify({ apiUrl: stub.url, installationId: "old", installationToken: "brg_it_old" }));
        mkdirSync(join(dir, "upgrade-required.json")); // the marker cannot be written: retireLegacy throws
      }
    );
  }, 30_000);

  test("a clock refusal (C13) stops, keeping the files; /bridge:connect after the fix connects — and the credential watch then leaves the healthy socket alone", async () => {
    const opts: StubOptions = { rejectAssertions: true };
    const stub = startAuthStub(opts);
    await withPlugin(
      stub,
      { BRIDGE_TEST_CREDENTIAL_WATCH_MS: "200" },
      async (client, dir, notices) => {
        expect(await until(() => notices().some((n) => n.includes("check the system clock")), 10_000)).toBe(true);
        expect(existsSync(join(dir, "key.json"))).toBe(true);
        opts.rejectAssertions = false; // the person fixed the clock
        await client.callTool({ name: "connect", arguments: {} });
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        expect(await until(() => stub.liveSockets() === 1, 3_000)).toBe(true);
        const opens = stub.stats.wsOpens;
        await Bun.sleep(1_000); // a negative across five credential-watch ticks
        expect(stub.stats.wsOpens).toBe(opens);
        expect((await status(client)).websocket).toBe("connected");
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("/bridge:connect out of a stop starts a new episode: a pending credential watch does not ALSO reconnect over it (exactly one socket)", async () => {
    const opts: StubOptions = { rejectAssertions: true };
    const stub = startAuthStub(opts);
    await withPlugin(
      stub,
      { BRIDGE_TEST_CREDENTIAL_WATCH_MS: "200" },
      async (client, _dir, notices, _p, stderr) => {
        expect(await until(() => notices().some((n) => n.includes("check the system clock")), 5_000)).toBe(true);
        opts.rejectAssertions = false;
        opts.mintDelayMs = 1_500; // the connect's mint spans several watch ticks
        const opens = stub.stats.wsOpens;
        await client.callTool({ name: "connect", arguments: {} });
        expect(await until(async () => (await status(client)).websocket === "connected", 5_000)).toBe(true);
        expect(stub.stats.wsOpens).toBe(opens + 1);
        expect(stderr()).not.toContain("a new sign-in on disk");
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("a 4003 after a 4001 notice is still told (notices are keyed by code + reason, not by class)", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      { BRIDGE_TEST_BACKOFF_SCALE: "0.02" }, // the slow credential retry in ~1 s
      async (_client, _dir, notices) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 5_000)).toBe(true);
        stub.rejectNextWsAuths(1); // the immediate re-mint's auth: 4001 again → told
        stub.rejectNextWsAuths(1, 4003, "deregistered"); // the slow retry's auth: 4003 → told too
        stub.closeAll(4001, "Invalid token");
        expect(await until(() => notices().some((n) => n.includes("Bridge refused this session's access token")), 5_000)).toBe(true);
        expect(await until(() => notices().some((n) => n.includes("agent deactivated")), 5_000)).toBe(true);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("a completed auth ends the episode: the same 4003 after a recovery is told again", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      { BRIDGE_TEST_BACKOFF_SCALE: "0.02" }, // the slow 4003 retry in ~1 s
      async (client, _dir, notices) => {
        const connected = async () => (await status(client)).websocket === "connected";
        const told = () => notices().filter((n) => n.includes("agent deactivated")).length;
        expect(await until(connected, 5_000)).toBe(true);
        stub.closeAll(4003, "deregistered");
        expect(await until(() => told() === 1, 5_000)).toBe(true);
        expect(await until(connected, 5_000)).toBe(true); // the retry authenticated
        stub.closeAll(4003, "deregistered");
        expect(await until(() => told() === 2, 5_000)).toBe(true);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("the BRIDGE_TEST_* timing knobs are ignored unless BRIDGE_TEST=1: production timing stays", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      { BRIDGE_TEST: "", BRIDGE_TEST_BACKOFF_SCALE: "0.02", BRIDGE_TEST_CREDENTIAL_WATCH_MS: "200" },
      async (client) => {
        expect(await until(async () => (await status(client)).websocket === "connected", 5_000)).toBe(true);
        stub.closeAll(4003, "deregistered");
        await Bun.sleep(1_500); // a negative: the scaled retry would be ~1 s; the real one is ≥ 30 s
        expect(stub.stats.authTokens).toHaveLength(1);
        const inS = Number(/in (\d+)s/.exec(String((await status(client)).websocket))?.[1]);
        expect(inS).toBeGreaterThanOrEqual(25);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("a named profile with no credentials refuses to connect and says so", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      { BRIDGE_PROFILE: "reviewer" },
      async (client) => {
        const s = await status(client);
        expect(s.configured).toBe(false);
        expect(s.auth.problem).toContain('profile "reviewer" is not signed in');
        await Bun.sleep(500);
        expect(stub.stats.authTokens).toHaveLength(0);
      },
      enrolledIn(stub) // the DEFAULT profile is signed in — it must not be used
    );
  }, 30_000);
});
