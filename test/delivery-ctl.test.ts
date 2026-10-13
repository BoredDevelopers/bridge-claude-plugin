/**
 * RFC-027 D7 — the control socket end to end: the REAL hook process
 * (hooks/delivery.ts) against the REAL control server (delivery/ctl-server.ts),
 * with a fake pending set and a hand-driven clock. This is the seam where a
 * prompt becomes a confirmation and a missed entry becomes a notice.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync, chmodSync, symlinkSync, realpathSync, readdirSync, unlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { ctlSocketPath } from "../delivery/ctl-path";
import { startCtlServer, openCtlServer, sweepStaleCtlSockets, sweepCtlDirs, removeLegacyCtlDir, type CtlServer } from "../delivery/ctl-server";
import { checkPrivateDir } from "../delivery/private-dir";
import { MissedTracker } from "../delivery/missed";
import type { NoticeEntry } from "../delivery/notice";

const HOOK = join(import.meta.dir, "..", "hooks", "delivery.ts");
const PID = 515151;
const A = "01992f6e-7c1a-7b2e-9f00-00000000000a";
const B = "01992f6e-7c1a-7b2e-9f00-00000000000b";
const THREAD = "01992f6e-0000-7000-8000-0000000000f1";
const TAG = (id: string) =>
  `<channel source="plugin:einweave:einweave" channel_id="01992f6e-0000-7000-8000-000000000001" message_id="${id}" sender="alice" type="text">\nbody of ${id}\n</channel>`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

type Entry = NoticeEntry & { content: string };

function setup() {
  const dir = mkdtempSync(join("/tmp", "ewc-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let clock = 0;
  const held = new Map<string, Entry>();
  const confirmCalls: string[][] = [];
  const tracker = new MissedTracker<Entry>();
  const logs: string[] = [];
  const push = (id: string) => {
    held.set(id, { id, kind: "message", type: "question", channelName: "general", threadId: THREAD, senderHandle: "alice", content: `SECRET ${id}` });
    tracker.pushed(id, clock);
  };
  const start = () =>
    startCtlServer<Entry>({
      path: ctlSocketPath(dir, PID),
      pending: {
        list: () => [...held.values()],
        confirm: (ids) => {
          confirmCalls.push([...ids]);
          return ids.filter((id) => held.delete(id));
        },
      },
      tracker,
      toNotice: (e) => e,
      now: () => clock,
      log: (l) => logs.push(l),
    }).then((s) => {
      if (s) cleanups.push(() => s.stop());
      return s;
    });
  const hook = async (mode: string, prompt?: string) => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), EINWEAVE_STATE_DIR: dir, CLAUDE_PID: String(PID) };
    const proc = Bun.spawn(["bun", HOOK, mode], { stdin: "pipe", stdout: "pipe", env });
    proc.stdin.write(JSON.stringify({ hook_event_name: mode === "stop" ? "Stop" : "UserPromptSubmit", prompt }));
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out ? (JSON.parse(out).hookSpecificOutput.additionalContext as string) : null;
  };
  return { dir, held, confirmCalls, logs, push, start, hook, at: (t: number) => (clock = t) };
}

describe("control socket ⇄ hook", () => {
  test("a delivered entry is confirmed exactly once; nothing to say → the hook prints nothing", async () => {
    const t = setup();
    const srv = (await t.start())!;
    t.push(A);
    t.at(500);
    expect(await t.hook("prompt", TAG(A))).toBeNull();
    expect(t.confirmCalls).toEqual([[A]]);
    expect(t.held.has(A)).toBe(false);
    expect(srv.stats()).toMatchObject({ confirmed: 1, lastHookAt: 500 });
  });

  test("a confirmed entry that is redelivered later starts a fresh push (no stale idle push → no false notice)", async () => {
    const t = setup();
    await t.start();
    t.push(A); // idle at 0
    t.at(500);
    await t.hook("prompt", TAG(A)); // confirmed; a turn starts
    t.at(1000);
    t.push(A); // redelivered mid-turn (resume before the ack landed)
    t.at(6000);
    expect(await t.hook("prompt", "typed mid-tool")).toBeNull();
  });

  test("an id this process does not hold is not confirmed (quoted tag, another session's entry)", async () => {
    const t = setup();
    const srv = (await t.start())!;
    expect(await t.hook("prompt", TAG(B))).toBeNull();
    expect(srv.stats().confirmed).toBe(0);
  });

  test("idle push never delivered (no channels): full notice once, then a count, gone once read", async () => {
    const t = setup();
    await t.start();
    t.push(A);
    t.at(5000);
    const first = await t.hook("prompt", "what is new?");
    expect(first).toContain(`(id ${A}, thread ${THREAD}) — read_deliveries returns it`);
    expect(first).not.toContain("SECRET");
    t.at(9000);
    expect(await t.hook("prompt", "and now?")).toBe(
      "1 Bridge entry pushed earlier still unconfirmed (#general ×1); read_deliveries returns them.",
    );
    t.held.delete(A); // a read tool returned it (T5 wiring settles the tracker too)
    t.at(12000);
    expect(await t.hook("prompt", "ok")).toBeNull();
  });

  test("MEASURED: pushed mid-tool, a prompt typed mid-tool → no notice; after Stop → notice", async () => {
    const t = setup();
    await t.start();
    t.at(0);
    await t.hook("prompt", "do the thing"); // turn starts
    t.at(1000);
    t.push(B); // during a tool call
    t.at(5000);
    expect(await t.hook("prompt", "USERQ typed mid-tool")).toBeNull();
    t.at(20000);
    await t.hook("stop");
    t.at(23000);
    expect(await t.hook("prompt", "next")).toContain(B);
  });

  test("socket 0600 in a 0700 dir", async () => {
    const t = setup();
    const srv = (await t.start())!;
    expect(statSync(srv.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(t.dir, "ctl")).mode & 0o777).toBe(0o700);
  });

  test("a live server already on the path → this one stays off; a stale file is replaced", async () => {
    const t = setup();
    const first = (await t.start()) as CtlServer;
    expect(await t.start()).toBeNull();
    expect(t.logs.join("\n")).toContain("served by another process");
    first.stop();
    mkdirSync(join(t.dir, "ctl"), { recursive: true });
    writeFileSync(ctlSocketPath(t.dir, PID), ""); // a dead socket file
    expect(await t.start()).not.toBeNull();
  });

  test("a bad request is refused and does not count as a hook reporting", async () => {
    const t = setup();
    const srv = (await t.start())!;
    const res = await new Promise<string>((resolve) => {
      let buf = "";
      Bun.connect({
        unix: srv.path,
        socket: {
          open: (s) => void s.write('{"op":"confirm","ids":["x"]}\n'),
          data: (_s, c) => void (buf += c.toString()),
          close: () => resolve(buf),
        },
      });
    });
    expect(JSON.parse(res)).toEqual({ ok: false, error: "bad request" });
    expect(srv.stats().lastHookAt).toBeNull();
  });
});

describe("sweepStaleCtlSockets", () => {
  test("removes sockets of dead Claude pids and temp sockets of dead plugin pids only, and only our name shapes", () => {
    const dir = mkdtempSync(join("/tmp", "ews-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // [name, removed?] with pid 2 the only live one.
    const cases: Array<[string, boolean]> = [
      ["c1.sock", true],
      ["c2.sock", false],
      ["c3-0123abcd.sock", true],
      ["c9.sock.tmp-7-ab12", true], // bound by plugin pid 7, dead
      ["c9.sock.tmp-2-ab12", false], // bound by plugin pid 2, alive: mid-bind
      ["other.sock", false],
      ["c4.sock.bak", false],
      ["c4.sock.tmp-x-ab12", false],
    ];
    for (const [n] of cases) writeFileSync(join(dir, n), "");
    expect(sweepStaleCtlSockets(dir, (pid) => pid === 2)).toBe(cases.filter(([, r]) => r).length);
    expect(cases.map(([n]) => !existsSync(join(dir, n)))).toEqual(cases.map(([, r]) => r));
  });
});

/** A raw prompt request: does a live server answer on this path, and what does it say? */
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

function bare(path: string, log: string[] = []) {
  return {
    path,
    pending: { list: () => [] as Entry[], confirm: () => [] as string[] },
    tracker: new MissedTracker<Entry>(),
    toNotice: (e: Entry) => e,
    log: (l: string) => log.push(l),
  };
}

describe("the socket directory must be ours alone (S1)", () => {
  const LONG = "/" + "s".repeat(120);
  function withTmp() {
    const tmp = realpathSync(mkdtempSync(join("/tmp", "ewt-")));
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    cleanups.push(() => {
      if (prev === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prev;
      rmSync(tmp, { recursive: true, force: true });
    });
    return { tmp, fallback: join(tmp, `ew-ctl-${userInfo().uid}`) };
  }

  test("an absent fallback directory is created 0700 and used", async () => {
    const { fallback } = withTmp();
    const open = await openCtlServer(bare(ctlSocketPath(LONG, PID)));
    expect(open.server).not.toBeNull();
    cleanups.push(() => open.server?.stop());
    expect(statSync(fallback).mode & 0o777).toBe(0o700);
    expect((await ask(open.server!.path))?.ok).toBe(true);
  });

  for (const mode of [0o777, 0o755, 0o750]) {
    test(`a pre-created ${mode.toString(8)} fallback directory: refused, logged, no socket`, async () => {
      const { fallback } = withTmp();
      mkdirSync(fallback, { mode: 0o700 });
      chmodSync(fallback, mode);
      const log: string[] = [];
      const open = await openCtlServer(bare(ctlSocketPath(LONG, PID), log));
      expect(open.server).toBeNull();
      expect(open.failure?.kind).toBe("unsafe-dir");
      expect(log.join("\n")).toContain("not 700");
      expect(existsSync(ctlSocketPath(LONG, PID))).toBe(false);
    });
  }

  test("a symlinked fallback directory: refused, nothing is created in its target", async () => {
    const { tmp, fallback } = withTmp();
    const target = join(tmp, "elsewhere");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, fallback);
    const open = await openCtlServer(bare(ctlSocketPath(LONG, PID)));
    expect(open.failure?.kind).toBe("unsafe-dir");
    expect(readdirSync(target)).toEqual([]);
  });

  test("the primary <state>/ctl directory gets the same check (a 0777 one is refused)", async () => {
    const t = setup();
    mkdirSync(join(t.dir, "ctl"), { mode: 0o700 });
    chmodSync(join(t.dir, "ctl"), 0o777);
    expect(await t.start()).toBeNull();
    expect(t.logs.join("\n")).toContain("not 700");
  });

  test("checkPrivateDir: a directory owned by another uid fails", () => {
    const dir = mkdtempSync(join("/tmp", "ewu-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    chmodSync(dir, 0o700);
    expect(checkPrivateDir(dir)).toEqual({ ok: true });
    const bad = checkPrivateDir(dir, userInfo().uid + 1);
    expect(bad.ok).toBe(false);
  });
});

describe("who serves the socket (S5)", () => {
  test("an old process stopping after a new one bound the path does not delete the new socket", async () => {
    const t = setup();
    const path = ctlSocketPath(t.dir, PID);
    const oldOne = (await openCtlServer(bare(path))).server!;
    const newOne = (await openCtlServer({ ...bare(path), takeover: true })).server!;
    expect(newOne).not.toBeNull();
    // The renamed-in socket was bound by a different listener: the old one now serves nothing.
    expect(oldOne.ownership()).toBe("replaced");
    expect(newOne.ownership()).toBe("ours");
    oldOne.stop();
    expect(existsSync(path)).toBe(true);
    // A renamed unix socket accepts connects, and survives the old listener's stop (Bun 1.4.0).
    expect((await ask(path))?.ok).toBe(true);
    newOne.stop();
    expect(existsSync(path)).toBe(false);
  });

  test("the public path only ever holds a finished 0600 socket: nothing is left under a temp name", async () => {
    const t = setup();
    const srv = (await t.start())!;
    expect(statSync(srv.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(t.dir, "ctl")).filter((n) => n.includes(".tmp-"))).toEqual([]);
    srv.stop();
    expect(readdirSync(join(t.dir, "ctl"))).toEqual([]);
  });

  test("ownership: gone once the file is removed", async () => {
    const t = setup();
    const srv = (await t.start())!;
    unlinkSync(srv.path);
    expect(srv.ownership()).toBe("gone");
    srv.stop();
  });

  test("stop() still removes the socket it created", async () => {
    const t = setup();
    const srv = (await t.start())!;
    srv.stop();
    expect(existsSync(srv.path)).toBe(false);
  });

  test("another live process → failure names it; the session-lock holder takes over", async () => {
    const t = setup();
    const path = ctlSocketPath(t.dir, PID);
    const other = (await openCtlServer(bare(path))).server!;
    cleanups.push(() => other.stop());
    const refused = await openCtlServer(bare(path));
    expect(refused.failure?.kind).toBe("served-elsewhere");
    const taken = await openCtlServer({ ...bare(path), takeover: true });
    expect(taken.server).not.toBeNull();
    cleanups.push(() => taken.server?.stop());
    expect(taken.server!.stats().lastHookAt).toBeNull();
    await ask(path);
    expect(taken.server!.stats().lastHookAt).not.toBeNull();
    expect(other.stats().lastHookAt).toBeNull();
  });
});

describe("housekeeping of the socket directories (item 8) and the path's uid (item 9)", () => {
  const dead = () => false;
  function tmpRoot() {
    const r = realpathSync(mkdtempSync(join("/tmp", "ewh-")));
    cleanups.push(() => rmSync(r, { recursive: true, force: true }));
    return r;
  }
  const uid = process.getuid?.() ?? "user";

  test("sweepCtlDirs cleans BOTH directories — the state ctl dir and the private tmp fallback", () => {
    const r = tmpRoot();
    const a = join(r, "ctl");
    const b = join(r, `ew-ctl-${uid}`);
    for (const d of [a, b]) {
      mkdirSync(d, { mode: 0o700 });
      writeFileSync(join(d, "c11.sock"), "");
      writeFileSync(join(d, "c12-0123abcd.sock.tmp-13-ab12"), "");
    }
    expect(sweepCtlDirs([a, b, a], dead)).toBe(4);
    expect(readdirSync(a)).toEqual([]);
    expect(readdirSync(b)).toEqual([]);
  });

  test("sweepCtlDirs never unlinks inside a directory that is not ours alone (a 0777 shared one)", () => {
    const r = tmpRoot();
    const b = join(r, `ew-ctl-${uid}`);
    mkdirSync(b, { mode: 0o700 });
    chmodSync(b, 0o777);
    writeFileSync(join(b, "c11.sock"), "");
    expect(sweepCtlDirs([b], dead)).toBe(0);
    expect(readdirSync(b)).toEqual(["c11.sock"]);
  });

  test("the orphaned 0.30.0 einweave-ctl-<uid> dir is removed when ours, private and holding only dead sockets", () => {
    const r = tmpRoot();
    const old = join(r, `einweave-ctl-${uid}`);
    mkdirSync(old, { mode: 0o700 });
    writeFileSync(join(old, "c21-0123456789ab.sock"), "");
    expect(removeLegacyCtlDir(r, dead)).toBe(true);
    expect(existsSync(old)).toBe(false);
  });

  test("…and left alone when it holds anything else, a live socket, or is not private", () => {
    for (const setup of ["stranger", "live", "wide"] as const) {
      const r = tmpRoot();
      const old = join(r, `einweave-ctl-${uid}`);
      mkdirSync(old, { mode: 0o700 });
      writeFileSync(join(old, setup === "stranger" ? "notes.txt" : "c21-0123456789ab.sock"), "");
      if (setup === "wide") chmodSync(old, 0o777);
      expect(removeLegacyCtlDir(r, setup === "live" ? () => true : dead)).toBe(false);
      expect(existsSync(old)).toBe(true);
    }
  });

  test("ctlSocketPath uses process.getuid (no passwd lookup) and never throws without it", () => {
    const real = process.getuid;
    try {
      (process as any).getuid = undefined;
      const p = ctlSocketPath("/" + "x".repeat(120), 5);
      expect(p).toContain("/ew-ctl-user/");
      (process as any).getuid = () => 4242;
      expect(ctlSocketPath("/" + "x".repeat(120), 5)).toContain("/ew-ctl-4242/");
    } finally {
      (process as any).getuid = real;
    }
  });
});
