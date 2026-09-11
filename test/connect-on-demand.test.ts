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
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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
