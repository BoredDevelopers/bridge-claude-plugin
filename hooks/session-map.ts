#!/usr/bin/env bun
/**
 * Bridge session identity — SessionStart / SessionEnd hook.
 *
 * The MCP server is spawned with a CLAUDE_CODE_SESSION_ID that is per *launch*:
 * it changes on every `claude --continue`, so a resumed conversation would
 * register a brand-new Bridge context and targeted messages would stop
 * following it. Hooks see the *stable* conversation id instead, so this hook
 * publishes it under the one identifier both processes share —
 * CLAUDE_CODE_SSE_PORT — and the server reads it back.
 *
 * NOT CLAUDE_PID: .mcp.json starts the server via `bun run … start`, whose
 * script is `bun install && bun server.ts`, so a wrapper process always sits
 * between Claude Code and the server. The server's process.ppid is that
 * wrapper, and its environment carries no CLAUDE_PID at all — only the SSE
 * port. CLAUDE_PID is still recorded in the file, purely as liveness metadata:
 * SSE ports are reused, so the server needs a way to tell a live mapping from
 * one a SIGKILLed session left behind.
 *
 * Invoked as `session-map.ts start|end` from hooks/hooks.json.
 *
 * Writes nothing to stdout: a hook's stdout is injected into the conversation
 * as context. Never throws — a broken mapping must cost a Bridge context, not
 * the user's session start.
 */

import {
  readFileSync,
  writeFileSync,
  writeSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  readdirSync,
  statSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

// Must match the server's SESSION_KEY_REGEX (server.ts): publishing an id the
// server would reject is the same as publishing nothing.
const SESSION_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
// The correlation key names a file — keep it to characters that cannot escape
// the directory.
const KEY_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const STDIN_TIMEOUT_MS = 2000;
const SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Same rule as the server's SESSION_MAP_DIRS (server.ts). The two must agree,
// or the mapping is written where nothing looks for it. The default is the
// server's default STATE_DIR.
const MAP_DIR = join(
  process.env.CLAUDE_PLUGIN_DATA ||
    join(homedir(), ".claude", "channels", "bridge"),
  "sessions"
);

// Synchronous by construction: main() exits the process explicitly (the bounded
// stdin read can leave a pending promise behind), and process.exit truncates
// buffered stream writes — which would drop exactly the diagnostic explaining
// why a mapping was skipped.
function log(msg: string): void {
  try {
    writeSync(2, `bridge session-map: ${msg}\n`);
  } catch {}
}

function numericEnv(name: string): number | null {
  const raw = (process.env[name] ?? "").trim();
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function readHookPayload(): Promise<Record<string, any>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    // Bounded read: a hook invoked without a payload on stdin (manual run, a
    // future Claude Code that stops piping) must not hang the session start
    // waiting for EOF.
    const text = await Promise.race([
      Bun.stdin.text(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), STDIN_TIMEOUT_MS);
      }),
    ]);
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else — alive.
    return (err as any)?.code === "EPERM";
  }
}

// The mapping directory is machine-global and nothing else prunes it: every
// session start would otherwise leave one file behind forever. Opportunistic —
// failures here are irrelevant to the mapping itself.
function sweep(): void {
  let names: string[];
  try {
    names = readdirSync(MAP_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - SWEEP_MAX_AGE_MS;
  for (const name of names) {
    const path = join(MAP_DIR, name);
    if (name.endsWith(".tmp")) {
      // A staged write whose rename never happened.
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {}
      continue;
    }
    if (!name.endsWith(".json")) continue;
    try {
      const m = JSON.parse(readFileSync(path, "utf8"));
      // A live Claude means a live mapping, however old the file is: a session
      // running for a week must not lose its context to the sweeper.
      if (pidAlive(m?.claudePid)) continue;
      const at = Date.parse(String(m?.updatedAt ?? ""));
      if (Number.isFinite(at) && at >= cutoff) continue;
      unlinkSync(path);
    } catch {
      // Unparseable: reap only once old enough that no starting session could
      // still be polling for it.
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {}
    }
  }
}

function writeMapping(file: string, data: Record<string, unknown>): void {
  mkdirSync(MAP_DIR, { recursive: true, mode: 0o700 });
  // Unique temp name: a session start racing another writer must not clobber
  // the staged file before the rename, and the server must never read a
  // half-written mapping.
  const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// `/clear` fires SessionEnd and then SessionStart WITHOUT restarting the MCP
// server, so the mapping is briefly absent and then names the new conversation
// while the running server still uses the pre-/clear id. Accepted and
// documented in resolveSessionKey (server.ts): the file describes the current
// conversation, so the next server start agrees with it again.
function removeMapping(file: string): void {
  try {
    unlinkSync(file);
  } catch (err) {
    if ((err as any)?.code !== "ENOENT") {
      log(`failed to remove ${file}: ${err}`);
    }
  }
  sweep();
}

async function main(): Promise<void> {
  /*
   * REMOVED 2026-07-29 — a `CLAUDE_CODE_CHILD_SESSION` guard that made this hook
   * a no-op in EVERY session since it shipped. It read:
   *
   *     if ((process.env.CLAUDE_CODE_CHILD_SESSION ?? "") !== "") return;
   *
   * justified as "a subagent inherits the parent's CLAUDE_PID and SSE port but
   * carries its OWN CLAUDE_CODE_SESSION_ID, so publishing from here would
   * overwrite the real conversation's mapping". Both halves are wrong, and each
   * is independently fatal:
   *
   * 1. `CLAUDE_CODE_CHILD_SESSION` is `1` in EVERY session, top-level included.
   *    Measured by launching `claude` with every CLAUDE_* variable scrubbed from
   *    the environment (`env -u …`): the SessionStart hook still received
   *    `CLAUDE_CODE_CHILD_SESSION=1`. It is undocumented — absent from both the
   *    hooks and plugins references — and does not mean what its name suggests.
   *    So this returned early every single time.
   * 2. The scenario it defends against cannot occur: **SessionStart does not
   *    fire for subagents.** They fire `SubagentStart`, a separate event this
   *    hook is not registered for.
   *
   * Consequence: the mapping directory was empty across every session ever run,
   * the server's 3s wait always timed out, and every session fell back to the
   * per-launch `CLAUDE_CODE_SESSION_ID`. Invisible on a fresh start — where the
   * launch id and the conversation id happen to be equal — and broken on exactly
   * the case this hook exists for: after `--continue` the server registers a
   * context under the launch id while the conversation carries another, so
   * replies targeted at the session stop reaching it.
   *
   * The whole feature rested on an undocumented environment variable whose
   * meaning was inferred from its name, and nothing asserted a mapping had ever
   * been written. The regression test added with this change asserts the FILE
   * EXISTS, which is the only claim that matters.
   */
  const claudePid = numericEnv("CLAUDE_PID");
  const ssePort = numericEnv("CLAUDE_CODE_SSE_PORT");
  // The SSE port is the only identifier the MCP server also has: it sits behind
  // a `bun run` wrapper, so its ppid is the wrapper and CLAUDE_PID is not in
  // its environment. CLAUDE_PID is recorded in the file instead, as the
  // liveness signal the server uses to reject a mapping a killed session left
  // behind on a since-reused port.
  /*
   * ⚠️ KNOWN LIMITATION — this whole mechanism is IDE-only.
   *
   * Measured 2026-07-29. `CLAUDE_CODE_SSE_PORT` is set by the CLI on ITSELF (the
   * VS Code integrated-terminal shell that spawns `claude` does not export it —
   * checked directly on the parent shell's environment), and only when BOTH
   * hold:
   *
   *   1. an IDE is attached — the value is always the port of a
   *      `~/.claude/ide/<port>.lock` whose `workspaceFolders` contains the
   *      session's cwd. Two live sessions matched their workspace's lock
   *      exactly, 2/2, and every lock on this machine carries
   *      `"ideName": "Visual Studio Code"`.
   *   2. the session is interactive — `claude -p` gets no port even when run
   *      from a directory that HAS a matching lock.
   *
   * So a plain-terminal / tmux / ssh session has no correlation key, this hook
   * returns here, and the MCP server falls back to the per-launch
   * CLAUDE_CODE_SESSION_ID. That is harmless on a fresh start (launch id ==
   * conversation id) and wrong after `--continue`/`--resume`, which is exactly
   * the case this hook exists for.
   *
   * Fixing it needs a correlation key both processes can see without an IDE.
   * The hard constraint is the server side: it sits behind a `bun run` wrapper,
   * so its ppid is the wrapper and its environment carries no CLAUDE_PID — it
   * has only CLAUDE_PROJECT_DIR, CLAUDE_PLUGIN_DATA and the launch id.
   * CLAUDE_PROJECT_DIR alone is not unique (several sessions per project is
   * normal), so the likely shape is a two-phase handshake: the server announces
   * {project, launch id, pid} and the hook claims the newest unclaimed
   * announcement for its project and writes the conversation id back. Not built
   * — it is a protocol change, not a guard fix.
   */
  const key = String(ssePort ?? "");
  if (!KEY_REGEX.test(key)) {
    log("no CLAUDE_CODE_SSE_PORT — no IDE attached; falling back to the per-launch session id");
    return;
  }
  const file = join(MAP_DIR, `${key}.json`);

  // argv is authoritative — hooks.json states the intent explicitly, so this is
  // known before stdin is read and the start branch can write immediately.
  const argMode = (process.argv[2] ?? "").toLowerCase();

  if (argMode !== "end" && argMode !== "start") {
    // Unlabelled invocation: the payload is the only way to tell the branches
    // apart, so this one path does pay the stdin wait before acting.
    const payload = await readHookPayload();
    await runStart(file, claudePid, ssePort, payload, {
      ending: payload.hook_event_name === "SessionEnd",
    });
    return;
  }

  if (argMode === "end") {
    removeMapping(file);
    return;
  }

  // Write from the environment FIRST. The server polls for only 3s while the
  // stdin read alone is allowed 2s, so a hook that waited for the payload
  // before writing anything could lose the race and leave the session on a
  // per-launch identity. The payload refines this a moment later.
  const envId = String(process.env.CLAUDE_CODE_SESSION_ID ?? "");
  let written = "";
  if (SESSION_ID_REGEX.test(envId)) {
    try {
      writeMapping(file, {
        sessionId: envId,
        source: "",
        claudePid,
        ssePort,
        updatedAt: new Date().toISOString(),
      });
      written = envId;
    } catch (err) {
      log(`failed to write ${file}: ${err}`);
    }
  }

  await runStart(file, claudePid, ssePort, await readHookPayload(), {
    ending: false,
    written,
  });
}

// The start branch's payload half: rewrite the mapping from the documented
// stable id once it arrives. Shared with the unlabelled-invocation path.
async function runStart(
  file: string,
  claudePid: number | null,
  ssePort: number | null,
  payload: Record<string, any>,
  opts: { ending: boolean; written?: string }
): Promise<void> {
  if (opts.ending) {
    removeMapping(file);
    return;
  }

  const sessionId = String(payload.session_id ?? "");
  if (!SESSION_ID_REGEX.test(sessionId)) {
    // No payload, no guessing: the env fallback already ran above where it was
    // safe to trust it, and anything else here would be an invention.
    if (!opts.written) {
      log("no usable session id in the hook payload — mapping not written");
    }
    sweep();
    return;
  }
  writeMapping(file, {
    sessionId,
    source: typeof payload.source === "string" ? payload.source : "",
    claudePid,
    ssePort,
    updatedAt: new Date().toISOString(),
  });
  sweep();
}

main()
  .catch((err) => log(`failed: ${err}`))
  // Explicit exit: the bounded stdin read can leave a pending promise behind.
  // Safe for diagnostics because log() writes to fd 2 synchronously.
  .finally(() => process.exit(0));
