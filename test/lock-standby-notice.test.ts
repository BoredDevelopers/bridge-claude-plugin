/**
 * RFC-017 D3/C2 — the standby notice: when a live holder wins the session lock, the
 * CONTENDER tells its model once (pid, version, tty, terminal, cwd, since) and `status`
 * shows the same holder. session-lock.test.ts already proves WHO wins (stderr-only,
 * no MCP client); this file drives the plugin over real MCP stdio (like
 * reconnect-close-codes.test.ts) so the model-facing notice and `status`'s `holder`
 * field are observable too.
 */
import { procStartOf } from "../proc-start";
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeInstallation } from "./key-fixtures";
import pkg from "../package.json" with { type: "json" };

/** The REAL running version — this holder record must equal it for a same-version
 * standby, never a hardcoded string that drifts from the next bump (P9). */
const MY_VERSION: string = pkg.version;

const SERVER = new URL("../server.ts", import.meta.url).pathname;
const SESSION_ID = "aaaaaaaa-1111-2222-3333-444444444444";
// A closed port: this test is about lock contention, never about a real socket.
const CLOSED_PORT_API_URL = "http://127.0.0.1:1";

// What a 0.26.1+ writer records (normalized TZ/locale — proc-start.ts).
const procStart = (pid: number): string => procStartOf(pid);

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
        software: "einweave-claude-plugin",
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
        // Pinned to a zone unlike this machine's AND CI's: `since` renders in LOCAL time, and
        // the holder's procStart (written by THIS process) must still match across zones.
        TZ: "Asia/Kolkata",
        EINWEAVE_STATE_DIR: dir,
        EINWEAVE_API_URL: CLOSED_PORT_API_URL,
        EINWEAVE_AUTOCONNECT: "1",
        EINWEAVE_SESSION_KEY: SESSION_ID,
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
      expect(text).toContain("since 2026-09-27T15:32:00+05:30"); // LOCAL time (TZ pinned above), not UTC
      expect(text).toContain("/einweave:connect takeover");
      // An operator-chosen key is not a conversation id `claude --resume` takes: no fork line.
      expect(text).not.toContain("--fork-session");

      const r: any = await client.callTool({ name: "status", arguments: {} });
      const s = JSON.parse(r.content[0].text);
      expect(s.holder).toMatchObject({
        pid: process.pid,
        version: MY_VERSION,
        tty: "ttys010",
        termProgram: "iTerm.app",
        cwd: "/Users/j/Code/holder-window",
        since: "2026-09-27T15:32:00+05:30",
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
      software: "einweave-claude-plugin",
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
        EINWEAVE_STATE_DIR: dir,
        EINWEAVE_API_URL: CLOSED_PORT_API_URL,
        EINWEAVE_AUTOCONNECT: "1",
        EINWEAVE_SESSION_KEY: SESSION_ID,
        CLAUDE_CODE_SSE_PORT: "",
        EINWEAVE_TEST: "1",
        EINWEAVE_TEST_LOCK_RETRY_MS: "300", // fast standby-retry loop for this test only
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

describe("fork hint: how to make a second window its own Bridge session", () => {
  /** A holder that is this test process, and a window whose session key comes from the SESSION MAP (the stable conversation id). */
  async function standbyWindow(opts: { mapped: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), "standby-fork-"));
    writeInstallation(dir, { apiUrl: CLOSED_PORT_API_URL, installationId: crypto.randomUUID(), jkt: "test-jkt", keyStorage: "software" });
    mkdirSync(join(dir, "locks"), { recursive: true });
    writeFileSync(
      join(dir, "locks", `${SESSION_ID}.lock`),
      JSON.stringify({ format: 1, pid: process.pid, procStart: procStart(process.pid), sessionKey: SESSION_ID, at: new Date().toISOString(), software: "einweave-claude-plugin", version: MY_VERSION }),
    );
    if (opts.mapped) {
      mkdirSync(join(dir, "sessions"), { recursive: true });
      writeFileSync(
        join(dir, "sessions", `pid-${process.pid}.json`),
        JSON.stringify({ sessionId: SESSION_ID, claudePid: process.pid, procStart: "", updatedAt: new Date().toISOString() }),
      );
    }
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        EINWEAVE_STATE_DIR: dir,
        EINWEAVE_API_URL: CLOSED_PORT_API_URL,
        EINWEAVE_AUTOCONNECT: "0",
        CLAUDE_CODE_SSE_PORT: "",
        // Mapped: the per-launch id differs from the mapped conversation id, as after a --resume.
        CLAUDE_CODE_SESSION_ID: "99999999-8888-7777-6666-555555555555",
        ...(opts.mapped ? {} : { EINWEAVE_SESSION_KEY: SESSION_ID }),
      } as Record<string, string>,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const notices: string[] = [];
    client.fallbackNotificationHandler = async (n: any) => {
      if (typeof n?.params?.content === "string") notices.push(n.params.content);
    };
    await client.connect(transport);
    return {
      client,
      notices,
      close: async () => {
        await client.close().catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  const FORK = `claude --resume ${SESSION_ID} --fork-session`;

  test("the session key IS the conversation id: the standby notice and a plain connect both print the exact command", async () => {
    const w = await standbyWindow({ mapped: true });
    try {
      const reply: any = await w.client.callTool({ name: "connect", arguments: {} });
      const text = reply.content[0].text as string;
      expect(text).toContain("stands by");
      expect(text).toContain("/einweave:connect takeover");
      expect(text).toContain(FORK);
      expect(await until(() => w.notices.some((c) => c.includes("stands by")), 9_000)).toBe(true);
      expect(w.notices.find((c) => c.includes("stands by"))).toContain(FORK);
    } finally {
      await w.close();
    }
  }, 30_000);

  test("the session key is NOT a conversation id (operator override): neither message carries the line", async () => {
    const w = await standbyWindow({ mapped: false });
    try {
      const reply: any = await w.client.callTool({ name: "connect", arguments: {} });
      const text = reply.content[0].text as string;
      expect(text).toContain("stands by");
      expect(text).not.toContain("--fork-session");
      expect(await until(() => w.notices.some((c) => c.includes("stands by")), 9_000)).toBe(true);
      expect(w.notices.find((c) => c.includes("stands by"))).not.toContain("--fork-session");
    } finally {
      await w.close();
    }
  }, 30_000);
});
