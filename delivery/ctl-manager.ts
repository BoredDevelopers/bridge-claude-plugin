/**
 * Who serves this session's control socket, kept true over time.
 *
 * Opening it once at startup is not enough: two plugin copies in one Claude contend for
 * the path, a /reload-plugins hands it from an old process to a new one, and a copy can
 * become the session-lock holder long after it started (the SDK's standby retry). So:
 *
 * - at most ONE open is ever in flight per process (opens are chained), and a server
 *   that is not adopted is stopped — no stray second listener;
 * - the server a process holds is re-verified (`ownership()`) whenever it is asked for:
 *   if another process bound the path since, ours is a zombie on an unlinked inode — it
 *   is stopped and `problem()` says "served elsewhere" (distinct from "no pid");
 * - the session-lock holder (asked of the LIVE lock, never cached; on lock acquire and on every
 *   authenticated) opens with `takeover`, so the socket always follows the lock;
 * - a copy that does not hold the lock retries a bounded number of times, so a handover
 *   from an exiting old process completes;
 * - the lock holder RECLAIMS: when it finds the path no longer its own (a non-holder renamed
 *   over it, or the file vanished) it re-opens with takeover, and it looks on its own — an
 *   unref'd interval while it holds the lock, not only when `status` is asked.
 */
import { openCtlServer, type CtlServer, type CtlFailure, type CtlServerOptions } from "./ctl-server";

export interface CtlManagerDeps<E extends { id: string }> {
  options(takeover: boolean): CtlServerOptions<E>;
  /** Waits between the background attempts of a copy that does not hold the lock. */
  retryDelaysMs: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /**
   * Does this process hold the session lock RIGHT NOW? Derived from the live lock and Session on
   * every ask — never cached: a Session the SDK stopped (superseded, revoked, standby) no longer
   * holds anything, and a stale "yes" would make two copies fight over the socket.
   */
  holdsLock(): boolean | Promise<boolean>;
  /** How often the lock holder re-checks that it still owns the path (default 30 s). */
  watchMs?: number;
}

export class CtlManager<E extends { id: string }> {
  private server: CtlServer | null = null;
  private failure: CtlFailure | null = null;
  private closed = false;
  private lastLog: string | null = null;
  private reclaimCount = 0;
  private retrying = false;
  private watch: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: CtlManagerDeps<E>) {}

  /** The socket this process really serves, or null. */
  current(): CtlServer | null {
    this.verify();
    return this.server;
  }

  /** How many times this process found the path no longer its own and took it back (a flap shows here). */
  reclaims(): number {
    return this.reclaimCount;
  }

  /** Why there is none (null when there is one, or nothing was attempted). */
  problem(): CtlFailure | null {
    this.verify();
    return this.failure;
  }

  /**
   * Make sure this process serves the socket if it may. Whether it may take the path over from a
   * live process is decided by the LIVE lock (`holdsLock`); `assumeHolder` is for the one moment
   * the lock was acquired but the Session object does not exist yet (openSession).
   */
  ensure(o: { assumeHolder?: boolean } = {}): Promise<void> {
    this.startWatch();
    const run = this.chain.then(() => this.open(o.assumeHolder === true));
    this.chain = run.catch(() => {});
    return run;
  }

  /** Background retries while another process serves the path. At most one loop. */
  retry(): void {
    if (this.retrying || this.closed) return;
    this.retrying = true;
    void (async () => {
      try {
        const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        for (const ms of this.d.retryDelaysMs) {
          if (this.closed || this.current() || this.failure?.kind !== "served-elsewhere" || (await this.d.holdsLock())) break;
          await sleep(ms);
          if (this.closed) break;
          await this.ensure();
        }
      } finally {
        this.retrying = false;
      }
    })();
  }

  private startWatch(): void {
    if (this.watch || this.closed) return;
    this.watch = setInterval(() => {
      void (async () => {
        if (this.closed || !(await this.d.holdsLock())) return; // a copy that does not hold the lock never reclaims
        if (this.server) this.verify(); // a lost path queues the reclaim itself
        // Nothing served while we hold the lock: try again whatever the failure was. A directory a
        // tmp cleaner removed, a transient rename error, an unsafe directory someone fixed — none of
        // them announces itself, and the hooks need this socket. Repeated identical failures are
        // logged once (open() dedupes), so the retry costs a syscall, not a log line.
        else await this.ensure();
      })().catch(() => {});
    }, this.d.watchMs ?? 30_000);
    this.watch.unref?.();
  }

  close(): void {
    this.closed = true;
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    this.server?.stop();
    this.server = null;
  }

  private verify(): void {
    if (!this.server) return;
    const owner = this.server.ownership();
    if (owner === "ours") return;
    const path = this.server.path;
    this.server.stop();
    this.server = null;
    this.failure =
      owner === "replaced"
        ? { kind: "served-elsewhere", detail: path }
        : { kind: "failed", detail: `control socket ${path} was removed` };
    // The lock holder is the copy the hooks must reach: take the path back (queued, so it never
    // overlaps an open in flight). Whether we are the holder is asked of the live lock.
    if (!this.closed) {
      void (async () => {
        if (await this.d.holdsLock()) {
          this.reclaimCount++;
          await this.ensure();
        }
      })().catch(() => {});
    }
  }

  private async open(assumeHolder: boolean): Promise<void> {
    if (this.closed) return;
    this.verify();
    if (this.server) return;
    const takeover = assumeHolder || (await this.d.holdsLock());
    const opts = this.d.options(takeover);
    // One line per distinct message: an open that keeps failing the same way is logged once.
    const res = await openCtlServer({
      ...opts,
      log: (line) => {
        if (line === this.lastLog) return;
        this.lastLog = line;
        opts.log(line);
      },
    });
    if (this.closed || this.server) {
      res.server?.stop();
      return;
    }
    this.server = res.server;
    this.failure = res.failure ?? null;
  }
}
