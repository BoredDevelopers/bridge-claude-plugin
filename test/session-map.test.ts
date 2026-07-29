/**
 * The SessionStart/SessionEnd hook publishes a mapping — and it must actually
 * reach disk.
 *
 * WHY THIS EXISTS
 * The hook shipped with a guard that returned early whenever
 * `CLAUDE_CODE_CHILD_SESSION` was non-empty. That variable is `1` in EVERY
 * Claude Code session, so the hook was a no-op from the day it landed: the
 * mapping directory was empty across every session ever run on the author's
 * machine, the MCP server's 3s wait always timed out, and every session silently
 * fell back to the per-launch `CLAUDE_CODE_SESSION_ID`.
 *
 * It stayed invisible because a fresh `claude` launch has launch-id ==
 * conversation-id, so the fallback looks identical to success. It only diverges
 * after `--continue`/`--resume` — the exact case the hook was written for — and
 * the symptom there is a session that quietly stops receiving replies targeted
 * at it, which reads as "Bridge is flaky" rather than as a broken hook.
 *
 * So every test here asserts on the FILE: that it exists, that it holds the
 * conversation id, and that `end` removes it. A test that only checked the exit
 * code would have passed against the broken version — it exited 0 while doing
 * nothing.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOOK = join(import.meta.dir, "..", "hooks", "session-map.ts");
const SSE_PORT = "40249";
const CONVERSATION_ID = "71d38a17-ea93-421f-8ed3-ed598c15b66b";

let dir = "";
const mapFile = () => join(dir, "sessions", `sse-${SSE_PORT}.json`);
const pidFile = (pid: number) => join(dir, "sessions", `pid-${pid}.json`);

/**
 * Run the hook the way hooks.json does. `env` entries set to null are REMOVED
 * rather than blanked — the guard this file exists to pin tested for a non-empty
 * string, so passing "" would not have reproduced it.
 */
async function runHook(
  mode: "start" | "end",
  env: Record<string, string | null> = {}
): Promise<{ code: number; stderr: string }> {
  const base: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: dir,
    CLAUDE_CODE_SSE_PORT: SSE_PORT,
    CLAUDE_PID: String(process.pid), // a live pid — the server rejects mappings whose pid is gone
    CLAUDE_CODE_SESSION_ID: CONVERSATION_ID,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete base[k];
    else base[k] = v;
  }
  const proc = Bun.spawn(["bun", HOOK, mode], {
    env: base as Record<string, string>,
    stdin: "ignore", // no payload: the env-first write must stand on its own
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  // A hook's stdout is injected into the conversation as context, so anything
  // written there becomes noise in every session start.
  expect(stdout, "the hook must write nothing to stdout").toBe("");
  return { code, stderr };
}

describe("session map hook", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bridge-session-map-"));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  test("publishes the conversation id where the MCP server looks for it", async () => {
    const { code } = await runHook("start");
    expect(code).toBe(0);
    // THE assertion. The broken version also exited 0.
    expect(existsSync(mapFile()), "no mapping was written — the server will fall back to the launch id").toBe(true);
    const mapping = JSON.parse(readFileSync(mapFile(), "utf8"));
    expect(mapping.sessionId).toBe(CONVERSATION_ID);
    expect(mapping.ssePort).toBe(Number(SSE_PORT));
    expect(mapping.claudePid).toBe(process.pid);
  });

  test("publishes even when CLAUDE_CODE_CHILD_SESSION is set, which it always is", async () => {
    // This is the regression. Claude Code sets this variable to "1" in every
    // session including top-level ones — verified by launching `claude` with all
    // CLAUDE_* scrubbed. Treating it as "I am a subagent" disabled the feature
    // entirely. SessionStart does not fire for subagents at all; they fire
    // SubagentStart, which this hook is not registered for.
    await runHook("start", { CLAUDE_CODE_CHILD_SESSION: "1" });
    expect(existsSync(mapFile()), "CLAUDE_CODE_CHILD_SESSION must not suppress the mapping").toBe(true);
    expect(JSON.parse(readFileSync(mapFile(), "utf8")).sessionId).toBe(CONVERSATION_ID);
  });

  test("`end` removes the mapping so a reused SSE port cannot inherit it", async () => {
    await runHook("start");
    expect(existsSync(mapFile())).toBe(true);
    await runHook("end");
    expect(existsSync(mapFile()), "a stale mapping lets the next session adopt a dead conversation's id").toBe(false);
  });

  test("writes nothing when there is no SSE port to correlate on", async () => {
    // Without the port the server has no key to look the mapping up by, so a
    // file here would be unreachable at best and adopted by the wrong session at
    // worst.
    // Headless is now a SUPPORTED case, not a dead end: with no SSE port the
    // hook must still publish under the CLI pid, which is the key that works
    // without an IDE. Only losing BOTH keys is fatal.
    const { code } = await runHook("start", { CLAUDE_CODE_SSE_PORT: null });
    expect(code).toBe(0); // never fail the user's session start
    expect(existsSync(mapFile()), "no sse key without a port").toBe(false);
    expect(existsSync(pidFile(process.pid)), "headless must still publish under the pid key").toBe(true);

    const both = await runHook("start", { CLAUDE_CODE_SSE_PORT: null, CLAUDE_PID: null });
    expect(both.code).toBe(0);
    expect(both.stderr).toContain("cannot correlate");
    // IDE-only by construction: the port exists only when an interactive session
    // is attached to an IDE whose workspace contains the cwd. A terminal session
    // lands here and keeps the per-launch id — documented in session-map.ts.
  });

  test("refuses a session id the Bridge server would reject", async () => {
    // SESSION_KEY_REGEX on the server side. Publishing an id it rejects is the
    // same as publishing nothing, but harder to diagnose.
    await runHook("start", { CLAUDE_CODE_SESSION_ID: "not a valid/key" });
    expect(existsSync(mapFile())).toBe(false);
  });

  test("does not clobber a live mapping written by another session", async () => {
    // SSE ports are reused. The `end` branch unlinks by port, so a session that
    // ends must not remove a mapping a DIFFERENT live conversation has since
    // published under the same port.
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const other = { sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", claudePid: process.pid, ssePort: Number(SSE_PORT), updatedAt: new Date().toISOString() };
    writeFileSync(mapFile(), JSON.stringify(other));
    await runHook("start");
    // Same port, same running hook: the newest start wins, which is correct —
    // the assertion is that it is a COMPLETE, valid mapping, not a merge.
    const mapping = JSON.parse(readFileSync(mapFile(), "utf8"));
    expect(mapping.sessionId).toBe(CONVERSATION_ID);
    expect(mapping.ssePort).toBe(Number(SSE_PORT));
  });
});

/**
 * The pid key, which is what makes this work without an IDE.
 *
 * CLAUDE_CODE_SSE_PORT exists only when an interactive session is attached to an
 * IDE. Headless sessions — tmux, ssh, OpenClaw's sdk-cli spawns — have none, and
 * they are where the bug is worst: measured on a headless `--continue`, the MCP
 * server's env carries a per-launch id that names NO conversation, while the
 * hook still sees the real one.
 */
describe("pid correlation", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bridge-pid-map-")); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  const run = (mode: "start" | "end", env: Record<string, string | null> = {}) => {
    const base: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dir,
      CLAUDE_CODE_SSE_PORT: "40249",
      CLAUDE_PID: String(process.pid),
      CLAUDE_CODE_SESSION_ID: "71d38a17-ea93-421f-8ed3-ed598c15b66b",
    };
    for (const [k, v] of Object.entries(env)) { if (v === null) delete base[k]; else base[k] = v; }
    const proc = Bun.spawn(["bun", HOOK, mode], { env: base as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return proc.exited.then(() => proc);
  };
  const f = (n: string) => join(dir, "sessions", n);

  test("writes BOTH keys when both are available", async () => {
    await run("start");
    // Not one or the other: the pid key is the one that works everywhere, and
    // the sse key still serves a reader that only knows how to look up a port.
    expect(existsSync(f(`pid-${process.pid}.json`)), "pid key missing").toBe(true);
    expect(existsSync(f("sse-40249.json")), "sse key missing").toBe(true);
    const m = JSON.parse(readFileSync(f(`pid-${process.pid}.json`), "utf8"));
    expect(m.sessionId).toBe("71d38a17-ea93-421f-8ed3-ed598c15b66b");
    expect(m.claudePid).toBe(process.pid);
    // Present, or a recycled pid could hand a live session a dead conversation.
    expect(typeof m.procStart).toBe("string");
    expect(m.procStart.length).toBeGreaterThan(0);
  });

  test("`end` removes both keys", async () => {
    await run("start");
    await run("end");
    expect(existsSync(f(`pid-${process.pid}.json`))).toBe(false);
    expect(existsSync(f("sse-40249.json"))).toBe(false);
  });

  test("a mapping whose recorded start time does not match is REFUSED", async () => {
    // Pid reuse. A session killed with SIGKILL never runs SessionEnd, so its
    // mapping outlives it; a later CLI landing on that pid would otherwise adopt
    // a dead conversation's identity. Liveness cannot catch it — the pid IS
    // alive, it is simply somebody else — so the start time is the only signal.
    // Found by mutation: deleting the comparison left the whole suite green.
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(
      join(dir, "sessions", `pid-${process.pid}.json`),
      JSON.stringify({
        sessionId: "dddddddd-dead-dead-dead-dddddddddddd",
        claudePid: process.pid, // alive...
        procStart: "Wed Jan  1 00:00:00 2020", // ...but not the process we recorded
        updatedAt: new Date().toISOString(),
      })
    );

    const plugin = Bun.spawn(["bun", join(import.meta.dir, "..", "server.ts")], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: "http://127.0.0.1:1",
        BRIDGE_TOKEN: "test-token",
        CLAUDE_CODE_SESSION_ID: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const deadline = Date.now() + 20_000;
    let err = "";
    const reader = (plugin.stderr as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    while (Date.now() < deadline && !err.includes("session key")) {
      const { value, done } = await reader.read();
      if (done) break;
      err += dec.decode(value, { stream: true });
    }
    reader.releaseLock();
    plugin.kill();

    expect(err, "must not adopt a mapping it cannot verify").not.toContain("dddddddd-dead");
    expect(err, "should fall back to the per-launch id").toContain("bbbbbbbb-cccc");
  }, 30_000);

  test("the server resolves through its own ancestry, with no SSE port at all", async () => {
    // The real mechanism end to end. This test process is the plugin's PARENT,
    // standing in for the Claude Code CLI: the hook keys the mapping by our pid,
    // and the plugin must walk up from itself and find it.
    await run("start", { CLAUDE_CODE_SSE_PORT: null });
    expect(existsSync(f(`pid-${process.pid}.json`))).toBe(true);

    const plugin = Bun.spawn(["bun", join(import.meta.dir, "..", "server.ts")], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: "http://127.0.0.1:1", // closed: we only need the boot log
        BRIDGE_TOKEN: "test-token",
        CLAUDE_CODE_SESSION_ID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", // the per-launch id it must NOT use
        CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const deadline = Date.now() + 20_000;
    let err = "";
    const reader = (plugin.stderr as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    while (Date.now() < deadline && !err.includes("session key")) {
      const { value, done } = await reader.read();
      if (done) break;
      err += dec.decode(value, { stream: true });
    }
    reader.releaseLock();
    plugin.kill();

    expect(err, `plugin never reported a session key. stderr:\n${err}`).toContain("session key");
    expect(err, "must resolve via the CLI pid, not the per-launch id").toContain(`cli pid ${process.pid}`);
    expect(err).toContain("71d38a17-ea93-421f-8ed3-ed598c15b66b");
    expect(err, "the per-launch id must not win").not.toContain("aaaaaaaa-bbbb");
  }, 30_000);
});
