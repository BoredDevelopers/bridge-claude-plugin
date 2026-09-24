/**
 * The profile lock: every read-rotate-persist of a chain token (installation
 * token, session refresh token) runs under it, re-reading the file inside, so two
 * processes never present the same single-use token (RFC-014 D2; Claude Code
 * #88583 / #91708 — an in-process-only guard lets a sibling's refresh revoke the
 * family).
 *
 * `mkdir` is the atomic acquire. The holder writes `{pid, nonce}` and touches the
 * directory every HEARTBEAT_MS while it holds it.
 *
 * ⚠️ BREAKING A STALE LOCK IS ITSELF SERIALIZED (`.lock.break`). Without that, two
 * waiters that both judged the same dead lock stale race: the first removes it and
 * takes a fresh one, the second's remove then deletes THAT fresh lock and both are
 * inside (measured: 15/20 trials with 8 processes). The breaker re-checks staleness
 * while holding `.lock.break`, so it can only ever remove the lock it judged.
 *
 * Stale = the holder's pid is dead, or the lock has not been touched for
 * ABANDONED_MS (a hung process — the heartbeat keeps a live one fresh, including
 * across an HTTP call that outlasts any fixed timeout or a laptop sleep). A lock
 * with no owner file yet is a holder between mkdir and write: young, not stale.
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync, utimesSync } from "fs";
import { join } from "path";

const HEARTBEAT_MS = 5_000;
const ABANDONED_MS = 10 * 60_000;
const OWNERLESS_MS = 10_000;
const BREAK_STALE_MS = 10_000;
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

function ageMs(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function readOwner(lockDir: string): { pid?: number; nonce?: string } | null {
  try {
    return JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function isStale(lockDir: string): boolean {
  const age = ageMs(lockDir);
  if (age === null) return false; // gone: just retry the mkdir
  const owner = readOwner(lockDir);
  if (!owner) return age > OWNERLESS_MS;
  return !pidAlive(owner.pid) || age > ABANDONED_MS;
}

/** Remove `lockDir` only if it is (still) stale, with breaking serialized. */
function breakIfStale(lockDir: string): void {
  const breakDir = `${lockDir}.break`;
  try {
    mkdirSync(breakDir, { mode: 0o700 });
  } catch (err) {
    if ((err as any)?.code !== "EEXIST") throw err;
    // A breaker that died mid-break (the section is two syscalls) leaves this behind.
    const age = ageMs(breakDir);
    if (age !== null && age > BREAK_STALE_MS) rmSync(breakDir, { recursive: true, force: true });
    return;
  }
  try {
    if (isStale(lockDir)) rmSync(lockDir, { recursive: true, force: true });
  } finally {
    rmSync(breakDir, { recursive: true, force: true });
  }
}

export async function withProfileLock<T>(profileDir: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const lockDir = join(profileDir, ".lock");
  const nonce = crypto.randomUUID();
  const deadline = Date.now() + CAP_MS;
  for (;;) {
    let acquired = false;
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      acquired = true;
      writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });
      break;
    } catch (err) {
      // Our fresh lock vanished before we could claim it — only possible if something
      // outside this protocol removed it; start over rather than run unprotected.
      if (acquired) continue;
      if ((err as any)?.code !== "EEXIST") throw err;
    }
    try {
      if (isStale(lockDir)) breakIfStale(lockDir);
    } catch {
      // A concurrent breaker's rm (EPERM / ENOTEMPTY mid-delete): retry.
    }
    if (Date.now() > deadline) throw new Error(`bridge: credential lock ${lockDir} held for over ${CAP_MS / 1000}s`);
    await Bun.sleep(RETRY_MS);
  }
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lockDir, now, now);
    } catch {}
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    // Only our own lock (by nonce, not pid: one process can wait on itself).
    if (readOwner(lockDir)?.nonce === nonce) rmSync(lockDir, { recursive: true, force: true });
  }
}
