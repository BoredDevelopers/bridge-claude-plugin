/**
 * SOURCE: plugin c8b0db6 `format-guard.ts`. ADAPTED, not byte-identical: the `fs`
 * read (`readFileSync` + its try/catch) moved OUT — that half belongs to
 * `@bridge/agent-sdk/node`'s `fileStore` (S1.4), which is the only thing in this
 * package allowed to touch a filesystem. What is left here judges an
 * ALREADY-PARSED value, so it stays pure: `readVersioned(path)` became
 * `classifyVersioned(parsed)`, and the "missing/corrupt file → absent" case is now
 * the node adapter's job (a caller there passes `undefined`/a JSON-parse failure
 * through as it likes — this module only classifies what it's handed).
 *
 * D8 (RFC-016 origin) — the on-disk format guard for JSON files this and other
 * concurrently running SDK-consumer versions share (installation.json;
 * procs/*.json, P2). Each such file carries an optional numeric "format" field —
 * a MISSING field means format 0 (every file written before this existed).
 *
 * A reader that meets a format HIGHER than it knows must not delete, rewrite or
 * "repair" the file — it was written by a newer build, and touching it here could
 * destroy that window's credential (downgrade safety, D1 applied to disk). This
 * module only ANSWERS that question; each caller decides what "unusable" means
 * for it (the plugin's store.ts treats the whole installation as one unit; see its
 * own comments).
 */
/** The highest format this build understands. Bumped only by an RFC that changes structure. */
export declare const KNOWN_FORMAT = 0;
export type VersionedFile<T> = {
    kind: "ok";
    format: number;
    data: T;
} | {
    kind: "newer";
    format: number;
} | {
    kind: "absent";
};
/**
 * Judge an already-parsed JSON value by its "format" field. `parsed` is whatever
 * `JSON.parse` produced — a missing file, a read failure or a `JSON.parse` throw
 * are the CALLER's to turn into `{ kind: "absent" }` (the node adapter's
 * `fileStore` does exactly that, matching the plugin's original "never throws"
 * behaviour one layer up).
 */
export declare function classifyVersioned<T>(parsed: unknown, knownMax?: number): VersionedFile<T>;
/** True when `parsed` is a versioned value whose declared format is higher than `knownMax` — never touch it. */
export declare function isNewerFormat(parsed: unknown, knownMax?: number): boolean;
