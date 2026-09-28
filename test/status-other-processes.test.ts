/**
 * RFC-017 D9/P8 — `status`'s `other_processes`: every OTHER live Bridge process on this
 * box (proc-registry's own liveness/format rules are unit-tested in
 * proc-registry.test.ts; this is server.ts's WIRING of `listProcs` into the tool).
 *
 * Both processes point at a CLOSED port — this is about the proc registry, not a live
 * connection (same trick session-lock.test.ts uses): `writeProc` runs unconditionally at
 * startup, before the connect attempt, and BRIDGE_AUTOCONNECT=0 means neither process
 * ever tries to dial out at all.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeInstallation } from "../auth/node/store";
import { createAgentAuthRoutes } from "./agent-auth-routes";
import { mintAgentToken } from "./agent-auth-stub";

const SERVER = new URL("../server.ts", import.meta.url).pathname;
const CLOSED_PORT_API_URL = "http://127.0.0.1:1";

async function bootMcp(dir: string, sessionKey: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [SERVER],
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dir,
      BRIDGE_STATE_DIR: dir,
      BRIDGE_API_URL: CLOSED_PORT_API_URL,
      BRIDGE_AUTOCONNECT: "0",
      BRIDGE_SESSION_KEY: sessionKey,
      CLAUDE_CODE_SSE_PORT: "",
    } as Record<string, string>,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function status(client: Client): Promise<any> {
  const r: any = await client.callTool({ name: "status", arguments: {} });
  return JSON.parse(r.content[0].text);
}

/** `writeProc` lands a moment after the MCP transport is already answerable (by
 * design — connect-on-demand keeps tools live before SESSION_KEY settles), so
 * `other_processes` needs a short poll rather than a single read. */
async function untilSees(client: Client, sessionKey: string, ms: number): Promise<any> {
  const end = Date.now() + ms;
  let last: any = null;
  while (Date.now() < end) {
    last = await status(client);
    if (last.other_processes?.some((p: any) => p.sessionKey === sessionKey)) return last;
    await Bun.sleep(100);
  }
  return last;
}

describe("RFC-017 D9/P8: status other_processes", () => {
  test("lists every OTHER live Bridge process on the box, excluding self", async () => {
    const dir = mkdtempSync(join(tmpdir(), "other-procs-"));
    writeInstallation(dir, {
      apiUrl: CLOSED_PORT_API_URL,
      installationId: crypto.randomUUID(),
      jkt: "test-jkt",
      keyStorage: "software",
    });
    const a = await bootMcp(dir, "session-aaaa");
    const b = await bootMcp(dir, "session-bbbb");
    try {
      const sa = await untilSees(a, "session-bbbb", 10_000);
      const sb = await untilSees(b, "session-aaaa", 10_000);
      expect(sa.other_processes.some((p: any) => p.sessionKey === "session-bbbb")).toBe(true);
      expect(sa.other_processes.some((p: any) => p.sessionKey === "session-aaaa")).toBe(false); // no self-reporting
      expect(sb.other_processes.some((p: any) => p.sessionKey === "session-aaaa")).toBe(true);
      const entry = sa.other_processes.find((p: any) => p.sessionKey === "session-bbbb");
      expect(typeof entry.pid).toBe("number");
      expect(typeof entry.version).toBe("string");
      expect(["connected", "standby", "superseded", "disconnected"]).toContain(entry.state);
      expect(typeof entry.startedAt).toBe("string");
    } finally {
      await a.close().catch(() => {});
      await b.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("finding 11b: proc state says \"connected\" only once authenticated, never merely on winning the lock", () => {
  test("during the gap between a won lock and a completed auth handshake, this process's OWN proc record still reads \"disconnected\" — never a premature \"connected\"", async () => {
    const dir = mkdtempSync(join(tmpdir(), "other-procs-"));
    const agentAuth = createAgentAuthRoutes();
    const enrolmentKey = mintAgentToken("ek");
    agentAuth.addEnrolmentKey(enrolmentKey);
    let releaseAuth: (() => void) | null = null;
    const server = Bun.serve({
      port: 0,
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
          try { frame = JSON.parse(String(raw)); } catch { return; }
          if (frame.type !== "auth") return;
          // Hold the "authenticated" reply back until the test releases it — this is the
          // window finding 11b is about: the lock is already won, but the socket has not
          // authenticated yet.
          new Promise<void>((r) => (releaseAuth = r)).then(() => {
            ws.send(JSON.stringify({ type: "authenticated", data: { agentId: "a", agentName: "A", contextId: "session-hold" } }));
          });
        },
      },
    });
    const p = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir, BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: `http://127.0.0.1:${server.port}`, BRIDGE_AUTOCONNECT: "1",
        BRIDGE_ENROLMENT_KEY: enrolmentKey,
        BRIDGE_SESSION_KEY: "session-hold", CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    let err = "";
    (async () => { const d = new TextDecoder(); for await (const c of p.stderr as any) err += d.decode(c, { stream: true }); })();
    try {
      const lockDeadline = Date.now() + 15_000;
      while (Date.now() < lockDeadline && !/session lock acquired/.test(err)) await Bun.sleep(30);
      expect(/session lock acquired/.test(err), "must have won the lock").toBe(true);
      const procFile = join(dir, "procs", `${p.pid}.json`);
      // A moment for `open`'s `sock.send` to actually reach the stub and be held there.
      await Bun.sleep(300);
      expect(releaseAuth, "the stub must be holding the reply — the window this test needs").not.toBeNull();
      const midRec = JSON.parse(readFileSync(procFile, "utf8"));
      expect(midRec.state, "lock won, but NOT yet authenticated — must not say connected").toBe("disconnected");
      releaseAuth!();
      const authDeadline = Date.now() + 5_000;
      while (Date.now() < authDeadline && !/authenticated as A/.test(err)) await Bun.sleep(30);
      expect(/authenticated as A/.test(err)).toBe(true);
      const afterRec = JSON.parse(readFileSync(procFile, "utf8"));
      expect(afterRec.state, "now authenticated — must say connected").toBe("connected");
    } finally {
      p.kill();
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
