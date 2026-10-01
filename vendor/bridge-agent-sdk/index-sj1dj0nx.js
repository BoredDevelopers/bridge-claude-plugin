import {
  AsyncChannel
} from "./index-0nd9zcgb.js";
import {
  FEED_PROTOCOL_VERSION,
  FeedError,
  FeedLineDecoder,
  cleanLine,
  cleanText,
  clipRow,
  createRenderCache,
  dateSeparator,
  dayKey,
  deadline,
  encodeFrame,
  hasMessage,
  initialTailState,
  isFeedError,
  messageKey,
  parseServerFrame,
  parseTailInput,
  renderFooter,
  renderHeader,
  renderMessage,
  renderTranscript,
  tailReduce,
  viewport
} from "./index-h8ffc6pv.js";

// src/node/proc-start.ts
import { execFile } from "node:child_process";
var __psExec = {
  run(pid, env) {
    return new Promise((resolve) => {
      execFile("ps", ["-o", "lstart=", "-p", String(pid)], { env }, (err, stdout) => {
        resolve(err ? "" : String(stdout).trim());
      });
    });
  }
};
function procStartOf(pid) {
  return __psExec.run(pid, { ...process.env, TZ: "UTC", LC_ALL: "C" });
}
function legacyProcStartOf(pid) {
  return __psExec.run(pid, process.env);
}
async function procStartMatches(pid, recorded) {
  if (!recorded)
    return false;
  const [norm, legacy] = await Promise.all([procStartOf(pid), legacyProcStartOf(pid)]);
  return recorded === norm || recorded === legacy;
}
function pidAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

// src/node/feed-client.ts
import * as net from "node:net";
var DEFAULT_CONNECT_TIMEOUT_MS = 5000;
var DEFAULT_BUFFERED = 1000;
var DEFAULT_HISTORY_TIMEOUT_MS = 30000;
function feedClient(path, options = {}) {
  return new Promise((resolveClient, rejectClient) => {
    if (options.signal?.aborted)
      return rejectClient(new FeedError("closed", "feed client aborted"));
    const socket = net.connect(path);
    socket.setEncoding("utf8");
    const decoder = new FeedLineDecoder;
    const channel = new AsyncChannel(options.maxBuffered ?? DEFAULT_BUFFERED);
    const pending = new Map;
    let hello;
    let nextReq = 1;
    let ended = false;
    let resolveClosed;
    const closed = new Promise((r) => resolveClosed = r);
    const connect2 = deadline(options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    function end(why) {
      if (ended)
        return;
      ended = true;
      connect2.clear();
      options.signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      channel.end();
      if (!hello)
        rejectClient(why);
      for (const p of pending.values())
        p.reject(why);
      pending.clear();
      resolveClosed();
    }
    const onAbort = () => end(new FeedError("closed", "feed client aborted"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    connect2.signal.addEventListener("abort", () => end(new FeedError("timeout", `no hello from the feed at ${path}`)), { once: true });
    socket.on("error", (e) => end(new FeedError("closed", `feed connection failed: ${e.message}`, { cause: e })));
    socket.on("close", () => end(new FeedError("closed", "feed connection closed")));
    const client = {
      get hello() {
        return hello;
      },
      closed,
      subscribe(replay) {
        if (ended)
          return;
        socket.write(encodeFrame(replay === undefined ? { t: "subscribe" } : { t: "subscribe", replay }));
      },
      history(req, opts) {
        if (ended)
          return Promise.reject(new FeedError("closed", "feed connection closed"));
        const id = `h${nextReq++}`;
        return new Promise((resolve, reject) => {
          const d = deadline(opts?.timeoutMs ?? options.historyTimeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS);
          const settle = (fn) => (...a) => {
            d.clear();
            pending.delete(id);
            fn(...a);
          };
          pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
          d.signal.addEventListener("abort", () => pending.get(id)?.reject(new FeedError("timeout", "history request timed out")), { once: true });
          socket.write(encodeFrame({ t: "history", req: id, ...req }));
        });
      },
      close() {
        end(new FeedError("closed", "feed client closed"));
      },
      [Symbol.asyncIterator]: () => channel[Symbol.asyncIterator]()
    };
    socket.on("data", (chunk) => {
      for (const line of decoder.push(chunk)) {
        if (ended)
          return;
        if (line.kind === "error") {
          if (line.code === "line_too_long")
            return end(new FeedError("protocol", line.message));
          if (!hello)
            return end(new FeedError("protocol", "first line from the feed is not JSON"));
          continue;
        }
        const parsed = parseServerFrame(line.value);
        if (!hello) {
          if (parsed.kind !== "frame" || parsed.frame.t !== "hello")
            return end(new FeedError("protocol", "the feed's first frame is not a valid hello"));
          if (parsed.frame.v !== FEED_PROTOCOL_VERSION) {
            return end(new FeedError("unsupported_version", `feed protocol v${parsed.frame.v} is not supported; this client speaks v${FEED_PROTOCOL_VERSION}`));
          }
          hello = parsed.frame;
          connect2.clear();
          resolveClient(client);
          continue;
        }
        if (parsed.kind !== "frame")
          continue;
        const f = parsed.frame;
        if (f.t === "history")
          pending.get(f.req)?.resolve(f);
        else if (f.t === "error" && f.req !== undefined && pending.has(f.req)) {
          pending.get(f.req).reject(new FeedError("remote", f.message, { remoteCode: f.code }));
        } else
          channel.push(f);
      }
    });
  });
}

// src/node/proc-registry.ts
import { mkdirSync, writeFileSync, renameSync, unlinkSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
var PROC_FORMAT = 0;
function procsDir(dir) {
  return join(dir, "procs");
}
var __io = { mkdirSync, writeFileSync, renameSync, unlinkSync, readdirSync, readFileSync };
var __ps = { pidAlive, procStartOf, legacyProcStartOf };
var PROC_FILE_RE = /^(\d+)\.json$/;
async function checkLive(pid, rec) {
  if (!__ps.pidAlive(pid))
    return "dead";
  const recordedStart = typeof rec.procStart === "string" ? rec.procStart : "";
  const currentStart = await __ps.procStartOf(pid);
  if (!recordedStart || !currentStart)
    return "unverifiable";
  if (currentStart === recordedStart)
    return "live";
  return await __ps.legacyProcStartOf(pid) === recordedStart ? "live" : "dead";
}
async function listProcs(dir, excludePid, options = {}) {
  const sweep = options.sweep !== false;
  const procs = procsDir(dir);
  let names;
  try {
    names = __io.readdirSync(procs);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = PROC_FILE_RE.exec(name);
    if (!m)
      continue;
    const pid = Number(m[1]);
    if (pid === excludePid)
      continue;
    const path = join(procs, name);
    let rec;
    try {
      rec = JSON.parse(__io.readFileSync(path, "utf8"));
    } catch {
      if (sweep) {
        try {
          __io.unlinkSync(path);
        } catch {}
      }
      continue;
    }
    const format = typeof rec.format === "number" ? rec.format : 0;
    if (format > PROC_FORMAT)
      continue;
    if (options.skipCheck?.(rec)) {
      out.push({ ...rec, verified: false });
      continue;
    }
    const verdict = await checkLive(pid, rec);
    if (verdict === "dead") {
      if (sweep) {
        try {
          __io.unlinkSync(path);
        } catch {}
      }
      continue;
    }
    out.push({ ...rec, verified: verdict === "live" });
  }
  return out;
}

// src/node/tail.ts
var TAIL_ENTER = "\x1B[?1049h\x1B[?25l\x1B[?1004h\x1B[?7l";
var TAIL_LEAVE = "\x1B[?7h\x1B[?1004l\x1B[?25h\x1B[?1049l\x1B]2;\x07";
var DEFAULT_POLL_MS = 1000;
var DEFAULT_REPLAY = 500;
var PROBE_TTL_MS = 1e4;
async function runTail(options = {}) {
  const dirs = options.procsDirs ?? [];
  if (dirs.length === 0 && !options.socket)
    throw new TypeError("runTail: procsDirs or socket is required");
  if (options.signal?.aborted)
    return { reason: "aborted" };
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const proc = options.process ?? process;
  const poll = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const cwd = options.cwd ?? process.cwd();
  const tty = stdout.isTTY === true;
  const color = options.color ?? (tty && !env.NO_COLOR);
  const all = options.all === true;
  const sizeNow = () => ({ cols: stdout.columns ?? options.width ?? 100, rows: stdout.rows ?? 24 });
  let state = initialTailState(sizeNow());
  let finished = false;
  let finish;
  const done = new Promise((r) => finish = r);
  const stopped = done.then(() => {
    return;
  });
  const attached = new Map;
  const connecting = new AbortController;
  const cache = createRenderCache();
  let waitTimer;
  let renderTimer;
  const read = options.listProcs ?? ((d) => listProcs(d, undefined, { sweep: false, skipCheck: (r) => typeof r.feed === "string" && attached.has(r.feed) }));
  const rawKeys = tty && stdin.isTTY === true && typeof stdin.setRawMode === "function";
  let entered = false;
  let restored = false;
  let top = 0;
  let lastTitle = "";
  const onData = (chunk) => {
    for (const ev of parseTailInput(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)))
      dispatch(ev);
  };
  const onResize = () => {
    const s = sizeNow();
    dispatch({ type: "resize", cols: s.cols, rows: s.rows });
  };
  function enter() {
    entered = true;
    stdout.write(TAIL_ENTER);
    if (rawKeys) {
      stdin.setRawMode(true);
      stdin.setEncoding?.("utf8");
      stdin.on("data", onData);
      stdin.resume?.();
    }
    stdout.on?.("resize", onResize);
  }
  function restore() {
    if (!entered || restored)
      return;
    restored = true;
    stdout.off?.("resize", onResize);
    if (rawKeys) {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause?.();
    }
    stdout.write(TAIL_LEAVE);
  }
  function draw() {
    const { cols } = state.size;
    const rows = Math.max(1, state.size.rows);
    const lines = [renderHeader({ handle: state.agent ?? undefined, label: state.label ?? undefined, state: state.connection }, cols, color)];
    if (rows >= 2) {
      const bodyH = rows - 2;
      if (bodyH > 0) {
        const t = renderTranscript(state.messages, { fold: (k) => state.fold.get(k) ?? "open", selectedKey: state.selected, unreadFromKey: state.unreadFrom }, { width: cols, color, showSession: all, cache });
        const vp = viewport(t, bodyH, { selectedKey: state.selected, follow: state.follow, prevTop: top });
        top = vp.top;
        lines.push(...vp.rows);
        while (lines.length < rows - 1)
          lines.push("");
      }
      let ins = 0;
      for (const m of state.messages)
        if (m.dir === "in")
          ins++;
      lines.push(renderFooter({ total: state.messages.length, ins, outs: state.messages.length - ins }, cols, color));
    }
    let frame = "\x1B[H" + lines.slice(0, rows).map((l) => "\x1B[2K" + clipRow(l, cols)).join(`\r
`);
    const title = state.unread > 0 ? `bridge (${state.unread})` : "bridge";
    if (title !== lastTitle) {
      lastTitle = title;
      frame += `\x1B]2;${title}\x07`;
    }
    stdout.write(frame);
  }
  function scheduleDraw() {
    if (!tty || finished || renderTimer !== undefined)
      return;
    renderTimer = setImmediate(() => {
      renderTimer = undefined;
      if (!finished)
        draw();
    });
  }
  let lastDay = null;
  let quiet = false;
  const say = (text) => void stdout.write(text + `
`);
  function printMessage(key) {
    const m = state.messages.find((x) => x.key === key);
    if (!m)
      return;
    const width = sizeNow().cols;
    const d = dayKey(m.ts);
    if (d !== "" && d !== lastDay) {
      lastDay = d;
      say(dateSeparator(m.ts, width, color));
    }
    for (const row of renderMessage(m, { width, color, fold: "full", showSession: all }))
      say(row);
  }
  const NOTES = {
    waiting: "waiting for a Bridge session…",
    ended: "session ended — waiting…"
  };
  function printDelta(prev, ev) {
    if (ev.type === "frame" && ev.frame.t === "message") {
      const key = messageKey(ev.frame, ev.session);
      if (!hasMessage(prev, key) && hasMessage(state, key))
        printMessage(key);
    }
    if (ev.type === "attached") {
      say(all ? `connected to [${ev.session}]` : `connected to ${ev.agent ? `@${ev.agent}` : "session"}${ev.label ? ` (${ev.label})` : ""}`);
      return;
    }
    if (prev.connection === state.connection)
      return;
    if (state.connection === "ended")
      say(NOTES.ended);
    else if (state.connection !== "waiting" && state.connection !== "connected" && !quiet)
      say(`session link: ${state.connection}`);
    else if (state.connection === "connected" && ev.type === "frame" && !quiet)
      say("session link: connected");
  }
  function dispatch(ev) {
    if (finished)
      return;
    const prev = state;
    state = tailReduce(state, ev);
    if (tty)
      scheduleDraw();
    else
      printDelta(prev, ev);
    if (state.quit)
      shutdown({ reason: "quit" });
  }
  function shutdown(result) {
    if (finished)
      return;
    finished = true;
    if (waitTimer !== undefined)
      clearTimeout(waitTimer);
    if (renderTimer !== undefined)
      clearImmediate(renderTimer);
    restore();
    for (const [sig, fn] of signalHandlers)
      proc.off(sig, fn);
    proc.off("exit", restore);
    options.signal?.removeEventListener("abort", onAbort);
    connecting.abort();
    for (const a of attached.values())
      a.client.close();
    if (result.reason === "unsupported_version" || result.reason === "error") {
      stderr.write(`bridge tail: ${cleanText(result.message)}
`);
    }
    finish(result);
  }
  const signalHandlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((sig) => [sig, () => shutdown({ reason: "signal", signal: sig })]);
  const onFatal = (err) => shutdown({ reason: "error", message: err instanceof Error ? err.message : String(err) });
  const onAbort = () => shutdown({ reason: "aborted" });
  async function discover() {
    if (options.socket)
      return [{ feed: options.socket, pid: 0, sessionKey: "", cwd: "", startedAt: "", state: "connected" }];
    const lists = await Promise.all(dirs.map((d) => read(d).catch(() => [])));
    const seen = new Set;
    const out = [];
    for (const r of lists.flat()) {
      const rec = r;
      if (typeof rec.feed !== "string" || rec.feed === "" || seen.has(rec.feed) || typeof rec.pid !== "number" || !Number.isFinite(rec.pid) || typeof rec.sessionKey !== "string" || typeof rec.cwd !== "string" || typeof rec.startedAt !== "string" || typeof rec.state !== "string")
        continue;
      seen.add(rec.feed);
      out.push({ feed: rec.feed, pid: rec.pid, sessionKey: rec.sessionKey, cwd: rec.cwd, startedAt: rec.startedAt, state: rec.state });
    }
    return out;
  }
  function rank(cands) {
    const tier = (c) => (c.state === "connected" ? 0 : 2) + (c.cwd === cwd ? 0 : 1);
    return [...cands].sort((a, b) => tier(a) - tier(b) || b.startedAt.localeCompare(a.startedAt));
  }
  async function connect2(path) {
    try {
      return await feedClient(path, { signal: connecting.signal });
    } catch (e) {
      if (isFeedError(e) && e.code === "unsupported_version") {
        shutdown({ reason: "unsupported_version", message: `${e.message}. Update bridge tail.` });
      }
      return null;
    }
  }
  const probed = new Map;
  const selectorMatches = (sel, label, context) => label.toLowerCase() === sel.toLowerCase() || context.startsWith(sel);
  function sessionName(client) {
    return cleanLine(client.hello.label ?? client.hello.context_id.slice(0, 8));
  }
  function announceInfo() {
    const clients = [...attached.values()].map((a) => a.client);
    if (clients.length === 1) {
      const h = clients[0].hello;
      return { agent: cleanLine(h.agent.handle), label: h.label ? cleanLine(h.label) : null };
    }
    return { agent: null, label: clients.length > 1 ? `${clients.length} sessions` : null };
  }
  async function attach(c, ready) {
    const client = ready ?? await connect2(c.feed);
    if (!client)
      return false;
    if (finished) {
      client.close();
      return false;
    }
    const a = { client, session: all ? sessionName(client) : undefined, replaying: true };
    attached.set(c.feed, a);
    client.subscribe(options.replay ?? DEFAULT_REPLAY);
    dispatch({ type: "attached", session: a.session, ...announceInfo() });
    consume(c.feed, a).catch(onFatal);
    return true;
  }
  async function consume(path, a) {
    for await (const frame of a.client) {
      if (frame.t === "replayed") {
        a.replaying = false;
        continue;
      }
      quiet = a.replaying;
      dispatch({ type: "frame", frame, session: a.session, history: a.replaying });
      quiet = false;
      if (finished)
        break;
    }
    a.client.close();
    attached.delete(path);
    if (finished)
      return;
    dispatch({ type: "detached", session: a.session, ...attached.size > 0 ? announceInfo() : {} });
  }
  async function reconcile() {
    if (!all && attached.size > 0)
      return;
    const ranked = rank(await discover());
    if (finished)
      return;
    if (all) {
      for (const c of ranked)
        if (!attached.has(c.feed) && !finished)
          await attach(c);
      return;
    }
    if (options.socket) {
      if (ranked[0])
        await attach(ranked[0]);
      return;
    }
    const sel = options.session;
    if (!sel) {
      for (const c of ranked)
        if (await attach(c))
          return;
      return;
    }
    const byRecord = ranked.filter((c) => String(c.pid) === sel || c.sessionKey.startsWith(sel));
    if (byRecord.length > 0) {
      for (const c of byRecord)
        if (await attach(c))
          return;
      return;
    }
    for (const c of ranked) {
      const known = probed.get(c.feed);
      if (known && Date.now() - known.at < PROBE_TTL_MS && !selectorMatches(sel, known.label, known.context))
        continue;
      const client = await connect2(c.feed);
      if (finished)
        return;
      if (!client)
        continue;
      const h = client.hello;
      probed.set(c.feed, { label: h.label ?? "", context: h.context_id, at: Date.now() });
      if (selectorMatches(sel, h.label ?? "", h.context_id)) {
        if (await attach(c, client))
          return;
      } else
        client.close();
    }
  }
  function wait(ms) {
    return new Promise((resolve) => {
      waitTimer = setTimeout(resolve, ms);
    });
  }
  for (const [sig, fn] of signalHandlers)
    proc.on(sig, fn);
  proc.on("exit", restore);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (tty)
    enter();
  else
    say(NOTES.waiting);
  scheduleDraw();
  (async () => {
    try {
      while (!finished) {
        await reconcile();
        if (finished)
          break;
        await Promise.race([wait(poll), stopped]);
      }
    } catch (e) {
      onFatal(e);
    }
  })();
  return done;
}

// src/node/tail-main.ts
var TAIL_USAGE = `usage: bridge-tail (--procs <dir> ... | --socket <path>) [options]

  --procs <dir>      proc-registry state dir to find sessions in (repeatable)
  --socket <path>    attach to this feed socket directly
  --session <sel>    pick a session by label, context id, sessionKey prefix or pid
  --all              merge every live session, with a session column
  --no-color         plain text, no colour
  --help             this text

keys: j/k or arrows move, enter folds (opens the rest of a long message), e folds all, g/G first/last, q quits
`;
function parseTailArgs(argv) {
  const out = { procsDirs: [], all: false, help: false };
  const value = (flag, i, inline) => {
    const v = inline ?? argv[i + 1];
    if (v === undefined || v === "" || inline === undefined && v.startsWith("--"))
      throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0;i < argv.length; i++) {
    const [flag, inline] = splitFlag(argv[i]);
    switch (flag) {
      case "--procs":
        out.procsDirs.push(value(flag, i, inline));
        if (inline === undefined)
          i++;
        break;
      case "--socket":
        out.socket = value(flag, i, inline);
        if (inline === undefined)
          i++;
        break;
      case "--session":
        out.session = value(flag, i, inline);
        if (inline === undefined)
          i++;
        break;
      case "--all":
        out.all = true;
        break;
      case "--no-color":
        out.color = false;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(argv[i])}`);
    }
  }
  return out;
}
function splitFlag(arg) {
  const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
  return eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}
var SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
async function tailMain(argv, io = {}) {
  const err = io.stderr ?? process.stderr;
  let args;
  try {
    args = parseTailArgs(argv);
  } catch (e) {
    err.write(`bridge tail: ${e.message}

${TAIL_USAGE}`);
    return 2;
  }
  const out = io.stdout ?? process.stdout;
  if (args.help) {
    out.write(TAIL_USAGE);
    return 0;
  }
  if (args.procsDirs.length === 0 && !args.socket) {
    err.write(`bridge tail: nowhere to look for a session — pass --procs <state dir> or --socket <path> (the launcher that knows the state dir does this for you)

${TAIL_USAGE}`);
    return 2;
  }
  const proc = io.process ?? process;
  const stop = new AbortController;
  let fatal;
  let failed = false;
  const onFatal = (e) => {
    if (failed)
      return;
    failed = true;
    fatal = e;
    stop.abort();
  };
  proc.on("uncaughtException", onFatal);
  proc.on("unhandledRejection", onFatal);
  let result;
  try {
    result = await runTail({ ...io, procsDirs: args.procsDirs, socket: args.socket, session: args.session, all: args.all, color: args.color, signal: stop.signal });
  } finally {
    proc.off("uncaughtException", onFatal);
    proc.off("unhandledRejection", onFatal);
  }
  if (failed) {
    err.write(`bridge tail: ${cleanText(fatal instanceof Error ? fatal.stack ?? fatal.message : String(fatal))}
`);
    return 1;
  }
  if (result.reason === "unsupported_version" || result.reason === "error")
    return 1;
  return result.reason === "signal" ? SIGNAL_EXIT[result.signal] ?? 1 : 0;
}

export { procStartOf, legacyProcStartOf, procStartMatches, pidAlive, feedClient, TAIL_ENTER, TAIL_LEAVE, runTail, TAIL_USAGE, parseTailArgs, tailMain };
