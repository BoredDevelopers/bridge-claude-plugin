/**
 * RFC-017 D3/C2 — the standby notice: when a live holder wins the session lock, the
 * CONTENDER tells its model once (pid, version, tty, terminal, cwd, since) and `status`
 * shows the same holder. session-lock.test.ts already proves WHO wins (stderr-only,
 * no MCP client); this file drives the plugin over real MCP stdio (like
 * reconnect-close-codes.test.ts) so the model-facing notice and `status`'s `holder`
 * field are observable too.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeInstallation } from "../auth/node/store";
import pkg from "../package.json" with { type: "json" };

/** The REAL running version — this holder record must equal it for a same-version
 * standby, never a hardcoded string that drifts from the next bump (P9). */
const MY_VERSION: string = pkg.version;

const SERVER = new URL("../server.ts", import.meta.url).pathname;
const SESSION_ID = "aaaaaaaa-1111-2222-3333-444444444444";
// A closed port: this test is about lock contention, never about a real socket.
const CLOSED_PORT_API_URL = "http://127.0.0.1:1";

function procStart(pid: number): string {
  const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
  return r.success ? new TextDecoder().decode(r.stdout).trim() : "";
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await Bun.sleep(25);
  }
  return pred();
}

describe("RFC-017 C2: standby names the holder — once, to the model, and in status", () => {
  test("pid, version, tty, termProgram, cwd and since all appear, exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standby-notice-"));
    writeInstallation(dir, { apiUrl: CLOSED_PORT_API_URL, installationId: crypto.randomUUID(), jkt: "test-jkt", keyStorage: "software" });
    // This test process stands in for the holder: real, live, a genuine start time —
    // exactly the shape holderIsLive requires — plus the RFC-017 identity fields a
    // 0.26 lock record carries.
    mkdirSync(join(dir, "locks"), { recursive: true });
    writeFileSync(
      join(dir, "locks", `${SESSION_ID}.lock`),
      JSON.stringify({
        format: 1,
        pid: process.pid,
        procStart: procStart(process.pid),
        sessionKey: SESSION_ID,
        at: new Date().toISOString(),
        software: "bridge-claude-plugin",
        version: MY_VERSION, // equal to this test's own build — a same-version standby
        tty: "ttys010",
        termProgram: "iTerm.app",
        cwd: "/Users/j/Code/holder-window",
        startedAt: "2026-09-27T10:02:00.000Z",
      })
    );
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: CLOSED_PORT_API_URL,
        BRIDGE_AUTOCONNECT: "1",
        BRIDGE_SESSION_KEY: SESSION_ID,
        CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const notices: string[] = [];
    client.fallbackNotificationHandler = async (n: any) => {
      if (typeof n?.params?.content === "string") notices.push(n.params.content);
    };
    try {
      await client.connect(transport);
      const sawNotice = await until(() => notices.some((c) => c.includes("stands by")), 9_000);
      expect(sawNotice).toBe(true);
      const standby = notices.filter((c) => c.includes("stands by"));
      expect(standby).toHaveLength(1); // once per episode, not once per 30s retry
      const text = standby[0]!;
      expect(text).toContain(`pid ${process.pid}`);
      expect(text).toContain(MY_VERSION);
      expect(text).toContain("ttys010");
      expect(text).toContain("iTerm.app");
      expect(text).toContain("/Users/j/Code/holder-window");
      expect(text).toContain("10:02"); // "since" — the timestamp is rendered, not omitted
      expect(text).toContain("/bridge:connect takeover");

      const r: any = await client.callTool({ name: "status", arguments: {} });
      const s = JSON.parse(r.content[0].text);
      expect(s.holder).toMatchObject({
        pid: process.pid,
        version: MY_VERSION,
        tty: "ttys010",
        termProgram: "iTerm.app",
        cwd: "/Users/j/Code/holder-window",
        since: "2026-09-27T10:02:00.000Z",
      });
    } finally {
      await client.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("finding 9: the standby dedupe key is pid + procStart, not the holder's own renewing `at`", () => {
  test("the SAME holder re-read with a FRESHER `at` (simulating its 30s lock renewal) does not re-notify", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standby-notice-"));
    writeInstallation(dir, { apiUrl: CLOSED_PORT_API_URL, installationId: crypto.randomUUID(), jkt: "test-jkt", keyStorage: "software" });
    const lockPath = join(dir, "locks", `${SESSION_ID}.lock`);
    const holderRecord = (at: string) => ({
      format: 1,
      pid: process.pid,
      procStart: procStart(process.pid),
      sessionKey: SESSION_ID,
      at,
      software: "bridge-claude-plugin",
      version: MY_VERSION,
      // Deliberately NO `startedAt` — the exact 0.25 shape, where the old buggy key
      // (`rec.startedAt ?? rec.at`) fell all the way back to the ever-changing `at`.
    });
    mkdirSync(join(dir, "locks"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify(holderRecord(new Date().toISOString())));
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: CLOSED_PORT_API_URL,
        BRIDGE_AUTOCONNECT: "1",
        BRIDGE_SESSION_KEY: SESSION_ID,
        CLAUDE_CODE_SSE_PORT: "",
        BRIDGE_TEST: "1",
        BRIDGE_TEST_LOCK_RETRY_MS: "300", // fast standby-retry loop for this test only
      } as Record<string, string>,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const notices: string[] = [];
    client.fallbackNotificationHandler = async (n: any) => {
      if (typeof n?.params?.content === "string") notices.push(n.params.content);
    };
    try {
      await client.connect(transport);
      expect(await until(() => notices.some((c) => c.includes("stands by")), 9_000)).toBe(true);
      // Rewrite the SAME holder (same pid+procStart) with a NEW `at` a few times, spanning
      // several of the plugin's fast 300ms standby retries — exactly what the holder's own
      // 30s renewal does in real life, just sped up here.
      for (let i = 0; i < 5; i++) {
        await Bun.sleep(150);
        writeFileSync(lockPath, JSON.stringify(holderRecord(new Date().toISOString())));
      }
      await Bun.sleep(500);
      const standby = notices.filter((c) => c.includes("stands by"));
      expect(standby, "the SAME holder must not be re-notified just because its `at` moved").toHaveLength(1);
    } finally {
      await client.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
