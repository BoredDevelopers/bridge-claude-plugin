/**
 * `@bridge/agent-sdk/node` — the Node/Bun adapter (RFC-018 D1/S1.4): `fileStore(dir)`
 * (+ `fileCursorStore(dir)`), the installation lock (`CredentialStore.withLock`'s
 * implementation), and `sessionLock(opts)` (the RFC-017 session lock, its ownership
 * rule, and its renewal). Everything here uses `node:*` modules only — never a
 * `Bun.` API (`test/node/no-bun-apis.test.ts` greps `src/**` for it), so this runs
 * unmodified on Node 24 and on Bun 1.3+. See `docs/RFC-018-agent-sdk-and-openclaw.md`.
 *
 * SIMPLIFY (review finding): `./node/proc-registry.ts` (`procRegistry`/`writeProc`/…)
 * is NOT re-exported here — nothing in this package's own public surface calls it (the
 * session lock has its own, separate liveness check), and no consumer has bound to it
 * yet (pre-prod). The module itself stays — it is still exercised directly by
 * `test/node/proc-registry.test.ts` — as an unexported building block a future "who
 * else is running" status surface can wire up without another public-API decision
 * being made for it now.
 */
export { fileStore, fileCursorStore, sweepOrphanTemps } from "./node/store";
export { withInstallationLock, sweepLockTombstones, type LockOptions, LOCK_DIR_NAME, STALE_MS, HOLD_BUDGET_MS, LOCK_WAIT_MS } from "./node/lock";
export { sessionLock, type SessionLockHandle, type SessionLockOptions, type SessionLockIdentity, type SessionLockDecision, type LockRecord, } from "./node/session-lock";
export { procStartOf, legacyProcStartOf, procStartMatches, pidAlive } from "./node/proc-start";
export { readVersioned } from "./node/format-guard";
export { hostname } from "./node/hostname";
export { feedServer, resolveFeedSocketPath, type FeedServer, type FeedServerOptions, type FeedPathOptions, type FeedHelloInfo, type FeedHistoryHandler, type FeedHistoryResult, } from "./node/feed-server";
export { feedClient, type FeedClient, type FeedClientOptions } from "./node/feed-client";
export { runTail, TAIL_ENTER, tailEnter, tailLeave, TAIL_LEAVE, type TailOptions, type TailResult, type TailInput, type TailOutput, type TailProcess, } from "./node/tail";
export { tailMain, parseTailArgs, TAIL_USAGE, type TailArgs } from "./node/tail-main";
