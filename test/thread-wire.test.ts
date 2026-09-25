/**
 * The REPLY WIRE — pinned for the first time (RFC-012 slice 5.2).
 *
 * Before this file NOTHING invoked the `reply` tool, so the outbound send wire
 * was entirely unguarded: a build could POST a reply anywhere and every suite
 * stayed green. That is exactly the gap that let the thread flip be a one-line
 * change with no test to break.
 *
 * The seam is the same as delivery-reasons / read-messages-cursor: the REAL
 * plugin, driven over stdio, against a stub HTTP+WS server that RECORDS the
 * outbound POSTs. That pins the plugin to the WIRE CONTRACT, not to a server
 * build.
 *
 * The contract (server side = bridge repo `packages/api/src/routes/threads.ts`,
 * `POST /:id/messages`):
 *   - a REPLY (thread_id given) → `POST /api/threads/<threadId>/messages`,
 *     body carries `content` and NEITHER `channelId` NOR `parentId` (the thread
 *     fixes the channel and its root is the parent).
 *   - a ROOT (no thread_id) → `POST /api/messages` with `channelId`, as before.
 *   - a task ROOT may carry an explicit `title` (D8).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentAuthRoutes } from "./agent-auth-routes";

const SERVER = join(import.meta.dir, "..", "server.ts");
const ENROLMENT_KEY = "brg_ek_test";

type Sent = { method: string; path: string; body: Record<string, unknown> };

type Stub = {
  port: number;
  connected: () => boolean;
  /** Every POST to a send route (`/api/messages` or a thread route), in order. */
  sends: Sent[];
  stop: () => void;
};

/**
 * Minimal Bridge that RECORDS the send wire. It answers both send routes with a
 * plausible `{ id }` so the reply handler's post-send bookkeeping runs, and
 * upgrades /ws so the plugin authenticates and will dispatch tool calls.
 */
function startStub(): Stub {
  let socket: any = null;
  const sends: Sent[] = [];
  const isThreadRoute = (p: string) => /^\/api\/threads\/[^/]+\/messages$/.test(p);
  const agentAuth = createAgentAuthRoutes();
  agentAuth.addEnrolmentKey(ENROLMENT_KEY);

  const server = Bun.serve({
    port: 0,
    // 127.0.0.1, never the wildcard default — see stub-loopback-bind.test.ts.
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const auth = await agentAuth.handle(req);
      if (auth) return auth;
      const url = new URL(req.url);
      if (url.pathname === "/ws" || req.headers.get("upgrade") === "websocket") {
        if (srv.upgrade(req)) return;
      }
      if (req.method === "POST" && (url.pathname === "/api/messages" || isThreadRoute(url.pathname))) {
        let body: Record<string, unknown> = {};
        try { body = (await req.json()) as Record<string, unknown>; } catch {}
        sends.push({ method: req.method, path: url.pathname, body });
        // The reply handler reads result.id (rememberOwnSend / rememberSentMessage)
        // and result.contextId (target note); echo enough to keep it honest.
        return Response.json({ id: `srv-${sends.length}`, contextId: body.contextId ?? null });
      }
      // Receipts are decorative here; the handler already tolerates failure.
      if (url.pathname === "/api/messages/receipts") return Response.json({ receipts: {} });
      return new Response("no", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        let frame: any = {};
        try { frame = JSON.parse(String(raw)); } catch { return; }
        if (frame.type === "auth") {
          socket = ws;
          ws.send(JSON.stringify({
            type: "authenticated",
            data: { agentId: "jorgen-mac", agentName: "Jörgen (Mac)", contextId: "ctx-under-test" },
          }));
        }
      },
      close() { socket = null; },
    },
  });

  return {
    port: server.port!,
    connected: () => socket !== null,
    sends,
    stop: () => server.stop(true),
  };
}

describe("reply posts a threaded reply to the thread-native route", () => {
  let dir = "";
  let stub: Stub;
  let plugin: ReturnType<typeof Bun.spawn>;
  let out = "";
  let nextId = 1;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "twire-"));
    stub = startStub();
    plugin = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: `http://127.0.0.1:${stub.port}`,
        BRIDGE_ENROLMENT_KEY: ENROLMENT_KEY, BRIDGE_AUTOCONNECT: "1",
        CLAUDE_CODE_SESSION_ID: "11111111-2222-3333-4444-555555555555",
        CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    out = "";
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of plugin.stdout as any) out += dec.decode(chunk, { stream: true });
    })();

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !stub.connected()) await Bun.sleep(50);
    expect(stub.connected(), "plugin never connected to the stub").toBe(true);

    const initId = nextId++;
    send({ jsonrpc: "2.0", id: initId, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" },
    }});
    await waitForId(initId);
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }, 30_000);

  afterEach(async () => {
    plugin?.kill();
    await plugin?.exited;
    stub?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function waitForId(id: number, waitMs = 8000): Promise<any> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      for (const line of out.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === id) return msg;
      }
      await Bun.sleep(25);
    }
    throw new Error(`no response to id ${id} within ${waitMs}ms. stdout:\n${out.slice(-2000)}`);
  }

  function send(frame: unknown) {
    const sink = plugin.stdin as { write: (s: string) => void; flush?: () => void };
    sink.write(JSON.stringify(frame) + "\n");
    sink.flush?.();
  }

  async function callTool(name: string, args: Record<string, unknown>, waitMs = 8000) {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const msg = await waitForId(id, waitMs);
    const text = msg.result?.content?.[0]?.text ?? "";
    return { isError: !!msg.result?.isError, text, raw: msg };
  }

  test("a threaded reply hits /api/threads/<id>/messages with no channelId or parentId", async () => {
    const r = await callTool("reply", { channel_id: "general", text: "in the thread", thread_id: "thr-abc" });
    expect(r.isError).toBe(false);
    expect(stub.sends.length).toBe(1);
    const s = stub.sends[0];
    expect(s.path).toBe("/api/threads/thr-abc/messages");
    expect(s.body.content).toBe("in the thread");
    // The thread fixes the channel and its root is the parent — the client names neither.
    expect(s.body).not.toHaveProperty("channelId");
    expect(s.body).not.toHaveProperty("parentId");
  });

  test("a thread id with URL-significant chars is percent-encoded into the path", async () => {
    await callTool("reply", { channel_id: "general", text: "hi", thread_id: "a b/c" });
    expect(stub.sends[0].path).toBe("/api/threads/a%20b%2Fc/messages");
  });

  test("a root send (no thread_id) stays on /api/messages with channelId", async () => {
    await callTool("reply", { channel_id: "general", text: "a root" });
    expect(stub.sends.length).toBe(1);
    const s = stub.sends[0];
    expect(s.path).toBe("/api/messages");
    expect(s.body.channelId).toBe("general");
    expect(s.body).not.toHaveProperty("parentId");
  });

  test("a task root carries the explicit title (D8) on /api/messages", async () => {
    await callTool("reply", { channel_id: "general", text: "do the thing", type: "task", title: "Do the thing" });
    const s = stub.sends[0];
    expect(s.path).toBe("/api/messages");
    expect(s.body.type).toBe("task");
    expect(s.body.title).toBe("Do the thing");
  });

  test("a threaded reply carries no title even if one is passed (title is root-only)", async () => {
    await callTool("reply", { channel_id: "general", text: "reply", thread_id: "thr-xyz", type: "task", title: "ignored" });
    const s = stub.sends[0];
    expect(s.path).toBe("/api/threads/thr-xyz/messages");
    expect(s.body).not.toHaveProperty("title");
  });
});
