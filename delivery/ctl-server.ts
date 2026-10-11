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
 * reporting). The socket is 0600 in a 0700 directory.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Socket, UnixSocketListener } from "bun";
import { parseCtlRequest, type CtlResponse } from "./ctl-protocol";
import { MissedTracker } from "./missed";
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
}

export interface CtlStats {
  /** Last time any hook reached this socket (ms), or null: hooks not reporting. */
  lastHookAt: number | null;
  /** Entries a hook confirmed in this process. */
  confirmed: number;
}

export interface CtlServer {
  path: string;
  stats(): CtlStats;
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
  try {
    const dir = dirname(o.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    if (existsSync(o.path)) {
      if (await socketAnswers(o.path)) {
        o.log(`bridge delivery: control socket ${o.path} is served by another process; hook confirmations off`);
        return null;
      }
      unlinkSync(o.path);
    }
    listener = Bun.listen<{ buf: string }>({
      unix: o.path,
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
    chmodSync(o.path, 0o600);
  } catch (err) {
    o.log(`bridge delivery: control socket not started (hook confirmations off): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  return {
    path: o.path,
    stats: () => ({ ...stats }),
    stop() {
      try {
        listener.stop(true);
      } catch {}
      try {
        unlinkSync(o.path);
      } catch {}
    },
  };
}

/**
 * Remove control sockets of Claude processes that are gone. Only `c<pid>.sock` /
 * `c<pid>-<tag>.sock` in that directory, only for a dead pid. Never throws.
 */
export function sweepStaleCtlSockets(dir: string, pidAlive: (pid: number) => boolean): number {
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      const m = /^c(\d+)(?:-[0-9a-f]{12})?\.sock$/.exec(name);
      if (!m || pidAlive(Number(m[1]))) continue;
      try {
        unlinkSync(join(dir, name));
        removed++;
      } catch {}
    }
  } catch {}
  return removed;
}
