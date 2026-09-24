/**
 * Credential files for one profile (RFC-014 §7.2). 0600 files written tmp+rename,
 * ONE FILE PER ITEM — never a shared blob (Claude Code #93537: a read-modify-write
 * of one blob by concurrent processes zeroes siblings). A keychain backend can
 * later implement the same functions.
 *
 *   <profile>/credentials.json          the installation (machine → agent)
 *   <profile>/sessions/<key>.json        one Claude session's refresh chain
 *
 * The access token is never written: it lives in memory, 1 h.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, statSync, rmSync } from "fs";
import { join } from "path";

export interface InstallationCredentials {
  apiUrl: string;
  installationId: string;
  installationToken: string;
  installationName?: string;
  enrolledAt?: number;
}

export interface SessionCredentials {
  sessionId: string;
  refreshToken: string;
  installationId: string;
}

const credentialsFile = (dir: string) => join(dir, "credentials.json");
const sessionsDir = (dir: string) => join(dir, "sessions");
export const sessionFileFor = (dir: string, key: string) =>
  join(sessionsDir(dir), `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  const dir = path.slice(0, path.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

export function readInstallation(dir: string): InstallationCredentials | null {
  const c = readJson<InstallationCredentials>(credentialsFile(dir));
  return c && typeof c.installationToken === "string" && typeof c.apiUrl === "string" && typeof c.installationId === "string"
    ? c
    : null;
}

export function writeInstallation(dir: string, c: InstallationCredentials): void {
  writeJson(credentialsFile(dir), c);
}

export function readSession(dir: string, key: string): SessionCredentials | null {
  const s = readJson<SessionCredentials>(sessionFileFor(dir, key));
  return s && typeof s.refreshToken === "string" && typeof s.sessionId === "string" ? s : null;
}

export function writeSession(dir: string, key: string, s: SessionCredentials): void {
  writeJson(sessionFileFor(dir, key), s);
}

export function deleteSession(dir: string, key: string): void {
  remove(sessionFileFor(dir, key));
}

/** Logout / installation revoked: the installation and every session under it. */
export function deleteProfileCredentials(dir: string): void {
  remove(credentialsFile(dir));
  try {
    rmSync(sessionsDir(dir), { recursive: true, force: true });
  } catch {}
}

/** Session files idle past the server's 7-day session idle are dead weight. */
export function sweepSessions(dir: string, keepFile: string, maxAgeMs: number): void {
  let names: string[];
  try {
    names = readdirSync(sessionsDir(dir));
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const n of names) {
    const p = join(sessionsDir(dir), n);
    if (p === keepFile) continue;
    try {
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    } catch {}
  }
}
