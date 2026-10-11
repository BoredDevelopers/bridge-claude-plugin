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
 * Once only, decided by a MARKER file in the new directory (`.migrated-from-legacy`),
 * written LAST and only when every profile moved — never by whether the directory exists
 * (`hooks/session-map.ts` creates `~/.einweave/sessions` before any credential does) and
 * never by what credentials it holds. Without the marker the move runs, profile by
 * profile, and each profile is judged on its own:
 *
 * - it already has `installation.json`, or `logged-out` (signed out on purpose: the old
 *   credential must never come back — not even into a profile still carrying our journal) →
 *   finished, left alone, and a stale journal of ours is removed;
 * - it holds any other credential file and no journal of ours → somebody else's, left alone;
 * - otherwise a journal file `.migrating` is written into it, the files are placed in the
 *   order that makes a reader see `installation.json` only after its key, and the journal
 *   is removed last. A profile that still has the journal was cut short by a crash or a
 *   failure: the next start finishes it (placing only what is missing).
 *
 * Files are placed by hard-linking a fully written temp file into position (atomic, fails
 * on an existing destination, so nothing is ever overwritten). Where the filesystem has no
 * hard links, the same guarantee comes from a short per-directory lock (`.place.lock`, a
 * directory made with mkdir, broken after 30 s) around "absent? then rename the finished temp
 * file into place": a racing window waits for the lock, then finds the file complete. Two
 * windows starting at once copy
 * identical bytes from the same source, so racing placements are harmless. A profile
 * cannot be staged in a directory and renamed in: the default profile lives IN the state
 * directory, which already exists. One profile failing does not stop the others, and
 * withholds the marker so the next start retries it. Never throws: a failed move means
 * signing in again, not a broken session.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PROFILE_NAME_RE } from "./auth/profile";

export const LEGACY_STATE_DIR = join(homedir(), ".claude", "channels", "bridge");

export function resolveStateDir(env: Record<string, string | undefined> = process.env): string {
  return env.EINWEAVE_STATE_DIR || join(homedir(), ".einweave");
}

// The credential unit goes in this order: `installation.json` LAST, so a reader that sees it
// finds the key beside it.
const PROFILE_FILES = ["state", "attempt", "logged-out", "key.json", "installation.json"];
/** A profile with either is finished — signed in, or signed out on purpose — whatever journal it still carries. */
const SETTLED = ["installation.json", "logged-out"];
/** Every file a profile's credential unit can hold (any of them without our journal = not ours to touch). */
const CREDENTIAL_FILES = ["key.json", "state", "attempt", "installation.json", "logged-out"];
/** Written by the move itself, last: once present, the old directory is never consulted again. */
export const MIGRATION_MARKER = ".migrated-from-legacy";
/** Present in a profile while the move into it is unfinished. */
export const PROFILE_JOURNAL = ".migrating";

export type MigrationResult =
  | { kind: "not-needed" }
  | { kind: "migrated"; profiles: number; env: boolean }
  | { kind: "failed"; error: string };

function fsyncFile(path: string): void {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

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

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

function profileDirs(root: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(join(root, "profiles"));
  } catch {}
  return names.filter((n) => PROFILE_NAME_RE.test(n)).map((n) => join(root, "profiles", n));
}

const PLACE_LOCK = ".place.lock";
const PLACE_LOCK_STALE_MS = 30_000;
const PLACE_LOCK_WAIT_MS = 10_000;

/**
 * Break a lock whose holder is gone. Two waiters may both see it stale, so it is never removed
 * in place (the second would delete the FIRST one's fresh lock out from under it): it is renamed
 * to a name only this caller knows — one rename wins, the loser's rename finds nothing — and only
 * that private copy is removed. What remains is a window of microseconds between a waiter's
 * staleness check and its rename; a lock taken in exactly that gap is lost to the waiter, which
 * for a placement of identical bytes costs nothing (the destination is still checked under the
 * lock, and the rename-into-place can only ever add a complete file).
 */
function breakIfStale(lock: string): void {
  try {
    if (Date.now() - statSync(lock).mtimeMs <= PLACE_LOCK_STALE_MS) return;
    const mine = `${lock}.broken-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    renameSync(lock, mine);
    rmSync(mine, { recursive: true, force: true });
  } catch {}
}

/** A mutex between windows, as a directory: mkdir is atomic; a holder gone for 30 s is broken. */
function withPlaceLock<T>(dir: string, fn: () => T): T {
  const lock = join(dir, PLACE_LOCK);
  const deadline = Date.now() + PLACE_LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      breakIfStale(lock);
      if (Date.now() > deadline) throw new Error(`could not take ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {}
  }
}

/** Put `bytes` at `dst` whole-or-not-at-all and never over an existing file; true if it was placed. */
export function placeNew(dst: string, bytes: string | Uint8Array, link: (existing: string, next: string) => void = linkSync): boolean {
  const tmp = `${dst}.migrating-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, bytes, { mode: 0o600, flag: "wx" });
    fsyncFile(tmp);
    try {
      link(tmp, dst);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      // No hard links here (FAT/exFAT, some network mounts, a cross-device path): take the
      // directory's placement lock, and under it rename the finished temp file in only if the
      // destination is absent — whole-or-nothing, still never an overwrite.
      if (code === "ENOTSUP" || code === "EPERM" || code === "EXDEV" || code === "ENOSYS") {
        return withPlaceLock(dirname(dst), () => {
          if (existsSync(dst)) return false;
          renameSync(tmp, dst);
          return true;
        });
      }
      throw err;
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

/** Move one profile (see the header for the rules); returns whether anything was placed. */
function copyProfile(from: string, to: string): boolean {
  const journaled = isFile(join(to, PROFILE_JOURNAL));
  if (SETTLED.some((n) => isFile(join(to, n)))) {
    if (journaled) {
      try {
        unlinkSync(join(to, PROFILE_JOURNAL)); // a crash after the last file, or a logout since: the move is over
      } catch {}
    }
    return false;
  }
  if (!journaled && CREDENTIAL_FILES.some((n) => isFile(join(to, n)))) return false;
  const sources = PROFILE_FILES.filter((n) => isFile(join(from, n)));
  if (sources.length === 0) return false;
  mkdirSync(to, { recursive: true, mode: 0o700 });
  placeNew(join(to, PROFILE_JOURNAL), `${new Date().toISOString()}\n`);
  let any = false;
  for (const name of sources) {
    if (placeNew(join(to, name), readFileSync(join(from, name)))) any = true;
  }
  try {
    unlinkSync(join(to, PROFILE_JOURNAL)); // a racing window may have finished and removed it
  } catch {}
  fsyncDir(to);
  return any;
}

function renamedEnv(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^BRIDGE_(\w+)=/, "EINWEAVE_$1="))
    .join("\n");
}

export function migrateLegacyState(newDir: string, legacyDir: string = LEGACY_STATE_DIR): MigrationResult {
  if (!existsSync(legacyDir) || isFile(join(newDir, MIGRATION_MARKER))) return { kind: "not-needed" };
  let profiles = 0;
  let env = false;
  const errors: string[] = [];
  const attempt = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  try {
    mkdirSync(newDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }
  attempt("default profile", () => void (copyProfile(legacyDir, newDir) && profiles++));
  for (const dir of profileDirs(legacyDir)) {
    const name = dir.slice(dir.lastIndexOf("/") + 1);
    attempt(`profile ${name}`, () => void (copyProfile(dir, join(newDir, "profiles", name)) && profiles++));
  }
  attempt(".env", () => {
    let text: string;
    try {
      text = renamedEnv(readFileSync(join(legacyDir, ".env"), "utf8"));
    } catch {
      return; // no .env to move
    }
    env = placeNew(join(newDir, ".env"), text);
  });
  if (errors.length > 0) return { kind: "failed", error: errors.join("; ") };
  try {
    placeNew(join(newDir, MIGRATION_MARKER), `${new Date().toISOString()} from ${legacyDir}\n`);
    fsyncDir(newDir);
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }
  return profiles === 0 && !env ? { kind: "not-needed" } : { kind: "migrated", profiles, env };
}

/**
 * Remove temp files of a move that died (`<file>.migrating-<pid>-<rand>`; they hold credential
 * bytes) for processes that are gone — in the state directory and in each profile. Never throws.
 */
export function sweepMigrationTemps(stateDir: string, pidAlive: (pid: number) => boolean): number {
  let removed = 0;
  for (const dir of [stateDir, ...profileDirs(stateDir)]) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /\.migrating-(\d+)-[a-z0-9]+$/.exec(name);
      if (!m || pidAlive(Number(m[1]))) continue;
      try {
        unlinkSync(join(dir, name));
        removed++;
      } catch {}
    }
  }
  return removed;
}
