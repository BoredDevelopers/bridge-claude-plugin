/**
 * `read_messages` must be able to resume, and must refuse rather than guess.
 *
 * WHY THIS EXISTS — the tool could not resume at all until 2026-08-05.
 *
 * The server has shipped an exact cursor (`?sinceSeq=`) since RFC-008: `seq` is
 * dense and gap-free within a channel, so `> seq` means precisely "everything
 * after the message I last saw". The tool sent `?since=` (a whole-second
 * timestamp, lossy by construction) and its output projection — a closed
 * allowlist of seven keys — DISCARDED `seq` before the model ever saw it. So the
 * model was handed messages with no position on them and a cursor that silently
 * dropped anything sharing a second with the last row it received.
 *
 * That combination is the dominant defect across MCP wrappers generally: the
 * wrapper throws away the upstream's position signal and then has nothing to
 * page with.
 *
 * THE SEAM. Same as delivery-reasons.test.ts — the real plugin, driven over
 * stdio, against a stub HTTP server. That pins the plugin to the WIRE CONTRACT
 * rather than to a particular server build, and it lets the last test below
 * impersonate something no real server can be asked to be any more: a Bridge
 * that predates `seq`.
 *
 * The server half of this contract lives in the bridge repo,
 * `packages/api/test/replay.test.ts` — "a same-second message is LOST by the
 * timestamp cursor and FOUND by sinceSeq", and "sending both cursors is a 400".
 * Both halves must move together.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SERVER = join(import.meta.dir, "..", "server.ts");
const CHANNEL = "general";

type Row = Record<string, unknown>;

type Stub = {
  port: number;
  connected: () => boolean;
  /** Every `/api/messages` query string this stub was asked for, in order. */
  queries: string[];
  /** What the next `/api/messages` call returns. */
  setRows: (rows: Row[]) => void;
  stop: () => void;
};

/**
 * Minimal Bridge: completes the WS handshake so the plugin stays up, and serves
 * `/api/messages` from whatever the test last set.
 */
function startStub(): Stub {
  let socket: any = null;
  let rows: Row[] = [];
  const queries: string[] = [];

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws" || req.headers.get("upgrade") === "websocket") {
        if (srv.upgrade(req)) return;
      }
      if (url.pathname === "/api/messages") {
        queries.push(url.search);
        return Response.json({ messages: rows, agent: "jorgen-mac" });
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
    queries,
    setRows: (r) => { rows = r; },
    stop: () => server.stop(true),
  };
}

/**
 * A row as the CURRENT server sends it. `seq` present is the whole point — the
 * last test drops it to impersonate an older server.
 */
const row = (seq: number, extra: Record<string, unknown> = {}): Row => ({
  id: `0000000${seq}-0000-7000-8000-00000000000${seq}`,
  channelId: CHANNEL,
  agentId: "aio",
  agentName: "aio",
  content: `message ${seq}`,
  type: "text",
  parentId: null,
  replyCount: 0,
  seq,
  createdAt: new Date().toISOString(),
  ...extra,
});

describe("read_messages resumes exactly, or says why it cannot", () => {
  let dir = "";
  let stub: Stub;
  let plugin: ReturnType<typeof Bun.spawn>;
  let out = "";
  let nextId = 1;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "rmc-"));
    stub = startStub();
    plugin = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: `http://127.0.0.1:${stub.port}`,
        BRIDGE_TOKEN: "test-token",
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

    // MCP requires the handshake before it will dispatch a tool call.
    send({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" },
    }});
    await Bun.sleep(300);
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    await Bun.sleep(200);
  }, 30_000);

  afterEach(() => {
    plugin?.kill();
    stub?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function send(frame: unknown) {
    // `Bun.spawn().stdin` is typed `number | FileSink`; with `stdin: "pipe"` it
    // is always the sink, but the union has to be narrowed by hand.
    const sink = plugin.stdin as { write: (s: string) => void; flush?: () => void };
    sink.write(JSON.stringify(frame) + "\n");
    sink.flush?.();
  }

  /** Call a tool and return its parsed result, waiting for the matching id. */
  async function callTool(name: string, args: Record<string, unknown>, waitMs = 8000) {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      for (const line of out.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== id) continue;
        const text = msg.result?.content?.[0]?.text ?? "";
        return { isError: !!msg.result?.isError, text, raw: msg };
      }
      await Bun.sleep(50);
    }
    throw new Error(`no response to ${name} within ${waitMs}ms. stdout so far:\n${out.slice(-2000)}`);
  }

  test("since_seq reaches the server as sinceSeq, and seq survives into the result", async () => {
    stub.setRows([row(7), row(8), row(9)]);
    const res = await callTool("read_messages", { channel_id: CHANNEL, since_seq: 6 });

    // ⚠️ The parameter has to arrive under the name the SERVER declares. Elysia
    // strips undeclared query params silently, so a rename here is not a
    // compile error and not a 400 — it is the newest N rows wearing a cursor's
    // clothes. Asserting the wire name is the only thing that catches it.
    const q = stub.queries.at(-1)!;
    expect(q).toContain("sinceSeq=6");
    expect(q).not.toContain("since=");

    expect(res.isError).toBe(false);
    const body = JSON.parse(res.text);
    expect(body.messages.map((m: any) => m.seq)).toEqual([7, 8, 9]);
    expect(body.next_since_seq).toBe(9);
    // The literal next call, so the model does not have to assemble one.
    expect(body.hint).toContain("since_seq: 9");
  });

  test("since_seq: 0 is a real cursor, not a missing one", async () => {
    // `!!0` is false, and treating 0 as absent would silently read the tail of
    // the channel instead of its beginning — the same class of bug as the
    // server's own `!== undefined` guard.
    stub.setRows([row(1)]);
    const res = await callTool("read_messages", { channel_id: CHANNEL, since_seq: 0 });
    expect(res.isError).toBe(false);
    expect(stub.queries.at(-1)).toContain("sinceSeq=0");
  });

  test("a full page says there may be more; a short page says caught up", async () => {
    stub.setRows([row(1), row(2)]);
    const full = JSON.parse((await callTool("read_messages", { channel_id: CHANNEL, limit: 2 })).text);
    expect(full.has_more).toBe(true);
    expect(full.hint).toContain("More may be waiting");

    stub.setRows([row(1)]);
    const short = JSON.parse((await callTool("read_messages", { channel_id: CHANNEL, limit: 2 })).text);
    expect(short.has_more).toBe(false);
    expect(short.hint).toContain("Caught up");
  });

  test("both cursors at once is refused, and neither is sent", async () => {
    stub.setRows([row(1)]);
    const before = stub.queries.length;
    const res = await callTool("read_messages", {
      channel_id: CHANNEL, since_seq: 5, since: "2026-08-05T00:00:00Z",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("not both");
    // Refused BEFORE the request, so the ambiguous read never happens.
    expect(stub.queries.length).toBe(before);
  });

  /**
   * ⚠️ THE ONE THAT CANNOT BE TESTED AGAINST A REAL SERVER ANY MORE.
   *
   * A Bridge that predates RFC-008 has no `seq` column, so it cannot select one
   * — and Elysia drops the `sinceSeq` param it does not declare, so the request
   * succeeds and returns the newest rows. Nothing about the reply looks wrong.
   * The stub can still be that server; production cannot.
   */
  test("a server that ignored the cursor is an error, not a plausible answer", async () => {
    const noSeq = [row(1), row(2)].map(({ seq, ...rest }) => rest);
    stub.setRows(noSeq);
    const res = await callTool("read_messages", { channel_id: CHANNEL, since_seq: 42 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("does not support since_seq");
  });

  test("without a cursor, rows lacking seq are still returned", async () => {
    // The guard must fire ONLY when a cursor was asked for. An ordinary read
    // against an older server is not wrong, just unpositioned — erroring here
    // would break every read rather than the one that could mislead.
    stub.setRows([row(1), row(2)].map(({ seq, ...rest }) => rest));
    const res = await callTool("read_messages", { channel_id: CHANNEL });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text).messages).toHaveLength(2);
  });
});
