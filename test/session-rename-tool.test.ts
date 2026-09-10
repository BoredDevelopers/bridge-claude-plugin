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

const SERVER = new URL("../server.ts", import.meta.url).pathname;
const SESSION_KEY = "11111111-2222-3333-4444-555555555555";

function labelFilePath(dir: string, key: string): string {
  return join(dir, `.session-label-${key}`);
}

// ── stub Bridge server (WS auth only) ───────────────────────────────────────

function startStub() {
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
    BRIDGE_TOKEN: "test-token",
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
  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
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
        let frame: any = {};
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (frame.type === "auth") {
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
  return { port: server.port!, putSeen: () => putSeen, stop: () => server.stop(true) };
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
        BRIDGE_TOKEN: "test-token",
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

function readLabelFileRaw(dir: string, key: string): string | null {
  try {
    return readFileSync(labelFilePath(dir, key), "utf8").trim();
  } catch {
    return null;
  }
}
