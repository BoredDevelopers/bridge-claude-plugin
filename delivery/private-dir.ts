/**
 * The directory a control socket lives in must be ours alone. The hook prints what the
 * socket's `context` says into the model as `additionalContext`, so a socket served by
 * another local user would be a prompt-injection channel. When the state dir is too deep
 * for a socket path, the socket moves to `tmpdir()/ew-ctl-<uid>/` — a shared,
 * predictable place any other user can pre-create. Both ends therefore check it, with
 * `lstat` (never `stat`: a symlink must not pass for a directory), the same rule as the
 * agent SDK's feed-socket directory: a real directory, owned by this uid, mode 0700.
 */
import { lstatSync, mkdirSync } from "node:fs";

export type DirCheck = { ok: true } | { ok: false; reason: string };

export function checkPrivateDir(dir: string, uid: number | undefined = process.getuid?.()): DirCheck {
  let st;
  try {
    st = lstatSync(dir);
  } catch (err) {
    return { ok: false, reason: `${dir} cannot be inspected: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, reason: `${dir} is not a real directory` };
  if (uid !== undefined && st.uid !== uid) return { ok: false, reason: `${dir} is owned by uid ${st.uid}, not ${uid}` };
  if ((st.mode & 0o777) !== 0o700) return { ok: false, reason: `${dir} has mode ${(st.mode & 0o777).toString(8)}, not 700` };
  return { ok: true };
}

/** Create `dir` 0700 if absent, then verify it — an existing directory is accepted only if it already passes. */
export function ensurePrivateDir(dir: string): DirCheck {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return { ok: false, reason: `${dir} cannot be created: ${err instanceof Error ? err.message : String(err)}` };
  }
  return checkPrivateDir(dir);
}
