/**
 * Where this plugin keeps its state, and the one-time move from the old place
 * (RFC-027 D7, §5).
 *
 * 0.30.0 moves from `~/.claude/channels/bridge` to `~/.einweave`
 * (`EINWEAVE_STATE_DIR` overrides). From the old directory it takes ONLY what
 * makes this machine signed in and pointed at its server:
 *
 * - each credential profile (the default one at the root, and `profiles/<name>/`):
 *   `key.json`, `state`, `attempt`, `installation.json`, `logged-out`. `attempt`
 *   travels with `state`: the two are one unit (the SDK fileStore's E5), and a state copied without its in-flight attempt is
 *   exactly the stale-state lock E6d describes;
 * - `.env`, with every `BRIDGE_` key renamed `EINWEAVE_` (an installation without
 *   the API URL it was enrolled against is useless).
 *
 * Cursors, labels, locks, procs, feed sockets and logs are not carried over: they
 * describe sessions of the old protocol. The old directory is left as it was.
 *
 * Only when the new directory does not exist at all. Built in a temp directory and
 * renamed into place, so two windows starting at once cannot interleave: one
 * rename wins, the other finds the directory and leaves it alone. Never throws: a
 * failed move means signing in again, not a broken session.
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PROFILE_NAME_RE } from "./auth/profile";

export const LEGACY_STATE_DIR = join(homedir(), ".claude", "channels", "bridge");

export function resolveStateDir(env: Record<string, string | undefined> = process.env): string {
  return env.EINWEAVE_STATE_DIR || join(homedir(), ".einweave");
}

const PROFILE_FILES = ["key.json", "state", "attempt", "installation.json", "logged-out"];

export type MigrationResult =
  | { kind: "not-needed" }
  | { kind: "migrated"; profiles: number; env: boolean }
  | { kind: "lost-race" }
  | { kind: "failed"; error: string };

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {}
}

/** Copy one profile's credential files; returns whether it held any. */
function copyProfile(from: string, to: string): boolean {
  let any = false;
  for (const name of PROFILE_FILES) {
    const src = join(from, name);
    try {
      if (!statSync(src).isFile()) continue;
    } catch {
      continue;
    }
    mkdirSync(to, { recursive: true, mode: 0o700 });
    const dst = join(to, name);
    copyFileSync(src, dst);
    const fd = openSync(dst, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    any = true;
  }
  if (any) fsyncDir(to);
  return any;
}

function renamedEnv(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^BRIDGE_(\w+)=/, "EINWEAVE_$1="))
    .join("\n");
}

export function migrateLegacyState(newDir: string, legacyDir: string = LEGACY_STATE_DIR): MigrationResult {
  if (existsSync(newDir) || !existsSync(legacyDir)) return { kind: "not-needed" };
  const tmp = `${newDir}.migrating-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    mkdirSync(dirname(newDir), { recursive: true });
    mkdirSync(tmp, { mode: 0o700 });
    let profiles = copyProfile(legacyDir, tmp) ? 1 : 0;
    let names: string[] = [];
    try {
      names = readdirSync(join(legacyDir, "profiles"));
    } catch {}
    for (const name of names) {
      if (PROFILE_NAME_RE.test(name) && copyProfile(join(legacyDir, "profiles", name), join(tmp, "profiles", name))) profiles++;
    }
    let env = false;
    try {
      writeFileSync(join(tmp, ".env"), renamedEnv(readFileSync(join(legacyDir, ".env"), "utf8")), { mode: 0o600 });
      env = true;
    } catch {}
    fsyncDir(tmp);
    try {
      renameSync(tmp, newDir);
    } catch {
      rmSync(tmp, { recursive: true, force: true });
      return { kind: "lost-race" };
    }
    fsyncDir(dirname(newDir));
    return { kind: "migrated", profiles, env };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
