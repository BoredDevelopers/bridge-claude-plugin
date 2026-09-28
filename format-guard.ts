/**
 * D8: the on-disk format guard for JSON files this and other concurrently running
 * plugin versions share (installation.json; procs/*.json, P2). Each such file carries
 * an optional numeric "format" field — a MISSING field means format 0 (every file
 * written before this existed, i.e. ≤ 0.25).
 *
 * A reader that meets a format HIGHER than it knows must not delete, rewrite or
 * "repair" the file — it was written by a newer plugin, and touching it here could
 * destroy that window's credential (downgrade safety, D1 applied to disk). This module
 * only ANSWERS that question; each caller decides what "unusable" means for it (store.ts
 * treats the whole installation as one unit; see its own comments).
 *
 * `state`, the connect-store and the label-store are bare scalars with no JSON
 * envelope and are NOT read through here — see their own modules for why they are
 * guarded differently (state: gated on installation.json's format, as part of the same
 * unit; connect-store: guarded by its own value's shape; label-store: not guarded, see
 * its header).
 */
import { readFileSync } from "fs";

/** The highest format this build understands. Bumped only by an RFC that changes structure. */
export const KNOWN_FORMAT = 0;

export type VersionedFile<T> =
  | { kind: "ok"; format: number; data: T }
  | { kind: "newer"; format: number }
  | { kind: "absent" };

/**
 * Read + parse a JSON file, honouring its "format" field. Never throws: a missing file
 * and a corrupt one both read as `absent` — exactly today's behaviour for every caller
 * here (a corrupt installation.json has always meant "not signed in").
 */
export function readVersioned<T>(path: string, knownMax: number = KNOWN_FORMAT): VersionedFile<T> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { kind: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "absent" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "absent" };
  const rawFormat = (parsed as { format?: unknown }).format;
  const format = typeof rawFormat === "number" && Number.isInteger(rawFormat) && rawFormat >= 0 ? rawFormat : 0;
  if (format > knownMax) return { kind: "newer", format };
  return { kind: "ok", format, data: parsed as T };
}

/** True when `path` holds a file whose declared format is higher than this build knows — never touch it. */
export function isNewerFormat(path: string, knownMax: number = KNOWN_FORMAT): boolean {
  return readVersioned(path, knownMax).kind === "newer";
}
