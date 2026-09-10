import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = new URL("../server.ts", import.meta.url).pathname;

function startStub() {
  let authFrame: any = null;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) { if (srv.upgrade(req)) return; return new Response("no", { status: 400 }); },
    websocket: {
      message(ws, raw) {
        let frame: any = {};
        try { frame = JSON.parse(String(raw)); } catch { return; }
        if (frame.type === "auth") {
          authFrame = frame;
          ws.send(JSON.stringify({
            type: "authenticated",
            data: { agentId: "jorgen-mac", agentName: "Jörgen (Mac)", contextId: "ctx" },
          }));
        }
      },
    },
  });
  return { port: server.port!, authFrame: () => authFrame, stop: () => server.stop(true) };
}

async function authFrameWith(label: string): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), "sl-"));
  const stub = startStub();
  const plugin = Bun.spawn(["bun", SERVER], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dir,
      BRIDGE_STATE_DIR: dir,
      BRIDGE_API_URL: `http://127.0.0.1:${stub.port}`,
      BRIDGE_TOKEN: "test-token",
      CLAUDE_CODE_SESSION_ID: "11111111-2222-3333-4444-555555555555",
      CLAUDE_CODE_SSE_PORT: "",
      BRIDGE_SESSION_LABEL: label,
    } as Record<string, string>,
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
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

describe("BRIDGE_SESSION_LABEL", () => {
  test("is sent as sessionInfo.sessionLabel when set", async () => {
    const frame = await authFrameWith("Researcher");
    expect(frame?.type).toBe("auth");
    expect(frame?.sessionInfo?.sessionLabel).toBe("Researcher");
  }, 30_000);

  test("is absent from sessionInfo when empty", async () => {
    const frame = await authFrameWith("");
    expect(frame?.type).toBe("auth");
    expect(frame?.sessionInfo?.sessionLabel).toBeUndefined();
  }, 30_000);
});
