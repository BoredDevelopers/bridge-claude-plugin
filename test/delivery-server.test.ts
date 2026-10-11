/**
 * RFC-027 D4/D7 at the SEAM: the real plugin process (server.ts) against a stub that
 * speaks the wire, driven by the real hook (hooks/delivery.ts). The unit suites prove
 * each half; this proves they are wired to each other — entry pushed → host notified →
 * hook reports the tag → control socket → the SDK's Pending.confirm → an `ack` frame
 * with how:"model" reaches the server. And the negative: a push alone acks nothing.
 *
 * "Claude Code's pid" is this test process: a `sessions/pid-<pid>.json` mapping makes
 * it the ancestor the plugin finds, and the hook is run with CLAUDE_PID set to it.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentAuthRoutes } from "./agent-auth-routes";
import { mintAgentToken } from "./agent-auth-stub";

const SERVER = join(import.meta.dir, "..", "server.ts");
const HOOK = join(import.meta.dir, "..", "hooks", "delivery.ts");
const ENROLMENT_KEY = mintAgentToken("ek");
const CHANNEL_ID = "0190a000-0000-7000-9000-0000000000c1";
const THREAD = "0190a000-0000-7000-9000-000000000001";
const mid = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;

type Ack = { ids: string[]; how: string };

function startStub() {
  const sockets = new Set<any>();
  const acks: Ack[] = [];
  const agentAuth = createAgentAuthRoutes();
  agentAuth.addEnrolmentKey(ENROLMENT_KEY);
  let authCount = 0;
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
      if (url.pathname === "/api/channels") return Response.json({ channels: [{ id: CHANNEL_ID, name: "general" }] });
      if (url.pathname === "/api/deliveries") return Response.json({ entries: [] });
      return new Response("no", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        let frame: any = {};
        try { frame = JSON.parse(String(raw)); } catch { return; }
        if (frame.type === "ack") acks.push({ ids: frame.ids, how: frame.how });
        if (frame.type === "auth") {
          sockets.add(ws);
          authCount++;
          ws.send(JSON.stringify({ v: 2, type: "authenticated", payload: { agentId: "bellman", agentName: "Bellman", contextId: "ctx-under-test" } }));
        }
      },
      close(ws) { sockets.delete(ws); },
    },
  });
  let seq = 0;
  return {
    port: server.port!,
    acks,
    connected: () => sockets.size > 0,
    authCount: () => authCount,
    /** Push a message entry to every connected socket, as the server's `message` frame. */
    pushMessage(id: string, content = "hello") {
      const message = { id, channelId: CHANNEL_ID, threadId: THREAD, agentId: "kevin", senderName: "Kevin", content, type: "text", seq: 1, createdAt: "2026-10-11T10:00:00.000Z" };
      for (const ws of sockets) ws.send(JSON.stringify({ v: 2, type: "message", seq: ++seq, payload: { message, deliveryReasons: ["broadcast"] } }));
    },
    stop: () => server.stop(true),
  };
}

describe("plugin ⇄ hook ⇄ server: confirmation reaches the server", () => {
  let dir = "";
  let stub: ReturnType<typeof startStub>;
  const plugins: Array<ReturnType<typeof Bun.spawn>> = [];
  const outs = new Map<ReturnType<typeof Bun.spawn>, { text: string }>();
  let nextId = 1;

  beforeEach(() => {
    // Short on purpose: the direct `<state>/ctl/c<pid>.sock` path.
    dir = mkdtempSync(join("/tmp", "ewds-"));
    stub = startStub();
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(
      join(dir, "sessions", `pid-${process.pid}.json`),
      JSON.stringify({ sessionId: "sess-0301", claudePid: process.pid, procStart: "", updatedAt: new Date().toISOString() }),
    );
  });
  afterEach(async () => {
    const [ps, s, d] = [plugins.splice(0), stub, dir];
    for (const p of ps) p.kill();
    await Promise.all(ps.map((p) => p.exited));
    s.stop();
    rmSync(d, { recursive: true, force: true });
  }, 15_000);

  async function boot(autoconnect: boolean) {
    const plugin = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        EINWEAVE_STATE_DIR: dir,
        EINWEAVE_API_URL: `http://127.0.0.1:${stub.port}`,
        EINWEAVE_ENROLMENT_KEY: ENROLMENT_KEY,
        EINWEAVE_AUTOCONNECT: autoconnect ? "1" : "0",
        EINWEAVE_TEST: "1",
        EINWEAVE_TEST_CTL_RETRY_MS: "50",
        EINWEAVE_TEST_LOCK_RETRY_MS: "300",
        EINWEAVE_TEST_CTL_WATCH_MS: "100",
        CLAUDE_CODE_SESSION_ID: "11111111-2222-3333-4444-555555555555",
        CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    plugins.push(plugin);
    const o = { text: "" };
    outs.set(plugin, o);
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of plugin.stdout as any) o.text += dec.decode(chunk, { stream: true });
    })();
    const id = nextId++;
    send(plugin, { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    await waitFor(() => lines(plugin).some((m) => m.id === id), 15_000, "initialize");
    send(plugin, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    return plugin;
  }
  const lines = (p: ReturnType<typeof Bun.spawn>): any[] =>
    outs.get(p)!.text.split("\n").filter((l) => l.trim().startsWith("{")).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  function send(p: ReturnType<typeof Bun.spawn>, frame: unknown) {
    const sink = p.stdin as { write: (s: string) => void; flush?: () => void };
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
  async function status(p: ReturnType<typeof Bun.spawn>): Promise<any> {
    const id = nextId++;
    send(p, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "status", arguments: {} } });
    await waitFor(() => lines(p).some((m) => m.id === id), 8000, "status");
    return JSON.parse(lines(p).find((m) => m.id === id).result.content[0].text);
  }
  /** The tag the host renders for a channel notification (what UserPromptSubmit receives as `prompt`). */
  const tagOf = (p: ReturnType<typeof Bun.spawn>, id: string): string | null => {
    const n = lines(p).find((m) => m.method === "notifications/claude/channel" && m.params?.meta?.message_id === id);
    if (!n) return null;
    const attrs = Object.entries(n.params.meta).map(([k, v]) => `${k}="${v}"`).join(" ");
    return `<channel source="plugin:bridge:bridge" ${attrs}>\n${n.params.content}\n</channel>`;
  };
  async function runHook(prompt: string) {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), EINWEAVE_STATE_DIR: dir, CLAUDE_PID: String(process.pid) };
    const proc = Bun.spawn(["bun", HOOK, "prompt"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    proc.stdin.write(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }));
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  }

  test("a push alone sends no ack; the hook reporting the tag makes the plugin ack it `model`, once", async () => {
    const plugin = await boot(true);
    await waitFor(() => stub.connected(), 15_000, "plugin to authenticate");
    const id = mid(1);
    stub.pushMessage(id);
    await waitFor(() => tagOf(plugin, id) !== null, 8000, "the channel notification");
    // GUARD: the push is not a confirmation. Nothing may be acked before the model has it.
    await Bun.sleep(700);
    expect(stub.acks).toEqual([]);
    expect((await status(plugin)).delivery).toMatchObject({ pending: 1, confirmed: 0 });

    await runHook(tagOf(plugin, id)!);
    await waitFor(() => stub.acks.length > 0, 5000, "the model ack");
    expect(stub.acks).toEqual([{ ids: [id], how: "model" }]);
    expect((await status(plugin)).delivery).toMatchObject({ state: "confirmed", pending: 0, confirmed: 1 });
  }, 40_000);

  test("a prompt that merely quotes a tag of an entry this session was never given confirms nothing", async () => {
    const plugin = await boot(true);
    await waitFor(() => stub.connected(), 15_000, "plugin to authenticate");
    const id = mid(2);
    stub.pushMessage(id);
    await waitFor(() => tagOf(plugin, id) !== null, 8000, "the channel notification");
    await runHook(tagOf(plugin, id)!.replace(id, mid(99)));
    await Bun.sleep(500);
    expect(stub.acks).toEqual([]);
  }, 40_000);

  test("two copies in one Claude: the session-lock holder serves the socket, and status names a socket served elsewhere", async () => {
    // A: no session (no lock), but it opens the socket. B: connects, wins the lock, TAKES the socket over.
    const a = await boot(false);
    await waitFor(() => lines(a).length > 0, 8000, "A up");
    const b = await boot(true);
    await waitFor(() => stub.connected(), 15_000, "B to authenticate");
    const id = mid(3);
    stub.pushMessage(id);
    await waitFor(() => tagOf(b, id) !== null, 8000, "the channel notification");
    await runHook(tagOf(b, id)!);
    await waitFor(() => stub.acks.length > 0, 5000, "the model ack");
    expect(stub.acks).toEqual([{ ids: [id], how: "model" }]);
    // A is now a zombie on an unlinked inode: its status must say the socket is served elsewhere.
    const st = await status(a);
    expect(st.delivery.state).toBe("hooks not reporting");
    expect(st.delivery.hint).toContain("served by another process");
    expect(st.delivery.hint).not.toContain("pid was not found");
  }, 60_000);

  test("M1: a window SUPERSEDED by another never reclaims the socket — the real holder keeps it and the hooks reach it", async () => {
    const a = await boot(true); // holds the lock and the socket
    await waitFor(() => stub.connected(), 15_000, "A to authenticate");
    const b = await boot(false);
    await waitFor(() => lines(b).length > 0, 8000, "B up");
    send(b, { jsonrpc: "2.0", id: 9001, method: "tools/call", params: { name: "connect", arguments: { takeover: true } } });
    await waitFor(() => lines(b).some((m) => m.id === 9001), 15_000, "B's takeover");
    let stA: any = {};
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      stA = await status(a);
      if (stA.stop_reason === "superseded") break;
      await Bun.sleep(100);
    }
    expect(stA.stop_reason).toBe("superseded");
    await waitFor(() => stub.authCount() >= 2, 15_000, "B to authenticate");
    await Bun.sleep(1200); // a dozen watch ticks (100 ms) — A must not reclaim on any of them
    for (const w of [a, b]) expect((await status(w)).delivery.ctl_reclaims).toBeUndefined(); // nobody took the path back, ever
    const id = mid(7);
    stub.pushMessage(id);
    await waitFor(() => tagOf(b, id) !== null, 8000, "the notification on B");
    await runHook(tagOf(b, id)!);
    await waitFor(() => stub.acks.some((x) => x.how === "model"), 5000, "the model ack from B");
    expect(stub.acks.filter((x) => x.how === "model")).toEqual([{ ids: [id], how: "model" }]);
    expect((await status(b)).delivery.state).toBe("confirmed");
    const hint = (await status(a)).delivery.hint as string;
    expect(hint).toContain("served by another process");
    // …and the superseded window refuses to read_deliveries (a stopped Session acknowledges nothing).
    const rid = nextId++;
    send(a, { jsonrpc: "2.0", id: rid, method: "tools/call", params: { name: "read_deliveries", arguments: {} } });
    await waitFor(() => lines(a).some((m) => m.id === rid), 8000, "read_deliveries on A");
    expect(lines(a).find((m) => m.id === rid).result.content[0].text).toMatch(/session has stopped \(superseded\)/);
  }, 90_000);

  test("startup removes what dead processes left: migration temps (credential bytes) and half-bound control sockets", async () => {
    mkdirSync(join(dir, "ctl"), { recursive: true, mode: 0o700 });
    const stale = [join(dir, "key.json.migrating-999999-abc123"), join(dir, "ctl", "c1.sock.tmp-999999-ab12"), join(dir, "ctl", "c2.sock")];
    for (const f of stale) writeFileSync(f, "left behind");
    await boot(false);
    await waitFor(() => stale.every((f) => !existsSync(f)), 8000, "the startup sweeps");
  }, 40_000);

  test("a copy that becomes the lock holder LATER (standby retry, no openSession) re-binds the socket", async () => {
    const b = await boot(true); // holds the lock and the socket
    await waitFor(() => stub.connected(), 15_000, "B to authenticate");
    const a = await boot(true); // same session key → stands by; the socket is B's
    const st = await (async () => {
      let s = await status(a);
      const end = Date.now() + 8000;
      while (Date.now() < end && !/served by another process/.test(s.delivery.hint ?? "")) {
        await Bun.sleep(100);
        s = await status(a);
      }
      return s;
    })();
    expect(st.delivery.hint).toContain("served by another process");
    await Bun.sleep(2500); // past A's bounded socket retries (~1.5 s): only the lock handover can re-bind now
    b.kill(); // B exits and removes its socket; A's standby retry takes the lock
    await b.exited;
    await waitFor(() => stub.authCount() >= 2 && stub.connected(), 20_000, "A to take the lock and authenticate");
    const id = mid(4);
    stub.pushMessage(id);
    await waitFor(() => tagOf(a, id) !== null, 8000, "the channel notification on A");
    await runHook(tagOf(a, id)!);
    await waitFor(() => stub.acks.length > 0, 5000, "the model ack");
    expect(stub.acks).toEqual([{ ids: [id], how: "model" }]);
    expect((await status(a)).delivery.state).toBe("confirmed");
  }, 60_000);

  test("status names the real cause when another process serves the socket (not 'pid was not found')", async () => {
    const a = await boot(false);
    await status(a);
    // B never connects (autoconnect off), so it never holds the lock and never takes the socket over.
    const b = await boot(false);
    // The control socket opens late in startup: poll until status has a verdict other than "no pid yet".
    let st = await status(b);
    const end = Date.now() + 8000;
    while (Date.now() < end && /pid was not found/.test(st.delivery.hint ?? "")) {
      await Bun.sleep(100);
      st = await status(b);
    }
    expect(st.delivery.state).toBe("hooks not reporting");
    expect(st.delivery.hint).toContain("served by another process");
    expect(st.delivery.hint).not.toContain("pid was not found");
  }, 40_000);
});
