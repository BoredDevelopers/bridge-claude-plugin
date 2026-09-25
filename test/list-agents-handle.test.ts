/**
 * `list_agents` must surface each agent's per-tenant HANDLE.
 *
 * WHY THIS EXISTS — the identity epic made the `handle` the @mention / member-add
 * address and turned `id` into an opaque uuid. A roster that shows only id + name
 * gives an agent no way to learn who to `@`: the id it sees is not addressable.
 * The server now returns `handle` on `GET /api/agents` (tenant-scoped, resolved by
 * immutable principal id; null when released), and this tool must pass it through
 * — including a `null`, which is information ("this agent holds no handle"), not a
 * field to drop.
 *
 * THE SEAM (same as `list-channels-read-state.test.ts`): the real plugin over
 * stdio against a stub HTTP server, so it pins the WIRE CONTRACT, not a build.
 * The server half lives in the bridge repo,
 * `packages/api/test/agent-roster-handle.test.ts`. Both halves move together.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentAuthRoutes } from "./agent-auth-routes";

const SERVER = join(import.meta.dir, "..", "server.ts");
const ENROLMENT_KEY = "brg_ek_test";

type Row = Record<string, unknown>;

type Stub = {
  port: number;
  connected: () => boolean;
  setAgents: (rows: Row[]) => void;
  stop: () => void;
};

function startStub(): Stub {
  let socket: any = null;
  let agents: Row[] = [];
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
      if (url.pathname === "/api/agents") return Response.json({ agents });
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
    setAgents: (r) => { agents = r; },
    stop: () => server.stop(true),
  };
}

/** An agent row as the CURRENT server sends it — note the tenant-scoped `handle`. */
const agent = (id: string, handle: string | null): Row => ({
  id,
  name: id.toUpperCase(),
  handle,
  online: true,
  state: "idle",
  description: null,
  skills: [],
  subagents: [],
});

describe("list_agents surfaces the per-tenant handle", () => {
  let dir = "";
  let stub: Stub;
  let plugin: ReturnType<typeof Bun.spawn>;
  let out = "";
  let nextId = 1;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "lah-"));
    stub = startStub();
    plugin = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: `http://127.0.0.1:${stub.port}`,
        BRIDGE_ENROLMENT_KEY: ENROLMENT_KEY, BRIDGE_AUTOCONNECT: "1",
        CLAUDE_CODE_SESSION_ID: "11111111-2222-3333-4444-666666666666",
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

  beforeEach(() => {
    stub.setAgents([agent("aio", "aio"), agent("bellman", null)]);
  });

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

  async function listAgents() {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_agents", arguments: {} } });
    const msg = await waitForId(id);
    expect(msg.result?.isError, `tool errored: ${msg.result?.content?.[0]?.text}`).toBeFalsy();
    const body = JSON.parse(msg.result.content[0].text);
    return new Map<string, any>(body.map((a: any) => [a.id, a]));
  }

  test("an agent that holds a handle carries it through", async () => {
    const byId = await listAgents();
    expect(byId.get("aio").handle).toBe("aio");
  });

  test("a released handle (null) is passed through as null, not dropped", async () => {
    // null means "holds no handle" — real information. Dropping it would read as
    // "unknown", the same lie `list_channels` was fixed for.
    const byId = await listAgents();
    const b = byId.get("bellman");
    expect(b).toBeDefined();
    expect("handle" in b).toBe(true);
    expect(b.handle).toBeNull();
  });
});
