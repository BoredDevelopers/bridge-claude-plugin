/**
 * SOURCE: Claude Code plugin `claude-channel-bridge` 0.26.2 (commit c8b0db6),
 * `lock-decision.ts` (repo root, not auth/core — S1.2 extracts it separately, per
 * the plan). BYTE-IDENTICAL below the marker: pure, no fs, nothing Claude-specific,
 * so no adaptation was needed. RFC-018 D10's CI byte-identity requirement names only
 * auth/core, but this file is guarded the same way anyway — see
 * `test/byte-identity.test.ts` and `fixtures/plugin-core/lock-decision.ts`.
 */
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
export declare const DEFAULT_HOLDER_VERSION = "0.25.0";
export declare function decideLock(holder: LockHolder | null, me: {
    version: string;
}, opts?: {
    takeover?: boolean;
}): LockDecision;
