/**
 * `list_channels` must read the read-state endpoint, and must not invent one.
 *
 * WHY THIS EXISTS — the tool was silently wrong for a whole server release.
 *
 * `GET /api/channels` used to carry `unreadCount` per channel. The server moved
 * read state to `GET /api/channels/read-state` so the channel list is identical
 * bytes for every member and can be cached (RFC-008). This handler kept reading
 * `ch.unreadCount ?? 0`.
 *
 * ⚠️ AND THE `?? 0` IS THE ACTUAL DEFECT, not the stale field name. Every channel
 * would have reported "0 unread" — a plausible answer, no error, nothing in a
 * log. An agent asking "is anything waiting for me?" would have been told no,
 * forever. A default is not a safe fallback when the thing it stands in for is a
 * fact about the world; the same mistake as `?? 0` on a reply count, and the
 * reason this file asserts on ABSENCE as hard as it asserts on values.
 *
 * THE SEAM. Same as `read-messages-cursor.test.ts`: the real plugin driven over
 * stdio against a stub HTTP server, so this pins the WIRE CONTRACT rather than a
 * particular server build — and lets the last test impersonate a server that
 * predates `/read-state`, which no real server can be asked to be any more.
 *
 * The server half lives in the bridge repo, `packages/api/test/read-state.test.ts`
 * ("the channel list no longer carries read state"). Both halves must move together.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SERVER = join(import.meta.dir, "..", "server.ts");

type Row = Record<string, unknown>;

type Stub = {
  port: number;
  connected: () => boolean;
  /** Paths this stub was asked for, in order — proves the second call happens. */
  paths: string[];
  setChannels: (rows: Row[]) => void;
  setReadState: (rows: Row[]) => void;
  /** Answer `/api/channels/read-state` with this status instead (404 = old server). */
  setReadStateError: (status: number) => void;
  stop: () => void;
};

function startStub(): Stub {
  let socket: any = null;
  let channels: Row[] = [];
  let readState: Row[] = [];
  let readStateError: number | null = null;
  const paths: string[] = [];

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws" || req.headers.get("upgrade") === "websocket") {
        if (srv.upgrade(req)) return;
      }
      paths.push(url.pathname);
      // ⚠️ BEFORE the `/api/channels` arm — it is a PREFIX of this path, and the
      // bridge repo has already taken an outage from exactly that ordering bug.
      if (url.pathname === "/api/channels/read-state") {
        if (readStateError !== null) return new Response("no", { status: readStateError });
        return Response.json({ readState });
      }
      if (url.pathname === "/api/channels") return Response.json({ channels });
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
    paths,
    setChannels: (r) => { channels = r; },
    setReadState: (r) => { readState = r; readStateError = null; },
    setReadStateError: (s) => { readStateError = s; },
    stop: () => server.stop(true),
  };
}

/** A channel row as the CURRENT server sends it — note: no `unreadCount`. */
const channel = (id: string, lastSeq: number): Row => ({
  id,
  name: id,
  description: null,
  lastSeq,
  archived: false,
  createdAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
});

const state = (channelId: string, unread: boolean, lastReadSeq: number): Row => ({
  channelId,
  lastReadSeq,
  threadsReadSeq: 0,
  unread,
});

describe("list_channels reports read state, or says it does not know", () => {
  let dir = "";
  let stub: Stub;
  let plugin: ReturnType<typeof Bun.spawn>;
  let out = "";
  let nextId = 1;

  /**
   * ⚠️ ONE PLUGIN BOOT FOR THE WHOLE FILE, NOT ONE PER TEST — and that is a
   * neighbourliness constraint, not an optimisation. Every test file here spawns
   * a plugin process plus a stub server, and bun runs the files concurrently.
   * Booting five times from this file was enough extra load to time out the
   * 15-second wait in `delivery-reasons.test.ts` — a green file making an
   * unrelated one red. MEASURED: full suite 47 pass before this file existed,
   * 51 pass / 1 fail with the per-test boot, green again with this.
   *
   * Safe because `list_channels` holds no state between calls: every invocation
   * re-fetches both endpoints, and the stub is re-armed below.
   */
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "lcrs-"));
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

    const initId = nextId++;
    send({ jsonrpc: "2.0", id: initId, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" },
    }});
    await waitForId(initId);
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }, 30_000);

  // Re-arm the stub for every test, so one test's 404 cannot leak into the next.
  beforeEach(() => {
    stub.setChannels([channel("general", 12), channel("acl-pilot", 5)]);
    stub.setReadState([state("general", true, 7), state("acl-pilot", false, 5)]);
    stub.paths.length = 0;
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

  /** Call `list_channels` and return its parsed body, keyed by channel id. */
  async function list() {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_channels", arguments: {} } });
    const msg = await waitForId(id);
    expect(msg.result?.isError, `tool errored: ${msg.result?.content?.[0]?.text}`).toBeFalsy();
    const body = JSON.parse(msg.result.content[0].text);
    return {
      body,
      byId: new Map<string, any>(body.channels.map((c: any) => [c.id, c])),
    };
  }

  test("the read-state endpoint is actually called", async () => {
    await list();
    // The bug was not a wrong value — it was a request that never happened.
    expect(stub.paths).toContain("/api/channels/read-state");
  });

  test("an unread channel reports hasUnread, and a read one reports false", async () => {
    const { byId } = await list();
    expect(byId.get("general").hasUnread).toBe(true);
    expect(byId.get("acl-pilot").hasUnread).toBe(false);
  });

  test("each channel carries the cursor read_messages resumes from", async () => {
    // The point of surfacing it: an agent can go straight to
    // `read_messages(since_seq: last_read_seq)` without first reading a page to
    // discover where it stopped.
    const { byId } = await list();
    expect(byId.get("general").last_read_seq).toBe(7);
    expect(byId.get("general").last_seq).toBe(12);
  });

  /**
   * ⚠️ THE TEST THAT WOULD HAVE CAUGHT THE ORIGINAL BUG, and the reason absence
   * is asserted rather than a value. Against a server with no `/read-state`, the
   * old handler answered `unread: 0` for everything — indistinguishable from a
   * genuinely quiet Bridge. Absent means "I do not know"; false means "I checked".
   */
  test("a server with no read-state endpoint yields ABSENT fields, not false", async () => {
    stub.setReadStateError(404);
    const { byId } = await list();
    const g = byId.get("general");
    expect(g).toBeDefined();
    // Still lists the channels — the tool degrades, it does not fail.
    expect(g.name).toBe("general");
    expect("hasUnread" in g).toBe(false);
    expect("last_read_seq" in g).toBe(false);
    // ...and emphatically not the old lie.
    expect(g.unread).toBeUndefined();
  });

  test("a transient read-state failure is not reported as 'nothing unread'", async () => {
    stub.setReadStateError(500);
    const { byId } = await list();
    expect("hasUnread" in byId.get("general")).toBe(false);
  });
});
