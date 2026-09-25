/**
 * RFC-014 slice 3 through the real MCP server (server.ts over stdio) against the
 * strict agent-auth stub: the socket authenticates with a session access token,
 * 4009 refreshes, a scheduled refresh reauths in-band, 4008 stops per reason,
 * HTTP 401 renews once, and /bridge:login switches the live connection.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { startAuthStub } from "./agent-auth-stub";
import { writeInstallation, readInstallation, sessionFileFor } from "../auth/store";

const SERVER = new URL("../server.ts", import.meta.url).pathname;
const SESSION = "11111111-2222-3333-4444-555555555555";

async function withPlugin<T>(
  stub: ReturnType<typeof startAuthStub>,
  env: Record<string, string>,
  fn: (client: Client, dir: string, notices: () => string[], prompts: string[]) => Promise<T>,
  preset?: (dir: string) => void,
  /** When set, the client supports elicitation and answers every prompt this way. */
  answer?: "accept" | "decline"
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "login-e2e-"));
  preset?.(dir);
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
      ...env,
    } as Record<string, string>,
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
    return await fn(client, dir, () => seen, prompts);
  } finally {
    await client.close().catch(() => {});
    stub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const enrolledIn = (stub: ReturnType<typeof startAuthStub>) => (dir: string) => {
  const g = stub.enrol();
  writeInstallation(dir, { apiUrl: stub.url, installationId: g.installation_id, installationToken: g.installation_token });
};

async function status(client: Client): Promise<any> {
  const r: any = await client.callTool({ name: "status", arguments: {} });
  return JSON.parse(r.content[0].text);
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await Bun.sleep(25);
  }
  return pred();
}

describe("plugin on a session grant (RFC-014)", () => {
  test("BRIDGE_ENROLMENT_KEY enrols at boot; the socket authenticates with a session access token", async () => {
    const stub = startAuthStub();
    stub.addEnrolmentKey("brg_ek_boot");
    await withPlugin(stub, { BRIDGE_ENROLMENT_KEY: "brg_ek_boot" }, async (client, dir) => {
      expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
      expect(stub.stats.authTokens[0]).toStartWith("brg_at_");
      expect(stub.stats.enrols).toBe(1);
      expect(existsSync(sessionFileFor(dir, SESSION))).toBe(true);
      const s = await status(client);
      expect(s.auth).toMatchObject({ profile: "default", credential: "installation" });
      expect(stub.stats.sessionMeta[0]!.client_version).toMatch(/^\d+\.\d+\.\d+$/);
    });
  }, 30_000);

  test("4009 (expired): reconnects with a refreshed token, same session", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async () => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        stub.closeAll(4009, "token expired");
        expect(await until(() => stub.stats.authTokens.length >= 2, 10_000)).toBe(true);
        expect(stub.stats.authTokens[1]).not.toBe(stub.stats.authTokens[0]);
        expect(stub.stats).toMatchObject({ refreshes: 1, sessionGrants: 1, reuse: 0 });
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("a scheduled refresh hands the live socket the new token in-band (reauth), no reconnect", async () => {
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

  test("4008 session revoked: stops, says /bridge:connect, and connect starts a new session", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (client, dir, notices) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        const inst = readInstallation(dir)!.installationId;
        stub.revokeSession(stub.sessionsFor(inst)[0]!.id);
        expect(await until(() => notices().some((n) => n.includes("/bridge:connect starts a new session")), 5_000)).toBe(true);
        await Bun.sleep(1_500);
        expect(stub.stats.authTokens).toHaveLength(1);
        expect(existsSync(sessionFileFor(dir, SESSION))).toBe(false);
        await client.callTool({ name: "connect", arguments: {} });
        expect(await until(() => stub.stats.authTokens.length >= 2, 10_000)).toBe(true);
        expect(stub.stats.sessionGrants).toBe(2);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("4008 installation revoked: signed out, told to run /bridge:login, no reconnect", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (client, dir, notices) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        stub.revokeInstallation(readInstallation(dir)!.installationId);
        expect(await until(() => notices().some((n) => n.includes("/bridge:login")), 5_000)).toBe(true);
        expect(readInstallation(dir)).toBeNull();
        await Bun.sleep(1_500);
        expect(stub.stats.authTokens).toHaveLength(1);
        expect((await status(client)).configured).toBe(false);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("an HTTP 401 renews once and retries", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (client) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        stub.expireAccess();
        const r: any = await client.callTool({ name: "list_channels", arguments: {} });
        expect(r.isError).not.toBe(true);
        expect(stub.stats.refreshes).toBe(1);
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
        // Another session on this machine logged in again (new installation on disk)…
        const g = stub.enrol();
        writeInstallation(dir, { apiUrl: stub.url, installationId: g.installation_id, installationToken: g.installation_token });
        // …and revoked the old one.
        stub.revokeInstallation(old);
        expect(await until(() => stub.stats.authTokens.length >= 2, 10_000)).toBe(true);
        expect(stub.sessionsFor(g.installation_id)).toHaveLength(1);
        expect(notices().some((n) => n.includes("/bridge:login"))).toBe(false);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("…even when this process already moved its HTTP credential to the new installation before the old one's 4008", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (client, dir, notices) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        const old = readInstallation(dir)!.installationId;
        const g = stub.enrol();
        writeInstallation(dir, { apiUrl: stub.url, installationId: g.installation_id, installationToken: g.installation_token });
        // A 401 makes this process renew — onto the NEW installation on disk.
        stub.expireAccess();
        await client.callTool({ name: "list_channels", arguments: {} });
        expect(stub.sessionsFor(g.installation_id)).toHaveLength(1);
        // Now the old installation's socket is revoked: that is the old one, not ours.
        stub.revokeInstallation(old);
        expect(await until(() => stub.stats.authTokens.length >= 2, 10_000)).toBe(true);
        expect(readInstallation(dir)?.installationId).toBe(g.installation_id);
        expect(notices().some((n) => n.includes("/bridge:login"))).toBe(false);
      },
      enrolledIn(stub)
    );
  }, 30_000);

  test("a persistent 401 renews exactly once, then reports the error (no loop)", async () => {
    const stub = startAuthStub({ always401: true });
    await withPlugin(
      stub,
      {},
      async (client) => {
        expect(await until(() => stub.stats.authTokens.length >= 1, 10_000)).toBe(true);
        const before = stub.stats.apiHits;
        const r: any = await client.callTool({ name: "list_channels", arguments: {} });
        expect(JSON.stringify(r.content)).toMatch(/401/);
        // list_channels makes two parallel requests: each is tried, renewed once, retried once…
        expect(stub.stats.apiHits - before).toBe(4);
        // …and the two 401s share ONE refresh (the second must not drop the fresh token).
        expect(stub.stats.refreshes).toBe(1);
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
    await withPlugin(stub, {}, async (client, dir) => {
      expect((await status(client)).configured).toBe(false);
      // Past startup (session-key resolution waits up to 3 s): from here only the
      // credential watch can notice the new files.
      await Bun.sleep(4_000);
      expect(stub.stats.authTokens).toHaveLength(0);
      const g = stub.enrol();
      writeInstallation(dir, { apiUrl: stub.url, installationId: g.installation_id, installationToken: g.installation_token });
      expect(await until(() => stub.stats.authTokens.length >= 1, 15_000)).toBe(true);
    });
  }, 30_000);

  test("device login through a prompting client: code shown to the person only, confirmed, connected", async () => {
    const stub = startAuthStub();
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

  test("device login declined at the terminal prompt: not connected, nothing stored", async () => {
    const stub = startAuthStub();
    await withPlugin(
      stub,
      {},
      async (client, dir, notices, prompts) => {
        await client.callTool({ name: "login", arguments: { mode: "device" } });
        expect(await until(() => notices().some((n) => n.includes("declined")), 15_000)).toBe(true);
        expect(prompts.some((p) => p.includes("@agent-one"))).toBe(true);
        expect(readInstallation(dir)).toBeNull();
        expect(stub.stats.authTokens).toHaveLength(0);
      },
      undefined,
      "decline"
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
