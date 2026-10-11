import {
  AsyncChannel
} from "./index-0nd9zcgb.js";
import {
  ADDRESSED_REASONS,
  Clock,
  MAX_ACK_IDS,
  PROTOCOL_VERSION,
  TokenClient,
  apiOrigin,
  assertNever,
  classifyClose,
  classifyTokenError,
  closeOutcome,
  deadline,
  dpopProof,
  generateSoftwareKey,
  httpHtu,
  isAddressed,
  isKeyAlreadyEnrolled,
  isOAuthError,
  randomB64url,
  reconnectDelay,
  softwareSigner,
  supportsKeyCredentials,
  userAgent,
  wsHtu
} from "./index-c3kvp3qz.js";

// src/runtime/runtime.ts
function unref(handle) {
  handle?.unref?.();
}
var defaultTimer = {
  setTimeout(fn, ms, opts) {
    const h = setTimeout(fn, ms);
    if (opts?.unref)
      unref(h);
    return { clear: () => clearTimeout(h) };
  },
  setInterval(fn, ms, opts) {
    const h = setInterval(fn, ms);
    if (opts?.unref)
      unref(h);
    return { clear: () => clearInterval(h) };
  }
};
function detectRuntimeIdentity() {
  const proc = globalThis.process;
  const versions = proc?.versions;
  const [runtimeName, runtimeVersion] = versions?.bun ? ["bun", versions.bun] : versions?.node ? ["node", versions.node] : ["unknown", "0.0.0"];
  return { runtimeName, runtimeVersion, os: proc?.platform ?? "unknown", arch: proc?.arch ?? "unknown" };
}
function createRuntime(ports = {}) {
  return {
    fetch: ports.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    WebSocket: ports.WebSocket ?? globalThis.WebSocket,
    timer: ports.timer ?? defaultTimer,
    clock: ports.clock ?? { now: () => Date.now() },
    random: ports.random ?? Math.random,
    userAgent: ports.userAgent ?? detectRuntimeIdentity()
  };
}
// src/runtime/ports.ts
var WS_READY_STATE = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
// src/runtime/errors.ts
class AgentClientError extends Error {
  name = "AgentClientError";
  code;
  reason;
  retryAfterS;
  minimum;
  installedApiUrl;
  configuredApiUrl;
  constructor(i) {
    super(i.message ?? i.code, i.cause !== undefined ? { cause: i.cause } : undefined);
    this.code = i.code;
    this.reason = i.reason;
    this.retryAfterS = i.retryAfterS;
    this.minimum = i.minimum;
    this.installedApiUrl = i.installedApiUrl;
    this.configuredApiUrl = i.configuredApiUrl;
  }
}
function isAgentClientError(e) {
  const o = e;
  return typeof o === "object" && o !== null && o.name === "AgentClientError" && typeof o.code === "string";
}
var TERMINAL = new Set([
  "installation_gone",
  "session_revoked",
  "session_limit",
  "corrupt_state",
  "update_required",
  "too_old",
  "refused",
  "server_mismatch"
]);
function isTerminalCredentialError(e) {
  return isAgentClientError(e) && TERMINAL.has(e.code);
}

// src/runtime/pending.ts
var DEFAULT_MAX = 1000;

class Pending {
  opts;
  held = new Map;
  constructor(opts = {}) {
    this.opts = opts;
  }
  get size() {
    return this.held.size;
  }
  has(id) {
    return this.held.has(id);
  }
  add(entry) {
    if (this.held.has(entry.id))
      return false;
    this.held.set(entry.id, { ...entry });
    const max = this.opts.maxSize ?? DEFAULT_MAX;
    while (this.held.size > max) {
      const oldest = this.held.keys().next().value;
      if (oldest === undefined)
        break;
      this.held.delete(oldest);
    }
    return true;
  }
  markPushed(id, at) {
    const e = this.held.get(id);
    if (e)
      e.pushedAt = at;
  }
  list() {
    return [...this.held.values()].map((e) => ({ ...e }));
  }
  confirm(ids) {
    const taken = [];
    for (const id of ids) {
      if (this.held.delete(id))
        taken.push(id);
    }
    if (taken.length > 0)
      this.opts.onConfirm?.(taken);
    return taken;
  }
  remove(ids) {
    for (const id of ids)
      this.held.delete(id);
  }
}

// src/runtime/session.ts
var REMINT_REARM_MS = 30000;
var DEFAULT_LIVENESS_MS = 90000;
var DEFAULT_STANDBY_RETRY_MS = 30000;
var DEFAULT_BUFFER_SIZE = 1000;
var DEFAULT_RECONCILE_MS = 15 * 60000;
var DEFAULT_STATUS_BUFFER_SIZE = 100;
var SETTLED_MAX = 1e4;
var OWN_SENT_MAX = 1000;
var CHECKPOINT = { mode: "checkpoint" };
function stopKindFromClose(outcome) {
  if (outcome.stop === "superseded")
    return "superseded";
  if (outcome.stop === "too-old")
    return "too-old";
  if (outcome.stop === "session-in-use")
    return "session-in-use";
  return "revoked";
}

class Session {
  rt;
  client;
  opts;
  pending;
  ws = null;
  started = false;
  reconnectTimer = null;
  watchdogTimer = null;
  standbyTimer = null;
  reconcileTimer = null;
  lock;
  reconnectAttempt = 0;
  lastClose = { cls: "transient" };
  authenticatedAt = null;
  remintedAfter4001 = false;
  sockBearer;
  sockGrant = null;
  draining = false;
  stopped = null;
  resolveClosed;
  closedPromise;
  myContextId = null;
  agentId;
  agentName;
  heartbeatMs = null;
  seq = { grantId: null, last: 0, saved: 0, epoch: 0 };
  seqWrites = Promise.resolve();
  lastSequencedAt = 0;
  adapter;
  settled = new Map;
  ownMessageIds = new Set;
  acks = { model: new Set, dismissed: new Set };
  pushQueue = [];
  pushing = false;
  statusChannel;
  unsubscribeRotation;
  unsubscribeLockLost;
  constructor(rt, client, opts = {}) {
    this.rt = rt;
    this.client = client;
    this.opts = opts;
    let resolve;
    this.closedPromise = new Promise((r) => resolve = r);
    this.resolveClosed = resolve;
    this.adapter = opts.adapter ?? CHECKPOINT;
    this.pending = new Pending({ onConfirm: (ids) => this.ack(ids, "model") });
    this.statusChannel = new AsyncChannel(DEFAULT_STATUS_BUFFER_SIZE);
    this.lock = opts.lock;
    this.unsubscribeRotation = client.onAccessRotated((frame) => this.sendReauth(frame));
    this.unsubscribeLockLost = opts.lock ? opts.lock.onLost(() => {
      const sock = this.ws;
      this.ws = null;
      if (sock) {
        try {
          sock.close();
        } catch {}
      }
      this.client.invalidateAccess();
      this.finish({ kind: "superseded" });
    }) : null;
    if (opts.autoConnect !== false)
      this.start();
  }
  start() {
    if (this.started)
      return;
    this.started = true;
    this.connectOrStandby();
  }
  status() {
    return this.statusChannel;
  }
  self() {
    return { contextId: this.myContextId, agentId: this.agentId, ownMessageIds: this.ownMessageIds };
  }
  lastSeq() {
    return this.seq.saved;
  }
  stopReason() {
    return this.stopped;
  }
  closed() {
    return this.closedPromise;
  }
  async send(channelId, content, opts = {}) {
    const result = await this.client.api.messages.create(channelId, { content, ...opts });
    if (result.id)
      this.rememberOwnSend(result.id);
    return result;
  }
  async reply(threadId, content, opts = {}) {
    const result = await this.client.api.threads.reply(threadId, { content, ...opts });
    if (result.id)
      this.rememberOwnSend(result.id);
    return result;
  }
  ack(ids, how) {
    const list = [...new Set(ids)].filter((id) => typeof id === "string" && id.length > 0);
    if (list.length === 0)
      return;
    this.pending.remove(list);
    for (const id of list) {
      if (how === "dismissed" && this.settled.get(id) === "model")
        continue;
      this.settle(id, how);
      this.acks[how].add(id);
    }
    this.flushAcks();
  }
  async drain() {
    if (this.stopped)
      return;
    this.draining = true;
    this.flushAcks();
    this.clearReconnectTimer();
    this.clearWatchdog();
    this.clearStandbyRetry();
    const sock = this.ws;
    this.ws = null;
    if (sock) {
      try {
        sock.close(1000, "drain");
      } catch {}
    }
    this.finish({ kind: "drain" });
  }
  wsUrl() {
    return `${this.client.apiUrl().replace(/^http/, "ws")}/ws`;
  }
  emitStatus(s) {
    this.statusChannel.push(s);
  }
  clearWatchdog() {
    this.watchdogTimer?.clear();
    this.watchdogTimer = null;
  }
  clearReconnectTimer() {
    this.reconnectTimer?.clear();
    this.reconnectTimer = null;
  }
  clearStandbyRetry() {
    this.standbyTimer?.clear();
    this.standbyTimer = null;
  }
  async connectOrStandby() {
    if (this.draining || this.stopped)
      return;
    if (this.lock) {
      const decision = await this.lock.acquire();
      if (this.draining || this.stopped)
        return;
      if (decision === "lost")
        return;
      if (decision === "standby") {
        const holder = await this.lock.holder().catch(() => null);
        if (this.draining || this.stopped)
          return;
        this.emitStatus({ kind: "standby", ...holder ? { holder } : {} });
        this.armStandbyRetry();
        return;
      }
    }
    this.clearStandbyRetry();
    this.connect();
  }
  armStandbyRetry() {
    if (this.standbyTimer)
      return;
    this.standbyTimer = this.rt.timer.setTimeout(() => {
      this.standbyTimer = null;
      this.connectOrStandby();
    }, this.opts.standbyRetryMs ?? DEFAULT_STANDBY_RETRY_MS);
  }
  async useGrant(grantId) {
    if (grantId === this.seq.grantId)
      return;
    let stored = null;
    if (grantId && this.opts.seqStore) {
      try {
        stored = await this.opts.seqStore.load(grantId);
      } catch {
        stored = null;
      }
    }
    const n = stored !== null && Number.isSafeInteger(stored) && stored > 0 ? stored : 0;
    this.seq = { grantId, last: n, saved: n, epoch: this.seq.epoch + 1 };
  }
  async connect() {
    if (this.draining || this.stopped)
      return;
    this.authenticatedAt = null;
    this.clearWatchdog();
    let cred;
    try {
      cred = await this.client.wsAuth();
    } catch (err) {
      this.credentialFailure(null, err);
      return;
    }
    if (this.draining || this.stopped)
      return;
    await this.useGrant(this.client.grant()?.sessionId ?? null);
    if (this.draining || this.stopped)
      return;
    let sock;
    try {
      sock = new this.rt.WebSocket(this.wsUrl());
    } catch (err) {
      this.credentialFailure(null, err);
      return;
    }
    this.ws = sock;
    this.sockBearer = cred.token;
    this.sockGrant = this.client.grant();
    let lastInboundAt = this.rt.clock.now();
    sock.addEventListener("open", async () => {
      const lockHeld = this.lock ? await this.lock.isHeld() : false;
      if (this.ws !== sock)
        return;
      const sessionInfo = {
        ...this.opts.sessionInfo,
        sessionKey: this.client.sessionKey(),
        softwareId: this.client.softwareId(),
        clientVersion: this.client.softwareVersion()
      };
      const supersede = lockHeld || this.opts.supersede === true;
      try {
        sock.send(JSON.stringify({
          type: "auth",
          v: PROTOCOL_VERSION,
          token: cred.token,
          dpop: cred.dpop,
          lastSeq: this.seq.saved,
          sessionInfo,
          ...supersede ? { supersede: true } : {}
        }));
      } catch {}
    });
    sock.addEventListener("message", (ev) => {
      lastInboundAt = this.rt.clock.now();
      if (this.ws !== sock)
        return;
      this.onFrame(String(ev.data));
    });
    sock.addEventListener("close", (ev) => {
      if (this.ws !== sock)
        return;
      this.clearWatchdog();
      this.clearReconcile();
      this.ws = null;
      const authenticatedFor = this.authenticatedAt === null ? 0 : this.rt.clock.now() - this.authenticatedAt;
      this.authenticatedAt = null;
      const code = ev.code;
      const reason = ev.reason || undefined;
      const cls = classifyClose(code, reason);
      if (cls !== this.lastClose.cls)
        this.reconnectAttempt = 0;
      this.lastClose = { cls, code, reason };
      this.emitStatus({ kind: "closed", code, reason, cls });
      if (cls === "expired" || cls === "evicted" || code === 4001)
        this.client.invalidateAccess(this.sockBearer);
      if (cls === "superseded") {
        this.client.invalidateAccess(this.sockBearer);
        (this.lock ? this.lock.holder().catch(() => null) : Promise.resolve(null)).then((h) => {
          const holder = h && typeof h.pid === "number" ? { pid: h.pid, ...h.version !== undefined ? { version: h.version } : {} } : undefined;
          this.finish({
            kind: "superseded",
            close: closeOutcome(cls, code, reason, { myVersion: this.client.softwareVersion(), ...holder ? { holder } : {} })
          });
          this.lock?.markLost();
        });
        return;
      }
      if (cls === "too-old" || cls === "session-in-use") {
        const outcome = closeOutcome(cls, code, reason, { myVersion: this.client.softwareVersion() });
        this.finish({ kind: stopKindFromClose(outcome), close: outcome });
        return;
      }
      if (cls === "revoked" && reason === "session revoked")
        this.client.sessionRevoked(this.sockGrant?.sessionId ?? null);
      if (cls === "revoked" && (reason === "installation revoked" || reason === "installation locked")) {
        this.client.installationRevoked(this.sockGrant?.installationId ?? null).catch(() => "absent").then((r) => {
          if (this.ws !== null && this.ws !== sock)
            return;
          if (r === "switched") {
            this.lastClose = { cls: "transient" };
            this.scheduleReconnect();
          } else {
            this.finish({
              kind: "revoked",
              close: closeOutcome(cls, code, reason, { keyDeleted: r === "deleted", myVersion: this.client.softwareVersion() })
            });
          }
        });
        return;
      }
      if (cls === "revoked") {
        this.finish({ kind: "revoked", close: closeOutcome(cls, code, reason, { myVersion: this.client.softwareVersion() }) });
        return;
      }
      if (authenticatedFor >= REMINT_REARM_MS)
        this.remintedAfter4001 = false;
      const immediate = code === 4001 && !this.remintedAfter4001;
      if (immediate)
        this.remintedAfter4001 = true;
      this.scheduleReconnect(immediate);
    });
    sock.addEventListener("error", () => {});
    this.watchdogTimer = this.rt.timer.setInterval(() => {
      if (this.rt.clock.now() - lastInboundAt < this.livenessMs())
        return;
      const wasCurrent = this.ws === sock;
      if (wasCurrent)
        this.ws = null;
      this.clearWatchdog();
      this.clearReconcile();
      try {
        sock.close();
      } catch {}
      if (wasCurrent)
        this.scheduleReconnect();
    }, Math.max(1, Math.floor(this.livenessMs() / 3)), { unref: true });
  }
  livenessMs() {
    if (this.opts.livenessTimeoutMs !== undefined)
      return this.opts.livenessTimeoutMs;
    return this.heartbeatMs !== null ? this.heartbeatMs * 3 : DEFAULT_LIVENESS_MS;
  }
  credentialFailure(sock, err) {
    if (sock !== null && this.ws !== sock)
      return;
    this.ws = null;
    this.clearWatchdog();
    this.clearReconcile();
    if (sock) {
      try {
        sock.close();
      } catch {}
    }
    if (isTerminalCredentialError(err)) {
      const kind = isAgentClientError(err) && err.code === "too_old" ? "too-old" : "credential";
      this.finish({ kind, credential: err });
      return;
    }
    const code = isAgentClientError(err) ? err.code : undefined;
    if (code === "rate_limited" || code === "not_enrolled") {
      this.lastClose = { cls: "credential" };
      const minDelayMs = code === "rate_limited" && isAgentClientError(err) && typeof err.retryAfterS === "number" ? Math.max(0, err.retryAfterS) * 1000 : 0;
      this.scheduleReconnect(false, minDelayMs);
      return;
    }
    this.lastClose = { cls: "transient" };
    this.scheduleReconnect();
  }
  scheduleReconnect(immediate = false, minDelayMs = 0) {
    if (this.draining || this.stopped)
      return;
    if (this.reconnectTimer)
      return;
    if (!immediate)
      this.reconnectAttempt++;
    let delayMs = immediate ? 0 : reconnectDelay(this.reconnectAttempt, this.lastClose.cls, this.rt.random);
    if (delayMs === null)
      return;
    if (minDelayMs > delayMs)
      delayMs = minDelayMs;
    this.emitStatus({ kind: "reconnecting", attempt: this.reconnectAttempt, delayMs, cls: this.lastClose.cls });
    this.reconnectTimer = this.rt.timer.setTimeout(() => {
      this.reconnectTimer = null;
      this.connectOrStandby();
    }, delayMs);
  }
  finish(stop) {
    if (this.stopped)
      return;
    this.stopped = stop;
    this.clearReconnectTimer();
    this.clearWatchdog();
    this.clearStandbyRetry();
    this.clearReconcile();
    this.unsubscribeRotation();
    this.unsubscribeLockLost?.();
    this.lock?.release();
    this.pushQueue.length = 0;
    this.adapter.close?.();
    this.emitStatus({ kind: "stopped", stop });
    this.statusChannel.end();
    this.resolveClosed(stop);
  }
  sendReauth(frame) {
    if (this.ws && this.ws.readyState === WS_READY_STATE.OPEN && this.authenticatedAt !== null) {
      try {
        this.ws.send(JSON.stringify({ type: "reauth", token: frame.token, dpop: frame.dpop }));
        this.sockBearer = frame.token;
        this.sockGrant = this.client.grant();
      } catch {}
    }
  }
  sendJson(frame) {
    if (!this.ws || this.ws.readyState !== WS_READY_STATE.OPEN)
      return false;
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }
  flushAcks() {
    if (this.authenticatedAt === null)
      return;
    for (const how of ["model", "dismissed"]) {
      const queued = [...this.acks[how]];
      for (let i = 0;i < queued.length; i += MAX_ACK_IDS) {
        const ids = queued.slice(i, i + MAX_ACK_IDS);
        if (!this.sendJson({ type: "ack", ids, how }))
          return;
        for (const id of ids)
          this.acks[how].delete(id);
      }
    }
  }
  noteSeq(seq) {
    this.lastSequencedAt = this.rt.clock.now();
    if (!(seq > this.seq.last))
      return;
    this.seq.last = seq;
    const { grantId, epoch } = this.seq;
    if (!grantId)
      return;
    const store = this.opts.seqStore;
    if (!store) {
      this.seq.saved = seq;
      return;
    }
    this.seqWrites = this.seqWrites.then(() => store.save(grantId, seq)).then(() => {
      if (this.seq.epoch === epoch && seq > this.seq.saved)
        this.seq.saved = seq;
    }, () => {});
  }
  clearReconcile() {
    this.reconcileTimer?.clear();
    this.reconcileTimer = null;
  }
  armReconcile() {
    this.clearReconcile();
    const after = this.opts.reconcileAfterMs ?? DEFAULT_RECONCILE_MS;
    this.lastSequencedAt = this.rt.clock.now();
    this.reconcileTimer = this.rt.timer.setInterval(() => {
      if (this.authenticatedAt === null || this.rt.clock.now() - this.lastSequencedAt < after)
        return;
      this.lastSequencedAt = this.rt.clock.now();
      this.reconcile();
    }, Math.max(1, Math.min(after, 60000)), { unref: true });
  }
  async reconcile() {
    let res;
    try {
      res = await this.client.api.deliveries.list();
    } catch {
      return;
    }
    for (const e of res.entries ?? []) {
      const entry = entryFrom(e.kind, e.payload, true);
      if (entry)
        this.deliver(entry);
    }
  }
  onFrame(raw) {
    let env;
    try {
      env = JSON.parse(raw);
    } catch {
      return;
    }
    if (env?.v !== PROTOCOL_VERSION || typeof env.type !== "string")
      return;
    if (typeof env.seq === "number" && Number.isSafeInteger(env.seq))
      this.noteSeq(env.seq);
    const p = env.payload ?? {};
    switch (env.type) {
      case "authenticated":
        this.handleAuthenticated(p);
        return;
      case "ping":
        this.sendJson({ type: "pong", lastSeq: this.seq.saved });
        return;
      case "message":
      case "task_event":
      case "action_request": {
        const entry = entryFrom(env.type, p, p.redelivery === true);
        if (entry)
          this.deliver(entry);
        return;
      }
      case "catchup":
        this.emitStatus({ kind: "catchup", channels: Array.isArray(p.channels) ? p.channels : [] });
        return;
      case "invalid_session": {
        this.seq = { ...this.seq, last: 0, saved: 0, epoch: this.seq.epoch + 1 };
        const lost = p.lost ?? { frames: 0, from: null };
        this.emitStatus({ kind: "invalid_session", lost });
        return;
      }
      case "drain": {
        const sock = this.ws;
        this.ws = null;
        this.clearWatchdog();
        this.clearReconcile();
        this.authenticatedAt = null;
        try {
          sock?.close(1000, "drain");
        } catch {}
        this.lastClose = { cls: "transient" };
        this.scheduleReconnect(true);
        return;
      }
      default:
        return;
    }
  }
  handleAuthenticated(p) {
    this.myContextId = typeof p.contextId === "string" && p.contextId ? p.contextId : null;
    this.agentId = typeof p.agentId === "string" ? p.agentId : undefined;
    this.agentName = typeof p.agentName === "string" ? p.agentName : undefined;
    this.heartbeatMs = typeof p.heartbeatMs === "number" && p.heartbeatMs > 0 ? p.heartbeatMs : null;
    this.authenticatedAt = this.rt.clock.now();
    this.reconnectAttempt = 0;
    this.lastClose = { cls: "transient" };
    this.emitStatus({
      kind: "authenticated",
      agentId: this.agentId,
      agentName: this.agentName,
      handle: typeof p.handle === "string" ? p.handle : null,
      contextId: this.myContextId,
      advice: p.client
    });
    this.flushAcks();
    this.armReconcile();
  }
  deliver(entry) {
    const settled = this.settled.get(entry.id);
    if (settled) {
      this.acks[settled].add(entry.id);
      this.flushAcks();
      return;
    }
    if (this.pending.has(entry.id))
      return;
    if (entry.kind === "message" && !isAddressed(entry.message.deliveryReasons) && this.opts.filter && !this.opts.filter(entry.message))
      return;
    this.pending.add(pendingMeta(entry));
    if (this.adapter.mode !== "channel" || !this.adapter.push)
      return;
    this.pushQueue.push(entry);
    const max = this.opts.bufferSize ?? DEFAULT_BUFFER_SIZE;
    while (this.pushQueue.length > max) {
      const dropped = this.pushQueue.shift();
      this.pending.remove([dropped.id]);
      this.emitStatus({ kind: "slow-consumer", droppedId: dropped.id });
    }
    this.drainPushQueue();
  }
  async drainPushQueue() {
    if (this.pushing)
      return;
    this.pushing = true;
    try {
      while (this.pushQueue.length > 0 && !this.stopped) {
        const entry = this.pushQueue.shift();
        try {
          await this.adapter.push(entry);
          this.pending.markPushed(entry.id, this.rt.clock.now());
        } catch {}
      }
    } finally {
      this.pushing = false;
    }
  }
  settle(id, how) {
    this.settled.delete(id);
    this.settled.set(id, how);
    if (this.settled.size > SETTLED_MAX) {
      const oldest = this.settled.keys().next().value;
      if (oldest !== undefined)
        this.settled.delete(oldest);
    }
  }
  rememberOwnSend(id) {
    this.ownMessageIds.add(id);
    if (this.ownMessageIds.size > OWN_SENT_MAX) {
      const first = this.ownMessageIds.values().next().value;
      if (first !== undefined)
        this.ownMessageIds.delete(first);
    }
  }
}
function entryFrom(kind, p, redelivery) {
  if (kind === "message") {
    const { message, deliveryReasons } = p;
    if (!message || typeof message.id !== "string")
      return null;
    return { kind: "message", id: message.id, redelivery, message: { ...message, deliveryReasons: Array.isArray(deliveryReasons) ? deliveryReasons : [] } };
  }
  if (kind === "task_event") {
    const event = p;
    return typeof event.id === "string" ? { kind: "task_event", id: event.id, redelivery, event } : null;
  }
  if (kind === "action_request") {
    const action = p;
    return typeof action.id === "string" ? { kind: "action_request", id: action.id, redelivery, action } : null;
  }
  return null;
}
function pendingMeta(entry) {
  const base = { id: entry.id, kind: entry.kind, pushedAt: null, redelivery: entry.redelivery };
  if (entry.kind === "message") {
    const m = entry.message;
    return { ...base, channelId: m.channelId ?? null, threadId: m.threadId ?? null, type: m.type ?? null, senderHandle: m.senderHandle ?? null };
  }
  if (entry.kind === "task_event") {
    return { ...base, channelId: null, threadId: entry.event.threadId ?? null, type: entry.event.change ?? null, senderHandle: null };
  }
  return { ...base, channelId: null, threadId: null, type: entry.action.action ?? null, senderHandle: null };
}

// src/runtime/sdk-version.generated.ts
var SDK_VERSION = "0.5.0";

// src/runtime/api.ts
var HTTP_TIMEOUT_MS = 20000;

class ApiRequestError extends Error {
  name = "ApiRequestError";
  status;
  body;
  retryAfterS;
  constructor(status, body, retryAfterS) {
    super(`Bridge API error ${status}`);
    this.status = status;
    this.body = body;
    this.retryAfterS = retryAfterS;
  }
}
function isApiRequestError(e) {
  const o = e;
  return typeof o === "object" && o !== null && o.name === "ApiRequestError" && typeof o.status === "number";
}
async function request(rt, client, method, path, opts, retried = false) {
  const auth = await client.httpAuth(method, path);
  const dl = opts.signal ? undefined : deadline(HTTP_TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await rt.fetch(`${client.apiUrl()}${path}`, {
      method,
      signal: opts.signal ?? dl.signal,
      headers: {
        Authorization: auth.headers.Authorization,
        DPoP: auth.headers.DPoP,
        "Content-Type": "application/json",
        "User-Agent": userAgent(SDK_VERSION, {
          softwareId: client.softwareId(),
          softwareVersion: client.softwareVersion(),
          runtimeName: rt.userAgent.runtimeName,
          runtimeVersion: rt.userAgent.runtimeVersion,
          os: rt.userAgent.os,
          arch: rt.userAgent.arch
        })
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
    text = await res.text();
  } finally {
    dl?.clear();
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (res.status === 401 && !retried) {
    const challenge = res.headers.get("www-authenticate") ?? "";
    if (/error="?use_dpop_nonce/.test(challenge) && res.headers.get("dpop-nonce")) {
      client.noteResourceNonce(res.headers.get("dpop-nonce"));
    } else if (/error="?invalid_dpop_proof/.test(challenge)) {
      client.observeServerDate(res.headers.get("date"));
    } else {
      client.invalidateAccess(auth.token);
    }
    return request(rt, client, method, path, opts, true);
  }
  if (res.status === 429) {
    throw new ApiRequestError(429, json, Number(res.headers.get("retry-after")) || undefined);
  }
  if (!res.ok)
    throw new ApiRequestError(res.status, json);
  return json;
}
function createApi(rt, client) {
  const req = (method, path, opts = {}) => request(rt, client, method, path, opts);
  const qs = (params) => {
    const p = new URLSearchParams;
    for (const [k, v] of Object.entries(params))
      if (v !== undefined)
        p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : "";
  };
  return {
    channels: {
      list: () => req("GET", "/api/channels"),
      readState: () => req("GET", "/api/channels/read-state"),
      markRead: (channelId, body) => req("POST", `/api/channels/${encodeURIComponent(channelId)}/read`, { body: body ?? {} })
    },
    messages: {
      list: (p) => req("GET", `/api/messages${qs(p)}`),
      create: (channelId, body) => req("POST", "/api/messages", { body: { channelId, ...body } }),
      receipts: (ids) => req("GET", `/api/messages/receipts?ids=${ids.map(encodeURIComponent).join(",")}`)
    },
    threads: {
      list: (p) => req("GET", `/api/threads${qs({ channel: p.channel, q: p.query })}`),
      messages: (threadId, p = {}) => req("GET", `/api/threads/${encodeURIComponent(threadId)}/messages${qs(p)}`),
      events: (threadId) => req("GET", `/api/threads/${encodeURIComponent(threadId)}/events`),
      reply: (threadId, body) => req("POST", `/api/threads/${encodeURIComponent(threadId)}/messages`, { body }),
      rename: (threadId, title) => req("PUT", `/api/threads/${encodeURIComponent(threadId)}`, { body: { title } }),
      markRead: (threadId, body) => req("POST", `/api/threads/${encodeURIComponent(threadId)}/read`, { body: body ?? {} }),
      markAnswer: (threadId, messageId) => req("PUT", `/api/threads/${encodeURIComponent(threadId)}/answer`, { body: { messageId } }),
      unmarkAnswer: (threadId) => req("DELETE", `/api/threads/${encodeURIComponent(threadId)}/answer`),
      setKind: (threadId, kind) => req("PUT", `/api/threads/${encodeURIComponent(threadId)}/kind`, { body: { kind } })
    },
    agents: {
      list: () => req("GET", "/api/agents"),
      contexts: (agentId) => req("GET", `/api/agents/${encodeURIComponent(agentId)}/contexts`),
      setContextLabel: (agentId, contextId, label) => req("PUT", `/api/agents/${encodeURIComponent(agentId)}/contexts/${encodeURIComponent(contextId)}/label`, { body: { label } })
    },
    presence: {
      list: () => req("GET", "/api/presence")
    },
    deliveries: {
      list: () => req("GET", "/api/deliveries")
    },
    tasks: {
      claim: (messageId) => req("POST", `/api/tasks/${encodeURIComponent(messageId)}/claim`),
      updateStatus: (messageId, body) => req("PUT", `/api/tasks/${encodeURIComponent(messageId)}/status`, { body }),
      cancel: (messageId, reason) => req("POST", `/api/tasks/${encodeURIComponent(messageId)}/cancel`, { body: reason ? { reason } : {} }),
      list: (p = {}) => req("GET", `/api/tasks${qs(p)}`)
    }
  };
}

// src/runtime/device.ts
async function pollDeviceCode(rt, poll, auth, opts = {}) {
  const sleep = (ms) => new Promise((resolve) => {
    const done = () => {
      handle.clear();
      opts.signal?.removeEventListener("abort", done);
      resolve();
    };
    const handle = rt.timer.setTimeout(done, ms);
    opts.signal?.addEventListener("abort", done, { once: true });
  });
  let intervalS = Math.max(1, auth.interval || 5);
  let extraS = 0;
  const deadline2 = rt.clock.now() + auth.expires_in * 1000;
  for (;; ) {
    await sleep((intervalS + extraS) * 1000);
    extraS = 0;
    if (opts.signal?.aborted)
      return { ok: false, error: "cancelled" };
    if (rt.clock.now() > deadline2)
      return { ok: false, error: "expired_token" };
    try {
      return { ok: true, grant: await poll() };
    } catch (e) {
      const a = classifyTokenError(e);
      switch (a.kind) {
        case "pending":
        case "transient":
        case "new_proof":
          continue;
        case "slow_down":
          intervalS += 5;
          continue;
        case "rate_limited":
          extraS = a.retryAfterS;
          continue;
        case "aborted":
          return { ok: false, error: "cancelled" };
        case "installation_gone":
        case "clock":
        case "session_revoked":
        case "session_limit":
        case "corrupt_state":
        case "update_required":
        case "too_old":
        case "refused":
          return { ok: false, error: isOAuthError(e) ? e.error : e instanceof Error ? e.message : String(e) };
        default:
          return assertNever(a);
      }
    }
  }
}

// src/runtime/client.ts
var EXPIRY_SLACK_MS = 60000;

class AgentClient {
  rt;
  opts;
  api;
  access = null;
  inflight = null;
  ticker = null;
  lateRefreshTimer = null;
  sessionBlocked = false;
  reconnectNext = false;
  mintNotBefore = 0;
  resourceNonce;
  stopped = null;
  rotateOnNextMint = false;
  lastSessionId = null;
  rotationListeners = new Set;
  clock;
  tokens;
  constructor(rt, opts) {
    this.rt = rt;
    this.opts = opts;
    this.clock = new Clock(() => rt.clock.now());
    this.tokens = new TokenClient({
      clock: this.clock,
      clientId: opts.softwareId,
      softwareId: opts.softwareId,
      softwareVersion: opts.softwareVersion,
      fetch: rt.fetch,
      timeouts: opts.timeouts
    });
    this.api = createApi(rt, this);
  }
  static async open(rt, opts) {
    apiOrigin(opts.apiUrl);
    return new AgentClient(rt, opts);
  }
  apiUrl() {
    return this.opts.apiUrl;
  }
  softwareId() {
    return this.opts.softwareId;
  }
  softwareVersion() {
    return this.opts.softwareVersion;
  }
  sessionKey() {
    return this.opts.sessionKey;
  }
  lockOpts() {
    return this.opts.timeouts?.mintBudgetMs !== undefined ? { budgetMs: this.opts.timeouts.mintBudgetMs } : {};
  }
  async source() {
    return await this.opts.store.read() ? "installation" : "none";
  }
  async current() {
    if (this.stopped)
      throw this.stopped;
    const a = this.access;
    if (a && this.rt.clock.now() < a.expiresAt - EXPIRY_SLACK_MS)
      return a;
    return this.renew();
  }
  async accessToken() {
    return (await this.current()).token;
  }
  async httpAuth(method, path) {
    const a = await this.current();
    const proof = await dpopProof(a.signer, this.clock, { htm: method, htu: httpHtu(this.opts.apiUrl, path), accessToken: a.token, nonce: this.resourceNonce });
    return { token: a.token, headers: { Authorization: `DPoP ${a.token}`, DPoP: proof } };
  }
  noteResourceNonce(nonce) {
    if (nonce)
      this.resourceNonce = nonce;
  }
  observeServerDate(date) {
    this.clock.observe(date);
  }
  async wsAuth() {
    const a = await this.current();
    return { token: a.token, dpop: await this.wsProof(a) };
  }
  wsProof(a) {
    return dpopProof(a.signer, this.clock, { htm: "GET", htu: wsHtu(this.opts.apiUrl), accessToken: a.token });
  }
  invalidateAccess(tokenUsed) {
    if (tokenUsed !== undefined && this.access?.token !== tokenUsed)
      return;
    if (this.access)
      this.rotateOnNextMint = true;
    this.access = null;
  }
  grant() {
    return this.access ? { installationId: this.access.installationId, sessionId: this.access.sessionId } : null;
  }
  onAccessRotated(cb) {
    this.rotationListeners.add(cb);
    return () => this.rotationListeners.delete(cb);
  }
  requestSessionReconnect() {
    this.stopped = null;
    if (this.sessionBlocked)
      this.reconnectNext = true;
  }
  refreshStop() {
    return this.stopped;
  }
  renew() {
    if (this.stopped)
      return Promise.reject(this.stopped);
    if (!this.inflight) {
      const hadAccess = this.access !== null || this.rotateOnNextMint;
      this.inflight = this.renewUnderLock().then(async (a) => {
        this.access = a;
        this.lastSessionId = a.sessionId;
        if (hadAccess)
          this.rotateOnNextMint = false;
        this.armTicker();
        if (hadAccess) {
          const dpop = await this.wsProof(a);
          for (const cb of this.rotationListeners)
            cb({ token: a.token, dpop });
        }
        return a;
      }).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }
  async renewUnderLock() {
    try {
      return await this.mintLocked();
    } catch (e) {
      const err = this.toClientError(e);
      if (err.code === "refused" || err.code === "session_limit" || err.code === "too_old" || err.code === "server_mismatch")
        this.stopped = err;
      throw err;
    }
  }
  async mintLocked() {
    if (this.sessionBlocked && !this.reconnectNext) {
      throw new AgentClientError({ code: "session_revoked", message: "this session was revoked — an explicit reconnect is required" });
    }
    const waitS = Math.ceil((this.mintNotBefore - this.rt.clock.now()) / 1000);
    if (waitS > 0)
      throw new AgentClientError({ code: "rate_limited", retryAfterS: waitS, message: `rate-limited — retry in ${waitS}s` });
    return this.opts.store.withLock((signal) => this.mintInside(signal), this.lockOpts());
  }
  async mintInside(signal) {
    const record = await this.opts.store.read();
    if (!record)
      throw new AgentClientError({ code: "not_enrolled", message: "no installation on this store — enrol first" });
    let installedOrigin;
    try {
      installedOrigin = apiOrigin(record.installation.apiUrl);
    } catch (e) {
      throw new AgentClientError({
        code: "server_mismatch",
        message: `this store's credentials carry an unreadable apiUrl (${JSON.stringify(record.installation.apiUrl)}: ${e instanceof Error ? e.message : String(e)}) — re-enrol (or log in again) for ${this.opts.apiUrl}`,
        configuredApiUrl: apiOrigin(this.opts.apiUrl)
      });
    }
    const configuredOrigin = apiOrigin(this.opts.apiUrl);
    if (installedOrigin !== configuredOrigin) {
      throw new AgentClientError({
        code: "server_mismatch",
        message: `this store's credentials belong to ${installedOrigin}; this client is configured for ${configuredOrigin} — re-enrol (or log in again) for ${configuredOrigin}`,
        installedApiUrl: installedOrigin,
        configuredApiUrl: configuredOrigin
      });
    }
    const meta = await this.tokens.discover(record.installation.apiUrl, signal);
    if (!supportsKeyCredentials(meta)) {
      throw new AgentClientError({ code: "refused", message: "this Bridge server does not support key credentials (RFC-016)" });
    }
    const signer = this.opts.signer ?? await softwareSigner(record.privateJwk);
    if (signer.jkt !== record.installation.jkt) {
      throw new AgentClientError({ code: "refused", message: "the store's key does not match its installation" });
    }
    let attempt = await this.opts.store.readAttempt();
    if (attempt === null) {
      attempt = randomB64url(16);
      await this.opts.store.writeAttempt(attempt);
    }
    const reconnect = this.reconnectNext;
    let g;
    try {
      g = await this.tokens.mint(meta, signer, {
        installationId: record.installation.installationId,
        joinState: record.joinState,
        attempt,
        sessionKey: this.opts.sessionKey,
        reconnect,
        platform: `${this.rt.userAgent.os}-${this.rt.userAgent.arch}`,
        clientVersion: this.opts.softwareVersion
      }, { signal });
    } catch (e) {
      throw await this.mintRefused(e);
    }
    await this.opts.store.writeJoinState(g.join_state);
    await this.opts.store.clearAttempt();
    this.sessionBlocked = false;
    this.reconnectNext = false;
    return this.toAccess(g, record.installation, signer);
  }
  async mintRefused(e) {
    const a = classifyTokenError(e);
    switch (a.kind) {
      case "installation_gone":
        await this.opts.store.clear();
        return new AgentClientError({ code: "installation_gone", reason: a.reason, cause: e });
      case "clock":
        return new AgentClientError({ code: "clock", cause: e });
      case "session_revoked":
        this.sessionBlocked = true;
        this.reconnectNext = false;
        return new AgentClientError({ code: "session_revoked", cause: e });
      case "session_limit":
        return new AgentClientError({ code: "session_limit", cause: e });
      case "corrupt_state":
        return new AgentClientError({ code: "corrupt_state", cause: e });
      case "update_required":
        return new AgentClientError({ code: "update_required", cause: e });
      case "too_old": {
        const minimum = isOAuthError(e) ? e.description?.match(/>=\s*(\d+\.\d+\.\d+)/)?.[1] : undefined;
        return new AgentClientError({ code: "too_old", minimum, cause: e });
      }
      case "rate_limited":
        this.mintNotBefore = this.rt.clock.now() + a.retryAfterS * 1000;
        return new AgentClientError({ code: "rate_limited", retryAfterS: a.retryAfterS, cause: e });
      case "refused":
        return new AgentClientError({ code: "refused", cause: e });
      case "new_proof":
      case "transient":
        return this.toClientError(e);
      case "aborted":
        return new AgentClientError({ code: "aborted", cause: e });
      case "pending":
      case "slow_down":
        return new AgentClientError({ code: "refused", cause: e });
      default:
        return assertNever(a);
    }
  }
  toClientError(e) {
    if (isAgentClientError(e))
      return e;
    if (isOAuthError(e))
      return new AgentClientError({ code: "network", message: `${e.error} (${e.status})`, cause: e });
    return new AgentClientError({ code: "network", message: e instanceof Error ? e.message : String(e), cause: e });
  }
  toAccess(g, inst, signer) {
    const now = this.rt.clock.now();
    const lifeMs = Math.max(1, g.expires_in) * 1000;
    const marginMs = Math.min(600000, lifeMs / 6);
    const jitterMs = this.rt.random() * Math.min(120000, marginMs / 2);
    return { token: g.access_token, expiresAt: now + lifeMs, refreshAt: now + lifeMs - marginMs - jitterMs, sessionId: g.session_id, installationId: inst.installationId, signer };
  }
  armTicker() {
    if (this.ticker)
      return;
    const due = () => {
      const a = this.access;
      return a !== null && !this.inflight && !this.stopped && this.rt.clock.now() >= a.refreshAt;
    };
    const go = () => {
      if (!due())
        return;
      this.renew().catch(() => {});
    };
    this.ticker = this.rt.timer.setInterval(() => {
      if (!due())
        return;
      const late = this.rt.clock.now() - this.access.refreshAt > 60000;
      if (late) {
        this.lateRefreshTimer?.clear();
        this.lateRefreshTimer = this.rt.timer.setTimeout(() => {
          this.lateRefreshTimer = null;
          go();
        }, this.rt.random() * 30000, { unref: true });
      } else
        go();
    }, 15000, { unref: true });
  }
  sessionRevoked(sessionId) {
    if (sessionId !== null && sessionId !== this.lastSessionId)
      return;
    this.access = null;
    this.sessionBlocked = true;
    this.reconnectNext = false;
  }
  async installationRevoked(revokedId) {
    if (revokedId === null || this.access?.installationId === revokedId)
      this.access = null;
    return this.opts.store.withLock(async () => {
      const record = await this.opts.store.read();
      if (!record)
        return "absent";
      if (record.installation.installationId !== revokedId)
        return "switched";
      await this.opts.store.clear();
      return "deleted";
    }, this.lockOpts());
  }
  async enrolWithKey(enrolmentKey, installationName) {
    const meta = await this.discoverOrRefuse();
    let key = await generateSoftwareKey();
    let g;
    try {
      g = await this.tokens.enrolWithKey(meta, key.signer, { enrolmentKey, installationName });
    } catch (e) {
      if (!isKeyAlreadyEnrolled(e))
        throw this.toClientError(e);
      key = await generateSoftwareKey();
      g = await this.tokens.enrolWithKey(meta, key.signer, { enrolmentKey, installationName });
    }
    await this.writeEnrolment(meta, installationName, g, key);
    return g;
  }
  async enrolWithAuthorizationCode(p, installationName) {
    const meta = await this.discoverOrRefuse();
    const key = await generateSoftwareKey();
    const g = await this.tokens.exchangeCode(meta, key.signer, p).catch((e) => {
      throw this.toClientError(e);
    });
    await this.writeEnrolment(meta, installationName, g, key);
    return g;
  }
  async deviceAuthorization(installationName) {
    const meta = await this.discoverOrRefuse();
    const auth = await this.tokens.deviceAuthorization(meta, installationName).catch((e) => {
      throw this.toClientError(e);
    });
    let key = await generateSoftwareKey();
    let freshKeyUsed = false;
    const poll = async () => {
      try {
        return await this.tokens.pollDeviceCode(meta, key.signer, auth.device_code);
      } catch (e) {
        if (!isKeyAlreadyEnrolled(e) || freshKeyUsed)
          throw e;
        freshKeyUsed = true;
        key = await generateSoftwareKey();
        return await this.tokens.pollDeviceCode(meta, key.signer, auth.device_code);
      }
    };
    const complete = async (opts = {}) => {
      const r = await pollDeviceCode(this.rt, poll, auth, opts);
      if (!r.ok)
        throw new AgentClientError({ code: r.error === "cancelled" ? "aborted" : "refused", message: r.error });
      await this.writeEnrolment(meta, installationName, r.grant, key);
      return r.grant;
    };
    return { auth, complete };
  }
  async discoverOrRefuse() {
    const meta = await this.tokens.discover(this.opts.apiUrl).catch((e) => {
      throw this.toClientError(e);
    });
    if (!supportsKeyCredentials(meta)) {
      throw new AgentClientError({ code: "refused", message: "this Bridge server does not support key credentials (RFC-016)" });
    }
    return meta;
  }
  async writeEnrolment(meta, name, g, key) {
    await this.opts.store.withLock(async (signal) => {
      const old = await this.opts.store.read();
      const oldAttempt = old ? await this.opts.store.readAttempt() : null;
      try {
        await this.opts.store.write({
          installation: {
            installationId: g.installation_id,
            installationName: name,
            apiUrl: this.opts.apiUrl,
            jkt: key.signer.jkt,
            keyStorage: key.signer.keyStorage,
            ...g.agent ? { agent: g.agent } : {},
            ...g.workspace ? { workspace: g.workspace } : {}
          },
          privateJwk: key.privateJwk,
          joinState: g.join_state
        });
        await this.opts.store.clearAttempt();
      } catch (e) {
        await this.revokeGrant(meta, key.signer, g, signal).catch(() => {});
        if (old && old.installation.installationId !== g.installation_id) {
          await this.revokeRecord(old, oldAttempt, signal).catch(() => {});
        }
        throw e;
      }
      this.access = null;
      this.stopped = null;
      this.sessionBlocked = false;
      this.reconnectNext = false;
      this.mintNotBefore = 0;
      this.resourceNonce = undefined;
      if (old && old.installation.installationId !== g.installation_id) {
        await this.revokeRecord(old, oldAttempt, signal).catch(() => {});
      }
    }, this.lockOpts());
  }
  async revokeGrant(meta, signer, g, signal) {
    await this.tokens.revoke(meta, signer, { installationId: g.installation_id, joinState: g.join_state, attempt: null, scope: "installation" }, { signal });
  }
  async revokeRecord(record, attempt, signal) {
    const oldMeta = await this.tokens.discover(record.installation.apiUrl, signal);
    const signer = await softwareSigner(record.privateJwk);
    await this.tokens.revoke(oldMeta, signer, { installationId: record.installation.installationId, joinState: record.joinState, attempt, scope: "installation" }, { signal });
  }
  async logout(opts = {}) {
    const revoke = opts.revoke ?? true;
    await this.opts.store.withLock(async (signal) => {
      const record = await this.opts.store.read();
      if (record && revoke) {
        try {
          const meta = await this.tokens.discover(record.installation.apiUrl, signal);
          const signer = this.opts.signer ?? await softwareSigner(record.privateJwk);
          await this.tokens.revoke(meta, signer, { installationId: record.installation.installationId, joinState: record.joinState, attempt: await this.opts.store.readAttempt(), scope: "installation" }, { signal });
        } catch {}
      }
      await this.opts.store.clear();
    }, this.lockOpts());
    this.access = null;
    this.stopped = null;
    this.sessionBlocked = false;
    this.reconnectNext = false;
    this.mintNotBefore = 0;
    this.resourceNonce = undefined;
  }
  session(opts = {}) {
    return new Session(this.rt, this, opts);
  }
  stop() {
    this.ticker?.clear();
    this.ticker = null;
    this.lateRefreshTimer?.clear();
    this.lateRefreshTimer = null;
  }
}
// src/runtime/delivery.ts
function queueAdapter() {
  let offered = null;
  let reader = null;
  let closed = false;
  return {
    mode: "channel",
    push(entry) {
      return new Promise((taken) => {
        if (closed)
          return taken();
        if (reader) {
          const r = reader;
          reader = null;
          taken();
          r({ value: entry, done: false });
          return;
        }
        offered = { entry, taken };
      });
    },
    close() {
      closed = true;
      offered?.taken();
      offered = null;
      reader?.({ value: undefined, done: true });
      reader = null;
    },
    entries() {
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (offered) {
              const o = offered;
              offered = null;
              o.taken();
              return Promise.resolve({ value: o.entry, done: false });
            }
            if (closed)
              return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => reader = resolve);
          }
        })
      };
    }
  };
}
// src/runtime/turn-trigger.ts
var TURN_TRIGGER_REASONS = new Set([...ADDRESSED_REASONS, "channel"]);
function isTurnTrigger(msg, self) {
  if (msg.id && self.ownMessageIds?.has(msg.id))
    return false;
  if (self.contextId && msg.senderContextId === self.contextId)
    return false;
  return msg.deliveryReasons.some((r) => TURN_TRIGGER_REASONS.has(r));
}
// src/runtime/store.ts
function memoryCredentialStore() {
  let record = null;
  let attempt = null;
  let chain = Promise.resolve();
  return {
    async read() {
      return record;
    },
    async write(r) {
      record = r;
    },
    async writeJoinState(joinState) {
      if (record)
        record = { ...record, joinState };
    },
    async clear() {
      record = null;
      attempt = null;
    },
    async readAttempt() {
      return attempt;
    },
    async writeAttempt(a) {
      attempt = a;
    },
    async clearAttempt() {
      attempt = null;
    },
    withLock(fn, opts) {
      const runLocked = () => {
        const ac = new AbortController;
        const timer = opts?.budgetMs !== undefined ? setTimeout(() => ac.abort(new DOMException("lock budget exceeded", "TimeoutError")), opts.budgetMs) : undefined;
        timer?.unref?.();
        return fn(ac.signal).finally(() => clearTimeout(timer));
      };
      const run = chain.then(runLocked, runLocked);
      chain = run.catch(() => {});
      return run;
    }
  };
}
function memorySeqStore(initial = {}) {
  const seqs = new Map(Object.entries(initial));
  return {
    async load(grantId) {
      return seqs.get(grantId) ?? null;
    },
    async save(grantId, seq) {
      seqs.set(grantId, seq);
    }
  };
}
function memorySessionLock(initialHolder = null) {
  let held = false;
  let lost = false;
  let holder = initialHolder;
  const listeners = new Set;
  return {
    isHeld: () => held,
    onLost(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async acquire() {
      if (lost)
        return "lost";
      if (held)
        return "acquire";
      if (holder)
        return "standby";
      held = true;
      return "acquire";
    },
    async holder() {
      return holder;
    },
    release() {
      held = false;
    },
    markLost() {
      if (lost)
        return;
      lost = true;
      const wasHeld = held;
      held = false;
      if (wasHeld)
        for (const cb of [...listeners])
          cb();
    },
    holderGone() {
      holder = null;
    },
    loseToOther(other = { pid: 999999 }) {
      held = false;
      lost = true;
      holder = other;
      for (const cb of [...listeners])
        cb();
    }
  };
}
export {
  AgentClient,
  AgentClientError,
  ApiRequestError,
  Pending,
  Session,
  WS_READY_STATE,
  createRuntime,
  isAgentClientError,
  isApiRequestError,
  isTerminalCredentialError,
  isTurnTrigger,
  memoryCredentialStore,
  memorySeqStore,
  memorySessionLock,
  queueAdapter
};
