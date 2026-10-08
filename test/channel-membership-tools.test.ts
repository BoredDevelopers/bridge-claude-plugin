/**
 * `join_channel`, `leave_channel`, `who_can_see` — an agent manages its own channel
 * membership and checks who reads a channel or task (0.28.0).
 *
 * WHY THIS EXISTS. Since the server's slice 5a-2, posting needs membership in
 * public channels too: a reply into a channel the agent is not in answers 403
 * `join_required`. The server has let agents join public channels since then
 * (`POST /api/channels/:id/join`), but no tool reached it, so an agent hit a wall
 * it could not climb — a person had to add it by hand (2026-10-08, #einweave).
 *
 * THE SEAM. The real plugin over stdio against a stub HTTP server, like
 * `list-channels-read-state.test.ts`, so this pins the WIRE CONTRACT: the route,
 * the name → id resolution, and that each server refusal comes back as something
 * the agent can act on. The server half: bridge repo, `test/channel-join.test.ts`.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentAuthRoutes } from "./agent-auth-routes";
import { mintAgentToken } from "./agent-auth-stub";

const SERVER = join(import.meta.dir, "..", "server.ts");
const ENROLMENT_KEY = mintAgentToken("ek");

const GENERAL = "01a11c21-175f-7000-9449-f0a07118354a";
const SECRET = "01a11c21-175f-7000-9449-f0a07118354b";
const GONE = "01a11c21-175f-7000-9449-f0a07118354c";
const OLD = "01a11c21-175f-7000-9449-f0a07118354d";
const TASK = "01a11c21-175f-7000-9449-f0a0711835aa";
const MINE = "01a11c21-175f-7000-9449-f0a07118354e"; // private, this agent is in it (its last owner)
const OPS_UPPER = "01a11c21-175f-7000-9449-f0a071183501"; // "Ops"
const OPS_LOWER = "01a11c21-175f-7000-9449-f0a071183502"; // "ops" — names differ only in case
const DUP_A = "01a11c21-175f-7000-9449-f0a071183503"; // "Dup"
const DUP_B = "01a11c21-175f-7000-9449-f0a071183504"; // "dUp"

type Call = { method: string; path: string };

function startStub() {
  let socket: any = null;
  const calls: Call[] = [];
  const joined = new Set<string>();
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
      calls.push({ method: req.method, path: url.pathname });
      /**
       * As the real server lists them: PUBLIC channels and the private ones this agent
       * is in — never a private channel it is not in (SECRET) — and archived ones
       * only when asked (`includeArchived=true`).
       */
      if (req.method === "GET" && url.pathname === "/api/channels") {
        const channels = [
          { id: GENERAL, name: "general" },
          { id: MINE, name: "mine" },
          { id: GONE, name: "gone" },
          { id: OPS_UPPER, name: "Ops" },
          { id: OPS_LOWER, name: "ops" },
          { id: DUP_A, name: "Dup" },
          { id: DUP_B, name: "dUp" },
        ];
        if (url.searchParams.get("includeArchived") === "true") channels.push({ id: OLD, name: "old" });
        return Response.json({ channels });
      }
      const m = url.pathname.match(/^\/api\/channels\/([^/]+)\/join$/);
      if (req.method === "POST" && m) {
        const id = m[1];
        // The read gate runs first: a private channel the agent is NOT in is a plain
        // 403 Forbidden; `invite_only` only for one it can read — it is already in it.
        if (id === SECRET) return Response.json({ error: "Forbidden" }, { status: 403 });
        if (id === MINE) return Response.json({ error: "invite_only" }, { status: 403 });
        if (id === GONE) return Response.json({ error: "removed_from_channel" }, { status: 403 });
        if (id === OLD) return Response.json({ error: "channel_archived" }, { status: 409 });
        if (id === GENERAL) {
          const first = !joined.has(id);
          joined.add(id);
          return Response.json({ ok: true, joined: first });
        }
        return Response.json({ error: "Channel not found" }, { status: 404 });
      }
      const leave = url.pathname.match(/^\/api\/channels\/([^/]+)\/leave$/);
      if (req.method === "POST" && leave) {
        const id = leave[1];
        if (id === GENERAL) return Response.json({ ok: true, channelId: id, left: true, releasedTasks: 2, agentsRemoved: [] });
        if (id === MINE) return Response.json({ error: "last_owner" }, { status: 409 });
        if (id === OPS_UPPER || id === OPS_LOWER) return Response.json({ ok: true, channelId: id, left: true, releasedTasks: 0, agentsRemoved: [] });
        if (id === OLD) return Response.json({ error: "channel_archived" }, { status: 409 });
        return Response.json({ error: "Not a member of this channel" }, { status: 404 });
      }
      const aud = url.pathname.match(/^\/api\/channels\/([^/]+)\/audience$/);
      if (req.method === "GET" && aud) {
        if (aud[1] === GENERAL) return Response.json({ visibility: "public", workspace: { people: 3, agents: 2 } });
        if (aud[1] === MINE) {
          return Response.json({
            visibility: "private",
            entries: [
              { principalId: "u1", kind: "human", name: "Jörgen", handle: "jorgen", reasons: [{ code: "manages_member", agentId: "a1", agentHandle: "scout" }, { code: "owner" }], lastSpokeAt: "2026-10-08T10:00:00.000Z" },
              { principalId: "a1", kind: "agent", name: "Scout", handle: "scout", reasons: [{ code: "member" }], lastSpokeAt: null },
            ],
          });
        }
        return Response.json({ error: "Channel not found" }, { status: 404 });
      }
      if (req.method === "GET" && url.pathname === `/api/tasks/${TASK}/audience`) {
        return Response.json({
          visibility: "private",
          entries: [{ principalId: "a2", kind: "agent", name: "Atlas", handle: "atlas", reasons: [{ code: "assignee" }], lastSpokeAt: null }],
          channelReaders: { people: 2, agents: 1 },
        });
      }
      if (req.method === "POST" && url.pathname === "/api/messages") {
        return Response.json({ error: "join_required" }, { status: 403 });
      }
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
            data: { agentId: "scout", agentName: "Scout", contextId: "ctx-under-test" },
          }));
        }
      },
      close() { socket = null; },
    },
  });

  return {
    port: server.port!,
    connected: () => socket !== null,
    calls,
    reset: () => { calls.length = 0; joined.clear(); },
    stop: () => server.stop(true),
  };
}

describe("join_channel", () => {
  let dir = "";
  let stub: ReturnType<typeof startStub>;
  let plugin: ReturnType<typeof Bun.spawn>;
  let out = "";
  let nextId = 1;

  // ONE plugin boot for the file — see list-channels-read-state.test.ts for why.
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "join-"));
    stub = startStub();
    plugin = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: `http://127.0.0.1:${stub.port}`,
        BRIDGE_ENROLMENT_KEY: ENROLMENT_KEY, BRIDGE_AUTOCONNECT: "1",
        CLAUDE_CODE_SESSION_ID: "11111111-2222-3333-4444-555555555556",
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

  beforeEach(() => stub.reset());

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

  async function call(name: string, args: Record<string, unknown>) {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const msg = await waitForId(id);
    return { isError: !!msg.result?.isError, text: String(msg.result?.content?.[0]?.text ?? "") };
  }

  test("is listed, and needs a channel", async () => {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
    const tool = (await waitForId(id)).result.tools.find((t: any) => t.name === "join_channel");
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(["channel_id"]);
  });

  test("by NAME: resolves to the id, then joins — and says so", async () => {
    const r = await call("join_channel", { channel_id: "#General" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("joined #general");
    expect(stub.calls).toContainEqual({ method: "POST", path: `/api/channels/${GENERAL}/join` });
  });

  test("by ID: straight to the join route, no lookup; a second join is a no-op", async () => {
    const first = await call("join_channel", { channel_id: GENERAL });
    expect(first.text).toContain("joined");
    expect(stub.calls).toEqual([{ method: "POST", path: `/api/channels/${GENERAL}/join` }]);
    const again = await call("join_channel", { channel_id: GENERAL });
    expect(again.isError).toBe(false);
    expect(again.text).toContain("already a member");
  });

  test("each refusal says what the agent can do about it", async () => {
    // A private channel it is not in: not listed, so by id — the server's plain Forbidden.
    const priv = await call("join_channel", { channel_id: SECRET });
    expect(priv.isError).toBe(true);
    expect(priv.text).toContain("private");
    expect(priv.text).toContain("an owner must add");
    // A private channel it IS in: `invite_only` means nothing to do, not a refusal.
    const mine = await call("join_channel", { channel_id: "mine" });
    expect(mine.isError, mine.text).toBe(false);
    expect(mine.text).toContain("#mine");
    expect(mine.text).toContain("already a member");
    const removed = await call("join_channel", { channel_id: "gone" });
    expect(removed.text).toContain("removed");
    const archived = await call("join_channel", { channel_id: "old" });
    expect(archived.text).toContain("archived");
  });

  test("an unknown name is refused before any join is attempted", async () => {
    const r = await call("join_channel", { channel_id: "nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('no channel named "nope"');
    expect(stub.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("a reply refused with join_required points at join_channel", async () => {
    const r = await call("reply", { channel_id: GENERAL, text: "hello" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("join_required");
    expect(r.text).toContain("join_channel(channel_id)");
  });

  test("leave_channel: by name, and says how many open tasks went back to the queue", async () => {
    const r = await call("leave_channel", { channel_id: "general" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("left #general");
    expect(r.text).toContain("2 open tasks went back to the queue");
    expect(stub.calls).toContainEqual({ method: "POST", path: `/api/channels/${GENERAL}/leave` });
  });

  test("leave_channel: each refusal says what the agent can do", async () => {
    expect((await call("leave_channel", { channel_id: "mine" })).text).toContain("last owner");
    expect((await call("leave_channel", { channel_id: "old" })).text).toContain("archived");
    const notMember = await call("leave_channel", { channel_id: "gone" });
    expect(notMember.isError).toBe(true);
    expect(notMember.text).toContain("not a member");
  });

  test("who_can_see: a private channel lists each reader with why", async () => {
    const r = await call("who_can_see", { channel_id: "mine" });
    expect(r.isError, r.text).toBe(false);
    const body = JSON.parse(r.text);
    expect(body.visibility).toBe("private");
    expect(body.readers).toEqual([
      { name: "Jörgen", handle: "jorgen", kind: "human", why: ["manages @scout, a member", "owner"], last_spoke_at: "2026-10-08T10:00:00.000Z" },
      { name: "Scout", handle: "scout", kind: "agent", why: ["member"], last_spoke_at: null },
    ]);
  });

  test("who_can_see: public = the whole workspace, counted", async () => {
    const body = JSON.parse((await call("who_can_see", { channel_id: GENERAL })).text);
    expect(body).toMatchObject({ visibility: "public", readers: "everyone in the workspace", workspace: { people: 3, agents: 2 } });
  });

  test("who_can_see: a task-only reader is told the channel's readers are counted, not named", async () => {
    const body = JSON.parse((await call("who_can_see", { message_id: TASK })).text);
    expect(body.readers.map((x: any) => x.handle)).toEqual(["atlas"]);
    expect(body.channel_readers_not_named).toEqual({ people: 2, agents: 1 });
    expect(stub.calls).toContainEqual({ method: "GET", path: `/api/tasks/${TASK}/audience` });
  });

  test("who_can_see: exactly one target; and not found reads as not found", async () => {
    expect((await call("who_can_see", {})).text).toContain("exactly one");
    expect((await call("who_can_see", { channel_id: "general", message_id: TASK })).text).toContain("exactly one");
    const nf = await call("who_can_see", { message_id: "01a11c21-175f-7000-9449-f0a0711835ff" });
    expect(nf.isError).toBe(true);
    expect(nf.text).toContain("not found, or not readable");
  });

  test("names are case-sensitive: an exact match wins, a unique folded match is used, an ambiguous one is refused", async () => {
    await call("leave_channel", { channel_id: "ops" });
    expect(stub.calls).toContainEqual({ method: "POST", path: `/api/channels/${OPS_LOWER}/leave` });
    expect(stub.calls.some((c) => c.path === `/api/channels/${OPS_UPPER}/leave`)).toBe(false);
    stub.reset();
    await call("leave_channel", { channel_id: "Ops" });
    expect(stub.calls).toContainEqual({ method: "POST", path: `/api/channels/${OPS_UPPER}/leave` });
    stub.reset();
    expect((await call("join_channel", { channel_id: "GENERAL" })).text).toContain("joined #general");
    stub.reset();
    const amb = await call("leave_channel", { channel_id: "DUP" });
    expect(amb.isError).toBe(true);
    expect(amb.text).toContain("matches several channels");
    expect(amb.text).toContain(DUP_A);
    expect(stub.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("an archived channel resolves by name, so the answer is 'archived', not 'no such channel'", async () => {
    const r = await call("leave_channel", { channel_id: "old" });
    expect(r.text).toContain("archived");
    expect(stub.calls).toContainEqual({ method: "POST", path: `/api/channels/${OLD}/leave` });
  });

  test("an uppercase id is sent lowercase (the server's id pattern is lowercase)", async () => {
    await call("join_channel", { channel_id: GENERAL.toUpperCase() });
    expect(stub.calls).toEqual([{ method: "POST", path: `/api/channels/${GENERAL}/join` }]);
  });
});
