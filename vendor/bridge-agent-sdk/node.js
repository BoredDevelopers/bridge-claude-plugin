import {
  TAIL_ENTER,
  TAIL_LEAVE,
  TAIL_USAGE,
  feedClient,
  legacyProcStartOf,
  parseTailArgs,
  pidAlive,
  procStartMatches,
  procStartOf,
  runTail,
  tailEnter,
  tailLeave,
  tailMain
} from "./index-rxjxqpxq.js";
import"./index-0nd9zcgb.js";
import {
  FEED_PROTOCOL_VERSION,
  FEED_RING_MAX_BYTES,
  FEED_RING_MAX_EVENTS,
  FeedError,
  FeedLineDecoder,
  FeedRing,
  KNOWN_FORMAT,
  classifyVersioned,
  deadline,
  decideLock,
  encodeFrame,
  isJoinState,
  isP256PrivateJwk,
  parseClientFrame,
  randomB64url
} from "./index-ags5za24.js";

// src/node/store.ts
import { readFileSync as readFileSync3, readdirSync as readdirSync2, statSync as statSync2, unlinkSync as unlinkSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/node/format-guard.ts
import { readFileSync } from "node:fs";
function readVersioned(path, knownMax = KNOWN_FORMAT) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { kind: "absent" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "absent" };
  }
  return classifyVersioned(parsed, knownMax);
}

// src/node/fs-atomic.ts
import * as fs from "node:fs";
import { dirname } from "node:path";
var __fsIo = {
  openSync: fs.openSync,
  writeSync: fs.writeSync,
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  renameSync: fs.renameSync
};
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function writeAllAndSync(fd, content) {
  const buf = Buffer.from(content, "utf8");
  let off = 0;
  while (off < buf.length)
    off += __fsIo.writeSync(fd, buf, off, buf.length - off);
  __fsIo.fsyncSync(fd);
}
function fsyncDir(dir) {
  let fd;
  try {
    fd = __fsIo.openSync(dir, "r");
  } catch {
    return;
  }
  try {
    __fsIo.fsyncSync(fd);
  } catch (e) {
    const code = e?.code;
    if (code !== "EPERM" && code !== "EISDIR" && code !== "EINVAL" && code !== "ENOTSUP")
      throw e;
  } finally {
    __fsIo.closeSync(fd);
  }
}
var RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
function renameWithRetry(from, to) {
  for (let delay = 10;; delay *= 2) {
    try {
      __fsIo.renameSync(from, to);
      return;
    } catch (e) {
      if (!RENAME_RETRY_CODES.has(e?.code ?? "") || delay > 640)
        throw e;
      sleepSync(delay);
    }
  }
}
function removeQuiet(path) {
  try {
    fs.unlinkSync(path);
  } catch {}
}
function writeAtomic(path, content, opts = {}) {
  const dir = dirname(path);
  fs.mkdirSync(dir, { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomB64url(4)}.tmp`;
  const fd = __fsIo.openSync(tmp, "wx", 384);
  try {
    try {
      if (opts.durable)
        writeAllAndSync(fd, content);
      else
        fs.writeSync(fd, content);
    } finally {
      __fsIo.closeSync(fd);
    }
    renameWithRetry(tmp, path);
  } catch (e) {
    removeQuiet(tmp);
    throw e;
  }
  if (opts.durable)
    fsyncDir(dir);
}

// src/node/lock.ts
import * as fs2 from "node:fs";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, statSync } from "node:fs";
import { join } from "node:path";
var LOCK_DIR_NAME = ".install-lock";
var STALE_MS = 120000;
var HOLD_BUDGET_MS = 90000;
var LOCK_WAIT_MS = 150000;
var BREAK_STALE_MS = 1e4;
var RETRY_MS = 100;
var TRANSIENT_FS = new Set(["ENOENT", "ENOTEMPTY", "EPERM", "EBUSY"]);
var __lockIo = {
  rmSync: fs2.rmSync,
  renameSync: fs2.renameSync,
  writeFileSync: fs2.writeFileSync
};
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var codeOf = (e) => e?.code ?? "";
function ageMs(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
function readOwner(lockDir) {
  try {
    return JSON.parse(readFileSync2(join(lockDir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}
function isStale(lockDir) {
  const age = ageMs(lockDir);
  return age !== null && age > STALE_MS;
}
function breakIfStale(lockDir) {
  const breakDir = `${lockDir}.break`;
  try {
    mkdirSync2(breakDir, { mode: 448 });
  } catch (err) {
    if (codeOf(err) !== "EEXIST")
      throw err;
    const age = ageMs(breakDir);
    if (age !== null && age > BREAK_STALE_MS)
      __lockIo.rmSync(breakDir, { recursive: true, force: true });
    return;
  }
  try {
    if (isStale(lockDir))
      __lockIo.rmSync(lockDir, { recursive: true, force: true });
  } finally {
    __lockIo.rmSync(breakDir, { recursive: true, force: true });
  }
}
async function withFsRetry(op) {
  for (let i = 0;; i++) {
    try {
      op();
      return;
    } catch (e) {
      if (!TRANSIENT_FS.has(codeOf(e)) || i >= 5)
        throw e;
      await sleep(50);
    }
  }
}
async function release(lockDir, nonce) {
  if (readOwner(lockDir)?.nonce !== nonce)
    return;
  const tomb = `${lockDir}.released-${nonce}`;
  try {
    await withFsRetry(() => __lockIo.renameSync(lockDir, tomb));
  } catch (e) {
    if (codeOf(e) === "ENOENT")
      return;
    throw e;
  }
  if (readOwner(tomb)?.nonce !== nonce) {
    try {
      __lockIo.renameSync(tomb, lockDir);
    } catch {}
    return;
  }
  await withFsRetry(() => __lockIo.rmSync(tomb, { recursive: true, force: true }));
}
var TOMBSTONE = new RegExp(`^${LOCK_DIR_NAME.replace(".", "\\.")}\\.released-[0-9a-f-]+$`);
function sweepLockTombstones(profileDir) {
  let n = 0;
  let entries;
  try {
    entries = fs2.readdirSync(profileDir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!TOMBSTONE.test(name))
      continue;
    const p = join(profileDir, name);
    const age = ageMs(p);
    if (age === null || age <= STALE_MS)
      continue;
    try {
      __lockIo.rmSync(p, { recursive: true, force: true });
      n++;
    } catch {}
  }
  return n;
}
async function withInstallationLock(profileDir, fn, o = {}) {
  const waitMs = o.waitMs ?? LOCK_WAIT_MS;
  const holdMs = o.holdMs ?? HOLD_BUDGET_MS;
  if (!(holdMs > 0 && holdMs < STALE_MS))
    throw new RangeError(`installation lock holdMs must be in (0, ${STALE_MS}), got ${holdMs}`);
  mkdirSync2(profileDir, { recursive: true, mode: 448 });
  const lockDir = join(profileDir, LOCK_DIR_NAME);
  const nonce = crypto.randomUUID();
  const waitDeadline = Date.now() + waitMs;
  for (;; ) {
    o.signal?.throwIfAborted();
    let created = false;
    try {
      mkdirSync2(lockDir, { mode: 448 });
      created = true;
      __lockIo.writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, nonce }), { mode: 384 });
      break;
    } catch (err) {
      if (created) {
        if (codeOf(err) === "ENOENT")
          continue;
        try {
          __lockIo.rmSync(lockDir, { recursive: true, force: true });
        } catch {}
        throw err;
      }
      if (codeOf(err) !== "EEXIST")
        throw err;
    }
    try {
      if (isStale(lockDir))
        breakIfStale(lockDir);
    } catch (err) {
      if (!TRANSIENT_FS.has(codeOf(err)))
        throw err;
    }
    if (Date.now() > waitDeadline)
      throw new Error(`bridge: installation lock ${lockDir} held for over ${waitMs / 1000}s`);
    await sleep(RETRY_MS);
  }
  const hold = deadline(holdMs);
  try {
    return await fn({ signal: hold.signal });
  } finally {
    hold.clear();
    try {
      await release(lockDir, nonce);
    } catch (e) {
      (o.log ?? ((m) => console.error(m)))(`bridge: could not release installation lock ${lockDir}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

// src/node/store.ts
var installationFile = (dir) => join2(dir, "installation.json");
var keyFile = (dir) => join2(dir, "key.json");
var stateFile = (dir) => join2(dir, "state");
var attemptFile = (dir) => join2(dir, "attempt");
var cursorFile = (dir) => join2(dir, "cursor");
function readText(path) {
  try {
    return readFileSync3(path, "utf8");
  } catch {
    return null;
  }
}
function readInstallation(dir) {
  const v = readVersioned(installationFile(dir), KNOWN_FORMAT);
  if (v.kind !== "ok")
    return null;
  const c = v.data;
  return typeof c.apiUrl === "string" && typeof c.installationId === "string" && typeof c.jkt === "string" ? c : null;
}
function isNewerInstallation(dir) {
  return readVersioned(installationFile(dir), KNOWN_FORMAT).kind === "newer";
}
function readKey(dir) {
  const raw = readText(keyFile(dir));
  if (raw === null)
    return null;
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  return isP256PrivateJwk(j) ? { kty: "EC", crv: "P-256", x: j.x, y: j.y, d: j.d } : null;
}
function readState(dir) {
  const t = readText(stateFile(dir))?.trim() ?? null;
  return t !== null && isJoinState(t) ? t : null;
}
function fileStore(dir) {
  return {
    async read() {
      const installation = readInstallation(dir);
      if (!installation)
        return null;
      const privateJwk = readKey(dir);
      const joinState = readState(dir);
      if (!privateJwk || joinState === null)
        return null;
      return { installation, privateJwk, joinState };
    },
    async write(record) {
      if (!isJoinState(record.joinState))
        throw new Error("refusing to write a malformed join state");
      if (isNewerInstallation(dir))
        throw new Error("refusing to write over a newer installation (RFC-017 D8)");
      removeQuiet(installationFile(dir));
      writeAtomic(keyFile(dir), JSON.stringify({ kty: record.privateJwk.kty, crv: record.privateJwk.crv, x: record.privateJwk.x, y: record.privateJwk.y, d: record.privateJwk.d }) + `
`, { durable: true });
      writeAtomic(stateFile(dir), record.joinState + `
`, { durable: true });
      const inst = record.installation;
      const out = {
        format: KNOWN_FORMAT,
        apiUrl: inst.apiUrl,
        installationId: inst.installationId,
        ...inst.installationName !== undefined ? { installationName: inst.installationName } : {},
        jkt: inst.jkt,
        keyStorage: inst.keyStorage,
        ...inst.agent ? { agent: inst.agent } : {},
        ...inst.workspace ? { workspace: inst.workspace } : {}
      };
      writeAtomic(installationFile(dir), JSON.stringify(out, null, 2) + `
`, { durable: true });
    },
    async writeJoinState(joinState) {
      if (!isJoinState(joinState))
        throw new Error("refusing to write a malformed join state");
      writeAtomic(stateFile(dir), joinState + `
`, { durable: true });
    },
    async clear() {
      if (isNewerInstallation(dir))
        return;
      removeQuiet(installationFile(dir));
      removeQuiet(keyFile(dir));
      removeQuiet(stateFile(dir));
      removeQuiet(attemptFile(dir));
    },
    async readAttempt() {
      const t = readText(attemptFile(dir))?.trim() ?? "";
      return t.length > 0 ? t : null;
    },
    async writeAttempt(attempt) {
      writeAtomic(attemptFile(dir), attempt + `
`, { durable: true });
    },
    async clearAttempt() {
      removeQuiet(attemptFile(dir));
    },
    withLock(fn, opts) {
      return withInstallationLock(dir, ({ signal }) => fn(signal), opts?.budgetMs !== undefined ? { holdMs: opts.budgetMs } : {});
    }
  };
}
function fileCursorStore(dir) {
  const path = cursorFile(dir);
  return {
    async read() {
      const t = readText(path)?.trim() ?? "";
      return t.length > 0 ? t : null;
    },
    async write(cursor) {
      if (cursor === null) {
        removeQuiet(path);
        return;
      }
      writeAtomic(path, cursor + `
`);
    }
  };
}
function sweepOrphanTemps(dir, minAgeMs = 60000) {
  const OWN_TMP = /^(key\.json|state|installation\.json|attempt|cursor)\.\d+\.\d+\.[A-Za-z0-9_-]+\.tmp$/;
  let n = 0;
  let names;
  try {
    names = readdirSync2(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - minAgeMs;
  for (const name of names) {
    if (!OWN_TMP.test(name))
      continue;
    const p = join2(dir, name);
    try {
      if (minAgeMs > 0 && statSync2(p).mtimeMs > cutoff)
        continue;
      unlinkSync2(p);
      n++;
    } catch {}
  }
  return n;
}
// src/node/session-lock.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync4, writeFileSync as writeFileSync2, renameSync as renameSync3, unlinkSync as unlinkSync3, statSync as statSync3 } from "node:fs";
import { join as join3 } from "node:path";
var LOCK_RECORD_FORMAT = 0;
function sessionLock(opts) {
  const lockDir = join3(opts.dir, "locks");
  const lockFile = join3(lockDir, `${opts.sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_")}.lock`);
  const retryMs = opts.retryMs ?? 30000;
  const staleMs = opts.staleMs ?? 5 * 60000;
  const startedAt = new Date().toISOString();
  let held = false;
  let lost = false;
  let renewTimer = null;
  const listeners = new Set;
  let myProcStartPromise = null;
  function myProcStart() {
    if (!myProcStartPromise)
      myProcStartPromise = procStartOf(process.pid);
    return myProcStartPromise;
  }
  function stopRenewal() {
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
  }
  function loseIt() {
    held = false;
    lost = true;
    stopRenewal();
    for (const cb of [...listeners])
      cb();
  }
  function readLockRecord() {
    try {
      return JSON.parse(readFileSync4(lockFile, "utf8"));
    } catch {
      return null;
    }
  }
  function readLockRecordForAcquire() {
    const rec = readLockRecord();
    if (rec !== null)
      return rec;
    sleepSync(20);
    return readLockRecord();
  }
  async function holderLiveness(rec) {
    if (!pidAlive(rec.pid))
      return "dead";
    if (!rec.procStart)
      return "unverifiable";
    if (!await procStartMatches(rec.pid, rec.procStart)) {
      await new Promise((r) => setTimeout(r, 20));
      if (!await procStartMatches(rec.pid, rec.procStart))
        return "dead";
    }
    try {
      if (Date.now() - statSync3(lockFile).mtimeMs > staleMs)
        return "dead";
    } catch {}
    return "live";
  }
  async function holderIsLive(rec) {
    const v = await holderLiveness(rec);
    if (v === "unverifiable") {
      opts.log?.(`bridge: session lock ${lockFile} names pid ${rec.pid} but its start time could not be verified (ps unavailable?) — treating it as live, never stealing it`);
    }
    return v !== "dead";
  }
  function buildRecord(procStart) {
    const id = opts.identity ?? {};
    return {
      format: LOCK_RECORD_FORMAT,
      pid: process.pid,
      procStart,
      sessionKey: opts.sessionKey,
      at: new Date().toISOString(),
      software: opts.software,
      version: opts.version,
      tty: id.tty ?? "",
      termProgram: id.termProgram ?? "",
      cwd: id.cwd ?? "",
      startedAt
    };
  }
  function writeLockExclusive(procStart) {
    try {
      writeFileSync2(lockFile, JSON.stringify(buildRecord(procStart)), { flag: "wx", mode: 384 });
      return true;
    } catch {
      return false;
    }
  }
  function writeLockTakeover(procStart) {
    try {
      const tmp = `${lockFile}.${process.pid}.tmp`;
      writeFileSync2(tmp, JSON.stringify(buildRecord(procStart)), { mode: 384 });
      renameSync3(tmp, lockFile);
    } catch {}
  }
  function armRenewal() {
    if (renewTimer)
      return;
    renewTimer = setInterval(() => {
      renewTick();
    }, retryMs);
    renewTimer.unref?.();
  }
  async function renewTick() {
    try {
      const current = readLockRecord();
      if (current === null)
        return;
      if (current.pid !== process.pid) {
        stopRenewal();
        held = false;
        if (await holderIsLive(current)) {
          loseIt();
          return;
        }
        await acquire();
        return;
      }
      const tmp = `${lockFile}.${process.pid}.tmp`;
      writeFileSync2(tmp, JSON.stringify({ ...current, at: new Date().toISOString() }), { mode: 384 });
      renameSync3(tmp, lockFile);
    } catch {}
  }
  async function acquire(acquireOpts = {}) {
    if (lost)
      return "lost";
    const procStart = await myProcStart();
    try {
      mkdirSync3(lockDir, { recursive: true, mode: 448 });
      let outcome = "acquire";
      if (!writeLockExclusive(procStart)) {
        const rec = readLockRecordForAcquire();
        if (rec && rec.pid === process.pid && rec.procStart === procStart) {
          held = true;
          armRenewal();
          return "acquire";
        }
        if (rec && await holderIsLive(rec)) {
          if (held) {
            loseIt();
            return "lost";
          }
          const decision = decideLock({ version: rec.version }, { version: opts.version }, acquireOpts);
          if (decision === "standby") {
            stopRenewal();
            held = false;
            return "standby";
          }
          outcome = "takeover";
          writeLockTakeover(procStart);
        } else {
          try {
            unlinkSync3(lockFile);
          } catch {}
          if (!writeLockExclusive(procStart))
            return "standby";
        }
      }
      const back = readLockRecord();
      if (back && back.pid !== process.pid)
        return "standby";
      held = true;
      armRenewal();
      return outcome;
    } catch {
      return "acquire";
    }
  }
  function release2() {
    stopRenewal();
    if (!held)
      return;
    held = false;
    try {
      const rec = readLockRecord();
      if (rec && rec.pid === process.pid)
        unlinkSync3(lockFile);
    } catch {}
  }
  return {
    acquire,
    release: release2,
    async holder() {
      return readLockRecord();
    },
    async isHeld() {
      if (!held)
        return false;
      const rec = readLockRecord();
      if (rec === null)
        return true;
      if (rec.pid === process.pid)
        return true;
      if (await holderIsLive(rec)) {
        loseIt();
        return false;
      }
      return true;
    },
    onLost(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    markLost() {
      if (lost)
        return;
      const wasHeld = held;
      lost = true;
      held = false;
      stopRenewal();
      if (wasHeld)
        for (const cb of [...listeners])
          cb();
    }
  };
}
// src/node/hostname.ts
import { hostname as osHostname } from "node:os";
function hostname() {
  return osHostname();
}
// src/node/feed-server.ts
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync as mkdirSync4, unlinkSync as unlinkSync4 } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join as join4 } from "node:path";
var DEFAULT_BACKLOG = 1024 * 1024;
var DEFAULT_HISTORY_TIMEOUT_MS = 15000;
var DEFAULT_HISTORY_INFLIGHT = 4;
var HISTORY_MAX_LIMIT = 200;
var PROBE_TIMEOUT_MS = 1000;
var CLOSE_GRACE_MS = 500;
var SAFE_NAME = /^[A-Za-z0-9._-]+$/;
function defaultMaxPathBytes() {
  return process.platform === "darwin" ? 103 : 107;
}
function mkdirOnce(dir) {
  try {
    mkdirSync4(dir, { mode: 448 });
  } catch (e) {
    if (e.code !== "EEXIST")
      throw e;
  }
}
function resolveFeedSocketPath(o) {
  if (!SAFE_NAME.test(o.contextId))
    throw new FeedError("bad_path", `context id is not usable in a file name: ${JSON.stringify(o.contextId)}`);
  const max = o.maxPathBytes ?? defaultMaxPathBytes();
  const preferredDir = join4(o.stateDir, "feed");
  const preferred = join4(preferredDir, `${o.contextId}.sock`);
  if (Buffer.byteLength(preferred) <= max) {
    mkdirSync4(preferredDir, { recursive: true, mode: 448 });
    chmodSync(preferredDir, 448);
    return preferred;
  }
  const uid = o.uid ?? process.getuid?.();
  const dir = join4(o.tmpRoot ?? tmpdir(), `bridge-feed-${uid ?? "user"}`);
  const hash = createHash("sha256").update(o.contextId).digest("hex").slice(0, 12);
  const fallback = join4(dir, `bf-${hash}.sock`);
  if (Buffer.byteLength(fallback) > max)
    throw new FeedError("bad_path", `no socket path short enough (${Buffer.byteLength(fallback)} > ${max} bytes): ${fallback}`);
  mkdirOnce(dir);
  const st = lstatSync(dir);
  if (!st.isDirectory())
    throw new FeedError("unsafe_dir", `${dir} is not a real directory`);
  if (uid !== undefined && st.uid !== uid)
    throw new FeedError("unsafe_dir", `${dir} is owned by uid ${st.uid}, not ${uid}`);
  if ((st.mode & 511) !== 448)
    throw new FeedError("unsafe_dir", `${dir} has mode ${(st.mode & 511).toString(8)}, not 700`);
  return fallback;
}
function probe(path) {
  return new Promise((resolve, reject) => {
    const d = deadline(PROBE_TIMEOUT_MS);
    const sock = net.connect(path);
    const done = (fn) => {
      d.clear();
      sock.destroy();
      fn();
    };
    d.signal.addEventListener("abort", () => done(() => resolve("live")), { once: true });
    sock.once("connect", () => done(() => resolve("live")));
    sock.once("error", (e) => {
      if (e.code === "ECONNREFUSED" || e.code === "ENOENT")
        done(() => resolve("dead"));
      else
        done(() => reject(e));
    });
  });
}
async function clearStale(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if (e.code === "ENOENT")
      return;
    throw e;
  }
  if (!st.isSocket())
    throw new FeedError("not_a_socket", `${path} exists and is not a socket; not removing it`);
  if (await probe(path) === "live")
    throw new FeedError("in_use", `another process is already serving a feed at ${path}`);
  try {
    unlinkSync4(path);
  } catch (e) {
    if (e.code !== "ENOENT")
      throw e;
  }
}
async function feedServer(options) {
  const path = resolveFeedSocketPath(options);
  await clearStale(path);
  const ring = new FeedRing(options.maxEvents ?? FEED_RING_MAX_EVENTS, options.maxBytes ?? FEED_RING_MAX_BYTES);
  const maxBacklog = options.maxBacklogBytes ?? DEFAULT_BACKLOG;
  const historyTimeoutMs = options.historyTimeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS;
  const maxInflight = options.maxHistoryInflight ?? DEFAULT_HISTORY_INFLIGHT;
  const clients = new Set;
  function drop(c) {
    c.dead = true;
    clients.delete(c);
    c.socket.destroy();
  }
  function send(c, line) {
    if (c.dead || c.socket.destroyed || !c.socket.writable)
      return;
    try {
      if (c.socket.writableLength > c.allowance) {
        c.socket.write(encodeFrame({ t: "error", code: "slow_consumer", message: "feed client too slow; dropped" }));
        drop(c);
        return;
      }
      c.socket.write(line);
    } catch {
      drop(c);
    }
  }
  function sendFrame(c, frame) {
    send(c, encodeFrame(frame));
  }
  async function handleHistory(c, req) {
    const handler = options.history;
    if (!handler)
      return sendFrame(c, { t: "error", req: req.req, code: "no_history", message: "this session cannot fetch history" });
    if (c.inflight >= maxInflight)
      return sendFrame(c, { t: "error", req: req.req, code: "busy", message: "too many history requests in flight" });
    c.inflight++;
    const d = deadline(historyTimeoutMs);
    try {
      const aborted = new Promise((_, reject) => d.signal.addEventListener("abort", () => reject(d.signal.reason), { once: true }));
      const result = await Promise.race([handler({ ...req, limit: Math.min(req.limit, HISTORY_MAX_LIMIT) }, d.signal), aborted]);
      sendFrame(c, { t: "history", req: req.req, messages: result.messages, more: result.more });
    } catch (e) {
      const timedOut = e?.name === "TimeoutError";
      sendFrame(c, { t: "error", req: req.req, code: timedOut ? "history_timeout" : "history_failed", message: timedOut ? "history request timed out" : "history request failed" });
    } finally {
      d.clear();
      c.inflight--;
    }
  }
  function onConnection(socket) {
    const c = { socket, subscribed: false, dead: false, inflight: 0, allowance: maxBacklog };
    clients.add(c);
    socket.on("error", () => drop(c));
    socket.on("close", () => {
      c.dead = true;
      clients.delete(c);
    });
    socket.setEncoding("utf8");
    const decoder = new FeedLineDecoder;
    try {
      sendFrame(c, { t: "hello", v: FEED_PROTOCOL_VERSION, ...options.hello() });
    } catch {
      return drop(c);
    }
    socket.on("data", (chunk) => {
      for (const line of decoder.push(chunk)) {
        if (c.dead)
          return;
        if (line.kind === "error") {
          sendFrame(c, { t: "error", code: line.code === "line_too_long" ? "line_too_long" : "bad_frame", message: line.message });
          if (line.code === "line_too_long")
            return drop(c);
          continue;
        }
        const parsed = parseClientFrame(line.value);
        if (parsed.kind === "skip")
          continue;
        if (parsed.kind === "error") {
          sendFrame(c, { t: "error", code: "bad_frame", message: parsed.message });
          continue;
        }
        const frame = parsed.frame;
        if (frame.t === "subscribe") {
          if (c.subscribed) {
            sendFrame(c, { t: "error", code: "already_subscribed", message: "already subscribed" });
            continue;
          }
          const replay = ring.last(frame.replay ?? 0);
          c.allowance = maxBacklog + replay.reduce((n, e) => n + e.bytes, 0);
          for (const e of replay)
            send(c, e.line);
          sendFrame(c, { t: "replayed", count: replay.length });
          c.subscribed = true;
        } else if (!c.subscribed) {
          sendFrame(c, { t: "error", req: frame.req, code: "not_subscribed", message: "subscribe first" });
        } else {
          handleHistory(c, frame);
        }
      }
    });
  }
  const server = net.createServer(onConnection);
  await new Promise((resolve, reject) => {
    server.once("error", (e) => reject(e.code === "EADDRINUSE" ? new FeedError("in_use", `another process is already serving a feed at ${path}`, { cause: e }) : e));
    server.listen(path, () => resolve());
  });
  server.on("error", () => {});
  chmodSync(path, 384);
  const ino = lstatSync(path).ino;
  let closing;
  return {
    path,
    publish(event) {
      try {
        const entry = ring.push(event);
        for (const c of [...clients])
          if (c.subscribed)
            send(c, entry.line);
      } catch {}
    },
    clientCount: () => [...clients].filter((c) => c.subscribed).length,
    close() {
      closing ??= (async () => {
        const stopped = new Promise((resolve) => server.close(() => resolve()));
        for (const c of [...clients]) {
          c.dead = true;
          c.socket.end();
        }
        const d = deadline(CLOSE_GRACE_MS);
        d.signal.addEventListener("abort", () => clients.forEach((c) => c.socket.destroy()), { once: true });
        await stopped;
        d.clear();
        try {
          if (lstatSync(path).ino === ino)
            unlinkSync4(path);
        } catch {}
      })();
      return closing;
    }
  };
}
export {
  HOLD_BUDGET_MS,
  LOCK_DIR_NAME,
  LOCK_WAIT_MS,
  STALE_MS,
  TAIL_ENTER,
  TAIL_LEAVE,
  TAIL_USAGE,
  feedClient,
  feedServer,
  fileCursorStore,
  fileStore,
  hostname,
  legacyProcStartOf,
  parseTailArgs,
  pidAlive,
  procStartMatches,
  procStartOf,
  readVersioned,
  resolveFeedSocketPath,
  runTail,
  sessionLock,
  sweepLockTombstones,
  sweepOrphanTemps,
  tailEnter,
  tailLeave,
  tailMain,
  withInstallationLock
};
