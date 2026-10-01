/**
 * RFC-018 S1.4 — atomic-write primitives shared by the node adapter's stores.
 * ADAPTED from the plugin's `auth/node/store.ts` (its `writeAtomic`/`fsyncDir`/
 * `renameWithRetry`), generalised past ONE caller: `durable: true` keeps the
 * plugin's fsync-before-rename-before-fsync-directory order (RFC-016 E5: a
 * credential write must survive a crash in the right place), and everything
 * else here (the proc registry, the cursor file) skips the extra syscalls —
 * losing the very last write of either only costs a redundant redelivery or an
 * extra mint, never a corrupt credential.
 *
 * Node `fs` only — no runtime-spawning API of any kind, so nothing here needs
 * the grep guard's attention, but this file is still part of `src/node/**` and
 * therefore still subject to it (`test/node/no-bun-apis.test.ts`).
 */
import * as fs from "node:fs";
/** The mutating calls, as one object so tests can inject failures (ESM imports cannot be spied on). */
export declare const __fsIo: {
    openSync: typeof fs.openSync;
    writeSync: typeof fs.writeSync;
    fsyncSync: typeof fs.fsyncSync;
    closeSync: typeof fs.closeSync;
    renameSync: typeof fs.renameSync;
};
/** Synchronous sleep for the writers below (all synchronous, like the plugin's originals):
 * `Atomics.wait` on a private buffer — no timer, no Bun-only sleep API. */
export declare function sleepSync(ms: number): void;
export declare function removeQuiet(path: string): void;
/**
 * tmp (0600) → write → [fsync when `durable`] → rename → [fsync the directory when
 * `durable`]. A failure leaves no temp file behind.
 */
export declare function writeAtomic(path: string, content: string, opts?: {
    durable?: boolean;
}): void;
