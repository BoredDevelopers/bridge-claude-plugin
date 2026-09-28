/**
 * Per-session connect-intent persistence — pure module, no top-level side
 * effects. Mirrors label-store.ts (which mirrors the cursor idiom). Keyed by
 * SESSION_KEY (resume-stable), so a session's connected/disconnected choice
 * survives reconnect and `claude -c`. Wired into server.ts: resolution is
 * `readConnectState(...) ?? (BRIDGE_AUTOCONNECT==="1")`; connect/disconnect
 * tools write it.
 *
 * D8 audit: this file's whole value space is exactly "0" or "1" — no JSON envelope, so
 * it stays byte-for-byte what 0.25 writes and reads (§7's mixed-period rule: a 0.25 and
 * a 0.26 window sharing a machine must both keep working on it). ANY other content
 * (corrupt, or a hypothetical future release's own encoding) already reads as
 * `undefined` today, degrading to the BRIDGE_AUTOCONNECT default — never a crash. The
 * one gap that mattered (D8's "never delete/rewrite/sweep a format it does not know")
 * is closed on the WRITE side: `writeConnectState` checks the CURRENT file first and
 * refuses to clobber content that PARSES as a JSON record declaring a `format` this
 * store does not know (a genuinely newer window's own encoding), rather than blindly
 * overwriting. Losing a stale connect-intent flag is recoverable (/bridge:connect); a
 * newer window's own encoding must not be destroyed by an older one passing through.
 * Plain garbage (unparseable, or JSON with no higher `format`) is NOT that — it is
 * corrupt, not a newer plugin's file, and must not wedge this store shut forever: it is
 * overwritten (logged once).
 */
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";

const PREFIX = ".connect-state-";

export function connectStateFileFor(dir: string, key: string): string {
  return join(dir, `${PREFIX}${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`);
}

/** true / false as stored, or undefined when there is no file. */
export function readConnectState(dir: string, key: string): boolean | undefined {
  try {
    const raw = readFileSync(connectStateFileFor(dir, key), "utf8").trim();
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {}
  return undefined;
}

/** True if `raw` (already trimmed) is exactly what this store has ever written — "0" or "1". */
function isOwnValue(raw: string): boolean {
  return raw === "0" || raw === "1";
}

/**
 * True only when `raw` parses as a JSON object declaring a numeric `format` higher than
 * this store's only known one (0 — the bare "0"/"1" scalar has no format field at all).
 * That is the ONE thing D8 protects: a genuinely newer window's own encoding. Anything
 * else that is not this store's own value — unparseable text, a JSON object with no
 * higher `format` — is corrupt, not a newer plugin's file.
 */
function isNewerForeignFormat(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const format = (parsed as { format?: unknown }).format;
  return typeof format === "number" && Number.isInteger(format) && format > 0;
}

export function writeConnectState(dir: string, key: string, on: boolean): void {
  try {
    const target = connectStateFileFor(dir, key);
    try {
      const existing = readFileSync(target, "utf8").trim();
      if (existing && !isOwnValue(existing)) {
        // D8: only a genuinely newer FORMAT is protected — never clobber it, leave it
        // exactly as found.
        if (isNewerForeignFormat(existing)) return;
        // Anything else here is corrupt, not a newer plugin's file: falling through and
        // overwriting is what keeps this store from wedging shut forever over garbage.
        process.stderr.write(`bridge channel: connect-state for ${key} was corrupt — overwriting\n`);
      }
    } catch {} // absent: nothing to protect
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, (on ? "1" : "0") + "\n", { mode: 0o600 });
    renameSync(tmp, target);
  } catch {}
}

export function sweepConnectStateFiles(dir: string, currentPath: string, maxAgeMs: number): void {
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(PREFIX)) continue;
      const path = join(dir, name);
      if (path === currentPath) continue;
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {}
    }
  } catch {}
}
