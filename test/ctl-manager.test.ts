/**
 * delivery/ctl-manager.ts — who serves the control socket, kept true over time: one open
 * in flight, a zombie (socket replaced by another process) detected and reported, the
 * lock holder taking the path over and re-binding after a handover, and a bounded retry
 * for a copy that does not hold the lock.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { ctlSocketPath } from "../delivery/ctl-path";
import { CtlManager } from "../delivery/ctl-manager";
import { openCtlServer, type CtlServerOptions } from "../delivery/ctl-server";
import { MissedTracker } from "../delivery/missed";

const PID = 616161;
type E = { id: string };
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(delays: number[] = [10, 10, 10, 10, 10, 10, 10, 10], watchMs = 60_000) {
  const dir = mkdtempSync(join("/tmp", "ewm-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = ctlSocketPath(dir, PID);
  const opts = (takeover = false): CtlServerOptions<E> => ({
    path,
    pending: { list: () => [], confirm: () => [] },
    tracker: new MissedTracker<E>(),
    toNotice: (e) => ({ id: e.id, kind: "message" }),
    log: () => {},
    ...(takeover ? { takeover: true } : {}),
  });
  let opens = 0;
  const manager = () => {
    const flag = { holds: false };
    const m = new CtlManager<E>({ options: (t) => (opens++, opts(t)), retryDelaysMs: delays, watchMs, holdsLock: () => flag.holds });
    cleanups.push(() => m.close());
    // The live lock is the test's to flip: `hold(true)` = this copy holds the session lock now.
    return Object.assign(m, { hold: (v: boolean) => void (flag.holds = v) });
  };
  return { dir, path, opts, manager, opens: () => opens };
}

function ask(path: string): Promise<any> {
  return new Promise((resolve) => {
    let buf = "";
    Bun.connect({
      unix: path,
      socket: {
        open: (s) => void s.write('{"op":"stop"}\n'),
        data: (_s, c) => void (buf += c.toString()),
        close: () => resolve(buf ? JSON.parse(buf) : null),
        error: () => resolve(null),
      },
    }).catch(() => resolve(null));
  });
}

const until = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !pred()) await Bun.sleep(10);
  return pred();
};

describe("CtlManager", () => {
  test("at most one open in flight: concurrent ensures open once, and leave one socket", async () => {
    const t = setup();
    const m = t.manager();
    m.hold(true);
    await Promise.all([m.ensure(), m.ensure(), m.ensure()]);
    expect(t.opens()).toBe(1);
    expect(m.current()).not.toBeNull();
    expect(readdirSync(join(t.dir, "ctl"))).toEqual([`c${PID}.sock`]);
  });

  test("a close that lands while an open is in flight adopts nothing: the late server is stopped, no file is left", async () => {
    const t = setup();
    mkdirSync(join(t.dir, "ctl"), { recursive: true, mode: 0o700 });
    writeFileSync(t.path, ""); // a dead socket file: the probe is asynchronous, so the open is genuinely in flight
    const m = t.manager();
    const opening = m.ensure();
    for (let i = 0; i < 5; i++) await Promise.resolve(); // the open has started and is parked on the probe's I/O
    expect(t.opens()).toBe(1);
    m.close();
    await opening;
    expect(m.current()).toBeNull();
    expect(readdirSync(join(t.dir, "ctl"))).toEqual([]);
  });

  test("a zombie is detected: another process took the path, so this one is dropped and says served-elsewhere", async () => {
    const t = setup();
    const a = t.manager();
    await a.ensure();
    expect(a.problem()).toBeNull();
    const b = t.manager();
    b.hold(true);
    await b.ensure();
    expect(b.current()).not.toBeNull();
    expect(a.current()).toBeNull();
    expect(a.problem()?.kind).toBe("served-elsewhere");
    expect((await ask(t.path))?.ok).toBe(true);
  });

  test("the REVIEWER CASE: A serving, newer B takes the path, B exits, A becomes the lock holder later → A re-binds", async () => {
    const t = setup();
    const a = t.manager();
    await a.ensure();
    const b = t.manager();
    b.hold(true);
    await b.ensure();
    expect(a.problem()?.kind).toBe("served-elsewhere");
    b.close(); // B exits and removes its socket
    a.hold(true);
    await a.ensure(); // A's Session authenticates via the standby retry
    expect(a.current()).not.toBeNull();
    expect(a.problem()).toBeNull();
    expect(a.current()!.stats().lastHookAt).toBeNull();
    expect((await ask(t.path))?.ok).toBe(true);
    expect(a.current()!.stats().lastHookAt).not.toBeNull();
  });

  test("a copy without the lock retries (bounded) and gets the socket once the other process is gone", async () => {
    const t = setup();
    const other = (await openCtlServer(t.opts())).server!;
    const m = t.manager();
    await m.ensure();
    expect(m.problem()?.kind).toBe("served-elsewhere");
    m.retry();
    await Bun.sleep(40);
    expect(m.current()).toBeNull();
    other.stop();
    expect(await until(() => m.current() !== null)).toBe(true);
    expect(m.problem()).toBeNull();
  });

  test("the retry is bounded: it gives up and stays served-elsewhere", async () => {
    const t = setup([10, 10]);
    const other = (await openCtlServer(t.opts())).server!;
    cleanups.push(() => other.stop());
    const m = t.manager();
    await m.ensure();
    const before = t.opens();
    m.retry();
    await Bun.sleep(300);
    expect(t.opens() - before).toBe(2);
    expect(m.problem()?.kind).toBe("served-elsewhere");
  });

  test("the lock holder RECLAIMS when the path stops being its own — on the next look", async () => {
    const t = setup();
    const holder = t.manager();
    holder.hold(true);
    await holder.ensure();
    const rogue = (await openCtlServer(t.opts(true))).server!; // a non-holder renames over the holder's socket
    cleanups.push(() => rogue.stop());
    expect(holder.current()).toBeNull(); // detected… (the reclaim is queued by the same look)
    expect(await until(() => rogue.ownership() === "replaced")).toBe(true); // …and taken back
    expect(holder.current()).not.toBeNull();
    expect(holder.problem()).toBeNull();
  });

  test("…and it looks by itself: an unref'd watch re-checks while the lock is held, with nobody asking", async () => {
    const t = setup(undefined, 25);
    const holder = t.manager();
    holder.hold(true);
    await holder.ensure();
    const rogue = (await openCtlServer(t.opts(true))).server!;
    cleanups.push(() => rogue.stop());
    expect(await until(() => rogue.ownership() === "replaced")).toBe(true); // no call into `holder` in between
    expect((await ask(t.path))?.ok).toBe(true);
  });

  test("M1: a SUPERSEDED copy (the live lock says it no longer holds) never reclaims, however many watch ticks pass", async () => {
    const t = setup(undefined, 20);
    const a = t.manager();
    a.hold(true);
    await a.ensure();
    const b = t.manager();
    b.hold(true);
    await b.ensure(); // B took the lock and the socket…
    a.hold(false); // …so A's live lock is gone: it was superseded
    await Bun.sleep(300); // many watch ticks
    expect(b.current()!.ownership()).toBe("ours"); // B kept the socket the whole time: no flapping
    expect(a.current()).toBeNull();
    expect(a.problem()?.kind).toBe("served-elsewhere");
    expect((await ask(t.path))?.ok).toBe(true);
    expect(b.current()!.stats().lastHookAt).not.toBeNull();
  });

  test("M1: the answer is read live — a copy that LOSES the lock stops reclaiming from that moment on", async () => {
    const t = setup(undefined, 20);
    const a = t.manager();
    a.hold(true);
    await a.ensure();
    const rogue = (await openCtlServer(t.opts(true))).server!;
    cleanups.push(() => rogue.stop());
    a.hold(false); // before the next tick looks
    await Bun.sleep(250);
    expect(rogue.ownership()).toBe("ours");
  });

  test("m5: a failure the holder cannot fix by waiting (an unsafe directory) is not retried by the watch, and logs once", async () => {
    const t = setup(undefined, 20);
    mkdirSync(join(t.dir, "ctl"), { mode: 0o700 });
    chmodSync(join(t.dir, "ctl"), 0o777);
    const lines: string[] = [];
    let opened = 0;
    const m = new CtlManager<E>({
      options: (tk) => (opened++, { ...t.opts(tk), log: (l) => lines.push(l) }),
      retryDelaysMs: [],
      watchMs: 20,
      holdsLock: () => true,
    });
    cleanups.push(() => m.close());
    await m.ensure();
    expect(m.problem()?.kind).toBe("unsafe-dir");
    await Bun.sleep(300);
    expect(opened).toBe(1); // the watch did not try again
    expect(lines).toHaveLength(1);
  });

  test("a copy WITHOUT the lock never reclaims: it records the loss and stays out", async () => {
    const t = setup(undefined, 25);
    const m = t.manager();
    await m.ensure();
    const rogue = (await openCtlServer(t.opts(true))).server!;
    cleanups.push(() => rogue.stop());
    expect(m.current()).toBeNull();
    await Bun.sleep(150);
    expect(rogue.ownership()).toBe("ours");
    expect(m.problem()?.kind).toBe("served-elsewhere");
  });

  test("a failure retrying cannot fix (an unsafe directory) is not retried", async () => {
    const t = setup();
    mkdirSync(join(t.dir, "ctl"), { mode: 0o700 });
    chmodSync(join(t.dir, "ctl"), 0o777);
    const m = t.manager();
    await m.ensure();
    expect(m.problem()?.kind).toBe("unsafe-dir");
    const before = t.opens();
    m.retry();
    await Bun.sleep(200);
    expect(t.opens()).toBe(before);
  });

  test("the lock holder never waits: it takes the path over from a live process at once", async () => {
    const t = setup();
    const other = (await openCtlServer(t.opts())).server!;
    cleanups.push(() => other.stop());
    const m = t.manager();
    await (m.hold(true), m.ensure());
    expect(m.current()).not.toBeNull();
    expect(other.ownership()).toBe("replaced");
  });
});
