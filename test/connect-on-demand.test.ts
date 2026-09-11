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
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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
