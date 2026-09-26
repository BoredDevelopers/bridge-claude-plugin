/**
 * The installation lock (RFC-016 §5.2).
 *
 * ⚠️ CONTRACT: EVERY request that presents or creates this profile's credential state —
 * each mint, each revoke, each enrolment (which replaces key + state) — runs inside ONE
 * `withInstallationLock` call, and reads `state` / `attempt` from disk INSIDE it (never a
 * copy read before), so two processes on the machine never present the same join state
 * with different attempts (a false lock, E6d). The holder bounds ALL its work by the
 * `signal` it is handed (HOLD_BUDGET_MS < STALE_MS, across every request it makes
 * inside), so a live holder is never judged stale.
 *
 * `mkdir` is the atomic acquire. STALE = OLDER THAN 120 s, BY THE CLOCK, AND NOTHING
 * ELSE — not pid liveness, no heartbeat (RFC-016 §5.2). A pid check keeps a hung or
 * sleeping holder's lock forever; a heartbeat keeps a wedged holder's lock forever.
 * Breaking a live holder's lock is SAFE here: a racer that gets in presents the same
 * state + attempt, and the server converges both (E6b).
 *
 * ⚠️ BREAKING A STALE LOCK IS ITSELF SERIALIZED (`<lock>.break`). Without that, two
 * waiters that both judged the same stale lock race: the first removes it and takes a
 * fresh one, the second's remove then deletes THAT fresh lock and both are inside
 * (measured under RFC-014: 15/20 trials with 8 processes). The breaker re-checks
 * staleness while holding `.break`, so it can only ever remove the lock it judged.
 *
 * ⚠️ CROSS-VERSION: the directory is `.install-lock`, NOT 0.24's `.lock`. 0.24's
 * withProfileLock breaks a lock whose owner pid is dead or that is 10 min old, and
 * heartbeats `.lock` while it holds it: sharing the path would let a stale 0.24 process
 * break a 0.25 lock (dead-pid rule) or keep refreshing one (heartbeat), and let 0.25's
 * 120 s rule break a live 0.24 holder. The two protect disjoint files (0.24:
 * credentials.json + sessions/; 0.25: key/state/attempt/installation.json), so neither
 * needs to exclude the other. Pinned by test/installation-lock.test.ts against a
 * verbatim copy of 0.24's auth/lock.ts.
 *
 * Node `fs` + timers only (no Bun API): the SDK's node adapter.
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";

export const LOCK_DIR_NAME = ".install-lock";
export const STALE_MS = 120_000;
/** One deadline for everything a holder does inside (discovery + enrol + C6 retry, or mint, or revoke). */
export const HOLD_BUDGET_MS = 90_000;
/** A waiter must outwait one stale holder, or it gives up just before the break. */
export const LOCK_WAIT_MS = 150_000;
const BREAK_STALE_MS = 10_000;
const RETRY_MS = 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ageMs(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function readOwner(lockDir: string): { nonce?: string } | null {
  try {
    return JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function isStale(lockDir: string): boolean {
  const age = ageMs(lockDir);
  return age !== null && age > STALE_MS;
}

/** Remove `lockDir` only if it is (still) stale, with breaking serialized. */
function breakIfStale(lockDir: string): void {
  const breakDir = `${lockDir}.break`;
  try {
    mkdirSync(breakDir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
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

export interface LockOptions {
  /** How long to wait for the lock (default LOCK_WAIT_MS). */
  waitMs?: number;
  /** The holder's budget; `signal` aborts when it is spent (default HOLD_BUDGET_MS). */
  holdMs?: number;
}

export async function withInstallationLock<T>(
  profileDir: string,
  fn: (lease: { signal: AbortSignal }) => Promise<T>,
  o: LockOptions = {}
): Promise<T> {
  const waitMs = o.waitMs ?? LOCK_WAIT_MS;
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const lockDir = join(profileDir, LOCK_DIR_NAME);
  const nonce = crypto.randomUUID();
  const deadline = Date.now() + waitMs;
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
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    }
    try {
      if (isStale(lockDir)) breakIfStale(lockDir);
    } catch {
      // A concurrent breaker's rm (EPERM / ENOTEMPTY mid-delete): retry.
    }
    if (Date.now() > deadline) throw new Error(`bridge: installation lock ${lockDir} held for over ${waitMs / 1000}s`);
    await sleep(RETRY_MS);
  }
  try {
    return await fn({ signal: AbortSignal.timeout(o.holdMs ?? HOLD_BUDGET_MS) });
  } finally {
    // Only our own lock (by nonce, not pid: one process can wait on itself).
    if (readOwner(lockDir)?.nonce === nonce) rmSync(lockDir, { recursive: true, force: true });
  }
}
