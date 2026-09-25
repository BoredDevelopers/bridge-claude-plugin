/**
 * `read_thread` and `list_threads` — reading thread replies an agent was not
 * connected for.
 *
 * WHY THIS EXISTS (2026-09-23). An agent (Kevin) was asked to reply in a thread
 * whose replies arrived before his session connected. No tool could read them:
 * `read_messages` is roots-only by design, and thread replies only ever reached
 * an agent live, over the socket. He had to ask a human to paste them.
 *
 * THE SEAM. Same as read-messages-cursor.test.ts — the real plugin over stdio
 * against a stub that MODELS the server's paging (bridge
 * `packages/api/src/routes/threads.ts`: `seq > sinceSeq`, ORDER BY seq,
 * `limit`, `hasMore` from one extra row, `nextSinceSeq` = last returned or the
 * echoed cursor). The server half is pinned in bridge
 * `packages/api/test/thread-read-route.test.ts`; both halves move together.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentAuthRoutes } from "./agent-auth-routes";

const SERVER = join(import.meta.dir, "..", "server.ts");
const ENROLMENT_KEY = "brg_ek_test";
const THREAD = "0190a000-0000-7000-9000-000000000001";
const CHANNEL_ID = "ch-general-id";
const CHANNEL_NAME = "general";

type Row = Record<string, unknown>;
const msg = (seq: number, content: string): Row => ({
  id: `0190a000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
  channelId: CHANNEL_ID,
  threadId: THREAD,
  agentId: "kevin",
  senderName: "Kevin",
  content,
  type: "text",
  seq,
  createdAt: "2026-09-23T05:55:07.000Z",
});

type Stub = {
  port: number;
  connected: () => boolean;
  /** Every request as "METHOD path?query", in order. */
  calls: string[];
  /** Bodies POSTed to a `/read` route, in order. */
  readBodies: { path: string; body: any }[];
  /** Bodies sent to `/answer`, in order. */
  answerBodies: any[];
  /** Bodies sent to `/kind`, in order. */
  kindBodies: any[];
  set: (s: Partial<State>) => void;
  stop: () => void;
};
type State = {
  root: Row | null;
  replies: Row[];
  threadStatus: number; // status for GET /api/threads/:id/messages
  legacy: boolean; // a server that predates paging: no hasMore/nextSinceSeq
  readStatus: number; // status for POST .../read
  threads: Row[];
  /** Server shape that predates name resolution: no `channelId` echo. */
  legacyList: boolean;
  /** PUT/DELETE /api/threads/:id/answer — status + `{error}` on refusal. */
  answerStatus: number;
  answerError: string;
  /** GET /api/threads/:id/events — the timeline; `eventsStatus` 404 models an older server. */
  events: Row[];
  eventsStatus: number;
};

function startStub(): Stub {
  let socket: any = null;
  const calls: string[] = [];
  const readBodies: { path: string; body: any }[] = [];
  const answerBodies: any[] = [];
  const kindBodies: any[] = [];
  let st: State = { root: null, replies: [], threadStatus: 200, legacy: false, readStatus: 200, threads: [], legacyList: false, answerStatus: 200, answerError: "", events: [], eventsStatus: 200 };
  let answer: string | null = null; // the thread's accepted answer
  let cursor = 0; // the stored thread read position
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
      calls.push(`${req.method} ${url.pathname}${url.search}`);

      if (url.pathname === "/api/channels") {
        return Response.json({ channels: [{ id: CHANNEL_ID, name: CHANNEL_NAME }] });
      }
      if (url.pathname === "/api/threads" && req.method === "GET") {
        // Models threads.ts: resolves a name OR an id; an unknown channel is a
        // 200 with `channelId: null` (NOT a 404 — the real server never 404s it).
        const c = url.searchParams.get("channel");
        const known = c === CHANNEL_ID || c === CHANNEL_NAME;
        if (st.legacyList) return Response.json({ threads: known ? st.threads : [] });
        return Response.json({ channelId: known ? CHANNEL_ID : null, threads: known ? st.threads : [] });
      }
      const k = url.pathname.match(/^\/api\/threads\/([^/]+)\/kind$/);
      if (k && req.method === "PUT") {
        const body: any = await req.json().catch(() => null);
        kindBodies.push(body);
        if (st.answerStatus !== 200) return Response.json({ error: st.answerError }, { status: st.answerStatus });
        return Response.json({ threadId: k[1], channelId: CHANNEL_ID, kind: body.kind, status: "open", answerMessageId: null });
      }
      const ev = url.pathname.match(/^\/api\/threads\/([^/]+)\/events$/);
      if (ev && req.method === "GET") {
        if (st.eventsStatus !== 200) return new Response("no", { status: st.eventsStatus });
        return Response.json({ events: st.events });
      }
      // Models threads.ts PUT/DELETE /:id/answer (RFC-015 D4): mark resolves, unmark reopens.
      const a = url.pathname.match(/^\/api\/threads\/([^/]+)\/answer$/);
      if (a && (req.method === "PUT" || req.method === "DELETE")) {
        const body: any = req.method === "PUT" ? await req.json().catch(() => null) : null;
        answerBodies.push(body);
        if (st.answerStatus !== 200) return Response.json({ error: st.answerError }, { status: st.answerStatus });
        answer = req.method === "PUT" ? body.messageId : null;
        return Response.json({
          threadId: a[1], channelId: CHANNEL_ID, kind: "question",
          status: answer ? "resolved" : "open", resolvedReason: answer ? "done" : null, answerMessageId: answer,
        });
      }
      const m = url.pathname.match(/^\/api\/threads\/([^/]+)\/(messages|read)$/);
      if (m && m[2] === "read" && req.method === "POST") {
        return req.json().catch(() => null).then((body: any) => {
          readBodies.push({ path: url.pathname, body });
          if (st.readStatus !== 200) return new Response("boom", { status: st.readStatus });
          // Models threads.ts: advance only if the stored position reaches
          // fromSeq; clamp to the head; never backwards.
          const all = [...(st.root ? [st.root] : []), ...st.replies];
          const head = all.length ? Math.max(...all.map((r) => Number(r.seq))) : 0;
          if (body?.fromSeq !== undefined && cursor < body.fromSeq) {
            return Response.json({ ok: true, advanced: false, threadId: m[1], lastReadSeq: cursor });
          }
          cursor = Math.max(cursor, Math.min(body?.lastReadSeq ?? head, head));
          return Response.json({ ok: true, advanced: true, threadId: m[1], lastReadSeq: cursor });
        });
      }
      if (m && m[2] === "messages" && req.method === "GET") {
        if (st.threadStatus !== 200) return new Response("Not found", { status: st.threadStatus });
        if (m[1] !== THREAD) return Response.json({ thread: null, parent: null, replies: [] });
        const q = url.searchParams;
        const limit = Number(q.get("limit") ?? 200);
        const since = q.get("sinceSeq");
        const after = since === null ? st.replies : st.replies.filter((r) => Number(r.seq) > Number(since));
        const page = after.slice(0, limit);
        const last = page[page.length - 1];
        const body: any = { parent: st.root, replies: page };
        if (!st.legacy) {
          body.thread = {
            id: THREAD, channelId: CHANNEL_ID, title: "Bug: threaded replies", kind: "question",
            status: answer ? "resolved" : "open", answerMessageId: answer, replyCount: st.replies.length,
          };
          body.hasMore = after.length > limit;
          body.nextSinceSeq = last ? last.seq : Number(since ?? 0);
        }
        return Response.json(body);
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
            data: { agentId: "bellman", agentName: "Bellman", contextId: "ctx-under-test" },
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
    readBodies,
    answerBodies,
    kindBodies,
    set: (s) => { st = { ...st, ...s }; },
    stop: () => server.stop(true),
  };
}

describe("read_thread / list_threads", () => {
  let dir = "";
  let stub: Stub;
  let plugin: ReturnType<typeof Bun.spawn>;
  let out = "";
  let nextId = 1;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "rt-"));
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
    stub.set({
      root: msg(12, "Bug: Threaded replies do not work"),
      replies: [msg(13, "r1"), msg(14, "r2"), msg(15, "r3")],
    });
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
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === id) return m;
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
  async function callTool(name: string, args: Record<string, unknown>) {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const m = await waitForId(id);
    return { isError: !!m.result?.isError, text: m.result?.content?.[0]?.text ?? "" };
  }
  async function ok(name: string, args: Record<string, unknown>) {
    const r = await callTool(name, args);
    if (r.isError) throw new Error(`unexpected tool error: ${r.text}`);
    return JSON.parse(r.text);
  }

  test("first page: root + replies, and the thread is marked read up to the LAST returned seq", async () => {
    const body = await ok("read_thread", { thread_id: THREAD, limit: 2 });
    expect(body.root.content).toBe("Bug: Threaded replies do not work");
    expect(body.replies.map((r: any) => r.content)).toEqual(["r1", "r2"]);
    expect(body.has_more).toBe(true);
    expect(body.next_since_seq).toBe(14);
    expect(body.channel_id).toBe(CHANNEL_ID);
    // Marked to 14 — what was READ — never to the head (15), which was not returned.
    expect(stub.readBodies).toEqual([{ path: `/api/threads/${THREAD}/read`, body: { fromSeq: 0, lastReadSeq: 14 } }]);
    expect(body.marked_read_up_to).toBe(14);
    const q = new URLSearchParams(stub.calls.find((c) => c.includes("/messages"))!.split("?")[1]);
    expect(q.get("limit")).toBe("2");
    expect(q.has("sinceSeq")).toBe(false);
  });

  test("since_seq reaches the server as sinceSeq, omits the root, and marks that page", async () => {
    await ok("read_thread", { thread_id: THREAD, limit: 2 });
    const body = await ok("read_thread", { thread_id: THREAD, since_seq: 14 });
    const q = new URLSearchParams(stub.calls.filter((c) => c.includes("/messages")).at(-1)!.split("?")[1]);
    expect(q.get("sinceSeq")).toBe("14");
    expect(body.root).toBeUndefined();
    expect(body.replies.map((r: any) => r.content)).toEqual(["r3"]);
    expect(body.has_more).toBe(false);
    expect(stub.readBodies.map((b) => b.body)).toEqual([
      { fromSeq: 0, lastReadSeq: 14 },
      { fromSeq: 14, lastReadSeq: 15 },
    ]);
    expect(body.marked_read_up_to).toBe(15);
  });

  test("a read starting ABOVE the stored position is not marked, and says where to catch up", async () => {
    // E.g. since_seq copied off a live reply: replies 13 and 14 were never read.
    const body = await ok("read_thread", { thread_id: THREAD, since_seq: 14 });
    expect(stub.readBodies.map((b) => b.body)).toEqual([{ fromSeq: 14, lastReadSeq: 15 }]);
    expect(body.marked_read_up_to).toBeUndefined();
    expect(body.mark_read_skipped).toContain("since_seq: 0");
  });

  test("a real thread that is rootless and empty is NOT reported as a message_id mix-up", async () => {
    stub.set({ root: null, replies: [] });
    const r = await callTool("read_thread", { thread_id: THREAD });
    expect(r.isError).toBe(false);
    const body = JSON.parse(r.text);
    expect(body.count).toBe(0);
    expect(body.channel_id).toBe(CHANNEL_ID); // from the thread summary, not a missing root
  });

  test("a first page with no replies resumes from the root's seq, not 0", async () => {
    stub.set({ replies: [] });
    const body = await ok("read_thread", { thread_id: THREAD });
    expect(body.next_since_seq).toBe(12);
    expect(body.hint).toContain("since_seq: 12");
  });

  test("an empty poll marks nothing and keeps the cursor", async () => {
    const body = await ok("read_thread", { thread_id: THREAD, since_seq: 15 });
    expect(body.count).toBe(0);
    expect(body.next_since_seq).toBe(15);
    expect(stub.readBodies).toEqual([]);
  });

  test("mark_read: false peeks without marking", async () => {
    await ok("read_thread", { thread_id: THREAD, mark_read: false });
    expect(stub.readBodies).toEqual([]);
  });

  test("a failed mark is reported, and the read still succeeds", async () => {
    stub.set({ readStatus: 500 });
    const body = await ok("read_thread", { thread_id: THREAD });
    expect(body.replies).toHaveLength(3);
    expect(body.marked_read_up_to).toBeUndefined();
    expect(body.mark_read_error).toContain("500");
  });

  test("a message_id passed as thread_id says so, instead of '0 replies'", async () => {
    const r = await callTool("read_thread", { thread_id: String(msg(12, "").id) });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("a message_id is not a thread_id");
  });

  test("mark_answer PUTs the reply; read_thread then shows kind + the answer; unmark DELETEs (RFC-015 D4)", async () => {
    const reply = String(msg(14, "r2").id);
    const marked = await ok("mark_answer", { thread_id: THREAD, message_id: reply });
    expect(marked).toEqual({ thread_id: THREAD, status: "resolved", answer_message_id: reply });
    expect(stub.calls).toContain(`PUT /api/threads/${THREAD}/answer`);
    expect(stub.answerBodies).toEqual([{ messageId: reply }]);

    const read = await ok("read_thread", { thread_id: THREAD, mark_read: false });
    expect(read.thread).toMatchObject({ kind: "question", status: "resolved", answer_message_id: reply });

    const unmarked = await ok("mark_answer", { thread_id: THREAD, unmark: true });
    expect(unmarked).toEqual({ thread_id: THREAD, status: "open", answer_message_id: null });
    expect(stub.calls).toContain(`DELETE /api/threads/${THREAD}/answer`);
  });

  test("read_thread's FIRST page carries the thread's history; a later page does not re-send it", async () => {
    stub.set({
      events: [
        { id: "e1", action: "answer", detail: { messageId: "m1", from: null }, actorId: "u1", actorType: "human", actorName: "Jörgen", occurredAt: "2026-09-25T10:00:00.000Z" },
        { id: "e2", action: "reopen", detail: null, actorId: "u2", actorType: "agent", actorName: null, occurredAt: "2026-09-25T10:05:00.000Z" },
      ],
    });
    const first = await ok("read_thread", { thread_id: THREAD, mark_read: false });
    expect(first.events).toEqual([
      { ts: "2026-09-25T10:00:00.000Z", by: "Jörgen", action: "answer", detail: { messageId: "m1", from: null } },
      { ts: "2026-09-25T10:05:00.000Z", by: "u2", action: "reopen" },
    ]);
    const later = await ok("read_thread", { thread_id: THREAD, since_seq: 13, mark_read: false });
    expect(later.events).toBeUndefined();
    expect(stub.calls.filter((c) => c.endsWith("/events"))).toHaveLength(1);
  });

  test("read_thread against a server without the timeline (404) still reads, with no events", async () => {
    stub.set({ eventsStatus: 404, events: [] });
    const body = await ok("read_thread", { thread_id: THREAD, mark_read: false });
    expect(body.events).toBeUndefined();
    expect(body.replies).toHaveLength(3);
    stub.set({ eventsStatus: 500 });
    const r = await callTool("read_thread", { thread_id: THREAD, mark_read: false });
    expect(r.isError).toBe(true);
  });

  test("set_thread_kind PUTs the kind and reports the result (RFC-015 slice 5)", async () => {
    const r = await ok("set_thread_kind", { thread_id: THREAD, kind: "question" });
    expect(r).toEqual({ thread_id: THREAD, kind: "question", status: "open", answer_message_id: null });
    expect(stub.calls).toContain(`PUT /api/threads/${THREAD}/kind`);
    expect(stub.kindBodies).toEqual([{ kind: "question" }]);
  });

  test("set_thread_kind refuses task/unknown locally, and explains 403 and the server's 422", async () => {
    const task = await callTool("set_thread_kind", { thread_id: THREAD, kind: "task" });
    expect(task.isError).toBe(true);
    expect(task.text).toContain("a task stays a task");
    expect(stub.kindBodies).toEqual([]);

    stub.set({ answerStatus: 403, answerError: "Forbidden" });
    const r403 = await callTool("set_thread_kind", { thread_id: THREAD, kind: "question" });
    expect(r403.text).toContain("only the thread's creator, the channel owner or a workspace admin");

    stub.set({ answerStatus: 422, answerError: "A task thread's kind cannot be changed" });
    const r422 = await callTool("set_thread_kind", { thread_id: THREAD, kind: "discussion" });
    expect(r422.isError).toBe(true);
    expect(r422.text).toContain("A task thread's kind cannot be changed");
  });

  test("mark_answer refuses an ambiguous or empty call locally — nothing is sent", async () => {
    const both = await callTool("mark_answer", { thread_id: THREAD, message_id: "x", unmark: true });
    expect(both.isError).toBe(true);
    expect(both.text).toContain("not both");
    const neither = await callTool("mark_answer", { thread_id: THREAD });
    expect(neither.isError).toBe(true);
    expect(neither.text).toContain("message_id is required");
    expect(stub.answerBodies).toEqual([]);
  });

  test("mark_answer explains a refusal: 403 standing, 409 nothing to withdraw, 422 the server's reason", async () => {
    stub.set({ answerStatus: 403, answerError: "Forbidden" });
    const r403 = await callTool("mark_answer", { thread_id: THREAD, message_id: "m" });
    expect(r403.isError).toBe(true);
    expect(r403.text).toContain("only the thread's creator, the channel owner or a workspace admin");

    stub.set({ answerStatus: 409, answerError: "Thread has no answer" });
    const r409 = await callTool("mark_answer", { thread_id: THREAD, unmark: true });
    expect(r409.text).toContain("no answer to withdraw");

    stub.set({ answerStatus: 422, answerError: "Only a question thread has an answer" });
    const r422 = await callTool("mark_answer", { thread_id: THREAD, message_id: "m" });
    expect(r422.isError).toBe(true);
    expect(r422.text).toContain("Only a question thread has an answer");
  });

  test("a masked or missing thread (404) is an error naming the id", async () => {
    stub.set({ threadStatus: 404 });
    const r = await callTool("read_thread", { thread_id: THREAD });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(THREAD);
  });

  test("a server that predates paging is refused, not trusted with a cursor", async () => {
    stub.set({ legacy: true });
    const r = await callTool("read_thread", { thread_id: THREAD, since_seq: 14 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("does not support paged thread reads");
    expect(stub.readBodies).toEqual([]);
  });

  test("list_threads resolves a channel NAME to its id and reports unread", async () => {
    stub.set({
      threads: [
        { id: THREAD, title: "Bug", status: "open", replyCount: 3, unreadCount: 2, lastActivityAt: "x" },
        { id: "t2", title: "Quiet", status: "open", replyCount: 1, unreadCount: 0, lastActivityAt: "y" },
      ],
    });
    const body = await ok("list_threads", { channel_id: CHANNEL_NAME });
    // The name goes to the server as-is; the server resolves it and echoes the id.
    expect(stub.calls).toContain(`GET /api/threads?channel=${CHANNEL_NAME}`);
    expect(body.channel_id).toBe(CHANNEL_ID);
    expect(body.threads.map((t: any) => [t.thread_id, t.unread])).toEqual([[THREAD, 2], ["t2", 0]]);
    expect(body.hint).toContain("1 thread(s) with unread");

    const unreadOnly = await ok("list_threads", { channel_id: CHANNEL_NAME, unread_only: true });
    expect(unreadOnly.threads.map((t: any) => t.thread_id)).toEqual([THREAD]);
  });

  test("list_threads(query) SEARCHES: sends q, reports kind, and says continue-don't-duplicate (RFC-015 D5)", async () => {
    stub.set({
      threads: [
        { id: THREAD, title: "Picker double-fetch on workspace switch", kind: "question", status: "open", replyCount: 2, unreadCount: 0, lastActivityAt: "x" },
      ],
    });
    const body = await ok("list_threads", { channel_id: CHANNEL_NAME, query: "  picker double fetch & more " });
    // Trimmed and URL-encoded (a title can hold &, #, ?).
    expect(stub.calls).toContain(`GET /api/threads?channel=${CHANNEL_NAME}&q=picker%20double%20fetch%20%26%20more`);
    expect(body.threads[0]).toMatchObject({ thread_id: THREAD, kind: "question" });
    expect(body.hint).toContain("1 similar thread(s)");
    expect(body.hint).toContain("reply(thread_id)");

    stub.set({ threads: [] });
    const none = await ok("list_threads", { channel_id: CHANNEL_NAME, query: "nightly deploy" });
    expect(none.hint).toContain("No similar threads");
  });

  test("list_threads WITHOUT a query sends no q (the plain list is unchanged)", async () => {
    stub.set({ threads: [] });
    await ok("list_threads", { channel_id: CHANNEL_NAME });
    expect(stub.calls).toContain(`GET /api/threads?channel=${CHANNEL_NAME}`);
    expect(stub.calls.some((c) => c.includes("&q="))).toBe(false);
  });

  test("an unknown channel is an error, never a false 'No unread threads.'", async () => {
    const r = await callTool("list_threads", { channel_id: "no-such-channel" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Unknown channel: no-such-channel");
  });

  test("a server that cannot say which channel it resolved is refused", async () => {
    stub.set({ legacyList: true, threads: [] });
    const r = await callTool("list_threads", { channel_id: CHANNEL_NAME });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("upgrade the server");
  });

  test("list_threads leaves unread ABSENT when the server does not report it", async () => {
    stub.set({ threads: [{ id: THREAD, title: "Bug", status: "open", replyCount: 3, lastActivityAt: "x" }] });
    const body = await ok("list_threads", { channel_id: CHANNEL_ID });
    expect("unread" in body.threads[0]).toBe(false);
  });
});
