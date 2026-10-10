/**
 * `list_presence` (RFC-025 PR B) — who is around: people AND agents, connected or when
 * last seen, with the @handle to address them and the workspace presence switch.
 *
 * WHAT MUST HOLD:
 *  - `presenceEnabled: false` reaches the agent. Off, people are OMITTED, not offline
 *    (RFC-025 D10); an agent without the flag reads "no people" as "nobody is here".
 *  - A server that sends no flag (pre-D10) had no switch → `true`, never `false`.
 *  - `handle` and `lastSeenAt` pass through, `null` included ("holds none", "never seen").
 *
 * THE SEAM (same as `list-agents-handle.test.ts`): the real plugin over stdio against a
 * stub HTTP server, so it pins the WIRE CONTRACT, not a build. The server half lives in
 * the bridge repo, `packages/api/test/presence-deltas.test.ts` (rows, handle, switch).
 * Both halves move together.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentAuthRoutes } from "./agent-auth-routes";
import { mintAgentToken } from "./agent-auth-stub";

const SERVER = join(import.meta.dir, "..", "server.ts");
// A well-formed key (server format + CRC) — the strict core refuses anything else.
const ENROLMENT_KEY = mintAgentToken("ek");


type Stub = {
  port: number;
  connected: () => boolean;
  setPresence: (body: unknown) => void;
  stop: () => void;
};

function startStub(): Stub {
  let socket: any = null;
  let presence: unknown = { principals: [], presenceEnabled: true };
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
      if (url.pathname === "/api/presence") return Response.json(presence);
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
            data: { agentId: "aio", agentName: "Aio", handle: "aio", contextId: "ctx-under-test" },
          }));
        }
      },
      close() { socket = null; },
    },
  });

  return {
    port: server.port!,
    connected: () => socket !== null,
    setPresence: (b) => { presence = b; },
    stop: () => server.stop(true),
  };
}

describe("list_presence (RFC-025 PR B)", () => {
  let dir = "";
  let stub: Stub;
  let plugin: ReturnType<typeof Bun.spawn>;
  let out = "";
  let nextId = 1;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "lpr-"));
    stub = startStub();
    plugin = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: `http://127.0.0.1:${stub.port}`,
        BRIDGE_ENROLMENT_KEY: ENROLMENT_KEY, BRIDGE_AUTOCONNECT: "1",
        CLAUDE_CODE_SESSION_ID: "11111111-2222-3333-4444-777777777777",
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


  afterAll(async () => {
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

  async function listPresence() {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_presence", arguments: {} } });
    const msg = await waitForId(id);
    expect(msg.result?.isError, `tool errored: ${msg.result?.content?.[0]?.text}`).toBeFalsy();
    return JSON.parse(msg.result.content[0].text);
  }

  const alice = { id: "u1", name: "Alice", handle: "alice", kind: "human", connected: false, connectedAt: null, lastSeenAt: "2026-10-10T12:00:00.000Z" };
  const aio = { id: "a1", name: "aio", handle: null, kind: "agent", connected: true, connectedAt: "2026-10-10T15:00:00.000Z", lastSeenAt: null };

  test("people and agents, with handle (null kept), kind, connected and lastSeenAt (null kept)", async () => {
    stub.setPresence({ principals: [alice, aio], presenceEnabled: true });
    const body = await listPresence();
    expect(body.presenceEnabled).toBe(true);
    expect(body.principals).toEqual([
      { id: "u1", name: "Alice", handle: "alice", kind: "human", connected: false, lastSeenAt: "2026-10-10T12:00:00.000Z" },
      { id: "a1", name: "aio", handle: null, kind: "agent", connected: true, lastSeenAt: null },
    ]);
  });

  test("presence turned off reaches the agent as presenceEnabled: false", async () => {
    stub.setPresence({ principals: [aio], presenceEnabled: false });
    const body = await listPresence();
    expect(body.presenceEnabled).toBe(false);
    expect(body.principals.map((p: any) => p.id)).toEqual(["a1"]);
  });

  test("a server that sends no switch (pre-D10) reads as on, never off", async () => {
    stub.setPresence({ principals: [alice] });
    const body = await listPresence();
    expect(body.presenceEnabled).toBe(true);
  });
});
