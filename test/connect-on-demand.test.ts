/**
 * connect-on-demand, Task 2: staying alive when unconfigured.
 *
 * Today server.ts calls `process.exit(1)` at startup when BRIDGE_API_URL /
 * BRIDGE_TOKEN are missing, so an unconfigured install gets a dead MCP
 * server instead of working tools + guidance. This spawns server.ts with NO
 * BRIDGE_TOKEN (and no BRIDGE_API_URL) and drives it over stdio MCP, like
 * session-rename-tool.test.ts does — the only assertion that actually proves
 * "stays alive" is a successful `tools/list` round trip, since a dead child
 * would leave the request hanging (or the transport erroring on a closed
 * pipe) rather than resolving.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { connectStateFileFor, writeConnectState } from "../connect-store";

const SERVER = new URL("../server.ts", import.meta.url).pathname;

describe("connect-on-demand: unconfigured startup", () => {
  test("stays alive and answers tools/list when unconfigured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cod-unconfigured-"));
    // Start from the real env (so `bun` resolves etc.), then strip the two
    // vars server.ts currently treats as required — a leftover BRIDGE_TOKEN
    // in the ambient env would silently defeat the "unconfigured" premise.
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    delete env.BRIDGE_API_URL;
    delete env.BRIDGE_TOKEN;
    env.CLAUDE_PLUGIN_DATA = dir;
    env.BRIDGE_STATE_DIR = dir;

    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const result = await client.listTools();
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools.length).toBeGreaterThan(0);
    } finally {
      await client.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * connect-on-demand, Task 3: the `wantConnected` startup gate.
 *
 * `wantConnected` is resolved as `readConnectState(...) ?? (BRIDGE_AUTOCONNECT
 * === "1")` right after SESSION_KEY settles, and the startup connect is now
 * `if (!shuttingDown && wantConnected && API_URL && TOKEN) connectUnlessDuplicate()`.
 * These spawn server.ts against a stub Bridge WS (mirrors
 * session-rename-tool.test.ts's `authFrameWithStore`) and watch for the "auth"
 * frame — that is the only externally observable proof a connect happened.
 *
 * SESSION_KEY resolution itself burns up to SESSION_MAP_WAIT_MS (3s, see
 * server.ts's `resolveSessionKey`) before falling through to
 * CLAUDE_CODE_SESSION_ID, since the ancestry-walk lookup is always tried
 * regardless of whether an SSE port is present. So a "connects" case can take
 * a few seconds to produce its auth frame, and a "does not connect" case must
 * be given at least that long before "no frame yet" can be read as "chose not
 * to" rather than "still resolving".
 */
const CONNECT_SESSION_KEY = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NO_CONNECT_WINDOW_MS = 6_000;
const CONNECT_DEADLINE_MS = 15_000;

function startAuthStub() {
  let authFrame: any = null;
  const server = Bun.serve({
    port: 0,
    // 127.0.0.1, never the wildcard default — see stub-loopback-bind.test.ts.
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        let frame: any = {};
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (frame.type === "auth") {
          authFrame = frame;
          ws.send(
            JSON.stringify({
              type: "authenticated",
              data: { agentId: "jorgen-mac", agentName: "Jörgen (Mac)", contextId: "ctx" },
            })
          );
        }
      },
    },
  });
  return { port: server.port!, authFrame: () => authFrame, stop: () => server.stop(true) };
}

describe("connect-on-demand: wantConnected startup gate", () => {
  test("does not connect when no env and no stored state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cod-connect-"));
    const stub = startAuthStub();
    const env: Record<string, string> = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dir,
      BRIDGE_STATE_DIR: dir,
      BRIDGE_API_URL: `http://127.0.0.1:${stub.port}`,
      BRIDGE_TOKEN: "test-token",
      CLAUDE_CODE_SESSION_ID: CONNECT_SESSION_KEY,
      CLAUDE_CODE_SSE_PORT: "",
    };
    delete env.BRIDGE_AUTOCONNECT;
    const plugin = Bun.spawn(["bun", SERVER], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      await Bun.sleep(NO_CONNECT_WINDOW_MS);
      expect(stub.authFrame()).toBeNull();
    } finally {
      plugin.kill();
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("connects when BRIDGE_AUTOCONNECT=1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cod-connect-"));
    const stub = startAuthStub();
    const env: Record<string, string> = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dir,
      BRIDGE_STATE_DIR: dir,
      BRIDGE_API_URL: `http://127.0.0.1:${stub.port}`,
      BRIDGE_TOKEN: "test-token",
      CLAUDE_CODE_SESSION_ID: CONNECT_SESSION_KEY,
      CLAUDE_CODE_SSE_PORT: "",
      BRIDGE_AUTOCONNECT: "1",
    };
    const plugin = Bun.spawn(["bun", SERVER], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      const deadline = Date.now() + CONNECT_DEADLINE_MS;
      while (Date.now() < deadline && !stub.authFrame()) await Bun.sleep(50);
      const frame = stub.authFrame();
      expect(frame?.type).toBe("auth");
    } finally {
      plugin.kill();
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("persisted false beats BRIDGE_AUTOCONNECT=1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cod-connect-"));
    // Pre-write the connect-state file BEFORE spawning, so it is there for
    // server.ts to read at startup — content "0" (persisted disconnected).
    writeConnectState(dir, CONNECT_SESSION_KEY, false);
    expect(existsSync(connectStateFileFor(dir, CONNECT_SESSION_KEY))).toBe(true);

    const stub = startAuthStub();
    const env: Record<string, string> = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dir,
      BRIDGE_STATE_DIR: dir,
      BRIDGE_API_URL: `http://127.0.0.1:${stub.port}`,
      BRIDGE_TOKEN: "test-token",
      CLAUDE_CODE_SESSION_ID: CONNECT_SESSION_KEY,
      CLAUDE_CODE_SSE_PORT: "",
      BRIDGE_AUTOCONNECT: "1",
    };
    const plugin = Bun.spawn(["bun", SERVER], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      await Bun.sleep(NO_CONNECT_WINDOW_MS);
      expect(stub.authFrame()).toBeNull();
    } finally {
      plugin.kill();
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * connect-on-demand, Tasks 4 + 5: the `connect`/`disconnect` tools and
 * reconnect suppression (`wantConnected`).
 *
 * Same SESSION_KEY resolution cost as above applies to every test here that
 * calls `connect`/`disconnect` and then checks the on-disk state file: the
 * tools read/write `connectStateFileFor(STATE_DIR, SESSION_KEY)` using
 * whatever SESSION_KEY *currently* holds, and that starts at a random
 * FALLBACK_SESSION_KEY until resolveSessionKey() settles it to
 * CLAUDE_CODE_SESSION_ID — which, per server.ts's resolveSessionKey(), takes
 * up to SESSION_MAP_WAIT_MS (3s) even when there is nothing to find (no
 * session-map hook, no SSE port). Every test below sleeps past that window
 * before making its first tool call, so the state file it inspects is
 * guaranteed to be the one keyed by the CLAUDE_CODE_SESSION_ID it set.
 */
const SESSION_KEY_SETTLE_MS = 4_000;

function startToolStub() {
  const authFrames: any[] = [];
  const server = Bun.serve({
    port: 0,
    // 127.0.0.1, never the wildcard default — see stub-loopback-bind.test.ts.
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        let frame: any = {};
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (frame.type === "auth") {
          authFrames.push(frame);
          ws.send(
            JSON.stringify({
              type: "authenticated",
              data: { agentId: "jorgen-mac", agentName: "Jörgen (Mac)", contextId: "ctx" },
            })
          );
        }
      },
    },
  });
  return {
    port: server.port!,
    authFrames: () => authFrames,
    authFrame: () => authFrames[authFrames.length - 1] ?? null,
    stop: () => server.stop(true),
  };
}

function connectToolEnv(dir: string, stubPort: number, sessionKey: string): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: dir,
    BRIDGE_STATE_DIR: dir,
    BRIDGE_API_URL: `http://127.0.0.1:${stubPort}`,
    BRIDGE_TOKEN: "test-token",
    CLAUDE_CODE_SESSION_ID: sessionKey,
    CLAUDE_CODE_SSE_PORT: "",
  };
  delete env.BRIDGE_AUTOCONNECT;
  return env;
}

function readState(dir: string, key: string): string | null {
  try {
    return readFileSync(connectStateFileFor(dir, key), "utf8").trim();
  } catch {
    return null;
  }
}

describe("connect-on-demand: connect/disconnect tools", () => {
  test("connect tool connects and persists", async () => {
    const key = "10000000-0000-0000-0000-000000000001";
    const dir = mkdtempSync(join(tmpdir(), "cod-tool-connect-"));
    const stub = startToolStub();
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: connectToolEnv(dir, stub.port, key),
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      await Bun.sleep(SESSION_KEY_SETTLE_MS);

      const result = await client.callTool({ name: "connect", arguments: {} });
      expect(result?.isError).not.toBe(true);

      expect(readState(dir, key)).toBe("1");

      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !stub.authFrame()) await Bun.sleep(50);
      expect(stub.authFrame()?.type).toBe("auth");
    } finally {
      await client.close().catch(() => {});
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("connect tool applies label", async () => {
    const key = "10000000-0000-0000-0000-000000000002";
    const dir = mkdtempSync(join(tmpdir(), "cod-tool-label-"));
    const stub = startToolStub();
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: connectToolEnv(dir, stub.port, key),
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      await Bun.sleep(SESSION_KEY_SETTLE_MS);

      const result = await client.callTool({ name: "connect", arguments: { label: "Reviewer" } });
      expect(result?.isError).not.toBe(true);

      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !stub.authFrame()) await Bun.sleep(50);
      const frame = stub.authFrame();
      expect(frame?.type).toBe("auth");
      expect(frame?.sessionInfo?.sessionLabel).toBe("Reviewer");
    } finally {
      await client.close().catch(() => {});
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("disconnect closes and stays closed", async () => {
    const key = "10000000-0000-0000-0000-000000000003";
    const dir = mkdtempSync(join(tmpdir(), "cod-tool-disconnect-"));
    const stub = startToolStub();
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: connectToolEnv(dir, stub.port, key),
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      await Bun.sleep(SESSION_KEY_SETTLE_MS);

      const connectResult = await client.callTool({ name: "connect", arguments: {} });
      expect(connectResult?.isError).not.toBe(true);

      let deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !stub.authFrame()) await Bun.sleep(50);
      expect(stub.authFrame()?.type).toBe("auth");
      const framesBefore = stub.authFrames().length;

      const disconnectResult = await client.callTool({ name: "disconnect", arguments: {} });
      expect(disconnectResult?.isError).not.toBe(true);
      expect(readState(dir, key)).toBe("0");

      await Bun.sleep(NO_CONNECT_WINDOW_MS);
      expect(stub.authFrames().length).toBe(framesBefore);
    } finally {
      await client.close().catch(() => {});
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  test("disconnect persists across restart", async () => {
    const key = "10000000-0000-0000-0000-000000000004";
    const dir = mkdtempSync(join(tmpdir(), "cod-tool-restart-"));
    const stub = startToolStub();

    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: connectToolEnv(dir, stub.port, key),
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      await Bun.sleep(SESSION_KEY_SETTLE_MS);

      const connectResult = await client.callTool({ name: "connect", arguments: {} });
      expect(connectResult?.isError).not.toBe(true);
      expect(readState(dir, key)).toBe("1");

      const disconnectResult = await client.callTool({ name: "disconnect", arguments: {} });
      expect(disconnectResult?.isError).not.toBe(true);
      expect(readState(dir, key)).toBe("0");
    } finally {
      await client.close().catch(() => {});
    }

    const framesBefore = stub.authFrames().length;
    // Fresh process, same session key + state dir, no BRIDGE_AUTOCONNECT: the
    // persisted "0" from the disconnect above is the only thing that can
    // decide this — resolution is `readConnectState(...) ?? (BRIDGE_AUTOCONNECT
    // === "1")`, and both env inputs are absent here.
    const plugin = Bun.spawn(["bun", SERVER], {
      env: connectToolEnv(dir, stub.port, key),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await Bun.sleep(SESSION_KEY_SETTLE_MS + NO_CONNECT_WINDOW_MS);
      expect(stub.authFrames().length).toBe(framesBefore);
    } finally {
      plugin.kill();
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

/**
 * connect-on-demand: Finding 1 — disconnect must stop an ARMED lock-retry
 * loop, not just the reconnect/liveness timers.
 *
 * `connectUnlessDuplicate()` self-recurses via `lockRetryTimer` when the
 * session lock is held by a sibling — a path that reaches `connectWs()`
 * WITHOUT going through `scheduleReconnect()`, so `scheduleReconnect`'s own
 * `!wantConnected` guard never sees it. Before the fix, `disconnect` cleared
 * `reconnectTimer` and `livenessTimer` but not `lockRetryTimer`: once the
 * sibling holding the lock went away, the still-armed timer would win the
 * freed lock and reconnect — after an explicit disconnect.
 *
 * Spawns a HOLDER that keeps the session lock (mirrors session-lock.test.ts),
 * then a LOSER sharing its session key with BRIDGE_AUTOCONNECT=1 so it arms
 * lockRetryTimer on startup, calls `disconnect` on the loser, frees the lock
 * by killing the holder, waits past LOCK_RETRY_MS (30s, server.ts), and
 * asserts the loser never sent an auth frame and its connect-state file
 * reads "0".
 */
function pipeToString(stream: { on(event: "data", cb: (chunk: Buffer) => void): unknown } | null): () => string {
  let acc = "";
  stream?.on("data", (chunk: Buffer) => {
    acc += chunk.toString();
  });
  return () => acc;
}

describe("connect-on-demand: disconnect stops the lock-retry loop", () => {
  test("disconnect stops the duplicate-instance lock-retry loop", async () => {
    const key = "40000000-0000-0000-0000-000000000001";
    const dir = mkdtempSync(join(tmpdir(), "cod-lockretry-"));
    const stub = startToolStub();

    // HOLDER: acquires and keeps the lock for `key` via the BRIDGE_SESSION_KEY
    // override (settles immediately, unlike the loser below). Points at a
    // closed port, like session-lock.test.ts's boot() — only the lock matters
    // here, not whether the holder itself ever authenticates.
    const holder = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: "http://127.0.0.1:1",
        BRIDGE_TOKEN: "test-token",
        BRIDGE_AUTOCONNECT: "1",
        BRIDGE_SESSION_KEY: key,
        CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let holderErr = "";
    (async () => {
      const d = new TextDecoder();
      for await (const c of holder.stderr as any) holderErr += d.decode(c, { stream: true });
    })();
    const holderDeadline = Date.now() + 9_000;
    while (Date.now() < holderDeadline && !/session lock acquired/.test(holderErr)) {
      await Bun.sleep(100);
    }
    expect(holderErr, "holder must take the lock before the loser starts").toContain(
      "session lock acquired"
    );

    // LOSER: same session key, resolved via CLAUDE_CODE_SESSION_ID — the
    // BRIDGE_SESSION_KEY override is reserved for the holder above, so the
    // loser goes through the normal ~3s resolution path like the Task 4/5
    // tests. BRIDGE_AUTOCONNECT=1 so it attempts to connect on its own once
    // SESSION_KEY settles, loses the lock race, and arms lockRetryTimer.
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      stderr: "pipe",
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: `http://127.0.0.1:${stub.port}`,
        BRIDGE_TOKEN: "test-token",
        BRIDGE_AUTOCONNECT: "1",
        CLAUDE_CODE_SESSION_ID: key,
        CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
    });
    const loserErr = pipeToString(transport.stderr as any);
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });

    try {
      await client.connect(transport);

      const duplicateDeadline = Date.now() + 15_000;
      while (Date.now() < duplicateDeadline && !/DUPLICATE INSTANCE/.test(loserErr())) {
        await Bun.sleep(100);
      }
      expect(loserErr(), "the loser must lose the lock race and arm lockRetryTimer").toContain(
        "DUPLICATE INSTANCE"
      );

      const disconnectResult = await client.callTool({ name: "disconnect", arguments: {} });
      expect(disconnectResult?.isError).not.toBe(true);
      expect(readState(dir, key)).toBe("0");

      // Free the lock the loser is standing by for.
      holder.kill();
      await holder.exited;

      // Past LOCK_RETRY_MS (30s, server.ts): with the guard/clear both
      // missing, the armed timer fires here, wins the now-free lock, and
      // connects — exactly the bug this test exists for.
      await Bun.sleep(35_000);

      expect(stub.authFrame(), "an explicit disconnect must stick even after the lock frees").toBeNull();
      expect(readState(dir, key)).toBe("0");
    } finally {
      await client.close().catch(() => {});
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * connect-on-demand: Finding 2 — connect/disconnect issued before SESSION_KEY
 * settles.
 *
 * Tools are answerable (`await mcp.connect`) before SESSION_KEY and
 * wantConnected resolve (`await resolveSessionKey()`, up to
 * SESSION_MAP_WAIT_MS ≈ 3s — see server.ts). Before the fix, a
 * connect/disconnect issued in that window (a) wrote its connect-state under
 * FALLBACK_SESSION_KEY instead of the key the session actually settles on,
 * and (b) had its in-memory `wantConnected` clobbered the moment startup's
 * own resolution ran a few seconds later.
 *
 * This calls `disconnect` as the VERY FIRST tool call — no settling sleep
 * before it, so SESSION_KEY is still FALLBACK_SESSION_KEY at the moment the
 * handler starts — with BRIDGE_AUTOCONNECT=1 so the bug (a live clobber back
 * to "connect") would be directly observable as an auth frame. Then it waits
 * past the settle window and asserts: no auth frame was ever sent, the
 * connect-state file under the REAL resolved key reads "0", it is the ONLY
 * connect-state file written (nothing landed under the fallback key), and
 * `status` reports wantConnected: false once everything has settled.
 */
describe("connect-on-demand: Finding 2 — pre-settle connect/disconnect intent", () => {
  test("disconnect issued before SESSION_KEY settles persists under the real key and sticks", async () => {
    const key = "50000000-0000-0000-0000-000000000001";
    const dir = mkdtempSync(join(tmpdir(), "cod-presettle-"));
    const stub = startToolStub();
    const env = { ...connectToolEnv(dir, stub.port, key), BRIDGE_AUTOCONNECT: "1" };
    const transport = new StdioClientTransport({ command: "bun", args: [SERVER], env });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);

      // The very first tool call — no settling sleep before it.
      const disconnectResult = await client.callTool({ name: "disconnect", arguments: {} });
      expect(disconnectResult?.isError).not.toBe(true);

      // Give resolution, the (would-be, buggy) startup overwrite, and any
      // resulting connect attempt time to play out.
      await Bun.sleep(SESSION_KEY_SETTLE_MS + NO_CONNECT_WINDOW_MS);

      expect(
        stub.authFrame(),
        "an early disconnect must stick even with BRIDGE_AUTOCONNECT=1"
      ).toBeNull();
      expect(readState(dir, key)).toBe("0");

      // Only the real key's connect-state file must exist — nothing under
      // the fallback key. ".connect-state-" mirrors connect-store.ts's own
      // (unexported) PREFIX constant.
      const files = readdirSync(dir).filter((f) => f.startsWith(".connect-state-"));
      const realKeyFile = connectStateFileFor(dir, key).split("/").pop() ?? "";
      expect(files).toEqual([realKeyFile]);

      const statusResult = await client.callTool({ name: "status", arguments: {} });
      const statusBody = JSON.parse((statusResult?.content as any)?.[0]?.text ?? "{}");
      expect(statusBody.wantConnected).toBe(false);
    } finally {
      await client.close().catch(() => {});
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * connect-on-demand, Task 6: REST-tool two-tier guard.
 *
 * The 9 Bridge REST tools (reply, list_channels, list_agents, list_contexts,
 * read_messages, claim_task, update_task_status, cancel_task, list_my_tasks)
 * must refuse with a DISTINCT hint depending on WHY they can't proceed:
 * unconfigured (no BRIDGE_API_URL/BRIDGE_TOKEN) vs. configured-but-idle
 * (wantConnected === false). `connect`/`disconnect`/`set_session_label` stay
 * ungated — `list_channels` stands in for all 9 here since they share one
 * helper called identically at the top of each case (see server.ts).
 *
 * Gated on wantConnected (INTENT), not on whether the socket has actually
 * finished its handshake — so "proceeds after connect" below calls
 * `list_channels` immediately after `connect` returns, before any auth frame
 * could plausibly have round-tripped.
 */
function startGuardStub() {
  let authFrame: any = null;
  const server = Bun.serve({
    port: 0,
    // 127.0.0.1, never the wildcard default — see stub-loopback-bind.test.ts.
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws" || req.headers.get("upgrade") === "websocket") {
        if (srv.upgrade(req)) return;
      }
      if (url.pathname === "/api/channels/read-state") return Response.json({ readState: [] });
      if (url.pathname === "/api/channels") return Response.json({ channels: [] });
      return new Response("no", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        let frame: any = {};
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (frame.type === "auth") {
          authFrame = frame;
          ws.send(
            JSON.stringify({
              type: "authenticated",
              data: { agentId: "jorgen-mac", agentName: "Jörgen (Mac)", contextId: "ctx" },
            })
          );
        }
      },
    },
  });
  return { port: server.port!, authFrame: () => authFrame, stop: () => server.stop(true) };
}

function unconfiguredEnv(dir: string): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.BRIDGE_API_URL;
  delete env.BRIDGE_TOKEN;
  delete env.BRIDGE_AUTOCONNECT;
  env.CLAUDE_PLUGIN_DATA = dir;
  env.BRIDGE_STATE_DIR = dir;
  return env;
}

describe("connect-on-demand: REST tool guard", () => {
  test("list_channels returns not-configured hint when no creds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cod-guard-unconf-"));
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: unconfiguredEnv(dir),
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "list_channels", arguments: {} });
      expect(result?.isError).not.toBe(true);
      const text = (result?.content as any)?.[0]?.text ?? "";
      expect(text).toContain("not configured");
      expect(text).toContain("/bridge:configure");
    } finally {
      await client.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("list_channels returns not-connected hint when idle with creds", async () => {
    const key = "20000000-0000-0000-0000-000000000001";
    const dir = mkdtempSync(join(tmpdir(), "cod-guard-idle-"));
    const stub = startGuardStub();
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: connectToolEnv(dir, stub.port, key),
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "list_channels", arguments: {} });
      expect(result?.isError).not.toBe(true);
      const text = (result?.content as any)?.[0]?.text ?? "";
      expect(text).toContain("not connected");
      expect(text).toContain("/bridge:connect");
    } finally {
      await client.close().catch(() => {});
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("list_channels proceeds after connect", async () => {
    const key = "20000000-0000-0000-0000-000000000002";
    const dir = mkdtempSync(join(tmpdir(), "cod-guard-connected-"));
    const stub = startGuardStub();
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: connectToolEnv(dir, stub.port, key),
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      // Same race the Task 4/5 tests guard against: a `connect` call before
      // SESSION_KEY settles persists its "1" under the fallback key, and the
      // startup path then overwrites wantConnected back to false once the
      // real key resolves. Wait it out first.
      await Bun.sleep(SESSION_KEY_SETTLE_MS);

      const connectResult = await client.callTool({ name: "connect", arguments: {} });
      expect(connectResult?.isError).not.toBe(true);

      const result = await client.callTool({ name: "list_channels", arguments: {} });
      expect(result?.isError).not.toBe(true);
      const text = (result?.content as any)?.[0]?.text ?? "";
      // Not the gate hint — real data, even though the socket has not
      // necessarily finished authenticating yet.
      expect(text.startsWith("Bridge not configured")).toBe(false);
      expect(text.startsWith("Bridge not connected")).toBe(false);
      const body = JSON.parse(text);
      expect(Array.isArray(body.channels)).toBe(true);
    } finally {
      await client.close().catch(() => {});
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("connect/disconnect are not gated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cod-guard-notgated-"));
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: unconfiguredEnv(dir),
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "disconnect", arguments: {} });
      expect(result?.isError).not.toBe(true);
      const text = (result?.content as any)?.[0]?.text ?? "";
      expect(text).toBe("disconnected");
    } finally {
      await client.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * connect-on-demand: `status` MCP tool.
 *
 * ALWAYS-ON — unlike the 9 REST tools above, `status` is NOT gated by
 * requireBridge(): it must answer with the connection/intent snapshot even
 * when unconfigured or idle, since that snapshot is precisely how a session
 * (or the /bridge:status skill) tells those two states apart. Returns text
 * containing a JSON object: `{ ...connectionStatus(), wantConnected,
 * configured, label }`.
 */
describe("connect-on-demand: status tool", () => {
  test("status works unconfigured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cod-status-unconf-"));
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: unconfiguredEnv(dir),
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "status", arguments: {} });
      expect(result?.isError).not.toBe(true);
      const text = (result?.content as any)?.[0]?.text ?? "";
      const body = JSON.parse(text);
      expect(body.configured).toBe(false);
      expect(body.wantConnected).toBe(false);
    } finally {
      await client.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("status reports idle with creds", async () => {
    const key = "30000000-0000-0000-0000-000000000001";
    const dir = mkdtempSync(join(tmpdir(), "cod-status-idle-"));
    const stub = startToolStub();
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: connectToolEnv(dir, stub.port, key),
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "status", arguments: {} });
      expect(result?.isError).not.toBe(true);
      const text = (result?.content as any)?.[0]?.text ?? "";
      const body = JSON.parse(text);
      expect(body.configured).toBe(true);
      expect(body.wantConnected).toBe(false);
    } finally {
      await client.close().catch(() => {});
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("status reports connected after connect", async () => {
    const key = "30000000-0000-0000-0000-000000000002";
    const dir = mkdtempSync(join(tmpdir(), "cod-status-connected-"));
    const stub = startToolStub();
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: connectToolEnv(dir, stub.port, key),
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      await Bun.sleep(SESSION_KEY_SETTLE_MS);

      const connectResult = await client.callTool({ name: "connect", arguments: {} });
      expect(connectResult?.isError).not.toBe(true);

      const authDeadline = Date.now() + 15_000;
      while (Date.now() < authDeadline && !stub.authFrame()) await Bun.sleep(50);
      expect(stub.authFrame()?.type).toBe("auth");

      // wantConnected flips synchronously inside the `connect` handler, but
      // receiving_messages/websocket only go true once the "authenticated"
      // frame round-trips back — poll status until it settles.
      let body: any = null;
      const statusDeadline = Date.now() + 5_000;
      while (Date.now() < statusDeadline) {
        const result = await client.callTool({ name: "status", arguments: {} });
        expect(result?.isError).not.toBe(true);
        const text = (result?.content as any)?.[0]?.text ?? "";
        body = JSON.parse(text);
        if (body.receiving_messages) break;
        await Bun.sleep(100);
      }
      expect(body.wantConnected).toBe(true);
      expect(body.receiving_messages).toBe(true);
      expect(body.websocket).toBe("connected");
    } finally {
      await client.close().catch(() => {});
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
