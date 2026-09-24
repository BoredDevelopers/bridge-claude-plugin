/**
 * The profile lock: every read-rotate-persist of a chain token (installation
 * token, session refresh token) runs under it, re-reading the file inside, so two
 * processes never present the same single-use token (RFC-014 D2; Claude Code
 * #88583 / #91708 — an in-process-only guard lets a sibling's refresh revoke the
 * family).
 *
 * `mkdir` is atomic on every local filesystem and on NFS (O_EXCL is not). The
 * holder writes `{pid, at}`; a lock whose pid is dead or that is older than
 * STALE_MS is broken — the critical section is one HTTP round trip.
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";

const STALE_MS = 30_000;
const RETRY_MS = 100;
const CAP_MS = 60_000;

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as any)?.code === "EPERM";
  }
}

function isStale(lockDir: string): boolean {
  try {
    const age = Date.now() - statSync(lockDir).mtimeMs;
    if (age > STALE_MS) return true;
    const owner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
    return !pidAlive(owner?.pid);
  } catch {
    // No owner file yet: the holder is between mkdir and write — young, not stale,
    // unless the directory itself is old (checked above).
    return false;
  }
}

export async function withProfileLock<T>(profileDir: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const lockDir = join(profileDir, ".lock");
  const deadline = Date.now() + CAP_MS;
  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      break;
    } catch (err) {
      if ((err as any)?.code !== "EEXIST") throw err;
      if (isStale(lockDir)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`bridge: credential lock ${lockDir} held for over ${CAP_MS / 1000}s`);
      await Bun.sleep(RETRY_MS);
    }
  }
  try {
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
    return await fn();
  } finally {
    // Only our own lock: if a slow holder was broken as stale, the lock now belongs
    // to someone else and deleting it would let a third process in beside them.
    try {
      if (JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"))?.pid === process.pid) {
        rmSync(lockDir, { recursive: true, force: true });
      }
    } catch {}
  }
}
