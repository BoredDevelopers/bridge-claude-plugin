/**
 * Credential files for one profile (RFC-016 §5.1). ONE FILE PER ITEM — never a shared
 * blob (Claude Code #93537: a read-modify-write of one blob by concurrent processes
 * zeroes siblings). All 0600.
 *
 *   <profile>/key.json            the installation's P-256 private JWK        (tmp + rename)
 *   <profile>/state               the current join state `brg_js_<seq>_…`     (tmp + rename)
 *   <profile>/installation.json   {apiUrl, installationId, jkt, …} — written LAST: its
 *                                 presence means "enrolled"                    (tmp + rename)
 *   <profile>/attempt             write-ahead attempt, only while a mint is in flight (E5):
 *                                 EXCLUSIVE CREATE in place (O_EXCL), never tmp + rename
 *   <profile>/logged-out          marker, plain write (content is only a timestamp)
 *
 * The access token is never written: it lives in memory, 1 h.
 *
 * ⚠️ E5 ORDER + DURABILITY (a power loss must not self-lock the machine). A mint is:
 * create `attempt` (fsync file + directory) → POST → write the new `state` (tmp, fsync,
 * rename, fsync directory) → delete `attempt`. Every step is durable before the next, so
 * after a crash the disk holds either (old state + attempt) — the retry is a replay,
 * E6(b) — or (new state), never (old state, attempt gone) after the server advanced,
 * which would present a stale state without its attempt: a LOCK (E6d). Without the
 * fsyncs a crash can reorder exactly that.
 *
 * Orphan temp files (a crash between write and rename) can hold the PRIVATE KEY:
 * `sweepOrphanTemps` removes them — call it once when a process opens the profile, and
 * deleteInstallationFiles removes them too.
 *
 * Windows: the 0600 / 0700 modes are ignored there; the files are as private as the
 * profile directory's ACL (by default the user's profile, owner-only).
 *
 * ⚠️ D8 (RFC-017): installation.json, key.json, state and attempt are ONE unit — the
 * whole profile — gated on installation.json's declared `format` (../../format-guard.ts).
 * A `format` higher than this build knows means a NEWER plugin wrote it: readInstallation
 * reads that the same as "signed out" (conservative, never wrong), and
 * deleteInstallationFiles refuses the WHOLE delete rather than only skip
 * installation.json — key.json/state belong to that same newer installation and must
 * survive with it. `writeInstallation` itself is NOT guarded here: every writer of it
 * (login, headless enrolment — including enrolFromKeyIfNeeded's own re-check, both
 * outside AND inside its installation lock, see its "P1 gap" comment in auth/manager.ts)
 * gates on `readInstallation`/`isNewerInstallation` returning something first.
 * `sweepOrphanTemps` needs no such guard: it only ever removes a `*.tmp` — a
 * crash-abandoned write that never became the canonical file — never the credential
 * itself, whichever format it is at.
 *
 * ⚠️ CROSS-VERSION: A STALE 0.24 PROCESS MAY SHARE THIS DIRECTORY. 0.24 (RFC-014) reads
 * and deletes only `credentials.json` and `sessions/` (recursively), sweeps `sessions/*`
 * by age and writes `logged-out`; its lock is `<profile>/.lock`. So 0.25 NEVER writes a
 * file named `credentials.json`, never writes into `sessions/`, and `installation.json`
 * never carries `installationToken` (0.24's readInstallation requires it): a 0.24 process
 * reads a 0.25 profile as "not signed in" and its deletion routine cannot reach a 0.25
 * file. Pinned by test/auth-store.test.ts against a verbatim copy of 0.24's store.
 *
 * Node `fs` only (works on Bun and Node) — the SDK's node adapter, not `core/`.
 */
import * as fs from "fs";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, readdirSync, rmdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { isP256PrivateJwk, type EcPrivateJwk } from "../core/jwk";
import { isJoinState, joinStateSeq } from "../core/join-state";
import { randomB64url } from "../core/b64url";
import type { KeyStorage } from "../core/signer";
import { readVersioned, KNOWN_FORMAT } from "../../format-guard";

export interface Installation {
  /** D8. Omitted on read (a missing field means 0); written explicitly from KNOWN_FORMAT. */
  format?: number;
  apiUrl: string;
  installationId: string;
  installationName?: string;
  enrolledAt?: number;
  /** RFC 7638 thumbprint of key.json's public key. */
  jkt: string;
  keyStorage: KeyStorage;
  agent?: { id: string; handle: string | null; name: string };
  workspace?: { id: string; name: string };
}

export const installationFile = (dir: string) => join(dir, "installation.json");
export const keyFile = (dir: string) => join(dir, "key.json");
export const stateFile = (dir: string) => join(dir, "state");
export const attemptFile = (dir: string) => join(dir, "attempt");

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJson<T>(path: string): T | null {
  const t = readText(path);
  if (t === null) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

/**
 * The syscalls whose ORDER is the durability guarantee — one object so the tests can
 * record the sequence (ESM namespace imports cannot be spied on). Production never
 * replaces them.
 */
export const __io = {
  openSync: fs.openSync,
  writeSync: fs.writeSync,
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  renameSync: fs.renameSync,
};

/** Synchronous sleep (the writers are synchronous): Atomics.wait on a private buffer. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write + fsync + close a file descriptor's full content. */
function writeAllAndSync(fd: number, content: string): void {
  const buf = Buffer.from(content, "utf8");
  let off = 0;
  while (off < buf.length) off += __io.writeSync(fd, buf, off, buf.length - off);
  __io.fsyncSync(fd);
}

/** fsync a DIRECTORY, so a create / rename / unlink in it survives a crash. Unsupported (Windows: EPERM/EISDIR) is not an error. */
function fsyncDir(dir: string): void {
  let fd: number;
  try {
    fd = __io.openSync(dir, "r");
  } catch {
    return;
  }
  try {
    __io.fsyncSync(fd);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "EPERM" && code !== "EISDIR" && code !== "EINVAL" && code !== "ENOTSUP") throw e;
  } finally {
    __io.closeSync(fd);
  }
}

const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * rename, retried on EPERM / EACCES / EBUSY with backoff (~1 s in all): on Windows an
 * antivirus or indexer briefly holding the target makes a rename fail transiently.
 */
function renameWithRetry(from: string, to: string): void {
  for (let delay = 10; ; delay *= 2) {
    try {
      __io.renameSync(from, to);
      return;
    } catch (e) {
      if (!RENAME_RETRY_CODES.has((e as NodeJS.ErrnoException)?.code ?? "") || delay > 640) throw e;
      sleepSync(delay);
    }
  }
}

/** tmp (0600) → write → fsync → rename → fsync the directory. A failure leaves no temp file behind. */
function writeAtomic(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomB64url(4)}.tmp`;
  const fd = __io.openSync(tmp, "wx", 0o600);
  try {
    try {
      writeAllAndSync(fd, content);
    } finally {
      __io.closeSync(fd);
    }
    renameWithRetry(tmp, path);
  } catch (e) {
    remove(tmp);
    throw e;
  }
  fsyncDir(dir);
}

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

/**
 * D8: `null` for BOTH "no installation" and "a newer plugin's installation" — a reader
 * that cannot use a credential behaves the same way either way (never mint, never
 * delete). `isNewerInstallation` is the one place that tells the two apart, for the
 * callers that must (deleteInstallationFiles; a future notice, D9).
 */
export function readInstallation(dir: string): Installation | null {
  const v = readVersioned<Installation>(installationFile(dir), KNOWN_FORMAT);
  if (v.kind !== "ok") return null;
  const c = v.data;
  return typeof c.apiUrl === "string" && typeof c.installationId === "string" && typeof c.jkt === "string" ? c : null;
}

/** D8: true when installation.json was written by a plugin newer than this one knows. */
export function isNewerInstallation(dir: string): boolean {
  return readVersioned(installationFile(dir), KNOWN_FORMAT).kind === "newer";
}

/**
 * Whitelisted fields only: nothing a caller spreads in (e.g. an RFC-014 `installationToken`)
 * reaches the file — a 0.24 process must never be able to read it as its own installation.
 * `format` is additive (D8: "additive fields never bump it") — 0.25's readInstallation
 * ignores it, so this is fully compatible with a 0.25 window sharing the profile.
 */
export function writeInstallation(dir: string, c: Installation): void {
  const out: Installation = {
    format: KNOWN_FORMAT,
    apiUrl: c.apiUrl,
    installationId: c.installationId,
    ...(c.installationName !== undefined ? { installationName: c.installationName } : {}),
    ...(c.enrolledAt !== undefined ? { enrolledAt: c.enrolledAt } : {}),
    jkt: c.jkt,
    keyStorage: c.keyStorage,
    ...(c.agent ? { agent: c.agent } : {}),
    ...(c.workspace ? { workspace: c.workspace } : {}),
  };
  writeAtomic(installationFile(dir), JSON.stringify(out, null, 2) + "\n");
}

export function readKey(dir: string): EcPrivateJwk | null {
  const j = readJson<unknown>(keyFile(dir));
  return isP256PrivateJwk(j) ? { kty: "EC", crv: "P-256", x: j.x, y: j.y, d: j.d } : null;
}

export function writeKey(dir: string, jwk: EcPrivateJwk): void {
  writeAtomic(keyFile(dir), JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }) + "\n");
}

export function readState(dir: string): string | null {
  const t = readText(stateFile(dir))?.trim() ?? null;
  return isJoinState(t) ? t : null;
}

/**
 * An UNCONDITIONAL write — only for an enrolment, which stores the server's fresh state
 * after clearing the profile. Every mint writes through writeStateIfNotOlder.
 */
export function writeState(dir: string, state: string): void {
  if (!isJoinState(state)) throw new Error("refusing to write a malformed join state");
  writeAtomic(stateFile(dir), state + "\n");
}

/**
 * §3.3: write the mint's new state "unless the file already holds a higher seq" — a
 * racer past a broken lock may have advanced it further; going back would present
 * a stale state next time, which is a LOCK (E6d). Equal seq is the same successor
 * (E6b replay), so rewriting it is harmless. Returns whether it wrote.
 */
export function writeStateIfNotOlder(dir: string, state: string): boolean {
  const next = joinStateSeq(state);
  if (next === null) throw new Error("refusing to write a malformed join state");
  const cur = readState(dir);
  const curSeq = cur === null ? null : joinStateSeq(cur);
  if (curSeq !== null && curSeq > next) return false;
  writeAtomic(stateFile(dir), state + "\n");
  return true;
}

/** RFC-016 C4: 32 random bytes, base64url. */
const ATTEMPT = /^[A-Za-z0-9_-]{43}$/;

/** The attempt file exists but cannot be read (EACCES, EISDIR, …): never spin on it, never replace it. */
export class AttemptUnreadableError extends Error {
  override readonly name = "AttemptUnreadableError";
}

/** The attempt's text; null only when it does not exist (ENOENT). Anything else throws. */
function readAttemptRaw(dir: string): string | null {
  try {
    return readFileSync(attemptFile(dir), "utf8").trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw new AttemptUnreadableError(`${attemptFile(dir)} exists but cannot be read (${(e as NodeJS.ErrnoException)?.code ?? e}) — fix its permissions or delete it`, { cause: e });
  }
}

/** Make a value another process wrote durable before we send it (its writer may not have fsynced yet). */
function syncExisting(dir: string): void {
  const fd = __io.openSync(attemptFile(dir), "r");
  try {
    __io.fsyncSync(fd);
  } finally {
    __io.closeSync(fd);
  }
  fsyncDir(dir);
}

/**
 * E5: the write-ahead attempt. EXCLUSIVE create (`wx` = O_CREAT|O_EXCL); on EEXIST
 * read and reuse the existing value, so two racers past a broken lock send the SAME
 * attempt and converge through E6(b). A just-created file can be read empty for a
 * moment (create and write are two syscalls): wait for its content rather than
 * replace it — replacing would give the two racers different attempts (a false lock).
 *
 * DURABLE ON RETURN: the file and its directory entry are fsynced before this resolves,
 * i.e. before the POST that uses the value can go out (see the header).
 */
export async function createOrReadAttempt(dir: string, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let i = 0; ; i++) {
    const fresh = randomB64url(32);
    let fd: number | null = null;
    try {
      fd = __io.openSync(attemptFile(dir), "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
    }
    if (fd !== null) {
      try {
        writeAllAndSync(fd, fresh);
      } finally {
        __io.closeSync(fd);
      }
      fsyncDir(dir);
      return fresh;
    }
    const existing = readAttemptRaw(dir);
    if (existing !== null && ATTEMPT.test(existing)) {
      try {
        syncExisting(dir);
      } catch (e) {
        // Deleted between our read and the fsync (its mint finished): not an error —
        // start over, exactly as for a deletion before the read.
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        throw e;
      }
      return existing;
    }
    if (existing === null) continue; // deleted between our create and read (ENOENT only): try again
    if (i >= 20) {
      // Empty/garbage for over a second: its writer died between the two syscalls.
      remove(attemptFile(dir));
      continue;
    }
    await sleep(50);
  }
}

export function readAttempt(dir: string): string | null {
  const t = readText(attemptFile(dir))?.trim() ?? null;
  return t !== null && ATTEMPT.test(t) ? t : null;
}

/** Only after the new state is on disk (§3.3 order: write state, THEN delete attempt). */
export function deleteAttempt(dir: string): void {
  remove(attemptFile(dir));
}

/**
 * Logout / terminal refusal / re-enrolment. installation.json FIRST: others then read
 * "signed out". The CREDENTIAL files' temps too, at any age: they are only ever written
 * under the installation lock, which the caller holds, so none is in flight. NOT an
 * `upgrade-required.json` temp — that marker is no credential, and its writer may be
 * mid-write (it is left to the age-gated sweep at open).
 *
 * D8: a no-op when installation.json is a newer format — the four files are one unit
 * (see this file's header), so refusing only the delete of installation.json while
 * still deleting key.json/state would strand a newer window's credential just as badly.
 */
export function deleteInstallationFiles(dir: string): void {
  if (isNewerInstallation(dir)) return;
  remove(installationFile(dir));
  remove(keyFile(dir));
  remove(stateFile(dir));
  remove(attemptFile(dir));
  sweep(dir, CREDENTIAL_TMP, 0);
  fsyncDir(dir);
}

/** writeAtomic's temp names for THIS store's files: `<file>.<pid>.<ms>.<rand>.tmp`. Never a 0.24 or hook temp. */
const OWN_TMP = /^(key\.json|state|installation\.json|upgrade-required\.json)\.\d+\.\d+\.[A-Za-z0-9_-]+\.tmp$/;
/** The subset that can hold credential material (the private key, the join state). */
const CREDENTIAL_TMP = /^(key\.json|state|installation\.json)\.\d+\.\d+\.[A-Za-z0-9_-]+\.tmp$/;
/** Older than this, a temp file is no writer's in-flight write (a write is milliseconds). */
export const ORPHAN_TMP_AGE_MS = 60_000;

/**
 * Remove this store's temp files a crash left behind — they can hold the PRIVATE KEY.
 * Call once when a process opens the profile (default age: a concurrent writer's
 * in-flight temp is never touched). Returns how many it removed.
 *
 * D8 audit: no format check needed. A `*.tmp` is never the canonical file (writeAtomic
 * renames it into place only on success), so an orphan is always debris from a write
 * that never completed — sweeping it cannot destroy a live credential at ANY format,
 * this build's or a newer one's.
 */
export function sweepOrphanTemps(dir: string, minAgeMs = ORPHAN_TMP_AGE_MS): number {
  return sweep(dir, OWN_TMP, minAgeMs);
}

function sweep(dir: string, pattern: RegExp, minAgeMs: number): number {
  let n = 0;
  const cutoff = Date.now() - minAgeMs;
  for (const name of names(dir)) {
    if (!pattern.test(name)) continue;
    const p = join(dir, name);
    try {
      if (minAgeMs > 0 && statSync(p).mtimeMs > cutoff) continue;
      unlinkSync(p);
      n++;
    } catch {}
  }
  return n;
}

// ── markers ────────────────────────────────────────────────────────────────

const loggedOutMarker = (dir: string) => join(dir, "logged-out");
const upgradeMarker = (dir: string) => join(dir, "upgrade-required.json");

/** Set by /bridge:logout; suppresses BRIDGE_ENROLMENT_KEY until the next login. (Same name as 0.24's: a 0.24 logout is honoured.) */
export function writeLoggedOutMarker(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(loggedOutMarker(dir), `${new Date().toISOString()}\n`, { mode: 0o600 });
}
export function clearLoggedOutMarker(dir: string): void {
  remove(loggedOutMarker(dir));
}
export function hasLoggedOutMarker(dir: string): boolean {
  try {
    statSync(loggedOutMarker(dir));
    return true;
  } catch {
    return false;
  }
}

// ── 0.23 / 0.24 → 0.25 (RFC-014 files) ─────────────────────────────────────

export interface UpgradeMarker {
  apiUrl?: string;
  installationName?: string;
  retiredAt: string;
}

const legacyCredentials = (dir: string) => join(dir, "credentials.json");
const legacySessions = (dir: string) => join(dir, "sessions");
/** 0.23/0.24's writeJson temp name: `${path}.${pid}.${Date.now()}.tmp` (never the hook's `.<pid>-<rand>.tmp`). */
const LEGACY_TMP = /\.json\.\d+\.\d+\.tmp$/;

function names(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Every RFC-014 file of a profile: `credentials.json`, a `credentials.json` temp file a
 * crash left behind, and in `sessions/` the refresh-token files and their temp files.
 * NOT the hook's `pid-*.json` / `sse-*.json` (same directory for the default profile) —
 * a session file is recognised by its `refreshToken`, not its name.
 */
function legacyFiles(dir: string): string[] {
  const out: string[] = [];
  if (existsSync(legacyCredentials(dir))) out.push(legacyCredentials(dir));
  for (const n of names(dir)) if (n.startsWith("credentials.json.") && LEGACY_TMP.test(n)) out.push(join(dir, n));
  for (const n of names(legacySessions(dir))) {
    const p = join(legacySessions(dir), n);
    if (LEGACY_TMP.test(n)) out.push(p);
    else if (n.endsWith(".json") && typeof readJson<{ refreshToken?: unknown }>(p)?.refreshToken === "string") out.push(p);
  }
  return out;
}

/** Any RFC-014 file at all — also a profile whose credentials.json is gone but whose refresh tokens are not. */
export function hasLegacyCredentials(dir: string): boolean {
  return legacyFiles(dir).length > 0;
}

/**
 * Retire an RFC-014 profile: its installation token and per-session refresh tokens are
 * useless against an RFC-016 server (the cutover revoked every grant, E13) but they are
 * still secrets on disk. Deletes every file legacyFiles() names — `<stateDir>/sessions/`
 * is ALSO where hooks/session-map.ts writes `pid-*.json` / `sse-*.json` for the default
 * profile, so the directory itself is never removed while anything else is in it.
 * Leaves an upgrade marker so the person is told to /bridge:login instead of "not
 * signed in".
 *
 * Not serialized with a 0.24 process's `.lock`: against an RFC-016 server 0.24 cannot
 * obtain a new RFC-014 credential (every RFC-014 grant is refused), so it can only
 * delete these files, never write fresh ones — a race here ends with them gone either way.
 */
export function retireLegacy(dir: string): UpgradeMarker | null {
  const files = legacyFiles(dir);
  if (files.length === 0) return null;
  const old = readJson<{ apiUrl?: unknown; installationName?: unknown }>(legacyCredentials(dir));
  const marker: UpgradeMarker = {
    ...(typeof old?.apiUrl === "string" ? { apiUrl: old.apiUrl } : {}),
    ...(typeof old?.installationName === "string" ? { installationName: old.installationName } : {}),
    retiredAt: new Date().toISOString(),
  };
  writeAtomic(upgradeMarker(dir), JSON.stringify(marker) + "\n");
  for (const f of files) remove(f);
  try {
    rmdirSync(legacySessions(dir)); // only if now empty
  } catch {}
  return marker;
}

export function readUpgradeMarker(dir: string): UpgradeMarker | null {
  return readJson<UpgradeMarker>(upgradeMarker(dir));
}
export function clearUpgradeMarker(dir: string): void {
  remove(upgradeMarker(dir));
}
