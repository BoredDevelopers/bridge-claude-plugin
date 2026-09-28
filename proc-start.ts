/**
 * A process's start time, for the pid-reuse check (session lock, proc registry,
 * session map): same pid AND same start time = the same process.
 *
 * ⚠️ `ps -o lstart` prints LOCAL time in the caller's locale: `TZ` and `LC_ALL`
 * change the string for the very same process ("Mon Sep 28 14:01:25 2026" under
 * TZ=UTC, "mån 28 sep. 16:01:25 2026" under a Swedish locale). Two windows whose
 * environments differ in either would read each other's LIVE holder as "a different
 * process" — dead — and both connect. So the string is NORMALIZED: `ps` always runs
 * with TZ=UTC and LC_ALL=C.
 *
 * Compatibility window (CLAUDE.md rule 1): windows on ≤ 0.26.0 wrote the reader's
 * LOCAL rendering. `procStartMatches` accepts either form until those are gone.
 */
function ps(pid: number, env: Record<string, string | undefined>): string {
  try {
    const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { env });
    return r.success ? new TextDecoder().decode(r.stdout).trim() : "";
  } catch {
    return "";
  }
}

/** Normalized start time of a live pid (what every writer records). "" if unknown. */
export function procStartOf(pid: number): string {
  return ps(pid, { ...process.env, TZ: "UTC", LC_ALL: "C" });
}

/** The pre-0.26.1 form: `ps` in this process's own environment. "" if unknown. */
export function legacyProcStartOf(pid: number): string {
  return ps(pid, process.env);
}

/**
 * Is `recorded` the start time of the process now running as `pid`? Accepts the
 * normalized form and, for records written by ≤ 0.26.0, the local one.
 * Only meaningful for a non-empty `recorded` (callers decide what empty means).
 */
export function procStartMatches(pid: number, recorded: string): boolean {
  if (!recorded) return false;
  return recorded === procStartOf(pid) || recorded === legacyProcStartOf(pid);
}
