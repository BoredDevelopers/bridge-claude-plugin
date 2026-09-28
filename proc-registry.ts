/**
 * The process registry (RFC-017 D2): every Bridge plugin process on the machine writes
 * `~/.claude/channels/bridge/procs/<pid>.json` describing itself, so a person (or a
 * future `status` / `/bridge:update`, D9) can answer "where is the other window" — the
 * question the RFC-016 rollout could not answer (see the RFC's §1, item 3).
 *
 * Liveness is pid + procStart — the SAME guard server.ts's session lock uses
 * (`holderIsLive`): a dead pid, or a live pid that is now someone else entirely (reuse),
 * is stale and is swept on `list()`, never returned. An empty recorded `procStart` is
 * unverifiable and therefore treated as NOT live, exactly like the session lock.
 *
 * D8: a record whose declared `format` is higher than PROC_FORMAT was written by a
 * newer plugin — `list()` skips it (neither sweeps it nor reports it as this build's
 * business to interpret) rather than delete or "repair" it.
 *
 * fs / the clock / pid-liveness are one object each so tests can inject failures, a
 * fake time or fake processes — ESM namespace imports cannot be spied on. Same idiom as
 * auth/node/store.ts's `__io` and auth/node/lock.ts's `__lockIo`; production never
 * replaces them. Each module owns its own liveness check rather than importing
 * server.ts's (server.ts has no exports and runs top-level side effects) — the same
 * shape test/fixtures/v024/lock.ts and server.ts already duplicate independently.
 */
import { mkdirSync, writeFileSync, renameSync, unlinkSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

export type ProcState = "connected" | "standby" | "superseded" | "disconnected";

/** What THIS process knows about itself; `writeProc` adds `format` and stamps `startedAt` from the clock. */
export interface ProcInfo {
  pid: number;
  /** `ps -o lstart= -p <pid>` at write time — "" if `ps` is unavailable (e.g. Windows). */
  procStart: string;
  software: "bridge-claude-plugin";
  version: string;
  sessionKey: string;
  profile: string;
  /** The Claude Code CLI process that owns this MCP server, or null (headless / not found). */
  claudePid: number | null;
  /** "" when unknown (no `ps`, or claudePid is null) — never a signal to sweep anything. */
  tty: string;
  /** From `TERM_PROGRAM`; "" if unset. */
  termProgram: string;
  /** `CLAUDE_PROJECT_DIR` — NEVER `process.cwd()`, which is the plugin root (D2). */
  cwd: string;
  state: ProcState;
}

export interface ProcRecord extends ProcInfo {
  format: number;
  startedAt: string;
}

/** `listProcs`'s own addition — never written to disk. `false` means `ps`/procStart could
 * not confirm this record's pid is still the SAME process (missing at write time, or `ps`
 * unavailable right now, e.g. Windows): still listed (never swept on a guess), but flagged
 * so a caller (`status`, D9) can say so rather than assert it as fact. */
export interface ListedProc extends ProcRecord {
  verified: boolean;
}

/** The highest format this build knows how to interpret. */
export const PROC_FORMAT = 0;

export function procsDir(stateDir: string): string {
  return join(stateDir, "procs");
}

function procFile(stateDir: string, pid: number): string {
  return join(procsDir(stateDir), `${pid}.json`);
}

/** The syscalls, one object so tests can inject failures. Production never replaces them. */
export const __io = { mkdirSync, writeFileSync, renameSync, unlinkSync, readdirSync, readFileSync };

/** Same semantics as server.ts's pidAlive: EPERM means it exists but belongs to someone else — alive. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Same semantics as server.ts's procStartOf: "" when it cannot be determined. */
export function procStartOf(pid: number): string {
  try {
    const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
    return r.success ? new TextDecoder().decode(r.stdout).trim() : "";
  } catch {
    return "";
  }
}

/** Injected for tests; production calls the real pidAlive / procStartOf above. */
export const __ps = { pidAlive, procStartOf };

/** Injected for tests (a fake `startedAt`); production is the real clock. */
export const __clock = { now: () => Date.now() };

/**
 * Write (or replace) this process's own record — 0600, tmp + rename, in the existing
 * 0700 state dir. `startedAt` is stamped from `__clock` here, not passed in: this IS the
 * moment this process registers itself. Best-effort, like every other store here: this
 * is telemetry, and a disk problem writing it must never take Bridge down.
 */
export function writeProc(stateDir: string, info: ProcInfo): void {
  try {
    const dir = procsDir(stateDir);
    __io.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = procFile(stateDir, info.pid);
    const tmp = `${target}.${info.pid}.tmp`;
    const record: ProcRecord = { format: PROC_FORMAT, ...info, startedAt: new Date(__clock.now()).toISOString() };
    __io.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    __io.renameSync(tmp, target);
  } catch {}
}

/**
 * Patch this process's own `state` in place (D2: `connected` | `standby` | `superseded` |
 * `disconnected`). A no-op if the record is gone (a shutdown raced it) or if it somehow
 * declares a format newer than this build's own write — D8: never rewrite that.
 *
 * Wiring the ACTUAL state transitions (lock acquired -> connected, duplicate -> standby,
 * superseded -> superseded) is P3/P4's job; this is the primitive they call.
 */
export function updateProcState(stateDir: string, pid: number, state: ProcState): void {
  const target = procFile(stateDir, pid);
  try {
    const existing = JSON.parse(__io.readFileSync(target, "utf8"));
    const format = typeof existing.format === "number" ? existing.format : 0;
    if (format > PROC_FORMAT) return; // D8: not ours to rewrite
    const tmp = `${target}.${pid}.tmp`;
    __io.writeFileSync(tmp, JSON.stringify({ ...existing, state }, null, 2) + "\n", { mode: 0o600 });
    __io.renameSync(tmp, target);
  } catch {}
}

/** Remove this process's own record. A no-op if it is already gone. */
export function removeProc(stateDir: string, pid: number): void {
  try {
    __io.unlinkSync(procFile(stateDir, pid));
  } catch {}
}

const PROC_FILE_RE = /^(\d+)\.json$/;

/**
 * Every OTHER live-OR-UNVERIFIABLE Bridge process on the machine. Stale entries — a dead
 * pid, or a reused one (same number, different process, caught by a procStart mismatch
 * that `ps` could actually compute) — are swept, never returned. A record at a newer
 * format is left exactly as found: not swept, not reported (this build cannot safely
 * interpret it). An UNVERIFIABLE one (see `checkLive`) is neither: it is listed with
 * `verified: false` rather than guessed at in either direction.
 */
export function listProcs(stateDir: string, excludePid?: number): ListedProc[] {
  const dir = procsDir(stateDir);
  let names: string[];
  try {
    names = __io.readdirSync(dir);
  } catch {
    return [];
  }
  const out: ListedProc[] = [];
  for (const name of names) {
    const m = PROC_FILE_RE.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === excludePid) continue;
    const path = join(dir, name);
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(__io.readFileSync(path, "utf8"));
    } catch {
      // Corrupt garbage, not a newer plugin's valid record (that case is the `format`
      // check below) — this file holds no credential, so cleaning it up is pure
      // housekeeping, same as sweeping a dead pid's.
      try {
        __io.unlinkSync(path);
      } catch {}
      continue;
    }
    const format = typeof rec.format === "number" ? rec.format : 0;
    if (format > PROC_FORMAT) continue; // D8: not ours to sweep or to interpret
    const verdict = checkLive(pid, rec);
    if (verdict === "dead") {
      try {
        __io.unlinkSync(path);
      } catch {}
      continue;
    }
    out.push({ ...(rec as unknown as ProcRecord), verified: verdict === "live" });
  }
  return out;
}

type LiveVerdict = "live" | "dead" | "unverifiable";

/**
 * "dead" only when BOTH sides of the identity check actually compared and disagreed — a
 * pid that is gone, or one that is alive but provably someone else (procStart mismatch).
 * Finding 11d: when `ps`/procStart cannot be computed at all — the record's OWN
 * `procStart` was empty (written where `ps` was unavailable), or `__ps.procStartOf(pid)`
 * returns "" right now (e.g. Windows, or a `ps`-less PATH) — that is neither "live" nor
 * "dead", it is UNVERIFIABLE: sweeping it would be a guess, and the exact guess that could
 * make a real, live window vanish from `status` merely because `ps` failed once.
 */
function checkLive(pid: number, rec: Record<string, unknown>): LiveVerdict {
  if (!__ps.pidAlive(pid)) return "dead";
  const recordedStart = typeof rec.procStart === "string" ? rec.procStart : "";
  const currentStart = __ps.procStartOf(pid);
  if (!recordedStart || !currentStart) return "unverifiable";
  return currentStart === recordedStart ? "live" : "dead";
}
