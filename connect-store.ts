/**
 * Per-session connect-intent persistence — pure module, no top-level side
 * effects. Mirrors label-store.ts (which mirrors the cursor idiom). Keyed by
 * SESSION_KEY (resume-stable), so a session's connected/disconnected choice
 * survives reconnect and `claude -c`. Wired into server.ts: resolution is
 * `readConnectState(...) ?? (BRIDGE_AUTOCONNECT==="1")`; connect/disconnect
 * tools write it.
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

export function writeConnectState(dir: string, key: string, on: boolean): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = connectStateFileFor(dir, key);
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
