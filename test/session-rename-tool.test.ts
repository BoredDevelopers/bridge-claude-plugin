/**
 * P2: per-session label RESOLUTION wiring + the `set_session_label` tool.
 *
 * server.ts has zero exports and runs `connectUnlessDuplicate()` at the top
 * level (see label-store.ts's header), so — like session-label.test.ts and
 * session-lock.test.ts — this drives it as a spawned child process rather
 * than importing it.
 *
 * SESSION_KEY here MUST match what resolveSessionKey() actually resolves, or
 * the pre-seeded label file would sit under the wrong name and every
 * resolution assertion would silently test nothing. Per server.ts's
 * resolveSessionKey(): with no BRIDGE_SESSION_KEY override and no session-map
 * hook running (BRIDGE_STATE_DIR/CLAUDE_PLUGIN_DATA point at a throwaway temp
 * dir with no `sessions/` subdirectory, so the ancestry walk always misses),
 * it falls through to CLAUDE_CODE_SESSION_ID (CLAUDE_CODE_SSE_PORT left "" so
 * the SSE-port path is skipped too) — same fixed id session-label.test.ts
 * already uses for the same reason.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAgentAuthRoutes } from "./agent-auth-routes";

const SERVER = new URL("../server.ts", import.meta.url).pathname;
const SESSION_KEY = "11111111-2222-3333-4444-555555555555";
const ENROLMENT_KEY = "brg_ek_test";

function labelFilePath(dir: string, key: string): string {
  return join(dir, `.session-label-${key}`);
}

// ── stub Bridge server (WS auth only) ───────────────────────────────────────

function startStub() {
  let authFrame: any = null;
  const agentAuth = createAgentAuthRoutes();
  agentAuth.addEnrolmentKey(ENROLMENT_KEY);
  const server = Bun.serve({
    port: 0,
    // 127.0.0.1, never the wildcard default — see stub-loopback-bind.test.ts.
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const auth = await agentAuth.handle(req);
      if (auth) return auth;
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

async function authFrameWithStore(opts: {
  seedLabel?: string;
  envLabel?: string;
}): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), "srt-"));
  if (opts.seedLabel !== undefined) {
    writeFileSync(labelFilePath(dir, SESSION_KEY), opts.seedLabel + "\n");
  }
  const stub = startStub();
  const env: Record<string, string> = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: dir,
    BRIDGE_STATE_DIR: dir,
    BRIDGE_API_URL: `http://127.0.0.1:${stub.port}`,
    BRIDGE_ENROLMENT_KEY: ENROLMENT_KEY, BRIDGE_AUTOCONNECT: "1",
    CLAUDE_CODE_SESSION_ID: SESSION_KEY,
    CLAUDE_CODE_SSE_PORT: "",
  };
  if (opts.envLabel !== undefined) env.BRIDGE_SESSION_LABEL = opts.envLabel;
  const plugin = Bun.spawn(["bun", SERVER], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !stub.authFrame()) await Bun.sleep(50);
    return stub.authFrame();
  } finally {
    plugin.kill();
    stub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("session label resolution (SESSION_KEY-keyed store)", () => {
  test("reads a pre-seeded label file when no env override is set", async () => {
    const frame = await authFrameWithStore({ seedLabel: "Reviewer" });
    expect(frame?.type).toBe("auth");
    expect(frame?.sessionInfo?.sessionLabel).toBe("Reviewer");
  }, 30_000);

  test("BRIDGE_SESSION_LABEL env wins over a stored file", async () => {
    const frame = await authFrameWithStore({ seedLabel: "Reviewer", envLabel: "FromEnv" });
    expect(frame?.type).toBe("auth");
    expect(frame?.sessionInfo?.sessionLabel).toBe("FromEnv");
  }, 30_000);

  test("no stored file and no env override means no sessionLabel", async () => {
    const frame = await authFrameWithStore({});
    expect(frame?.type).toBe("auth");
    expect(frame?.sessionInfo?.sessionLabel).toBeUndefined();
  }, 30_000);
});

// ── set_session_label tool round-trip (best effort — stdio MCP client) ─────
//
// Uses the SDK's own Client + StdioClientTransport (rather than hand-rolling
// the newline-delimited JSON-RPC framing) to drive `initialize` then
// `tools/call`. The stub server here additionally answers the PUT .../label
// HTTP request the tool is expected to make.

function startLabelStub() {
  let putSeen: { path: string; body: any; contextHeader: string | null } | null = null;
  // Every auth frame received, in order — a reconnect sends a SECOND one, and
  // the regression test below is specifically about what that second frame
  // carries. A single `authFrame` (last-write-wins) would not distinguish
  // "never reconnected" from "reconnected and sent the same thing twice".
  const authFrames: any[] = [];
  // The current connection's server-side socket, captured off the first
  // frame we see on it — WS auth is always the first message. Lets a test
  // force a reconnect deterministically by closing the transport out from
  // under the client, rather than waiting on the 90s liveness timeout.
  let liveWs: any = null;
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
      if (req.method === "PUT" && /^\/api\/agents\/[^/]+\/contexts\/[^/]+\/label$/.test(url.pathname)) {
        let body: any = {};
        try {
          body = await req.json();
        } catch {}
        putSeen = { path: url.pathname, body, contextHeader: req.headers.get("x-bridge-context") };
        return new Response(JSON.stringify({ label: "Reviewer · #ctx" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (srv.upgrade(req)) return;
      return new Response("no", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        liveWs = ws;
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
              data: {
                agentId: "jorgen-mac",
                agentName: "Jörgen (Mac)",
                contextId: "ctx",
                sendToken: "send-tok",
              },
            })
          );
        }
      },
    },
  });
  return {
    port: server.port!,
    putSeen: () => putSeen,
    authFrames: () => authFrames,
    closeLiveSocket: () => {
      try {
        liveWs?.close();
      } catch {}
    },
    stop: () => server.stop(true),
  };
}

describe("set_session_label tool (best effort — stdio round trip)", () => {
  test("PUTs the label endpoint, writes the label file, and reports the stored name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srt-tool-"));
    const stub = startLabelStub();
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: `http://127.0.0.1:${stub.port}`,
        BRIDGE_ENROLMENT_KEY: ENROLMENT_KEY, BRIDGE_AUTOCONNECT: "1",
        CLAUDE_CODE_SESSION_ID: SESSION_KEY,
        CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);

      // WS auth (and therefore agentId/myContextId) settles independently of
      // the stdio handshake, and the tool requires it — retry rather than
      // guessing a fixed delay.
      const deadline = Date.now() + 15_000;
      let lastErrText = "";
      let result: any = null;
      while (Date.now() < deadline) {
        result = await client.callTool({ name: "set_session_label", arguments: { label: "Reviewer" } });
        const text = Array.isArray(result?.content) ? (result.content[0]?.text ?? "") : "";
        if (!result?.isError) break;
        lastErrText = text;
        if (!/not yet authenticated/.test(text)) break;
        await Bun.sleep(200);
      }

      expect(result?.isError, `expected success, got: ${lastErrText}`).not.toBe(true);
      const text = result.content[0].text as string;
      expect(text).toContain("Reviewer · #ctx");

      const seen = stub.putSeen();
      expect(seen?.path).toBe("/api/agents/jorgen-mac/contexts/ctx/label");
      expect(seen?.body).toEqual({ label: "Reviewer" });
      expect(seen?.contextHeader).toBe("send-tok");

      const stored = readLabelFileRaw(dir, SESSION_KEY);
      expect(stored).toBe("Reviewer");
    } finally {
      await client.close().catch(() => {});
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

// Regression: the bug the first round-trip test could not have caught, because
// it never drove a SECOND auth frame. `set_session_label` used to stash the
// server's SUFFIXED response ("Reviewer · #ctx") into the in-memory
// `sessionLabel`, which `minimalSessionInfo()` feeds into the NEXT auth
// frame's `sessionInfo.sessionLabel` verbatim — and the SERVER re-suffixes
// whatever it receives. So a reconnect after a rename sent the already-
// suffixed value back, and the server would have compounded it further
// ("Reviewer · #ctx · #ctx") on every subsequent reconnect. `sessionLabel`
// must hold the RAW label, exactly like the on-disk file already does.
describe("set_session_label persists across reconnect (regression: no double-suffix)", () => {
  test("the second auth frame after a rename carries the RAW label, not the server's suffixed one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srt-reconnect-"));
    const stub = startLabelStub();
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: `http://127.0.0.1:${stub.port}`,
        BRIDGE_ENROLMENT_KEY: ENROLMENT_KEY, BRIDGE_AUTOCONNECT: "1",
        CLAUDE_CODE_SESSION_ID: SESSION_KEY,
        CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);

      // First auth frame — the initial connect, before any rename.
      let deadline = Date.now() + 15_000;
      while (Date.now() < deadline && stub.authFrames().length < 1) await Bun.sleep(50);
      expect(stub.authFrames().length, "initial connect must auth").toBeGreaterThanOrEqual(1);

      // Rename — same auth-settling retry as the round-trip test above.
      deadline = Date.now() + 15_000;
      let result: any = null;
      let lastErrText = "";
      while (Date.now() < deadline) {
        result = await client.callTool({ name: "set_session_label", arguments: { label: "Reviewer" } });
        const text = Array.isArray(result?.content) ? (result.content[0]?.text ?? "") : "";
        if (!result?.isError) break;
        lastErrText = text;
        if (!/not yet authenticated/.test(text)) break;
        await Bun.sleep(200);
      }
      expect(result?.isError, `expected rename success, got: ${lastErrText}`).not.toBe(true);

      // Force a RECONNECT by closing the server-side socket out from under
      // the plugin. Its `close` listener fires scheduleReconnect() (~1s
      // backoff after a prior successful auth), which re-authenticates with
      // freshly collected sessionInfo — sessionInfoPromise was reset by the
      // tool call, so this is what actually exercises the in-memory
      // `sessionLabel` value the tool just set, not a cached auth payload.
      stub.closeLiveSocket();

      deadline = Date.now() + 15_000;
      while (Date.now() < deadline && stub.authFrames().length < 2) await Bun.sleep(50);
      const frames = stub.authFrames();
      expect(frames.length, "expected a second auth frame after forcing reconnect").toBeGreaterThanOrEqual(2);

      const secondLabel = frames[1]?.sessionInfo?.sessionLabel;
      expect(secondLabel).toBe("Reviewer");
      expect(secondLabel).not.toBe("Reviewer · #ctx");
    } finally {
      await client.close().catch(() => {});
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

function readLabelFileRaw(dir: string, key: string): string | null {
  try {
    return readFileSync(labelFilePath(dir, key), "utf8").trim();
  } catch {
    return null;
  }
}
