/**
 * The plugin's reaction to each server close code, against a stub Bridge.
 *
 * The stub refuses the FIRST auth with a chosen close code and accepts every
 * later one, so "did it reconnect, how soon, and what does `status` say" is
 * observable through the real WebSocket and the real MCP tool surface.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = new URL("../server.ts", import.meta.url).pathname;

type Close = { code: number; reason: string };
/** `firstClose` refuses auth #1; `closes` refuses auths #1..#n in order (overrides). */
function startStub(firstClose: Close | null, opts: { channels429?: boolean; closes?: Close[] } = {}) {
  const refusals = opts.closes ?? (firstClose ? [firstClose] : []);
  let auths = 0;
  let open = 0;
  let maxOpen = 0;
  let onFirstClose: (() => void) | null = null;
  const server = Bun.serve({
    port: 0,
    // 127.0.0.1, never the wildcard default — see stub-loopback-bind.test.ts.
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      const path = new URL(req.url).pathname;
      if (path === "/api/channels" && opts.channels429) {
        return new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "7" },
        });
      }
      return Response.json([]);
    },
    websocket: {
      open() {
        open++;
        maxOpen = Math.max(maxOpen, open);
      },
      close() {
        open--;
      },
      message(ws, raw) {
        let frame: any = {};
        try { frame = JSON.parse(String(raw)); } catch { return; }
        if (frame.type !== "auth") return;
        auths++;
        const refusal = refusals[auths - 1];
        if (refusal) {
          ws.close(refusal.code, refusal.reason);
          if (auths === 1) queueMicrotask(() => onFirstClose?.());
          return;
        }
        ws.send(JSON.stringify({
          type: "authenticated",
          data: { agentId: "a", agentName: "A", contextId: "ctx" },
        }));
      },
    },
  });
  return {
    port: server.port!,
    auths: () => auths,
    maxOpen: () => maxOpen,
    firstClosed: () => new Promise<void>((r) => (onFirstClose = r)),
    stop: () => server.stop(true),
  };
}

async function withPlugin<T>(
  stub: ReturnType<typeof startStub>,
  fn: (client: Client, notices: () => string[]) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "rcc-"));
  const transport = new StdioClientTransport({
    command: "bun",
    args: [SERVER],
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dir,
      BRIDGE_STATE_DIR: dir,
      BRIDGE_API_URL: `http://127.0.0.1:${stub.port}`,
      BRIDGE_TOKEN: "test-token",
      BRIDGE_AUTOCONNECT: "1",
      CLAUDE_CODE_SESSION_ID: "11111111-2222-3333-4444-555555555555",
      CLAUDE_CODE_SSE_PORT: "",
    } as Record<string, string>,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  // Channel notifications the plugin pushes to the model (content strings).
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

describe("close codes", () => {
  test("4006 (auth timeout) is transient: reconnects within ~1s", async () => {
    const stub = startStub({ code: 4006, reason: "Authentication timeout" });
    await withPlugin(stub, async () => {
      expect(await until(() => stub.auths() >= 2, 5_000)).toBe(true);
    });
  }, 30_000);

  test("4007 (too many sessions) backs off slowly and says why", async () => {
    const stub = startStub({ code: 4007, reason: "Too many sessions" });
    await withPlugin(stub, async (client, notices) => {
      expect(await until(() => stub.auths() >= 1, 15_000)).toBe(true);
      await Bun.sleep(300);
      const s = await status(client);
      expect(s.websocket).toContain("too many live sessions");
      expect(s.websocket).toContain("4007");
      // First retry is ≥15s away; nothing may happen in the next 5.
      await Bun.sleep(5_000);
      expect(stub.auths()).toBe(1);
      // 4007 arrives after a server error FRAME in production, which already
      // notifies — the close path must not say it a second time.
      expect(notices().some((c) => c.includes("Bridge disconnected this session"))).toBe(false);
    });
  }, 40_000);

  test("4003 (deregistered) backs off slowly and says why", async () => {
    const stub = startStub({ code: 4003, reason: "deregistered" });
    await withPlugin(stub, async (client, notices) => {
      expect(await until(() => stub.auths() >= 1, 15_000)).toBe(true);
      await Bun.sleep(300);
      expect((await status(client)).websocket).toContain("agent deactivated");
      await Bun.sleep(5_000);
      expect(stub.auths()).toBe(1);
      // 4003 carries no error frame — the close notice is the ONLY way the model hears of it. Once.
      expect(notices().filter((c) => c.includes("Bridge disconnected this session"))).toHaveLength(1);
    });
  }, 40_000);

  test("4008 (token revoked) stops — and /bridge:connect tries again", async () => {
    const stub = startStub({ code: 4008, reason: "token revoked" });
    await withPlugin(stub, async (client) => {
      expect(await until(() => stub.auths() >= 1, 15_000)).toBe(true);
      await Bun.sleep(300);
      const s = await status(client);
      expect(s.websocket).toContain("token revoked");
      expect(s.websocket).not.toContain("reconnect attempt");
      await client.callTool({ name: "connect", arguments: {} });
      expect(await until(() => stub.auths() >= 2, 5_000)).toBe(true);
    });
  }, 40_000);

  test("/bridge:connect during a backoff cancels the pending retry — one socket, not two", async () => {
    // 4007, so the pending retry is 15–30s out: a wide, race-free window.
    const stub = startStub({ code: 4007, reason: "Too many sessions" });
    await withPlugin(stub, async (client) => {
      // Wait until the PLUGIN has a retry pending, not merely until the stub
      // closed — calling connect before the close is processed tests nothing.
      let pending = false;
      const end = Date.now() + 15_000;
      while (!pending && Date.now() < end) {
        pending = String((await status(client)).websocket).includes("reconnect attempt");
        if (!pending) await Bun.sleep(50);
      }
      expect(pending).toBe(true);
      await client.callTool({ name: "connect", arguments: {} });
      expect(await until(() => stub.auths() >= 2, 5_000)).toBe(true);
      // The cancelled retry was due at most 30s after the refusal. Wait past
      // that: a surviving timer would tear the good socket down and open a
      // third. (Slow by necessity — the timer is the thing under test, and
      // `status` reports "connected" without consulting it.)
      await Bun.sleep(31_000);
      expect(stub.auths()).toBe(2);
      expect(stub.maxOpen()).toBe(1);
    });
  }, 60_000);
});

describe("HTTP 429", () => {
  test("a rate-limited tool call tells the model how long to wait", async () => {
    const stub = startStub(null, { channels429: true });
    await withPlugin(stub, async (client) => {
      expect(await until(() => stub.auths() >= 1, 15_000)).toBe(true);
      await Bun.sleep(300);
      const r: any = await client.callTool({ name: "list_channels", arguments: {} });
      const text = r.content.map((c: any) => c.text).join("\n");
      expect(text).toContain("429");
      expect(text).toContain("wait 7 second(s)");
      expect(text).toContain("do not retry immediately");
      // A refusal, not an outage — must not read as "server unreachable".
      expect(text).not.toContain("request failed");
    });
  }, 30_000);
});

describe("schedule per close class", () => {
  test("a new KIND of close starts its own schedule from attempt 1", async () => {
    // Transient first (a restart), then a session-cap refusal.
    const stub = startStub(null, { closes: [{ code: 4000, reason: "restart" }, { code: 4007, reason: "Too many sessions" }] });
    await withPlugin(stub, async (client) => {
      expect(await until(() => stub.auths() >= 2, 15_000)).toBe(true);
      await Bun.sleep(300);
      const ws = String((await status(client)).websocket);
      expect(ws).toContain("4007");
      expect(ws).toContain("reconnect attempt 1,");
    });
  }, 40_000);
});
