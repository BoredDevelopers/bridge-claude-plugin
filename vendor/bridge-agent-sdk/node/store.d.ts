import type { CredentialStore, CursorStore } from "../runtime/store";
/**
 * `dir` (0700, created on first write) holds one profile's whole credential —
 * see the module header for the file layout and the D8 "one unit" rule.
 */
export declare function fileStore(dir: string): CredentialStore;
/** The WS replay cursor, persisted so it survives a restart — a plain text file, not
 * fsync-durable (losing the very last write only costs one extra redelivery, which
 * the dedupe layer already absorbs; RFC-016 E5's crash-safety is for credentials only). */
export declare function fileCursorStore(dir: string): CursorStore;
/** Remove this store's own leftover temp files (a crash between write and rename can
 * hold the PRIVATE KEY) — best-effort housekeeping a caller runs once when it opens a
 * profile. Never touches a file that isn't one of writeAtomic's own tmp names. */
export declare function sweepOrphanTemps(dir: string, minAgeMs?: number): number;
