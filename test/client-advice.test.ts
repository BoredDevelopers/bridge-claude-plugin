/**
 * RFC-017 D5/P6 — the `authenticated` frame's `client.advice` (`ok` | `update_available`
 * | `update_required_by <date>`): one model notice per DISTINCT advice value per
 * process, and `status`'s `server_versions`/`advice` (P8) kept in step with whatever the
 * server last said. Same stub-server + MCP-client harness as reconnect-close-codes.test.ts.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAgentAuthRoutes } from "./agent-auth-routes";
import { mintAgentToken } from "./agent-auth-stub";

const SERVER = new URL("../server.ts", import.meta.url).pathname;
const ENROLMENT_KEY = mintAgentToken("ek");

/** Accepts every auth; each successive `authenticated` frame carries the NEXT entry of
 * `clients` as its `client` block (the last entry repeats once exhausted). `undefined`
 * omits the field entirely — a pre-017 server. */
function startAdviceStub(clients: Array<Record<string, unknown> | undefined>) {
  let auths = 0;
  const agentAuth = createAgentAuthRoutes();
  agentAuth.addEnrolmentKey(ENROLMENT_KEY);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const auth = await agentAuth.handle(req);
      if (auth) return auth;
      if (srv.upgrade(req)) return;
      return Response.json([]);
    },
    websocket: {
      message(ws, raw) {
        let frame: any = {};
        try { frame = JSON.parse(String(raw)); } catch { return; }
        if (frame.type !== "auth") return;
        const client = clients[Math.min(auths, clients.length - 1)];
        auths++;
        ws.send(JSON.stringify({
          type: "authenticated",
          data: { agentId: "a", agentName: "A", contextId: "ctx", ...(client ? { client } : {}) },
        }));
      },
    },
  });
  return { port: server.port!, auths: () => auths, stop: () => server.stop(true) };
}

async function withPlugin<T>(
  stub: { port: number; stop(): unknown },
  fn: (client: Client, notices: () => string[]) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "advice-"));
  const transport = new StdioClientTransport({
    command: "bun",
    args: [SERVER],
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dir,
      BRIDGE_STATE_DIR: dir,
      BRIDGE_API_URL: `http://127.0.0.1:${stub.port}`,
      BRIDGE_ENROLMENT_KEY: ENROLMENT_KEY,
      BRIDGE_AUTOCONNECT: "1",
      CLAUDE_CODE_SESSION_ID: "22222222-3333-4444-5555-666666666666",
      CLAUDE_CODE_SSE_PORT: "",
    } as Record<string, string>,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  const seen: string[] = [];
  client.fallbackNotificationHandler = async (n: any) => {
    if (typeof n?.params?.content === "string") seen.push(n.params.content);
  };
  try {
    await client.connect(transport);
    return await fn(client, () => seen);
  } finally {
    await client.close().catch(() => {});
    stub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

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

describe("RFC-017 D5/P6: client.advice from the authenticated frame", () => {
  test("advice 'ok': silent, but status still carries the minimum/recommended block", async () => {
    const stub = startAdviceStub([{ minimum: "0.25.0", recommended: "0.26.0", advice: "ok" }]);
    await withPlugin(stub, async (client, notices) => {
      expect(await until(() => stub.auths() >= 1, 15_000)).toBe(true);
      await Bun.sleep(300);
      expect(notices().some((c) => c.includes("Bridge plugin") || c.includes("Bridge will stop accepting"))).toBe(false);
      const s = await status(client);
      expect(s.server_versions).toEqual({ minimum: "0.25.0", recommended: "0.26.0" });
      expect(s.advice).toBe("ok");
    });
  }, 40_000);

  test("advice 'update_available': one notice naming the recommended version and this window's own", async () => {
    const stub = startAdviceStub([{ minimum: "0.25.0", recommended: "0.27.0", advice: "update_available" }]);
    await withPlugin(stub, async (client, notices) => {
      expect(await until(() => stub.auths() >= 1, 15_000)).toBe(true);
      await Bun.sleep(300);
      const matches = notices().filter((c) => c.includes("0.27.0 is available"));
      expect(matches).toHaveLength(1);
      expect(matches[0]).toContain("/plugin update bridge");
      expect(matches[0]).toContain("/reload-plugins");
      const s = await status(client);
      expect(s.advice).toBe("update_available");
    });
  }, 40_000);

  test("advice 'update_required_by <date>': one notice naming the date", async () => {
    const stub = startAdviceStub([{ minimum: "0.25.0", recommended: "0.27.0", advice: "update_required_by 2026-12-01" }]);
    await withPlugin(stub, async (client, notices) => {
      expect(await until(() => stub.auths() >= 1, 15_000)).toBe(true);
      await Bun.sleep(300);
      const matches = notices().filter((c) => c.includes("2026-12-01"));
      expect(matches).toHaveLength(1);
      expect(matches[0]).toContain("Bridge will stop accepting plugin");
      expect(matches[0]).toContain("/plugin update bridge");
    });
  }, 40_000);

  test("the SAME advice value is told only once per process, even across a reconnect", async () => {
    const stub = startAdviceStub([
      { minimum: "0.25.0", recommended: "0.27.0", advice: "update_available" },
      { minimum: "0.25.0", recommended: "0.27.0", advice: "update_available" },
    ]);
    await withPlugin(stub, async (client, notices) => {
      expect(await until(() => stub.auths() >= 1, 15_000)).toBe(true);
      await Bun.sleep(300);
      // Cheapest way to a SECOND `authenticated` frame without waiting on a real
      // close/backoff — an explicit disconnect + connect.
      await client.callTool({ name: "disconnect", arguments: {} });
      await client.callTool({ name: "connect", arguments: {} });
      expect(await until(() => stub.auths() >= 2, 15_000)).toBe(true);
      await Bun.sleep(300);
      expect(notices().filter((c) => c.includes("0.27.0 is available"))).toHaveLength(1);
    });
  }, 40_000);

  test("no client block at all (pre-017 server): silent, and status reports null", async () => {
    const stub = startAdviceStub([undefined]);
    await withPlugin(stub, async (client, notices) => {
      expect(await until(() => stub.auths() >= 1, 15_000)).toBe(true);
      await Bun.sleep(300);
      expect(notices().some((c) => c.includes("Bridge plugin") || c.includes("Bridge will stop accepting"))).toBe(false);
      const s = await status(client);
      expect(s.server_versions).toBeNull();
      expect(s.advice).toBeNull();
    });
  }, 40_000);
});
