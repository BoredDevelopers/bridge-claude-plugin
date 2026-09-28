/**
 * RFC-017 D3 — who wins a contested session lock. Pure (no fs, no process, no clock):
 * server.ts's `acquireSessionLock` is the only caller, and hands it the lock file's
 * current holder (or `null`) plus this process's own version; this module only decides,
 * it never reads or writes anything. Kept dependency-free like reconnect-policy.ts and
 * the server's own `client-versions.ts`, so the three rules below are unit-testable with
 * nothing on disk.
 *
 * The three rules (RFC-017 D3, "Decided" 2026-09-27):
 * - An older version never takes over from a newer one — the auto path never downgrades.
 * - Equal versions stand by, same as today.
 * - A missing holder version counts as 0.25 or older (every lock record before this RFC
 *   had no `version` field at all).
 * - An explicit `takeover` always wins, even onto an older version (Q1: the person's own
 *   choice) — it is the ONE escape hatch from the first rule.
 */

export type LockDecision = "acquire" | "takeover" | "standby";

/** Just enough of the lock record for the decision — an old (≤ 0.25) record has no `version` at all. */
export interface LockHolder {
  version?: string;
}

/** Every lock record before this RFC predates `version` entirely — D3 treats that as this. */
export const DEFAULT_HOLDER_VERSION = "0.25.0";

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function parse(v: string): [number, number, number] | null {
  const m = VERSION_RE.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Missing OR unparseable both fall back to DEFAULT_HOLDER_VERSION — a parse bug must never miscompare. */
function normalize(v: string | undefined): [number, number, number] {
  return (v !== undefined ? parse(v) : null) ?? parse(DEFAULT_HOLDER_VERSION)!;
}

/** -1 / 0 / 1, `x.y.z` only (the plugin's own version is a plain semver triple — version-sync.test.ts). */
function compare(a: string | undefined, b: string | undefined): number {
  const [am, an, ap] = normalize(a);
  const [bm, bn, bp] = normalize(b);
  if (am !== bm) return am - bm;
  if (an !== bn) return an - bn;
  return ap - bp;
}

export function decideLock(holder: LockHolder | null, me: { version: string }, opts: { takeover?: boolean } = {}): LockDecision {
  if (!holder) return "acquire";
  if (opts.takeover) return "takeover"; // the person's explicit choice always wins (Q1)
  // A version PRESENT but unparseable is never trusted as older OR newer: the auto path
  // must not guess, because guessing wrong in the "newer" direction is exactly the
  // downgrade D3's first rule forbids. This is NOT the same as a MISSING version — D3
  // treats an absent field as 0.25 or older (below) precisely because every pre-RFC-017
  // record lacks the field entirely, a known, safe shape; a present-but-garbled one could
  // be anything, including a future format this build cannot read.
  if (holder.version !== undefined && parse(holder.version) === null) return "standby";
  return compare(me.version, holder.version) > 0 ? "takeover" : "standby";
}
