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
import * as fs from "fs";
import { mkdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

export const LOCK_DIR_NAME = ".install-lock";
export const STALE_MS = 120_000;
/** One deadline for everything a holder does inside (discovery + enrol + C6 retry, or mint, or revoke). */
export const HOLD_BUDGET_MS = 90_000;
/** A waiter must outwait one stale holder, or it gives up just before the break. */
export const LOCK_WAIT_MS = 150_000;
const BREAK_STALE_MS = 10_000;
const RETRY_MS = 100;
/** Errors a concurrent breaker / a Windows scanner can cause mid-delete: retried, never fatal. */
const TRANSIENT_FS = new Set(["ENOENT", "ENOTEMPTY", "EPERM", "EBUSY"]);

/** The mutating calls, as one object so tests can inject failures (ESM imports cannot be spied on). */
export const __lockIo = {
  rmSync: fs.rmSync,
  renameSync: fs.renameSync,
  writeFileSync: fs.writeFileSync,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const codeOf = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? "";

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

/**
 * Remove `lockDir` only if it is (still) stale, with breaking serialized.
 *
 * Residual: a `.break` older than BREAK_STALE_MS is reclaimed as a dead breaker's — if
 * that breaker is merely slow (suspended between its re-check and its rm for 10 s), two
 * breakers can each remove a lock and two holders can end up inside. That is safe for
 * the same reason a stale break is: both present the same state + attempt, and the
 * server converges them (E6b).
 */
function breakIfStale(lockDir: string): void {
  const breakDir = `${lockDir}.break`;
  try {
    mkdirSync(breakDir, { mode: 0o700 });
  } catch (err) {
    if (codeOf(err) !== "EEXIST") throw err;
    // A breaker that died mid-break (the section is two syscalls) leaves this behind.
    const age = ageMs(breakDir);
    if (age !== null && age > BREAK_STALE_MS) __lockIo.rmSync(breakDir, { recursive: true, force: true });
    return;
  }
  try {
    if (isStale(lockDir)) __lockIo.rmSync(lockDir, { recursive: true, force: true });
  } finally {
    __lockIo.rmSync(breakDir, { recursive: true, force: true });
  }
}

/** Run `op`, retrying a few times (≈ 300 ms) on the transient codes; rethrow anything else. */
async function withFsRetry(op: () => void): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      op();
      return;
    } catch (e) {
      if (!TRANSIENT_FS.has(codeOf(e)) || i >= 5) throw e;
      await sleep(50);
    }
  }
}

/**
 * Release OUR lock and nothing else. A plain "check nonce, then rm" would delete a NEWER
 * owner's lock if ours was broken and re-taken between the check and the rm. So: check,
 * atomically RENAME the directory to a tombstone unique to our nonce, then check what we
 * moved; if it is not ours, put it back.
 *
 * Residual: after we moved a newer owner's lock aside, a THIRD process can mkdir a lock
 * before we put it back. POSIX rename(2) REPLACES an empty target directory, so:
 *   - third still EMPTY (between its mkdir and its owner.json write): the rename-back
 *     succeeds and replaces it; the third then writes its owner.json INTO the restored
 *     lock (over the newer owner's), and both run inside it;
 *   - third already has its owner.json: the rename-back fails (ENOTEMPTY / EEXIST) and
 *     the newer owner runs on without a lock file (its tombstone stays behind until
 *     sweepLockTombstones);
 * Either way two holders overlap, and each presents the one current state + attempt from
 * disk, so they converge through E6(b) — the same guarantee as a stale break. (Windows
 * never replaces an existing directory: only the second case.)
 */
async function release(lockDir: string, nonce: string): Promise<void> {
  if (readOwner(lockDir)?.nonce !== nonce) return; // taken over (broken as stale): not ours
  const tomb = `${lockDir}.released-${nonce}`;
  try {
    await withFsRetry(() => __lockIo.renameSync(lockDir, tomb));
  } catch (e) {
    if (codeOf(e) === "ENOENT") return; // broken between the check and the rename
    throw e;
  }
  if (readOwner(tomb)?.nonce !== nonce) {
    try {
      __lockIo.renameSync(tomb, lockDir);
    } catch {}
    return;
  }
  await withFsRetry(() => __lockIo.rmSync(tomb, { recursive: true, force: true }));
}

const TOMBSTONE = new RegExp(`^${LOCK_DIR_NAME.replace(".", "\\.")}\\.released-[0-9a-f-]+$`);

/**
 * Remove release tombstones (`.install-lock.released-<nonce>`) a failed release left
 * behind. Only those older than STALE_MS: a tombstone is a lock directory moved aside, so
 * its age is its lock's, and a lock that old is breakable anyway — removing its tombstone
 * is never worse than a stale break. A younger one may be a release in progress. Call once
 * when a process opens the profile. Returns how many it removed; never throws.
 */
export function sweepLockTombstones(profileDir: string): number {
  let n = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(profileDir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!TOMBSTONE.test(name)) continue;
    const p = join(profileDir, name);
    const age = ageMs(p);
    if (age === null || age <= STALE_MS) continue;
    try {
      __lockIo.rmSync(p, { recursive: true, force: true });
      n++;
    } catch {}
  }
  return n;
}

export interface LockOptions {
  /** How long to wait for the lock (default LOCK_WAIT_MS). */
  waitMs?: number;
  /** The holder's budget; `signal` aborts when it is spent (default HOLD_BUDGET_MS; must be < STALE_MS). */
  holdMs?: number;
  /** Stop WAITING (not holding) — rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Where a failed release is reported (it never fails the caller: the stale break reclaims the lock). */
  log?: (msg: string) => void;
}

export async function withInstallationLock<T>(
  profileDir: string,
  fn: (lease: { signal: AbortSignal }) => Promise<T>,
  o: LockOptions = {}
): Promise<T> {
  const waitMs = o.waitMs ?? LOCK_WAIT_MS;
  const holdMs = o.holdMs ?? HOLD_BUDGET_MS;
  // A holder allowed to outlive the stale break would be broken while live, every time.
  if (!(holdMs > 0 && holdMs < STALE_MS)) throw new RangeError(`installation lock holdMs must be in (0, ${STALE_MS}), got ${holdMs}`);
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const lockDir = join(profileDir, LOCK_DIR_NAME);
  const nonce = crypto.randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    o.signal?.throwIfAborted();
    let created = false;
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      created = true;
      __lockIo.writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });
      break;
    } catch (err) {
      if (created) {
        // Our fresh lock vanished before we could claim it (ENOENT) — only possible if
        // something outside this protocol removed it; start over rather than run unprotected.
        if (codeOf(err) === "ENOENT") continue;
        // Any other failure (ENOSPC, EACCES, …): an ownerless lock would block everyone
        // until the stale break. Take it back down and say why.
        try {
          __lockIo.rmSync(lockDir, { recursive: true, force: true });
        } catch {}
        throw err;
      }
      if (codeOf(err) !== "EEXIST") throw err;
    }
    try {
      if (isStale(lockDir)) breakIfStale(lockDir);
    } catch (err) {
      // A concurrent breaker's rm mid-delete: retry. Anything else (EACCES, EROFS, …) is real.
      if (!TRANSIENT_FS.has(codeOf(err))) throw err;
    }
    if (Date.now() > deadline) throw new Error(`bridge: installation lock ${lockDir} held for over ${waitMs / 1000}s`);
    await sleep(RETRY_MS);
  }
  try {
    return await fn({ signal: AbortSignal.timeout(holdMs) });
  } finally {
    // Never let a failed release replace fn's result (or its error): report it; the lock
    // then ages out through the stale break.
    try {
      await release(lockDir, nonce);
    } catch (e) {
      (o.log ?? ((m: string) => console.error(m)))(`bridge: could not release installation lock ${lockDir}: ${e instanceof Error ? e.message : e}`);
    }
  }
}
