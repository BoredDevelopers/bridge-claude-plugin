#!/usr/bin/env bun
/**
 * Delivery confirmation hook — UserPromptSubmit and Stop (RFC-027 D4/D7).
 *
 * Claude Code acknowledges nothing it receives from a channel: `mcp.notification`
 * resolves on the stdio write, and a session started without the channels flag
 * drops every push silently. What it does do (measured, 2.1.296) is fire
 * UserPromptSubmit at the moment the model receives a channel entry, with the
 * whole `<channel … message_id="…">` tag as `prompt`. That is the receipt.
 *
 *   delivery.ts prompt — tell this session's MCP server which entry, if any, the
 *     prompt delivered; print the missed-entry notice it answers with, if any.
 *   delivery.ts stop   — tell it the turn ended (the missed rule needs turns).
 *
 * The server is found through `<state>/ctl/c$CLAUDE_PID.sock` (`ctl-path.ts`).
 *
 * FAIL OPEN, ALWAYS. No CLAUDE_PID, no socket, a socket directory that is not ours, a slow or broken server, bad stdin:
 * exit 0 and print nothing. This runs on every prompt the user types; it may cost
 * a Bridge confirmation, never the user's prompt. And stdout is model context:
 * the only thing ever written there is the one JSON object below.
 */
import { writeSync } from "node:fs";
import { dirname } from "node:path";
import { deliveredEntryId } from "../delivery/tags";
import { ctlSocketPath } from "../delivery/ctl-path";
import { checkPrivateDir } from "../delivery/private-dir";
import { resolveStateDir } from "../state-dir";
import type { CtlRequest } from "../delivery/ctl-protocol";

const STDIN_TIMEOUT_MS = 1000;
const SOCKET_TIMEOUT_MS = 1500;
const MAX_RESPONSE_BYTES = 64 * 1024;

const stateDir = resolveStateDir();

function claudePid(): number | null {
  const raw = (process.env.CLAUDE_PID ?? "").trim();
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function readPayload(): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      Bun.stdin.text(),
      new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), STDIN_TIMEOUT_MS))),
    ]);
    const parsed = text ? JSON.parse(text) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/** One request, one response line; null on any failure or timeout. */
function ask(path: string, req: CtlRequest): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = (v: Record<string, unknown> | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), SOCKET_TIMEOUT_MS);
    Bun.connect({
      unix: path,
      socket: {
        open(s) {
          s.write(JSON.stringify(req) + "\n");
        },
        data(s, chunk) {
          buf += chunk.toString();
          // Settle BEFORE end(): end() runs close() synchronously, which would
          // settle null first and drop the answer.
          if (buf.length > MAX_RESPONSE_BYTES) {
            finish(null);
            return void s.end();
          }
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          let v: unknown = null;
          try {
            v = JSON.parse(buf.slice(0, nl));
          } catch {}
          finish(v && typeof v === "object" ? (v as Record<string, unknown>) : null);
          s.end();
        },
        close() {
          finish(null);
        },
        error() {
          finish(null);
        },
      },
    }).catch(() => finish(null));
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "prompt" && mode !== "stop") return;
  const pid = claudePid();
  const payload = await readPayload();
  if (!pid) return;
  const path = ctlSocketPath(stateDir, pid);
  // What the socket answers is printed into the model's context: never talk to one in a
  // directory that is not ours alone (a shared tmp fallback another user may have made).
  if (!checkPrivateDir(dirname(path)).ok) return;

  if (mode === "stop") {
    await ask(path, { op: "stop" });
    return;
  }
  const res = await ask(path, { op: "prompt", id: deliveredEntryId(payload.prompt) });
  if (res?.ok === true && typeof res.context === "string" && res.context.length > 0) {
    writeSync(
      1,
      JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: res.context } }),
    );
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
