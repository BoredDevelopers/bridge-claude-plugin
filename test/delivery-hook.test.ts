/**
 * RFC-027 D7 — hooks/delivery.ts as Claude Code runs it: a child process with the
 * hook payload on stdin and CLAUDE_PID in its environment, talking to a fake
 * control socket. It must fail open (exit 0, nothing on stdout) in every failure,
 * and write exactly one JSON object to stdout when — and only when — the server
 * hands it a notice.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync, chmodSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, dirname, basename } from "node:path";
import { ctlSocketPath } from "../delivery/ctl-path";

const HOOK = join(import.meta.dir, "..", "hooks", "delivery.ts");
const PID = 424242;
const ID = "01992f6e-7c1a-7b2e-9f00-1a2b3c4d5e6f";
const TAG = (id: string, source = "plugin:bridge:bridge") =>
  `<channel source="${source}" channel_id="01992f6e-0000-7000-8000-000000000001" message_id="${id}" sender="alice" type="text">\nhi\n</channel>`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function stateDir(): string {
  // Short on purpose: the direct `<state>/ctl/…` path, not the long-path fallback.
  const dir = mkdtempSync(join("/tmp", "ew-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake MCP-server side: records requests, answers with `reply(req)` (or never, if it returns undefined). */
function fakeServer(dir: string, reply: (req: any) => unknown) {
  const path = ctlSocketPath(dir, PID);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const requests: any[] = [];
  const server = Bun.listen({
    unix: path,
    socket: {
      data(s, chunk) {
        const req = JSON.parse(chunk.toString().trim());
        requests.push(req);
        const r = reply(req);
        if (r !== undefined) s.write(JSON.stringify(r) + "\n");
      },
    },
  });
  cleanups.push(() => server.stop(true));
  return { requests, path };
}

async function runHook(mode: string, opts: { dir: string; stdin?: string; pid?: string | null; tmp?: string }) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), EINWEAVE_STATE_DIR: opts.dir };
  if (opts.tmp) env.TMPDIR = opts.tmp;
  delete env.CLAUDE_PID;
  if (opts.pid !== null) env.CLAUDE_PID = opts.pid ?? String(PID);
  const started = Date.now();
  const proc = Bun.spawn(["bun", HOOK, mode], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
  proc.stdin.write(opts.stdin ?? "");
  proc.stdin.end();
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, code, ms: Date.now() - started };
}

const ups = (prompt: string) => JSON.stringify({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt });

describe("hooks/delivery.ts prompt", () => {
  test("a Bridge channel turn sends its entry id; a notice comes back as additionalContext JSON", async () => {
    const dir = stateDir();
    const srv = fakeServer(dir, () => ({ ok: true, op: "prompt", confirmed: true, context: "Bridge pushed 1 entry…" }));
    const r = await runHook("prompt", { dir, stdin: ups(TAG(ID)) });
    expect(r.code).toBe(0);
    expect(srv.requests).toEqual([{ op: "prompt", id: ID }]);
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Bridge pushed 1 entry…" },
    });
  });

  test("a typed prompt or another source's tag sends id null (hooks-alive) and prints nothing when there is no notice", async () => {
    const dir = stateDir();
    const srv = fakeServer(dir, () => ({ ok: true, op: "prompt", confirmed: false, context: null }));
    for (const prompt of ["what is 2+2?", TAG(ID, "plugin:telegram:telegram")]) {
      const r = await runHook("prompt", { dir, stdin: ups(prompt) });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    }
    expect(srv.requests).toEqual([
      { op: "prompt", id: null },
      { op: "prompt", id: null },
    ]);
  });

  test("FAIL OPEN: no socket → exit 0, empty stdout", async () => {
    const dir = stateDir();
    expect(existsSync(ctlSocketPath(dir, PID))).toBe(false);
    const r = await runHook("prompt", { dir, stdin: ups(TAG(ID)) });
    expect(r).toMatchObject({ code: 0, stdout: "" });
  });

  test("FAIL OPEN: no CLAUDE_PID, garbage stdin, empty stdin", async () => {
    const dir = stateDir();
    const srv = fakeServer(dir, () => ({ ok: true, op: "prompt", confirmed: false, context: "X" }));
    expect(await runHook("prompt", { dir, stdin: ups(TAG(ID)), pid: null })).toMatchObject({ code: 0, stdout: "" });
    expect(await runHook("prompt", { dir, stdin: ups(TAG(ID)), pid: "12abc" })).toMatchObject({ code: 0, stdout: "" });
    expect(srv.requests).toEqual([]);
    // Bad stdin is not a reason to skip the hooks-alive signal.
    expect((await runHook("prompt", { dir, stdin: "{not json" })).code).toBe(0);
    expect((await runHook("prompt", { dir, stdin: "" })).code).toBe(0);
    expect(srv.requests).toEqual([
      { op: "prompt", id: null },
      { op: "prompt", id: null },
    ]);
  });

  test("FAIL OPEN: a server that never answers costs at most the socket budget", async () => {
    const dir = stateDir();
    fakeServer(dir, () => undefined);
    const r = await runHook("prompt", { dir, stdin: ups(TAG(ID)) });
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(r.ms).toBeLessThan(4000); // hooks.json timeout is 5 s
  });

  test("FAIL OPEN: junk or a refusal from the server prints nothing", async () => {
    for (const reply of [{ ok: false, error: "x" }, { ok: true, context: 42 }, { ok: true, context: ["x"] }, "string", { ok: true, context: "" }]) {
      const dir = stateDir();
      fakeServer(dir, () => reply);
      expect(await runHook("prompt", { dir, stdin: ups(TAG(ID)) })).toMatchObject({ code: 0, stdout: "" });
    }
  });
});

describe("hooks/delivery.ts stop", () => {
  test("sends stop and prints nothing, whatever the server says", async () => {
    const dir = stateDir();
    const srv = fakeServer(dir, () => ({ ok: true, op: "prompt", context: "must not print" }));
    const r = await runHook("stop", { dir, stdin: JSON.stringify({ hook_event_name: "Stop" }) });
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(srv.requests).toEqual([{ op: "stop" }]);
  });

  test("an unknown mode does nothing", async () => {
    const dir = stateDir();
    const srv = fakeServer(dir, () => ({ ok: true }));
    expect(await runHook("bogus", { dir, stdin: "{}" })).toMatchObject({ code: 0, stdout: "" });
    expect(srv.requests).toEqual([]);
  });
});

describe("ctlSocketPath", () => {
  test("short state dir → <state>/ctl/c<pid>.sock; a long one → a short per-user tmp path, distinct per state dir", () => {
    expect(ctlSocketPath("/home/u/.einweave", 7)).toBe("/home/u/.einweave/ctl/c7.sock");
    const longA = "/" + "a".repeat(120);
    const longB = "/" + "b".repeat(120);
    const a = ctlSocketPath(longA, 7);
    expect(Buffer.byteLength(a)).toBeLessThanOrEqual(100);
    expect(a.startsWith(tmpdir())).toBe(true);
    expect(a).not.toBe(ctlSocketPath(longB, 7));
  });
});

describe("hooks/delivery.ts refuses a socket directory that is not ours (S1)", () => {
  // A state dir too deep for a socket path → the socket lives in tmpdir()/ew-ctl-<uid>/.
  const LONG = "/" + "s".repeat(120);
  const uid = userInfo().uid;

  function withTmp(): { tmp: string; fallback: string } {
    const tmp = realpathSync(mkdtempSync(join("/tmp", "ewt-")));
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    cleanups.push(() => {
      if (prev === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prev;
      rmSync(tmp, { recursive: true, force: true });
    });
    return { tmp, fallback: join(tmp, `ew-ctl-${uid}`) };
  }
  const listen = (fallback: string) => {
    const path = ctlSocketPath(LONG, PID);
    expect(dirname(path)).toBe(fallback);
    const requests: any[] = [];
    const server = Bun.listen({
      unix: path,
      socket: {
        data(s, chunk) {
          requests.push(JSON.parse(chunk.toString().trim()));
          s.write(JSON.stringify({ ok: true, op: "prompt", confirmed: false, context: "INJECTED" }) + "\n");
        },
      },
    });
    cleanups.push(() => server.stop(true));
    return requests;
  };

  test("control: a 0700 directory of ours is used", async () => {
    const { tmp, fallback } = withTmp();
    mkdirSync(fallback, { mode: 0o700 });
    const requests = listen(fallback);
    const r = await runHook("prompt", { dir: LONG, tmp, stdin: ups(TAG(ID)) });
    expect(requests).toHaveLength(1);
    expect(r.stdout).toContain("INJECTED");
  });

  for (const mode of [0o777, 0o755, 0o770]) {
    test(`mode ${mode.toString(8)} directory: nothing printed, the socket is never contacted`, async () => {
      const { tmp, fallback } = withTmp();
      mkdirSync(fallback, { mode: 0o700 });
      const requests = listen(fallback);
      chmodSync(fallback, mode);
      const r = await runHook("prompt", { dir: LONG, tmp, stdin: ups(TAG(ID)) });
      expect(r).toMatchObject({ code: 0, stdout: "" });
      expect(requests).toEqual([]);
    });
  }

  test("a symlink in place of the directory: nothing printed, the socket is never contacted", async () => {
    const { tmp, fallback } = withTmp();
    const real = join(tmp, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, fallback);
    const requests = (() => {
      const path = join(real, basename(ctlSocketPath(LONG, PID)));
      const reqs: any[] = [];
      const server = Bun.listen({
        unix: path,
        socket: {
          data(s, chunk) {
            reqs.push(JSON.parse(chunk.toString().trim()));
            s.write(JSON.stringify({ ok: true, op: "prompt", confirmed: false, context: "INJECTED" }) + "\n");
          },
        },
      });
      cleanups.push(() => server.stop(true));
      return reqs;
    })();
    const r = await runHook("prompt", { dir: LONG, tmp, stdin: ups(TAG(ID)) });
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(requests).toEqual([]);
  });
});
