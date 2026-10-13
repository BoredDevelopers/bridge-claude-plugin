import type { CredentialStore, SeqStore } from "../runtime/store";
/**
 * `dir` (0700, created on first write) holds one profile's whole credential —
 * see the module header for the file layout and the D8 "one unit" rule.
 */
export declare function fileStore(dir: string): CredentialStore;
/**
 * Each grant's stored seq, one plain-text file per grant in `dir` (`<dir>/<grantId>`),
 * written atomically. Not fsync-durable: losing the very last write resumes a few frames
 * early, and the session's own dedupe absorbs the repeats (RFC-016 E5's crash-safety is
 * for credentials only). A grant id that is not path-safe is never stored or read.
 */
export declare function fileSeqStore(dir: string): SeqStore;
/** Remove this store's own leftover temp files (a crash between write and rename can
 * hold the PRIVATE KEY) — best-effort housekeeping a caller runs once when it opens a
 * profile. Never touches a file that isn't one of writeAtomic's own tmp names. */
export declare function sweepOrphanTemps(dir: string, minAgeMs?: number): number;
