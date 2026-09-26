/**
 * Credential files for one profile (RFC-016 §5.1). 0600 files written tmp+rename,
 * ONE FILE PER ITEM — never a shared blob (Claude Code #93537: a read-modify-write
 * of one blob by concurrent processes zeroes siblings).
 *
 *   <profile>/key.json            the installation's P-256 private JWK
 *   <profile>/state               the current join state `brg_js_<seq>_…`
 *   <profile>/attempt             write-ahead attempt, only while a mint is in flight (E5)
 *   <profile>/installation.json   {apiUrl, installationId, jkt, …} — written LAST: its
 *                                 presence means "enrolled"
 *
 * The access token is never written: it lives in memory, 1 h.
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
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, readdirSync, rmdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { isP256PrivateJwk, type EcPrivateJwk } from "../core/jwk";
import { isJoinState, joinStateSeq } from "../core/join-state";
import { randomB64url } from "../core/b64url";
import type { KeyStorage } from "../core/signer";

export interface Installation {
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

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomB64url(4)}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

export function readInstallation(dir: string): Installation | null {
  const c = readJson<Installation>(installationFile(dir));
  return c && typeof c.apiUrl === "string" && typeof c.installationId === "string" && typeof c.jkt === "string" ? c : null;
}

/**
 * Whitelisted fields only: nothing a caller spreads in (e.g. an RFC-014 `installationToken`)
 * reaches the file — a 0.24 process must never be able to read it as its own installation.
 */
export function writeInstallation(dir: string, c: Installation): void {
  const out: Installation = {
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

/** A fresh enrolment's seq-0 state (the profile's files were just cleared). */
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

/**
 * E5: the write-ahead attempt. EXCLUSIVE create (`wx` = O_CREAT|O_EXCL); on EEXIST
 * read and reuse the existing value, so two racers past a broken lock send the SAME
 * attempt and converge through E6(b). A just-created file can be read empty for a
 * moment (create and write are two syscalls): wait for its content rather than
 * replace it — replacing would give the two racers different attempts (a false lock).
 */
export async function createOrReadAttempt(dir: string, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let i = 0; ; i++) {
    const fresh = randomB64url(32);
    try {
      writeFileSync(attemptFile(dir), fresh, { flag: "wx", mode: 0o600 });
      return fresh;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
    }
    const existing = readText(attemptFile(dir))?.trim() ?? null;
    if (existing !== null && ATTEMPT.test(existing)) return existing;
    if (existing === null) continue; // deleted between our create and read: try again
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

/** Logout / terminal refusal / re-enrolment. installation.json FIRST: others then read "signed out". */
export function deleteInstallationFiles(dir: string): void {
  remove(installationFile(dir));
  remove(keyFile(dir));
  remove(stateFile(dir));
  remove(attemptFile(dir));
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
