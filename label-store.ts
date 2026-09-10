/**
 * Per-session display-label persistence — pure module, no top-level side
 * effects. Mirrors the cursor persistence idiom in server.ts:452-507
 * (cursorFileFor / readCursorFile / atomic tmp+rename write / sweepCursors),
 * but as exported functions taking explicit args so it can be unit-tested
 * directly. server.ts itself has zero exports and runs code (including
 * connectUnlessDuplicate()) at the top level, which rules out importing it
 * from a test.
 *
 * Keyed by SESSION_KEY (resume-stable), NOT CLAUDE_CODE_SESSION_ID — see
 * server.ts:94-111 for why the launch id changes on every `--continue`.
 *
 * Wired into server.ts: resolution precedence is env override > stored file
 * > "" (derived), read into module-scope `sessionLabel` once SESSION_KEY is
 * settled and consumed by minimalSessionInfo(); the `set_session_label` tool
 * writes/clears the file through writeLabelFile/clearLabelFile below.
 */
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";

/** Same key-sanitisation rule as cursorFileFor. */
export function labelFileFor(dir: string, key: string): string {
  return join(dir, `.session-label-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`);
}

/** Returns the stored label (trimmed) or null if there is none. */
export function readLabelFile(dir: string, key: string): string | null {
  try {
    const raw = readFileSync(labelFileFor(dir, key), "utf8").trim();
    if (raw) return raw;
  } catch {}
  return null;
}

/** Atomic write: tmp file (pid-suffixed so concurrent writers can't clobber
 * each other's staged file) then rename — same as saveCursor. Ensures `dir`
 * exists first (same as saveCursor's `mkdirSync(STATE_DIR,{recursive:true,
 * mode:0o700})`) — without it, a write against a fresh STATE_DIR silently
 * no-ops inside the catch instead of persisting anything. */
export function writeLabelFile(dir: string, key: string, label: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = labelFileFor(dir, key);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, label + "\n", { mode: 0o600 });
    renameSync(tmp, target);
  } catch {}
}

/** Delete the stored label file, if any. Clearing a missing file is a no-op —
 * same try/catch-swallow idiom as every other write here. */
export function clearLabelFile(dir: string, key: string): void {
  try {
    unlinkSync(labelFileFor(dir, key));
  } catch {}
}

/** Same shape as sweepCursors: iterate label files, skip currentPath, unlink
 * anything older than maxAgeMs. All wrapped in try/catch-swallow. */
export function sweepLabelFiles(dir: string, currentPath: string, maxAgeMs: number): void {
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(".session-label-")) continue;
      const path = join(dir, name);
      if (path === currentPath) continue;
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {}
    }
  } catch {}
}
