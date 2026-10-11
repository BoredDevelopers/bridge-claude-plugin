/**
 * `read_deliveries`: everything this session's model still owes, all three kinds, cleared by
 * reading — the real plugin over stdio against a stub that models GET /api/deliveries (keyset
 * paging) and the wire frames, plus the real hook for the missed-notice round trip.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentAuthRoutes } from "./agent-auth-routes";
import { mintAgentToken } from "./agent-auth-stub";

const SERVER = join(import.meta.dir, "..", "server.ts");
const HOOK = join(import.meta.dir, "..", "hooks", "delivery.ts");
const ENROLMENT_KEY = mintAgentToken("ek");
const CHANNEL_ID = "0190a000-0000-7000-9000-0000000000c1";
const THREAD = "0190a000-0000-7000-9000-000000000001";
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;

type Owed = { kind: "message" | "task_event" | "action_request"; id: string; reasons: string[]; payload: Record<string, unknown> };
const message = (n: number, content = `hello ${n}`, reasons: string[] = ["channel"]): Owed => ({
  kind: "message",
  id: id(n),
  reasons,
  payload: {
    message: { id: id(n), channelId: CHANNEL_ID, threadId: THREAD, agentId: "kevin", senderName: "Kevin", content, type: "text", seq: n, createdAt: "2026-10-11T10:00:00.000Z" },
    deliveryReasons: reasons,
  },
});
const taskEvent = (n: number): Owed => ({
  kind: "task_event",
  id: id(n),
  reasons: ["assigned"],
  payload: { id: id(n), taskId: "T-7", threadId: THREAD, change: "assigned", status: "open", assigneeId: "bellman", actorId: "kevin", reason: "please", occurredAt: "2026-10-11T10:01:00.000Z" },
});
const action = (n: number): Owed => ({
  kind: "action_request",
  id: id(n),
  reasons: ["action"],
  payload: { id: id(n), action: "restart", params: { force: true } },
});

function startStub() {
  const sockets = new Set<any>();
  const acks: { ids: string[]; how: string }[] = [];
  const calls: string[] = [];
  const state = { owed: [] as Owed[], status: 200, delayMs: 0, agentId: "bellman", authDelayMs: 0, channels: [{ id: CHANNEL_ID, name: "general" }] as { id: string; name: string }[] };
  const agentAuth = createAgentAuthRoutes();
  agentAuth.addEnrolmentKey(ENROLMENT_KEY);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const auth = await agentAuth.handle(req);
      if (auth) return auth;
      const url = new URL(req.url);
      if (url.pathname === "/ws" || req.headers.get("upgrade") === "websocket") {
        if (srv.upgrade(req)) return;
      }
      calls.push(`${req.method} ${url.pathname}${url.search}`);
      if (url.pathname === "/api/channels") return Response.json({ channels: state.channels });
      if (url.pathname === "/api/messages") {
        if (state.delayMs) await Bun.sleep(state.delayMs);
        return Response.json({ messages: state.owed.filter((e) => e.kind === "message").map((e) => (e.payload as any).message) });
      }
      if (/^\/api\/channels\/[^/]+\/read$/.test(url.pathname)) return Response.json({ ok: true, advanced: true, lastReadSeq: 99 });
      if (url.pathname === "/api/deliveries") {
        if (state.delayMs) await Bun.sleep(state.delayMs);
        if (state.status !== 200) return new Response("boom", { status: state.status });
        // Models the server: still-owed entries (not acked `model`), keyset-paged by position.
        const owed = state.owed.filter((e) => !acked.has(e.id));
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const after = url.searchParams.get("after");
        const start = after ? owed.findIndex((e) => e.id === after) + 1 : 0;
        const page = owed.slice(start, start + limit);
        const next = start + limit < owed.length ? page[page.length - 1]!.id : null;
        return Response.json({ entries: page, next });
      }
      return new Response("no", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        let frame: any = {};
        try { frame = JSON.parse(String(raw)); } catch { return; }
        if (frame.type === "ack") {
          acks.push({ ids: frame.ids, how: frame.how });
          if (frame.how === "model") for (const i of frame.ids) acked.add(i);
        }
        if (frame.type === "auth") {
          sockets.add(ws);
          const reply = JSON.stringify({ v: 2, type: "authenticated", payload: { agentId: state.agentId, agentName: state.agentId, contextId: "ctx-under-test" } });
          if (state.authDelayMs) setTimeout(() => ws.send(reply), state.authDelayMs);
          else ws.send(reply);
        }
      },
      close(ws) { sockets.delete(ws); },
    },
  });
  const acked = new Set<string>();
  let seq = 0;
  return {
    port: server.port!,
    acks,
    calls,
    state,
    connected: () => sockets.size > 0,
    dropSockets: () => { for (const ws of [...sockets]) ws.close(1011, "test drop"); },
    /** The server pushes an owed entry as a live frame. */
    push(e: Owed) {
      for (const ws of sockets) ws.send(JSON.stringify({ v: 2, type: e.kind, seq: ++seq, payload: e.payload }));
    },
    stop: () => server.stop(true),
  };
}

describe("read_deliveries", () => {
  let dir = "";
  let stub: ReturnType<typeof startStub>;
  let plugin: ReturnType<typeof Bun.spawn> | null = null;
  const spawned: Array<ReturnType<typeof Bun.spawn>> = [];
  let out = { text: "" };
  let nextId = 1;

  beforeEach(() => {
    dir = mkdtempSync(join("/tmp", "ewrd-"));
    stub = startStub();
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "sessions", `pid-${process.pid}.json`), JSON.stringify({ sessionId: "sess-rd", claudePid: process.pid, procStart: "", updatedAt: new Date().toISOString() }));
  });
  afterEach(async () => {
    const [ps, s, d] = [spawned.splice(0), stub, dir];
    plugin = null;
    for (const p of ps) p.kill();
    await Promise.all(ps.map((p) => p.exited));
    s.stop();
    rmSync(d, { recursive: true, force: true });
  }, 15_000);

  async function boot(autoconnect = true, extraEnv: Record<string, string> = {}) {
    out = { text: "" };
    const p = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        EINWEAVE_STATE_DIR: dir,
        EINWEAVE_API_URL: `http://127.0.0.1:${stub.port}`,
        EINWEAVE_ENROLMENT_KEY: ENROLMENT_KEY,
        EINWEAVE_AUTOCONNECT: autoconnect ? "1" : "0",
        CLAUDE_CODE_SESSION_ID: "11111111-2222-3333-4444-555555555555",
        CLAUDE_CODE_SSE_PORT: "",
        EINWEAVE_TEST: "1",
        EINWEAVE_TEST_LOCK_RETRY_MS: "300",
        ...extraEnv,
      } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    plugin = p;
    spawned.push(p);
    const o = out;
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of p.stdout as any) o.text += dec.decode(chunk, { stream: true });
    })();
    const init = nextId++;
    send({ jsonrpc: "2.0", id: init, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    await waitFor(() => lines().some((m) => m.id === init), 15_000, "initialize");
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    if (autoconnect && !extraEnv.__noWait) await waitFor(() => stub.connected(), 15_000, "authenticate");
  }
  const lines = (): any[] => out.text.split("\n").filter((l) => l.trim().startsWith("{")).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  function send(frame: unknown) {
    const sink = plugin!.stdin as { write: (s: string) => void; flush?: () => void };
    sink.write(JSON.stringify(frame) + "\n");
    sink.flush?.();
  }
  async function waitFor(cond: () => boolean, ms: number, what: string) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (cond()) return;
      await Bun.sleep(25);
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    const rid = nextId++;
    send({ jsonrpc: "2.0", id: rid, method: "tools/call", params: { name, arguments: args } });
    await waitFor(() => lines().some((m) => m.id === rid), 10_000, name);
    const m = lines().find((x) => x.id === rid);
    return { isError: !!m.result?.isError, text: m.result?.content?.[0]?.text ?? "" };
  }
  async function hook(prompt: string) {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), EINWEAVE_STATE_DIR: dir, CLAUDE_PID: String(process.pid) };
    const proc = Bun.spawn(["bun", HOOK, "prompt"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    proc.stdin.write(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }));
    proc.stdin.end();
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text ? (JSON.parse(text).hookSpecificOutput.additionalContext as string) : null;
  }
  const acksSettled = async (n: number) => waitFor(() => stub.acks.length >= n, 5000, `${n} ack frame(s)`);

  test("all three kinds come back, rendered like pushes, and are acked `model` — exactly the ones returned", async () => {
    stub.state.owed = [message(1), taskEvent(2), action(3)];
    await boot();
    const r = await call("read_deliveries");
    expect(r.isError).toBe(false);
    const body = JSON.parse(r.text);
    expect(body.count).toBe(3);
    expect(body.next).toBeNull();
    expect(body.entries.map((e: any) => [e.kind, e.id])).toEqual([["message", id(1)], ["task_event", id(2)], ["action_request", id(3)]]);
    const [m, te, ar] = body.entries;
    expect(m).toMatchObject({ reasons: ["channel"], channel_id: CHANNEL_ID, thread_id: THREAD, content: "hello 1", redelivery: false });
    expect(m.meta).toMatchObject({ sender: "Kevin", type: "text", message_id: id(1) });
    expect(te).toMatchObject({ thread_id: THREAD, content: "Task T-7: assigned (status open) — please" });
    expect(te.meta).toMatchObject({ type: "task_event", task_id: "T-7", change: "assigned" });
    expect(ar).toMatchObject({ content: 'Action requested: restart {"force":true}' });
    await acksSettled(1);
    expect(stub.acks).toEqual([{ ids: [id(1), id(2), id(3)], how: "model" }]);
    // Cleared: a second read owes nothing.
    const again = JSON.parse((await call("read_deliveries")).text);
    expect(again.count).toBe(0);
    expect(again.hint).toContain("Nothing is owed");
  }, 40_000);

  test("paging: `next` is passed through with a literal next call, and only the returned page is acked", async () => {
    stub.state.owed = [message(1), message(2), message(3)];
    await boot();
    const first = JSON.parse((await call("read_deliveries", { limit: 2 })).text);
    expect(first.count).toBe(2);
    expect(first.next).toBe(id(2));
    expect(first.hint).toContain(`read_deliveries(after: "${id(2)}")`);
    await acksSettled(1);
    expect(stub.acks).toEqual([{ ids: [id(1), id(2)], how: "model" }]); // not the third
    const second = JSON.parse((await call("read_deliveries", { limit: 2, after: first.next })).text);
    expect(second.entries.map((e: any) => e.id)).toEqual([id(3)]);
    expect(second.next).toBeNull();
    await acksSettled(2);
    expect(stub.acks[1]).toEqual({ ids: [id(3)], how: "model" });
    const gets = stub.calls.filter((c) => c.startsWith("GET /api/deliveries"));
    expect(gets.at(-1)).toContain(`after=${id(2)}`);
  }, 40_000);

  test("echoes of this session's own sends are not shown; they are acked `dismissed`, and limit is clamped to 200", async () => {
    const own = message(1, "my own words");
    (own.payload.message as any).senderContextId = "ctx-under-test"; // this session's grant
    stub.state.owed = [own, message(2)];
    await boot();
    const body = JSON.parse((await call("read_deliveries", { limit: 999 })).text);
    expect(body.entries.map((e: any) => e.id)).toEqual([id(2)]);
    await acksSettled(2);
    expect(stub.acks).toContainEqual({ ids: [id(1)], how: "dismissed" });
    expect(stub.acks).toContainEqual({ ids: [id(2)], how: "model" });
    expect(stub.calls.find((c) => c.startsWith("GET /api/deliveries"))).toContain("limit=200");
  }, 40_000);

  test("EINWEAVE_CHANNELS: a broadcast in an excluded channel is not shown, NOT acked, and stays owed; addressed ones pass", async () => {
    stub.state.owed = [message(1, "broadcast in an excluded channel"), message(2, "for me", ["mention"])];
    await boot(true, { EINWEAVE_CHANNELS: "nowhere" });
    const body = JSON.parse((await call("read_deliveries")).text);
    expect(body.entries.map((e: any) => e.id)).toEqual([id(2)]);
    expect(body.filtered).toBe(1);
    expect(body.hint).toContain("EINWEAVE_CHANNELS");
    await acksSettled(1);
    expect(stub.acks).toEqual([{ ids: [id(2)], how: "model" }]); // never the filtered one: no false ✓✓
    const again = JSON.parse((await call("read_deliveries")).text);
    expect(again.entries).toEqual([]); // still owed, still not shown
    expect(again.filtered).toBe(1);
    expect(stub.acks).toHaveLength(1);
  }, 40_000);

  test("paging advances past filtered rows: the cursor comes from the server page", async () => {
    stub.state.owed = [message(1), message(2), message(3, "mine", ["thread"])];
    await boot(true, { EINWEAVE_CHANNELS: "nowhere" });
    const first = JSON.parse((await call("read_deliveries", { limit: 2 })).text);
    expect(first.entries).toEqual([]);
    expect(first.filtered).toBe(2);
    expect(first.next).toBe(id(2));
    expect(first.hint).toContain(`read_deliveries(after: "${id(2)}")`);
    const second = JSON.parse((await call("read_deliveries", { limit: 2, after: first.next })).text);
    expect(second.entries.map((e: any) => e.id)).toEqual([id(3)]);
  }, 40_000);

  test("a page over the byte budget: only what is returned is acked, no `next` is offered, and the next call returns the rest", async () => {
    const big = "x".repeat(15_000);
    stub.state.owed = [1, 2, 3, 4, 5].map((n) => message(n, big));
    await boot();
    const first = JSON.parse((await call("read_deliveries")).text);
    expect(first.entries.map((e: any) => e.id)).toEqual([id(1), id(2)]);
    expect(first.truncated).toBe(true);
    expect(first.next).toBeNull(); // the server's cursor would skip the uncut remainder
    expect(first.hint).toContain("WITHOUT");
    await acksSettled(1);
    expect(stub.acks).toEqual([{ ids: [id(1), id(2)], how: "model" }]);
    // The ids ride at the top level once, not again inside meta.
    expect(first.entries[0].channel_id).toBe(CHANNEL_ID);
    expect(first.entries[0].meta.channel_id).toBeUndefined();
    expect(first.entries[0].meta.thread_id).toBeUndefined();
    const second = JSON.parse((await call("read_deliveries")).text); // no `after`
    expect(second.entries.map((e: any) => e.id)).toEqual([id(3), id(4)]);
    const third = JSON.parse((await call("read_deliveries")).text);
    expect(third.entries.map((e: any) => e.id)).toEqual([id(5)]);
    expect(third.truncated).toBeUndefined();
    await acksSettled(3);
    expect(stub.acks.map((a) => a.ids)).toEqual([[id(1), id(2)], [id(3), id(4)], [id(5)]]);
  }, 40_000);

  test("cut short while the server HAS a next page: that cursor is withheld (it would skip the remainder)", async () => {
    const big = "x".repeat(15_000);
    stub.state.owed = [1, 2, 3, 4, 5].map((n) => message(n, big));
    await boot();
    const first = JSON.parse((await call("read_deliveries", { limit: 4 })).text);
    expect(first.entries).toHaveLength(2);
    expect(first.next).toBeNull();
    expect(first.hint).not.toContain("after:");
  }, 40_000);

  test("a single entry bigger than the budget is still returned (and acked)", async () => {
    stub.state.owed = [message(1, "y".repeat(60_000)), message(2)];
    await boot();
    const body = JSON.parse((await call("read_deliveries")).text);
    expect(body.entries.map((e: any) => e.id)).toEqual([id(1)]);
    expect(body.truncated).toBe(true);
    await acksSettled(1);
    expect(stub.acks).toEqual([{ ids: [id(1)], how: "model" }]);
  }, 40_000);

  test("before the FIRST authentication a read refuses too: the Session cannot send acks yet", async () => {
    stub.state.owed = [message(1)];
    stub.state.authDelayMs = 2500;
    await boot(true, { __noWait: "1" });
    await waitFor(() => stub.connected(), 15_000, "the auth frame to arrive");
    const r = await call("read_deliveries");
    expect(r.text).toContain("still connecting");
    expect(stub.calls.filter((c) => c.includes("/api/deliveries"))).toEqual([]);
    expect(stub.acks).toEqual([]);
  }, 40_000);

  test("M2: read_messages works before the first authentication, and its acks are held, then flushed to the same agent", async () => {
    stub.state.owed = [message(1)];
    stub.state.authDelayMs = 2500;
    await boot(true, { __noWait: "1" });
    await waitFor(() => stub.connected(), 15_000, "the auth frame to arrive");
    const msgs = JSON.parse((await call("read_messages", { channel_id: CHANNEL_ID, mark_read: false })).text);
    expect(msgs.messages.map((m: any) => m.id)).toEqual([id(1)]); // reading works, authenticated or not
    expect(stub.acks).toEqual([]); // nothing can be sent yet
    await waitFor(() => stub.acks.length > 0, 10_000, "the held ack to be flushed once authenticated");
    expect(stub.acks).toEqual([{ ids: [id(1)], how: "model" }]); // same agent: delivered
  }, 40_000);

  test("M2: read_deliveries refuses while RECONNECTING — it would return the same page forever", async () => {
    stub.state.owed = [message(1)];
    await boot();
    stub.state.authDelayMs = 8000; // the next authentication takes a while
    stub.dropSockets();
    let text = "";
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      text = (await call("read_deliveries")).text;
      if (/reconnecting/.test(text)) break;
      await Bun.sleep(150);
    }
    expect(text).toContain("reconnecting");
    expect(text).toContain("acks can't be sent yet");
    expect(stub.acks).toEqual([]);
  }, 60_000);

  test("m2: a channel the name map has not heard of is fetched once and then DELIVERED, not mistaken for an excluded one", async () => {
    const LATE = "0190a000-0000-7000-9000-0000000000c9";
    const late = message(1, "in a channel created after the map was built");
    (late.payload.message as any).channelId = LATE;
    stub.state.owed = [late];
    await boot(true, { EINWEAVE_CHANNELS: "late" });
    stub.state.channels = [...stub.state.channels, { id: LATE, name: "late" }];
    await Bun.sleep(5300); // the map refresh is rate-limited to once per 5 s
    const body = JSON.parse((await call("read_deliveries")).text);
    expect(body.filtered).toBe(0);
    expect(body.entries.map((e: any) => e.id)).toEqual([id(1)]);
    await acksSettled(1);
    expect(stub.acks).toEqual([{ ids: [id(1)], how: "model" }]);
  }, 60_000);

  test("a window that STANDS BY refuses: no fetch, no ack", async () => {
    stub.state.owed = [message(1)];
    await boot(); // holds the lock
    await boot(true, { __noWait: "1" }); // the same session key: this one stands by
    const end = Date.now() + 10_000;
    let st: any = {};
    while (Date.now() < end) {
      st = JSON.parse((await call("status")).text);
      if (st.holder) break;
      await Bun.sleep(100);
    }
    expect(st.holder).toBeTruthy();
    const before = stub.calls.filter((c) => c.includes("/api/deliveries")).length;
    const r = await call("read_deliveries");
    expect(r.text).toContain("stands by");
    expect(r.text).toContain("/bridge:connect takeover");
    // The plain HTTP reads still work in a standby window; their acks are HELD (never sent for a session this window does not hold).
    const msgs = JSON.parse((await call("read_messages", { channel_id: CHANNEL_ID, mark_read: false })).text);
    expect(msgs.messages.map((m: any) => m.id)).toEqual([id(1)]);
    await Bun.sleep(600);
    expect(stub.calls.filter((c) => c.includes("/api/deliveries"))).toHaveLength(before);
    expect(stub.acks).toEqual([]);
  }, 60_000);

  test("a Session replaced WHILE read_deliveries is fetching: the read fails (the SDK refuses a stopped session) and nothing is acked", async () => {
    stub.state.owed = [message(1)];
    await boot();
    stub.state.delayMs = 1200;
    const reading = call("read_deliveries");
    await Bun.sleep(300);
    await call("disconnect");
    const r = await reading;
    expect(r.isError).toBe(true);
    await Bun.sleep(500);
    expect(stub.acks).toEqual([]);
  }, 60_000);

  // read_messages is a plain REST read: the Session can be replaced while it is in flight.
  for (const swap of ["a DIFFERENT agent", "the SAME agent"] as const) {
    test(`read_messages with a Session swapped in during the read — ${swap}: ${swap === "the SAME agent" ? "acked through the new Session" : "no ack for what the old agent read"}`, async () => {
      stub.state.owed = [message(1)];
      await boot();
      stub.state.delayMs = 1200;
      const reading = call("read_messages", { channel_id: CHANNEL_ID, mark_read: false });
      await Bun.sleep(300);
      if (swap === "a DIFFERENT agent") stub.state.agentId = "mallory";
      await call("disconnect");
      await call("connect");
      const body = JSON.parse((await reading).text);
      expect(body.messages.map((m: any) => m.id)).toEqual([id(1)]); // the model did get it
      await Bun.sleep(1200);
      const modelAcks = stub.acks.filter((a) => a.how === "model");
      if (swap === "the SAME agent") expect(modelAcks).toEqual([{ ids: [id(1)], how: "model" }]);
      else expect(modelAcks).toEqual([]);
    }, 60_000);
  }

  test("a failure acks nothing: the entries stay owed", async () => {
    stub.state.owed = [message(1), taskEvent(2)];
    await boot();
    stub.state.status = 500;
    const r = await call("read_deliveries");
    expect(r.isError).toBe(true);
    await Bun.sleep(500);
    expect(stub.acks).toEqual([]);
    stub.state.status = 200;
    expect(JSON.parse((await call("read_deliveries")).text).count).toBe(2); // still owed, and now returned
  }, 40_000);

  test("not connected: a clear error and nothing is fetched or acked", async () => {
    stub.state.owed = [message(1)];
    await boot();
    await call("disconnect"); // no live Session any more
    const r = await call("read_deliveries");
    expect(r.text).toMatch(/not connected/i);
    expect(stub.calls.filter((c) => c.includes("/api/deliveries"))).toEqual([]);
    expect(stub.acks).toEqual([]);
  }, 40_000);

  test("a missed task_event: the notice names read_deliveries, and reading it empties the notice and the count line", async () => {
    await boot();
    const ev = taskEvent(5);
    stub.state.owed = [ev];
    stub.push(ev); // pushed to the host, never confirmed by any prompt (channels off)
    await waitFor(() => lines().some((m) => m.method === "notifications/claude/channel" && m.params?.meta?.message_id === ev.id), 8000, "the push");
    await Bun.sleep(2300); // past the 2 s grace: the host has had its chance
    const notice = await hook("what is new?");
    expect(notice).toContain("task event");
    expect(notice).toContain(`(id ${ev.id}`);
    expect(notice).toContain("read_deliveries returns it");
    expect(notice).not.toMatch(/read_thread|list_threads/);
    // Still there as a count on the next prompt…
    expect(await hook("and now?")).toContain("read_deliveries returns them.");
    // …until read_deliveries returns it.
    const r = JSON.parse((await call("read_deliveries")).text);
    expect(r.entries.map((e: any) => e.id)).toEqual([ev.id]);
    await acksSettled(1);
    expect(await hook("anything?")).toBeNull();
  }, 40_000);
});
