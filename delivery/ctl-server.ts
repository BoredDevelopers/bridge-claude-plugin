/**
 * The MCP-server end of the control socket (RFC-027 D7; grammar in
 * `ctl-protocol.ts`, the hook in `hooks/delivery.ts`).
 *
 * It confirms an entry ONLY if this process holds it pending (`PendingPort`,
 * backed by the SDK's `Pending`), so a prompt that merely quotes a tag, or a hook
 * of another session that found this socket, cannot light ✓✓ on anything this
 * session was not given. It keeps the turn state the missed rule needs and
 * answers each prompt with the missed notice, if any.
 *
 * Opening never fails the session: a socket that cannot open is logged, and the
 * session runs without hook confirmations (status then says hooks are not
 * reporting). The socket is 0600 in a 0700 directory that is verified (lstat, own uid,
 * mode 700) before anything is bound — see `private-dir.ts`.
 *
 * Who serves the path: the hook finds the socket by Claude's pid alone, so two plugin
 * copies in one Claude contend for it. The copy that holds the session lock passes
 * `takeover` and binds regardless; any other copy yields (and `status` says why).
 *
 * Bun must never own the PUBLIC path: `Bun.listen` unlinks its path on stop, whoever
 * owns it by then. So the listener binds at a private temp name in the same 0700
 * directory (`<path>.tmp-<pid>-<rand>`), is chmod 0600 there, and is then `rename`d onto
 * the public path — atomic, replacing an older socket without an unlink window, and never
 * visible with a wider mode. `stop()` removes the public path only if it is still the
 * file WE created (same inode/device), so an old process exiting after a newer one
 * bound the path cannot delete the newer socket.
 */
import { chmodSync, lstatSync, readdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Socket, UnixSocketListener } from "bun";
import { parseCtlRequest, type CtlResponse } from "./ctl-protocol";
import { MissedTracker } from "./missed";
import { checkPrivateDir, ensurePrivateDir } from "./private-dir";
import { missedNotice, type NoticeEntry } from "./notice";

/** What the control socket needs from the SDK's pending set. */
export interface PendingPort<E extends { id: string }> {
  list(): readonly E[];
  /** Confirms (ack how:"model") only ids held pending; returns those it confirmed. */
  confirm(ids: readonly string[]): readonly string[];
}

export interface CtlServerOptions<E extends { id: string }> {
  path: string;
  pending: PendingPort<E>;
  tracker: MissedTracker<E>;
  toNotice: (entry: E) => NoticeEntry;
  now?: () => number;
  log: (line: string) => void;
  /** Bind even if another process answers on the path (the session-lock holder). */
  takeover?: boolean;
}

/** Why no socket is open — `status` names it; "the pid was not found" is a different cause. */
export type CtlFailure =
  | { kind: "served-elsewhere"; detail: string }
  | { kind: "unsafe-dir"; detail: string }
  | { kind: "failed"; detail: string };

export type CtlOpen = { server: CtlServer; failure?: undefined } | { server: null; failure: CtlFailure };

export interface CtlStats {
  /** Last time any hook reached this socket (ms), or null: hooks not reporting. */
  lastHookAt: number | null;
  /** Entries a hook confirmed in this process. */
  confirmed: number;
}

export interface CtlServer {
  path: string;
  stats(): CtlStats;
  /** Is the public path still the socket this server created? "replaced": another process bound it since. */
  ownership(): "ours" | "replaced" | "gone";
  stop(): void;
}

const MAX_LINE = 4096;

/** Probe an existing socket file: is a live server behind it? */
function socketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 300);
    Bun.connect({
      unix: path,
      socket: {
        open(s) {
          clearTimeout(timer);
          s.end();
          resolve(true);
        },
        error() {
          clearTimeout(timer);
          resolve(false);
        },
        data() {},
      },
    }).catch(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function startCtlServer<E extends { id: string }>(o: CtlServerOptions<E>): Promise<CtlServer | null> {
  return (await openCtlServer(o)).server;
}

export async function openCtlServerWithRetry<E extends { id: string }>(
  o: CtlServerOptions<E>,
  delaysMs: readonly number[],
  stop: () => boolean = () => false,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<CtlOpen> {
  let res = await openCtlServer(o);
  for (const ms of delaysMs) {
    if (res.server || res.failure.kind !== "served-elsewhere" || stop()) break;
    await sleep(ms);
    if (stop()) break;
    res = await openCtlServer(o);
  }
  return res;
}

export async function openCtlServer<E extends { id: string }>(o: CtlServerOptions<E>): Promise<CtlOpen> {
  const now = o.now ?? Date.now;
  const stats: CtlStats = { lastHookAt: null, confirmed: 0 };

  const handle = (line: string): CtlResponse => {
    const req = parseCtlRequest(line);
    if (!req) return { ok: false, error: "bad request" };
    stats.lastHookAt = now();
    switch (req.op) {
      case "stop":
        o.tracker.stopped(now());
        return { ok: true, op: "stop" };
      case "pending":
        return { ok: true, op: "pending", entries: o.pending.list().map(o.toNotice) };
      case "prompt": {
        let confirmed = false;
        if (req.id) {
          confirmed = o.pending.confirm([req.id]).includes(req.id);
          if (confirmed) {
            o.tracker.settled(req.id);
            stats.confirmed++;
          }
        }
        const split = o.tracker.prompt(o.pending.list(), now());
        const context = missedNotice(split.fresh.map(o.toNotice), split.outstanding.map(o.toNotice));
        return { ok: true, op: "prompt", confirmed, context };
      }
    }
  };

  let listener: UnixSocketListener<{ buf: string }>;
  let mine: { ino: number; dev: number } | null = null;
  const tmp = `${o.path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 6)}`;
  try {
    const dir = dirname(o.path);
    const safe = ensurePrivateDir(dir);
    if (!safe.ok) {
      o.log(`bridge delivery: control socket not started — ${safe.reason}; hook confirmations off`);
      return { server: null, failure: { kind: "unsafe-dir", detail: safe.reason } };
    }
    if (!o.takeover && lstatOrNull(o.path) && (await socketAnswers(o.path))) {
      o.log(`bridge delivery: control socket ${o.path} is served by another process; hook confirmations off`);
      return { server: null, failure: { kind: "served-elsewhere", detail: o.path } };
    }
    listener = Bun.listen<{ buf: string }>({
      unix: tmp,
      socket: {
        open(s) {
          s.data = { buf: "" };
        },
        data(s: Socket<{ buf: string }>, chunk) {
          s.data.buf += chunk.toString();
          if (s.data.buf.length > MAX_LINE) return void s.end();
          const nl = s.data.buf.indexOf("\n");
          if (nl < 0) return;
          let res: CtlResponse;
          try {
            res = handle(s.data.buf.slice(0, nl));
          } catch (err) {
            o.log(`bridge delivery: control request failed: ${err instanceof Error ? err.message : String(err)}`);
            res = { ok: false, error: "internal" };
          }
          s.write(JSON.stringify(res) + "\n");
          s.end();
        },
      },
    });
    chmodSync(tmp, 0o600);
    const st = lstatSync(tmp);
    mine = { ino: st.ino, dev: st.dev };
    renameSync(tmp, o.path);
  } catch (err) {
    try {
      listener!?.stop(true);
    } catch {}
    try {
      unlinkSync(tmp);
    } catch {}
    const detail = err instanceof Error ? err.message : String(err);
    o.log(`bridge delivery: control socket not started (hook confirmations off): ${detail}`);
    return { server: null, failure: { kind: "failed", detail } };
  }

  const ownership = (): "ours" | "replaced" | "gone" => {
    const cur = lstatOrNull(o.path);
    if (!cur) return "gone";
    return mine && cur.ino === mine.ino && cur.dev === mine.dev ? "ours" : "replaced";
  };

  return {
    server: {
      path: o.path,
      stats: () => ({ ...stats }),
      ownership,
      stop() {
        // Bun unlinks only the temp name, which the rename already moved away.
        try {
          listener.stop(true);
        } catch {}
        if (ownership() === "ours") {
          try {
            unlinkSync(o.path);
          } catch {}
        }
      },
    },
  };
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Remove control sockets of Claude processes that are gone, and temp sockets of plugin
 * processes that died mid-bind. Only `c<pid>.sock` / `c<pid>-<tag>.sock` (dead Claude pid)
 * and their `.tmp-<pid>-<rand>` forms (dead plugin pid) in that directory. Never throws.
 */
export function sweepStaleCtlSockets(dir: string, pidAlive: (pid: number) => boolean): number {
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      const m = /^c(\d+)(?:-[0-9a-f]{8,12})?\.sock(?:\.tmp-(\d+)-[0-9a-f]{1,4})?$/.exec(name);
      // A temp name is judged by the PLUGIN process that bound it; a socket by Claude's pid.
      if (!m || pidAlive(Number(m[2] ?? m[1]))) continue;
      try {
        unlinkSync(join(dir, name));
        removed++;
      } catch {}
    }
  } catch {}
  return removed;
}

/**
 * Startup housekeeping for the control sockets, in every directory this process may have
 * used: `<state>/ctl` and the per-user shared-tmp fallback. The shared one is swept only if
 * it passes the same ownership check as for binding (never unlink inside a directory that is
 * not ours alone). Returns how many files were removed. Never throws.
 */
export function sweepCtlDirs(dirs: readonly string[], pidAlive: (pid: number) => boolean): number {
  let removed = 0;
  for (const dir of new Set(dirs)) {
    if (lstatOrNull(dir) && !checkPrivateDir(dir).ok) continue;
    removed += sweepStaleCtlSockets(dir, pidAlive);
  }
  return removed;
}

/**
 * The 0.30.0 fallback directory (`einweave-ctl-<uid>` in tmp, renamed `ew-ctl-<uid>`): remove it
 * if it is ours, private, and holds nothing but sockets of dead processes. Anything else in it
 * (or a live socket) and it is left alone. Never throws.
 */
export function removeLegacyCtlDir(tmpRoot: string, pidAlive: (pid: number) => boolean): boolean {
  const dir = join(tmpRoot, `einweave-ctl-${process.getuid?.() ?? "user"}`);
  try {
    if (!lstatOrNull(dir) || !checkPrivateDir(dir).ok) return false;
    sweepStaleCtlSockets(dir, pidAlive);
    rmdirSync(dir); // fails (and is ignored) unless it is empty now
    return true;
  } catch {
    return false;
  }
}
