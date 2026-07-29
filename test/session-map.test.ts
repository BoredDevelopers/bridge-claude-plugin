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
const mapFile = () => join(dir, "sessions", `${SSE_PORT}.json`);

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
    const { code, stderr } = await runHook("start", { CLAUDE_CODE_SSE_PORT: null });
    expect(code).toBe(0); // never fail the user's session start
    expect(existsSync(mapFile())).toBe(false);
    expect(stderr).toContain("CLAUDE_CODE_SSE_PORT");
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
