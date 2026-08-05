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
  /** The whole channel. The stub PAGES this the way the server does. */
  setChannel: (rows: Row[]) => void;
  /** Bypass the model and return exactly these rows (for malformed-server cases). */
  setRawResponse: (rows: Row[] | null) => void;
  /** Make the next `/api/messages` call fail with this status and body. */
  setError: (status: number, body: string) => void;
  stop: () => void;
};

/**
 * Minimal Bridge that MODELS the real paging rather than echoing a fixture.
 *
 * ⚠️ THIS USED TO RETURN THE SAME ARRAY WHATEVER WAS ASKED, and that is why the
 * first version of this suite could not see the bug it was written to prevent:
 * with the response independent of `limit` and `sinceSeq`, no test could
 * observe that NO-CURSOR MODE RETURNS THE NEWEST PAGE. One test then pinned the
 * wrong behaviour as correct.
 *
 * The two modes, straight from `packages/api/src/routes/messages.ts`:
 *   sinceSeq → `seq > cursor`, ORDER BY seq ASC, first `limit`   (:558, :467)
 *   neither  → ORDER BY created_at DESC, seq DESC, take `limit`,
 *              then `rows.reverse()`                              (:567, :640)
 * Both hand back oldest-first, which is exactly what makes the difference easy
 * to miss — and the `limit` clamp is the server's own (:531).
 */
function startStub(): Stub {
  let socket: any = null;
  let channel: Row[] = [];
  let raw: Row[] | null = null;
  let failWith: { status: number; body: string } | null = null;
  const queries: string[] = [];

  const clamp = (v: string | null) =>
    Math.min(Math.max(Math.trunc(Number(v) || 50), 1), 200);

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws" || req.headers.get("upgrade") === "websocket") {
        if (srv.upgrade(req)) return;
      }
      if (url.pathname === "/api/messages") {
        queries.push(url.search);
        if (failWith) return new Response(failWith.body, { status: failWith.status });
        if (raw !== null) return Response.json({ messages: raw, agent: "jorgen-mac" });
        const q = url.searchParams;
        const limit = clamp(q.get("limit"));
        const sinceSeq = q.get("sinceSeq");
        const messages =
          sinceSeq !== null
            ? channel.filter((r) => Number(r.seq) > Number(sinceSeq)).slice(0, limit)
            : // Newest `limit`, handed back oldest-first.
              channel.slice(-limit);
        return Response.json({ messages, agent: "jorgen-mac" });
      }
      // Receipts are decorative here; the handler already tolerates failure.
      if (url.pathname === "/api/messages/receipts") return Response.json({ receipts: {} });
      return new Response("no", { status: 404 });
    },
    websocket: {
      message(ws, raw2) {
        let frame: any = {};
        try { frame = JSON.parse(String(raw2)); } catch { return; }
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
    setChannel: (r) => { channel = r; raw = null; failWith = null; },
    setRawResponse: (r) => { raw = r; },
    setError: (status, body) => { failWith = { status, body }; },
    stop: () => server.stop(true),
  };
}

/**
 * A row as the CURRENT server sends it. `seq` present is the whole point — the
 * last test drops it to impersonate an older server.
 */
const row = (seq: number, extra: Record<string, unknown> = {}): Row => ({
  id: `00000000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
  channelId: CHANNEL,
  agentId: "aio",
  agentName: "aio",
  content: `message ${seq}`,
  type: "text",
  parentId: null,
  replyCount: 0,
  seq,
  // ⚠️ WHOLE SECONDS, not `new Date().toISOString()`. `created_at` is an epoch
  // SECONDS column, and its second-granularity is the single fact this entire
  // feature exists because of — a stub emitting millisecond precision is
  // unfaithful in exactly the place that matters.
  createdAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
  ...extra,
});

/** A channel of `n` messages, seq 1..n. */
const channelOf = (n: number): Row[] => Array.from({ length: n }, (_, i) => row(i + 1));

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
    // ⚠️ AWAIT THE RESPONSE, don't sleep at it. Fixed sleeps here were a latent
    // CI flake for no benefit — the id-matching loop this file already needs
    // for tool calls answers the question exactly.
    const initId = nextId++;
    send({ jsonrpc: "2.0", id: initId, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" },
    }});
    await waitForId(initId);
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }, 30_000);

  afterEach(async () => {
    plugin?.kill();
    // Await exit before removing the state dir the plugin may still be writing
    // to — a race by construction, even if it has not been seen to fire.
    await plugin?.exited;
    stub?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Resolve when a JSON-RPC response with this id appears on stdout. */
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
    const msg = await waitForId(id, waitMs);
    const text = msg.result?.content?.[0]?.text ?? "";
    return { isError: !!msg.result?.isError, text, raw: msg };
  }

  /** Call `read_messages` and parse the JSON body it returns. */
  async function read(args: Record<string, unknown>) {
    const res = await callTool("read_messages", { channel_id: CHANNEL, ...args });
    if (res.isError) throw new Error(`unexpected tool error: ${res.text}`);
    return JSON.parse(res.text);
  }

  test("since_seq reaches the server as sinceSeq, and seq survives into the result", async () => {
    stub.setChannel(channelOf(9));
    const body = await read({ since_seq: 6 });

    // ⚠️ The parameter has to arrive under the name the SERVER declares. Elysia
    // strips undeclared query params silently, so a rename here is not a
    // compile error and not a 400 — it is the newest N rows wearing a cursor's
    // clothes. Asserting the wire name is the only thing that catches it.
    const q = new URLSearchParams(stub.queries.at(-1)!);
    expect(q.get("sinceSeq")).toBe("6");
    // `.has("since")`, not a substring check: `"sinceSeq=6"` does not CONTAIN
    // `"since="`, so the old assertion would have passed even if the param were
    // renamed to something that did.
    expect(q.has("since")).toBe(false);

    expect(body.messages.map((m: any) => m.seq)).toEqual([7, 8, 9]);
    expect(body.next_since_seq).toBe(9);
    // The literal next call, so the model does not have to assemble one.
    expect(body.hint).toContain("since_seq: 9");
  });

  test("since_seq: 0 is a real cursor, and reads from the beginning", async () => {
    // `!!0` is false, and treating 0 as absent would read the TAIL instead of
    // the start — the same class of bug as the server's own `!== undefined`.
    stub.setChannel(channelOf(50));
    const body = await read({ since_seq: 0, limit: 3 });
    expect(new URLSearchParams(stub.queries.at(-1)!).get("sinceSeq")).toBe("0");
    // The beginning, not the newest three.
    expect(body.messages.map((m: any) => m.seq)).toEqual([1, 2, 3]);
  });

  /**
   * ⚠️ THE REGRESSION THIS SUITE ONCE PINNED AS CORRECT.
   *
   * With no cursor the server orders `created_at DESC, seq DESC`, takes the
   * newest `limit`, then reverses — so a FULL page means more messages BEHIND,
   * not ahead. The first version of this test used no cursor and asserted
   * `has_more: true` + "More may be waiting", which sent the model forward from
   * the newest message into an empty result reporting "Caught up", with the
   * whole backlog unread and nothing saying so.
   */
  test("the default read says older messages exist, and does not point forward", async () => {
    stub.setChannel(channelOf(100));
    const body = await read({ limit: 20 });

    expect(body.messages.map((m: any) => m.seq)).toEqual(
      Array.from({ length: 20 }, (_, i) => 81 + i)
    );
    expect(body.older_not_returned).toBe(true);
    // NOT "more may be waiting" — there is nothing ahead of seq 100.
    expect(body.has_more).toBe(false);
    expect(body.hint).toContain("Older messages exist");
    expect(body.hint).toContain("since_seq: 0");
  });

  test("in cursor mode a full page does point forward, and the next call delivers", async () => {
    stub.setChannel(channelOf(100));
    const first = await read({ since_seq: 0, limit: 20 });
    expect(first.has_more).toBe(true);
    expect(first.older_not_returned).toBe(false);
    expect(first.hint).toContain("More may be waiting");
    expect(first.next_since_seq).toBe(20);

    // Following the hint must actually advance — the failure above was that it
    // did not.
    const second = await read({ since_seq: first.next_since_seq, limit: 20 });
    expect(second.messages.map((m: any) => m.seq)[0]).toBe(21);
    expect(second.count).toBe(20);
  });

  test("a short page in cursor mode is caught up", async () => {
    stub.setChannel(channelOf(3));
    const body = await read({ since_seq: 0, limit: 20 });
    expect(body.has_more).toBe(false);
    expect(body.hint).toContain("Caught up");
  });

  /**
   * The polling steady state. Resuming from the head returns nothing, and the
   * cursor must SURVIVE that — with zero messages there are zero rows carrying
   * a seq, so the echo is the only thing keeping the position alive.
   */
  test("an empty poll keeps the cursor instead of discarding it", async () => {
    stub.setChannel(channelOf(10));
    const body = await read({ since_seq: 10 });
    expect(body.count).toBe(0);
    expect(body.next_since_seq).toBe(10);
    expect(body.hint).toContain("since_seq: 10");
    expect(body.hint).not.toContain("Nothing to resume from");
  });

  test("a genuinely empty channel says so, without inventing a cursor", async () => {
    stub.setChannel([]);
    const body = await read({});
    expect(body.count).toBe(0);
    expect(body.next_since_seq).toBeUndefined();
    expect(body.hint).toContain("Nothing to resume from");
  });

  test("a bad limit cannot produce a false 'caught up'", async () => {
    stub.setChannel(channelOf(100));
    // -5 used to pass through unclamped, so `length === limit` was false and
    // the model was told it was caught up on a channel with 99 unread.
    const neg = await read({ since_seq: 0, limit: -5 });
    expect(neg.count).toBe(1);
    expect(neg.has_more).toBe(true);

    // 1.5 used to reach the wire as `limit=1.5`.
    const frac = await read({ since_seq: 0, limit: 1.5 });
    expect(new URLSearchParams(stub.queries.at(-1)!).get("limit")).toBe("1");
    expect(frac.has_more).toBe(true);
  });

  test("both cursors at once is refused, and neither is sent", async () => {
    stub.setChannel(channelOf(5));
    const before = stub.queries.length;
    const res = await callTool("read_messages", {
      channel_id: CHANNEL, since_seq: 5, since: "2026-08-05T00:00:00Z",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("not both");
    // Refused BEFORE the request, so the ambiguous read never happens.
    expect(stub.queries.length).toBe(before);
  });

  test("an empty `since` is not a cursor, so it does not trip the both-check", async () => {
    stub.setChannel(channelOf(5));
    const body = await read({ since_seq: 2, since: "" });
    expect(body.messages.map((m: any) => m.seq)).toEqual([3, 4, 5]);
  });

  test("`since` alone still reaches the wire", async () => {
    stub.setChannel(channelOf(5));
    await read({ since: "2026-08-05T00:00:00Z" });
    const q = new URLSearchParams(stub.queries.at(-1)!);
    expect(q.get("since")).toBe("2026-08-05T00:00:00Z");
    expect(q.has("sinceSeq")).toBe(false);
  });

  test("a non-numeric since_seq is refused before the request", async () => {
    stub.setChannel(channelOf(5));
    const before = stub.queries.length;
    // `Number([])` is 0 and passes Number.isInteger — it used to read the whole
    // channel from the start.
    const res = await callTool("read_messages", { channel_id: CHANNEL, since_seq: [] as any });
    expect(res.isError).toBe(true);
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
    stub.setRawResponse([row(1), row(2)].map(({ seq, ...rest }) => rest));
    const res = await callTool("read_messages", { channel_id: CHANNEL, since_seq: 42 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("does not support since_seq");
  });

  test("seq: null is treated as no seq, not as a usable cursor", async () => {
    // `null === undefined` is false, so a null used to sail through the guard
    // and become `since_seq: null` in the hint — which the handler then reads
    // as "no cursor", producing the tail-of-channel read the guard exists to
    // prevent, reached via the hint the guard printed.
    stub.setRawResponse([row(1, { seq: null }), row(2, { seq: null })]);
    const res = await callTool("read_messages", { channel_id: CHANNEL, since_seq: 42 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("does not support since_seq");
  });

  test("a mixed page is caught, even though its FIRST row has a seq", async () => {
    // The guard used to check messages[0] while the cursor is taken from the
    // LAST row, so this page passed and then reported no cursor at all.
    stub.setRawResponse([row(7), (({ seq, ...rest }) => rest)(row(8))]);
    const res = await callTool("read_messages", { channel_id: CHANNEL, since_seq: 6 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("does not support since_seq");
  });

  test("without a cursor, rows lacking seq are still returned", async () => {
    // The guard must fire ONLY when a cursor was asked for. An ordinary read
    // against an older server is not wrong, just unpositioned — erroring here
    // would break every read rather than the one that could mislead.
    stub.setRawResponse([row(1), row(2)].map(({ seq, ...rest }) => rest));
    const res = await callTool("read_messages", { channel_id: CHANNEL });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text).messages).toHaveLength(2);
  });

  test("a server error carries its body, not just a status code", async () => {
    // The real 400 for `since: "yesterday"` has a BODY saying what is wrong,
    // and the description invites natural language — so that sentence is the
    // only clue the model gets. A bare status is unactionable.
    stub.setError(400, JSON.stringify({ error: "Invalid 'since' timestamp" }));
    const res = await callTool("read_messages", { channel_id: CHANNEL, since: "yesterday" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Invalid 'since' timestamp");
  });
});
