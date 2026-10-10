/**
 * RFC-027 D7 — the control socket end to end: the REAL hook process
 * (hooks/delivery.ts) against the REAL control server (delivery/ctl-server.ts),
 * with a fake pending set and a hand-driven clock. This is the seam where a
 * prompt becomes a confirmation and a missed entry becomes a notice.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ctlSocketPath } from "../delivery/ctl-path";
import { startCtlServer, sweepStaleCtlSockets, type CtlServer } from "../delivery/ctl-server";
import { MissedTracker } from "../delivery/missed";
import type { NoticeEntry } from "../delivery/notice";

const HOOK = join(import.meta.dir, "..", "hooks", "delivery.ts");
const PID = 515151;
const A = "01992f6e-7c1a-7b2e-9f00-00000000000a";
const B = "01992f6e-7c1a-7b2e-9f00-00000000000b";
const THREAD = "01992f6e-0000-7000-8000-0000000000f1";
const TAG = (id: string) =>
  `<channel source="plugin:bridge:bridge" channel_id="01992f6e-0000-7000-8000-000000000001" message_id="${id}" sender="alice" type="text">\nbody of ${id}\n</channel>`;

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
    expect(first).toContain(`(id ${A}, thread ${THREAD}) — read_thread("${THREAD}") returns it`);
    expect(first).not.toContain("SECRET");
    t.at(9000);
    expect(await t.hook("prompt", "and now?")).toBe(
      "1 Bridge entry pushed earlier still unconfirmed (#general ×1); list_threads and read_thread return them.",
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
  test("removes sockets of dead pids only, and only our name shapes", () => {
    const dir = mkdtempSync(join("/tmp", "ews-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const n of ["c1.sock", "c2.sock", "c3-0123456789ab.sock", "other.sock", "c4.sock.bak"]) writeFileSync(join(dir, n), "");
    expect(sweepStaleCtlSockets(dir, (pid) => pid === 2)).toBe(2);
    expect(["c1.sock", "c2.sock", "c3-0123456789ab.sock", "other.sock", "c4.sock.bak"].map((n) => existsSync(join(dir, n)))).toEqual([
      false,
      true,
      false,
      true,
      true,
    ]);
  });
});
