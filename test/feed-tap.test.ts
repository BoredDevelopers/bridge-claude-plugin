/**
 * RFC-022 D8/D10 — this session serves a local feed, and `tail` can read it.
 *
 * Two halves:
 *   - the translation (inbound WS message / `reply` call → feed frame), pure, here;
 *   - the seam, end to end: a REAL plugin process against a stub Bridge server, read
 *     through the registry record it wrote, by the vendored feed client AND by the
 *     launcher script it wrote — because what broke the host's view was never a
 *     function, it was what a second process could actually see.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ThreadNotes, feedContextName, inboundToFeed, launcherPath, outboundToFeed, sweepStaleFeedSockets, writeLauncher } from "../feed-tap";
import { feedClient, type FeedClient } from "../vendor/bridge-agent-sdk/node.js";
import { createAgentAuthRoutes } from "./agent-auth-routes";
import { mintAgentToken } from "./agent-auth-stub";

const ESC = "\x1b";

describe("inboundToFeed", () => {
  const base = { id: "m1", channelId: "c1", agentId: "a-kevin", agentName: "kevin", senderType: "agent", content: "Is it safe?\nsecond line", type: "question", createdAt: "2026-10-01T12:21:07.000Z", threadId: "t1", isRoot: true };

  test("a root: fields mapped, thread title derived from its first line", () => {
    const threads = new ThreadNotes();
    expect(inboundToFeed(base, { channelName: "dev", targeted: true }, threads)).toEqual({
      t: "message", dir: "in", id: "m1", ts: "2026-10-01T12:21:07.000Z",
      channel: { id: "c1", name: "dev" }, thread_id: "t1", thread_title: "Is it safe?", is_root: true,
      sender: { id: "a-kevin", handle: "kevin", kind: "agent" }, targeted: true, type: "question", text: "Is it safe?\nsecond line",
    });
  });

  test("a reply carries the title of a root this session saw, and none for one it did not", () => {
    const threads = new ThreadNotes();
    inboundToFeed(base, { channelName: "dev", targeted: true }, threads);
    const reply = { ...base, id: "m2", isRoot: false, content: "yes", type: "response" };
    expect(inboundToFeed(reply, { channelName: "dev", targeted: true }, threads).thread_title).toBe("Is it safe?");
    expect(inboundToFeed({ ...reply, threadId: "unseen" }, { channelName: "dev", targeted: true }, threads).thread_title).toBeUndefined();
  });

  test("a server that sends threadTitle and senderHandle is believed over the local guess", () => {
    const f = inboundToFeed({ ...base, isRoot: false, threadTitle: "Server title", senderHandle: "kev" }, { channelName: "dev", targeted: false }, new ThreadNotes());
    expect(f.thread_title).toBe("Server title");
    expect(f.sender.handle).toBe("kev");
    expect(f.targeted).toBe(false);
  });

  test("a human sender, an unknown channel name, and a frame with almost nothing in it", () => {
    expect(inboundToFeed({ ...base, senderType: "human" }, { channelName: "", targeted: false }, new ThreadNotes())).toMatchObject({ sender: { kind: "human" }, channel: { id: "c1", name: "c1" } });
    const bare = inboundToFeed({}, { channelName: "", targeted: false }, new ThreadNotes());
    expect(bare).toMatchObject({ t: "message", dir: "in", is_root: true, type: "text", text: "", sender: { handle: "unknown" } });
    expect(typeof bare.id).toBe("string");
  });

  test("a replayed row from a person: no senderType, no agent id → human", () => {
    // Replay rows carry neither `senderType` nor `senderName`; `agentName` is null for a human.
    const f = inboundToFeed({ id: "r1", channelId: "c1", userId: "u-jorgen", agentName: null, content: "hi", isRoot: true, threadId: "t7" }, { channelName: "dev", targeted: false }, new ThreadNotes());
    expect(f.sender).toEqual({ id: "u-jorgen", handle: "unknown", kind: "human" });
    // An explicit agent type still wins, and so does an agent id.
    expect(inboundToFeed({ senderType: "agent" }, { channelName: "", targeted: false }, new ThreadNotes()).sender.kind).toBe("agent");
    expect(inboundToFeed({ agentId: "a1" }, { channelName: "", targeted: false }, new ThreadNotes()).sender.kind).toBe("agent");
  });

  test("a frame WITHOUT isRoot is shown as a root but never remembered as the thread's root", () => {
    // An older server sends no `isRoot`. Remembering such a reply as the root would
    // overwrite the thread's title and the recipient of every later reply.
    const threads = new ThreadNotes();
    inboundToFeed(base, { channelName: "dev", targeted: true }, threads); // the real root, by kevin
    const ambiguous = inboundToFeed({ id: "m9", channelId: "c1", agentName: "aio", content: "a reply, not flagged", threadId: "t1" }, { channelName: "dev", targeted: true }, threads);
    expect(ambiguous.is_root).toBe(true);
    expect(threads.get("t1")).toEqual({ title: "Is it safe?", rootSender: "kevin" });
  });

  test("never throws on hostile shapes", () => {
    for (const bad of [null, undefined, 7, "x", { content: 5, threadId: {}, agentName: [] }]) {
      expect(() => inboundToFeed(bad, { channelName: "", targeted: false }, new ThreadNotes())).not.toThrow();
    }
  });
});

describe("outboundToFeed", () => {
  const self = { id: "a-me", handle: "bellman" };
  const send = { id: "o1", channelId: "c1", channelName: "dev", threadId: "", resultThreadId: "t9", title: "", type: "task", text: "Please rerun the suite.\nOnly recovery.", self, broadcast: false, targetContextId: "" };

  test("a new root: no recipient, the title is the explicit one or the first line", () => {
    const f = outboundToFeed(send, new ThreadNotes());
    expect(f).toMatchObject({ dir: "out", id: "o1", is_root: true, thread_id: "t9", thread_title: "Please rerun the suite.", targeted: true, type: "task", sender: { handle: "bellman" } });
    expect(f.to).toBeUndefined();
    expect(outboundToFeed({ ...send, title: "Monitor suite" }, new ThreadNotes()).thread_title).toBe("Monitor suite");
  });

  test("a reply into a thread this session saw is addressed to whoever started it", () => {
    const threads = new ThreadNotes();
    inboundToFeed({ id: "m1", channelId: "c1", agentName: "kevin", content: "Is it safe?", threadId: "t1", isRoot: true }, { channelName: "dev", targeted: true }, threads);
    const reply = { ...send, threadId: "t1", resultThreadId: "t1", type: "response", text: "No." };
    const f = outboundToFeed(reply, threads);
    expect(f).toMatchObject({ is_root: false, thread_id: "t1", thread_title: "Is it safe?" });
    expect(f.to).toEqual({ handle: "kevin" });
    // The session the server actually targeted rides along…
    expect(outboundToFeed({ ...reply, id: "o4", targetContextId: "ctx-kevin-2" }, threads).to).toEqual({ handle: "kevin", context_id: "ctx-kevin-2" });
    // …and a forced broadcast has no single recipient at all.
    expect(outboundToFeed({ ...reply, id: "o5", broadcast: true }, threads).to).toBeUndefined();
  });

  test("a reply into our own thread, or one we never saw, names no recipient", () => {
    const threads = new ThreadNotes();
    outboundToFeed(send, threads); // our own root, thread t9
    expect(outboundToFeed({ ...send, id: "o2", threadId: "t9", text: "more" }, threads).to).toBeUndefined();
    expect(outboundToFeed({ ...send, id: "o3", threadId: "unseen", text: "x" }, threads).to).toBeUndefined();
  });
});

describe("ThreadNotes", () => {
  test("bounded: the oldest thread is forgotten first, a re-noted one is kept", () => {
    const n = new ThreadNotes();
    for (let i = 0; i < 500; i++) n.note(`t${i}`, { title: `T${i}`, rootSender: "x" });
    n.note("t0", { title: "T0 again", rootSender: "x" }); // refreshes t0
    n.note("t500", { title: "T500", rootSender: "x" }); // evicts the oldest, now t1
    expect(n.get("t0")?.title).toBe("T0 again");
    expect(n.get("t1")).toBeUndefined();
    expect(n.get("t500")?.title).toBe("T500");
  });
});

describe("launcher", () => {
  test("an executable script at a stable path that runs this build's tail against this state dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-l-"));
    try {
      const path = writeLauncher(dir, "/plugins/it's here/0.27.0");
      expect(path).toBe(launcherPath(dir));
      expect(path).toBe(join(dir, "bin", "bridge-tail"));
      expect(statSync(path).mode & 0o777).toBe(0o700);
      const script = readFileSync(path, "utf8");
      expect(script.startsWith("#!/bin/sh\n")).toBe(true);
      // Paths are single-quoted, with an embedded quote closed, escaped and reopened.
      // The runtime is named by absolute path: the pane's PATH may not have it.
      expect(script).toContain(`exec '${process.execPath}' '/plugins/it'\\''s here/0.27.0/vendor/bridge-agent-sdk/tail-cli.js' --procs '${dir}' "$@"`);
      expect(statSync(join(dir, "bin")).mode & 0o777).toBe(0o700);
      // Rewriting (the next start, or a second window) leaves one file and no temp behind.
      writeLauncher(dir, "/plugins/next/0.28.0");
      expect(readdirSync(join(dir, "bin"))).toEqual(["bridge-tail"]);
      expect(readFileSync(path, "utf8")).toContain("/plugins/next/0.28.0/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an existing, looser bin/ is tightened to 0700", () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-b-"));
    try {
      mkdirSync(join(dir, "bin"), { mode: 0o755 });
      writeLauncher(dir, "/plugins/x");
      expect(statSync(join(dir, "bin")).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("feedContextName keeps only socket-file-safe characters", () => {
    expect(feedContextName("p123")).toBe("p123");
    expect(feedContextName("a/b c:d")).toBe("a_b_c_d");
    expect(feedContextName("")).toBe("session");
  });
});

describe("sweepStaleFeedSockets", () => {
  test("removes p<pid>.sock for dead pids only, and nothing that is not that shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-s-"));
    try {
      mkdirSync(join(dir, "feed"));
      for (const name of ["p111.sock", "p222.sock", "other.sock", "p333.sock.tmp", "px.sock"]) writeFileSync(join(dir, "feed", name), "");
      const logged: string[] = [];
      const removed = sweepStaleFeedSockets(dir, (pid) => pid === 222, (l) => logged.push(l));
      expect(removed).toBe(1);
      expect(readdirSync(join(dir, "feed")).sort()).toEqual(["other.sock", "p222.sock", "p333.sock.tmp", "px.sock"]);
      expect(logged).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a state dir with no feed/ is not an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-s-"));
    try {
      expect(sweepStaleFeedSockets(dir, () => false, () => {})).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── end to end: a real plugin process, a stub Bridge server, a real feed client ──────

const SERVER = join(import.meta.dir, "..", "server.ts");
const ENROLMENT_KEY = mintAgentToken("ek");

type Stub = { port: number; send: (frame: unknown) => void; connected: () => boolean; stop: () => void; posted: any[]; drop: (code: number, reason: string) => void; auths: () => number };

function startStub(): Stub {
  let socket: any = null;
  let auths = 0;
  const posted: any[] = [];
  const agentAuth = createAgentAuthRoutes();
  agentAuth.addEnrolmentKey(ENROLMENT_KEY);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1", // never the wildcard default — see stub-loopback-bind.test.ts
    async fetch(req, srv) {
      const auth = await agentAuth.handle(req);
      if (auth) return auth;
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/channels") {
        return Response.json({ channels: [{ id: "chan-dev-id", name: "dev" }] });
      }
      if (req.method === "POST" && url.pathname === "/api/messages") {
        const body = await req.json();
        posted.push(body);
        return Response.json({ id: "sent-1", channelId: "chan-dev-id", threadId: "thr-out-1" });
      }
      if (srv.upgrade(req)) return;
      return new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        let frame: any = {};
        try { frame = JSON.parse(String(raw)); } catch { return; }
        if (frame.type === "auth") {
          socket = ws;
          auths++;
          ws.send(JSON.stringify({ type: "authenticated", data: { agentId: "bellman-id", agentName: "Bellman (Mac)", handle: "bellman", contextId: "ctx-under-test" } }));
        }
      },
      close() { socket = null; },
    },
  });
  return { port: server.port!, send: (f) => socket?.send(JSON.stringify(f)), connected: () => socket !== null, stop: () => server.stop(true), posted, drop: (code, reason) => socket?.close(code, reason), auths: () => auths };
}

async function until<T>(what: string, fn: () => T | undefined | null | false, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

describe("a running plugin serves its feed", () => {
  let dir = "";
  let stub: Stub;
  let plugin: ReturnType<typeof Bun.spawn>;
  let out = "";
  let client: FeedClient | null = null;
  // Set by a nested describe's beforeEach-free tests through `boot()`.
  async function boot(extraEnv: Record<string, string> = {}, prepare: (stateDir: string) => void = () => {}): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), "ft-"));
    prepare(dir);
    stub = startStub();
    plugin = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: `http://127.0.0.1:${stub.port}`,
        BRIDGE_ENROLMENT_KEY: ENROLMENT_KEY, BRIDGE_AUTOCONNECT: "1",
        BRIDGE_SESSION_LABEL: "feed-test",
        CLAUDE_CODE_SESSION_ID: "11111111-2222-3333-4444-555555555555",
        CLAUDE_CODE_SSE_PORT: "",
        BRIDGE_TEST_BACKOFF_SCALE: "0.05", // a dropped socket reconnects in tens of ms
        ...extraEnv,
      } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    out = "";
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of plugin.stdout as any) out += dec.decode(chunk, { stream: true });
    })();
    await until("the plugin to connect to the stub", () => stub.connected());
  }

  beforeEach(async () => {
    dir = "";
  });

  afterEach(() => {
    client?.close();
    client = null;
    plugin?.kill();
    stub?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** The plugin's own registry record — how a tail finds the socket. */
  function record(): any {
    const procs = join(dir, "procs");
    try {
      const name = readdirSync(procs).find((f) => f === `${plugin.pid}.json`);
      return name ? JSON.parse(readFileSync(join(procs, name), "utf8")) : null;
    } catch { return null; }
  }

  async function attach(): Promise<{ frames: AsyncIterator<any>; hello: any }> {
    const rec = await until("a registry record advertising the feed", () => (record()?.feed ? record() : null));
    client = await feedClient(rec.feed);
    client.subscribe(100);
    return { frames: client[Symbol.asyncIterator](), hello: client.hello };
  }

  async function nextMessage(frames: AsyncIterator<any>, id: string): Promise<any> {
    for (;;) {
      const r = await Promise.race([frames.next(), Bun.sleep(8000).then(() => { throw new Error(`timed out waiting for feed message ${id}`); })]);
      if ((r as any).done) throw new Error("feed ended");
      const f = (r as any).value;
      if (f.t === "message" && f.id === id) return f;
    }
  }

  test("the record advertises a 0600 socket in a 0700 dir, and hello names the session", async () => {
    await boot();
    const { hello } = await attach();
    const rec = record();
    expect(statSync(rec.feed).mode & 0o777).toBe(0o600);
    expect(statSync(join(rec.feed, "..")).mode & 0o777).toBe(0o700);
    // The @handle from the authenticated frame, not the display name.
    expect(hello).toMatchObject({ v: 1, software_id: "bridge-claude-plugin", label: "feed-test", agent: { id: "bellman-id", handle: "bellman" } });
  }, 30_000);

  test("an inbound message reaches the feed IN FULL, with the channel's name, stripped", async () => {
    await boot();
    const { frames } = await attach();
    const long = Array.from({ length: 12 }, (_, i) => `line ${i + 1} of a message far longer than the host's preview`).join("\n");
    stub.send({
      type: "message",
      data: { id: "msg-full-1", channelId: "chan-dev-id", agentId: "kevin-id", agentName: `${ESC}[8mkevin${ESC}[28m`, senderType: "agent", content: `${ESC}]52;c;aGVsbG8=\x07${long}`, type: "question", threadId: "thr-1", isRoot: true, createdAt: new Date().toISOString() },
      deliveryReasons: ["mention"],
    });
    const f = await nextMessage(frames, "msg-full-1");
    expect(f.text).toBe(long); // all twelve lines, no control sequence
    expect(f).toMatchObject({ dir: "in", channel: { id: "chan-dev-id", name: "dev" }, sender: { handle: "kevin", kind: "agent" }, targeted: true, type: "question", is_root: true, thread_id: "thr-1" });
    // The host was handed it too — the feed is beside delivery, not instead of it.
    await until("the host notification", () => out.includes("msg-full-1") && out.includes("notifications/claude/channel"));
  }, 30_000);

  /**
   * Send `dropped` (messages the plugin must NOT surface), then a barrier that IS
   * surfaced. When the barrier arrives every dropped one has had its chance — so the
   * feed's message ids up to the barrier are the whole answer, with no sleep.
   */
  async function feedIdsUpToBarrier(frames: AsyncIterator<any>, dropped: any[]): Promise<string[]> {
    const now = () => new Date().toISOString();
    for (const d of dropped) stub.send({ type: "message", ...d, data: { createdAt: now(), ...d.data } });
    stub.send({ type: "message", data: { id: "msg-barrier", channelId: "chan-dev-id", agentId: "kevin-id", agentName: "kevin", content: "barrier", createdAt: now() }, deliveryReasons: ["mention"] });
    const seen: string[] = [];
    for (;;) {
      const r: any = await Promise.race([frames.next(), Bun.sleep(8000).then(() => { throw new Error("timed out waiting for the barrier"); })]);
      if (r.value?.t === "message") seen.push(r.value.id);
      if (r.value?.id === "msg-barrier") return seen;
    }
  }

  test("a message the plugin does NOT surface is not in the feed: every skip, each at its own point", async () => {
    await boot();
    const { frames } = await attach();
    const seen = await feedIdsUpToBarrier(frames, [
      // Skipped in handleInboundMessage: our own send coming back (sender context is ours).
      { data: { id: "skip-own-send", channelId: "chan-dev-id", agentName: "bellman", content: "echo", senderContextId: "ctx-under-test" }, deliveryReasons: ["target"] },
      // Skipped INSIDE routeInbound: this agent's own message from another of its sessions, unaddressed.
      { data: { id: "skip-own-agent", channelId: "chan-dev-id", agentId: "bellman-id", agentName: "bellman", content: "from my other window", senderContextId: "ctx-other" } },
      // Skipped INSIDE routeInbound: targeted at ANOTHER session of this agent.
      { data: { id: "skip-other-context", channelId: "chan-dev-id", agentId: "kevin-id", agentName: "kevin", content: "for the other window", metadata: JSON.stringify({ contextId: "ctx-other", contextAgentId: "bellman-id" }) }, deliveryReasons: ["mention"] },
    ]);
    expect(seen).toEqual(["msg-barrier"]);
  }, 30_000);

  test("a channel outside BRIDGE_CHANNELS is filtered from the feed exactly as from the host", async () => {
    await boot({ BRIDGE_CHANNELS: "ops" });
    const { frames } = await attach();
    const seen = await feedIdsUpToBarrier(frames, [
      // Broadcast traffic in #dev, which is not in the filter: dropped by the channel filter in routeInbound.
      { data: { id: "skip-filtered", channelId: "chan-dev-id", agentId: "kevin-id", agentName: "kevin", content: "broadcast in a filtered channel" }, deliveryReasons: ["channel"] },
    ]);
    // The barrier is a mention, which bypasses the filter — and is the only thing in the feed.
    expect(seen).toEqual(["msg-barrier"]);
    expect(out).not.toContain("skip-filtered");
  }, 30_000);

  test("the feed says what the link is doing: reconnecting after a drop, connected again, stopped when it is not coming back", async () => {
    await boot();
    const { frames } = await attach();
    const nextStatus = async (): Promise<any> => {
      for (;;) {
        const r: any = await Promise.race([frames.next(), Bun.sleep(8000).then(() => { throw new Error("timed out waiting for a status frame"); })]);
        if (r.done) throw new Error("feed ended");
        if (r.value.t === "status") return r.value;
      }
    };
    expect(await nextStatus()).toMatchObject({ state: "connected" }); // replayed: published at authenticate
    stub.drop(1011, "server restart");
    expect(await nextStatus()).toMatchObject({ state: "reconnecting" });
    expect(await nextStatus()).toMatchObject({ state: "connected" });
    expect(stub.auths()).toBe(2);
    // A revoked session never reconnects by itself: the feed must not claim it will.
    stub.drop(4008, "session revoked");
    const stopped = await nextStatus();
    expect(stopped.state).toBe("stopped");
    expect(String(stopped.reason ?? "")).not.toBe("");
  }, 30_000);

  test("shutdown publishes stopped and removes the socket file", async () => {
    await boot();
    const { frames } = await attach();
    const feedPath = record().feed;
    // Wait for the replayed `connected` first: until the server has PROCESSED the
    // subscribe this client receives nothing, and a SIGTERM sent before that would end
    // the feed with no frames at all — a race in the test, not a property of shutdown.
    for (;;) {
      const r: any = await Promise.race([frames.next(), Bun.sleep(8000).then(() => { throw new Error("timed out waiting for the replayed status"); })]);
      if (r.value?.t === "status") { expect(r.value.state).toBe("connected"); break; }
    }
    plugin.kill("SIGTERM");
    let last: any = null;
    for (;;) {
      const r: any = await Promise.race([frames.next(), Bun.sleep(8000).then(() => { throw new Error("timed out waiting for the feed to end"); })]);
      if (r.done) break;
      if (r.value.t === "status") last = r.value;
    }
    expect(last).toMatchObject({ state: "stopped" });
    await until("the socket file to be removed", () => !existsSync(feedPath));
  }, 30_000);

  test("a feed that cannot open costs the session nothing: messages still reach the host", async () => {
    // `feed` exists as a FILE, so the socket directory cannot be created.
    await boot({}, (stateDir) => writeFileSync(join(stateDir, "feed"), "not a directory"));
    stub.send({ type: "message", data: { id: "msg-nofeed-1", channelId: "chan-dev-id", agentId: "kevin-id", agentName: "kevin", content: "still delivered", createdAt: new Date().toISOString() }, deliveryReasons: ["mention"] });
    await until("the host notification", () => out.includes("msg-nofeed-1") && out.includes("notifications/claude/channel"));
    const rec = await until("the registry record", () => record());
    expect(rec.feed).toBeUndefined();
  }, 30_000);

  test("a sent reply reaches the feed with its text — the host shows none of it", async () => {
    await boot();
    const { frames } = await attach();
    const send = (frame: unknown) => {
      const sink = plugin.stdin as { write: (s: string) => void; flush?: () => void };
      sink.write(JSON.stringify(frame) + "\n");
      sink.flush?.();
    };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    await until("initialize to be answered", () => out.includes('"id":1'));
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reply", arguments: { channel_id: "dev", text: "Please rerun the suite.\nOnly the recovery tests.", type: "task", title: "Monitor suite" } } });
    const f = await nextMessage(frames, "sent-1");
    expect(f).toMatchObject({
      dir: "out", is_root: true, type: "task", targeted: true,
      channel: { id: "chan-dev-id", name: "dev" },
      thread_id: "thr-out-1", thread_title: "Monitor suite",
      sender: { handle: "bellman" },
      text: "Please rerun the suite.\nOnly the recovery tests.",
    });
    expect(stub.posted).toHaveLength(1);
    // And the host still gets only the terse tool result.
    await until("the tool result", () => out.includes('"id":2'));
    expect(out).toContain("sent (id: sent-1");
  }, 30_000);

  test("the launcher the plugin wrote prints the session's messages in full", async () => {
    await boot();
    const { frames } = await attach();
    stub.send({ type: "message", data: { id: "msg-tail-1", channelId: "chan-dev-id", agentId: "kevin-id", agentName: "kevin", content: "first line\nsecond line that the host would never show", type: "text", threadId: "thr-2", isRoot: true, createdAt: new Date().toISOString() }, deliveryReasons: ["mention"] });
    await nextMessage(frames, "msg-tail-1");
    const tail = Bun.spawn([launcherPath(dir), "--no-color"], { stdout: "pipe", stderr: "pipe", stdin: "ignore", cwd: dir });
    try {
      let printed = "";
      (async () => {
        const dec = new TextDecoder();
        for await (const chunk of tail.stdout as any) printed += dec.decode(chunk, { stream: true });
      })();
      await until("the tail to print the message", () => printed.includes("second line that the host would never show"));
      expect(printed).toContain("#dev");
      expect(printed).toContain("@kevin");
      expect(printed).toContain("first line");
    } finally {
      tail.kill();
    }
  }, 30_000);
});
