// src/core/wire.ts
var ADDRESSED_REASONS = ["target", "assignee", "mention", "thread"];
var BROADCAST_REASONS = ["channel", "member", "type", "tag"];
var ADDRESSED = new Set(ADDRESSED_REASONS);
function isAddressed(reasons) {
  if (!reasons)
    return false;
  for (const r of reasons)
    if (ADDRESSED.has(r))
      return true;
  return false;
}
var WS_CLOSE_CODES = {
  authTimeout: 4006,
  invalidToken: 4001,
  deregisteredOrArchived: 4003,
  tooManySessions: 4007,
  policy: 4008,
  tokenExpired: 4009,
  grantCheckFailed: 1011
};

// src/core/reconnect-policy.ts
var SCHEDULE = {
  transient: { baseMs: 1000, capMs: 30000 },
  expired: { baseMs: 1000, capMs: 30000 },
  evicted: { baseMs: 1000, capMs: 30000 },
  "session-cap": { baseMs: 30000, capMs: 300000 },
  credential: { baseMs: 60000, capMs: 300000 }
};
function reasonPrefix(reason) {
  if (!reason)
    return "";
  const i = reason.indexOf(":");
  return i === -1 ? reason : reason.slice(0, i);
}
function classifyClose(code, reason) {
  switch (code) {
    case WS_CLOSE_CODES.tooManySessions:
      return "session-cap";
    case WS_CLOSE_CODES.invalidToken:
    case WS_CLOSE_CODES.deregisteredOrArchived:
      return "credential";
    case WS_CLOSE_CODES.policy: {
      if (reason === "session evicted")
        return "evicted";
      const prefix = reasonPrefix(reason);
      if (prefix === "session superseded")
        return "superseded";
      if (prefix === "client too old" || prefix === "client version withdrawn")
        return "too-old";
      return "revoked";
    }
    case WS_CLOSE_CODES.tokenExpired:
      return "expired";
    default:
      return "transient";
  }
}
function reconnectDelay(attempt, cls, rand = Math.random) {
  if (cls === "revoked" || cls === "superseded" || cls === "too-old")
    return null;
  const { baseMs, capMs } = SCHEDULE[cls];
  const n = Math.max(1, Math.floor(attempt));
  const backoff = Math.min(capMs, baseMs * 2 ** (n - 1));
  return Math.round(backoff / 2 + rand() * (backoff / 2));
}
var SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
function parseSemver(v) {
  if (v === undefined)
    return null;
  const m = SEMVER_RE.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function isNewerThan(other, mine) {
  const o = parseSemver(other);
  const m = parseSemver(mine);
  if (!o || !m)
    return false;
  for (let i = 0;i < 3; i++)
    if (o[i] !== m[i])
      return o[i] > m[i];
  return false;
}
var REVOKED_STOP = {
  "session revoked": "session-revoked",
  "installation revoked": "installation-revoked",
  "installation locked": "installation-locked"
};
function closeOutcome(cls, code, reason, opts = {}) {
  const base = { class: cls, code, reason, retry: cls !== "revoked" && cls !== "superseded" && cls !== "too-old" };
  switch (cls) {
    case "revoked":
      return { ...base, stop: reason && REVOKED_STOP[reason] || "policy-unknown", ...opts.keyDeleted ? { keyDeleted: true } : {} };
    case "superseded":
      return {
        ...base,
        stop: "superseded",
        ...opts.holder ? { holder: opts.holder } : {},
        holderIsNewer: !!opts.myVersion && isNewerThan(opts.holder?.version, opts.myVersion)
      };
    case "too-old": {
      const i = reason?.indexOf(": ") ?? -1;
      return { ...base, stop: "too-old", ...i !== -1 ? { remedy: reason.slice(i + 2) } : {} };
    }
    default:
      return base;
  }
}
// src/core/lock-decision.ts
var DEFAULT_HOLDER_VERSION = "0.25.0";
var VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
function parse(v) {
  const m = VERSION_RE.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function normalize(v) {
  return (v !== undefined ? parse(v) : null) ?? parse(DEFAULT_HOLDER_VERSION);
}
function compare(a, b) {
  const [am, an, ap] = normalize(a);
  const [bm, bn, bp] = normalize(b);
  if (am !== bm)
    return am - bm;
  if (an !== bn)
    return an - bn;
  return ap - bp;
}
function decideLock(holder, me, opts = {}) {
  if (!holder)
    return "acquire";
  if (opts.takeover)
    return "takeover";
  if (holder.version !== undefined && parse(holder.version) === null)
    return "standby";
  return compare(me.version, holder.version) > 0 ? "takeover" : "standby";
}
// src/core/format-guard.ts
var KNOWN_FORMAT = 0;
function classifyVersioned(parsed, knownMax = KNOWN_FORMAT) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { kind: "absent" };
  const rawFormat = parsed.format;
  const format = typeof rawFormat === "number" && Number.isInteger(rawFormat) && rawFormat >= 0 ? rawFormat : 0;
  if (format > knownMax)
    return { kind: "newer", format };
  return { kind: "ok", format, data: parsed };
}
function isNewerFormat(parsed, knownMax = KNOWN_FORMAT) {
  return classifyVersioned(parsed, knownMax).kind === "newer";
}
// src/core/software.ts
function userAgent(sdkVersion, id) {
  return `bridge-agent-sdk/${sdkVersion} (${id.runtimeName}/${id.runtimeVersion}; ${id.os}/${id.arch}) ${id.softwareId}/${id.softwareVersion}`;
}
function identityTokenClientOptions(id) {
  return { clientId: id.softwareId, softwareId: id.softwareId, softwareVersion: id.softwareVersion };
}
// src/core/dedupe.ts
class Dedupe {
  ttlMs;
  maxSize;
  now;
  seenAt = new Map;
  constructor(opts) {
    if (!(opts.ttlMs > 0))
      throw new RangeError("Dedupe: ttlMs must be > 0");
    if (!(opts.maxSize > 0))
      throw new RangeError("Dedupe: maxSize must be > 0");
    this.ttlMs = opts.ttlMs;
    this.maxSize = opts.maxSize;
    this.now = opts.now ?? Date.now;
  }
  seen(id) {
    const t = this.now();
    this.evictExpired(t);
    if (this.seenAt.has(id)) {
      this.seenAt.delete(id);
      this.seenAt.set(id, t);
      return false;
    }
    this.seenAt.set(id, t);
    while (this.seenAt.size > this.maxSize) {
      const oldest = this.seenAt.keys().next().value;
      if (oldest === undefined)
        break;
      this.seenAt.delete(oldest);
    }
    return true;
  }
  forget(id) {
    this.seenAt.delete(id);
  }
  evictExpired(t) {
    for (const [id, at] of this.seenAt) {
      if (t - at < this.ttlMs)
        break;
      this.seenAt.delete(id);
    }
  }
  get size() {
    return this.seenAt.size;
  }
}
// src/core/cursor.ts
var MAX_REPLAY_AGE_MS = 60 * 60 * 1000;
function sinceParam(lastMessageTime, nowMs) {
  if (lastMessageTime) {
    const t = new Date(lastMessageTime).getTime() - 1;
    if (Number.isFinite(t)) {
      return new Date(Math.max(t, nowMs - MAX_REPLAY_AGE_MS)).toISOString();
    }
  }
  return new Date(nowMs).toISOString();
}
function advanceCursor(current, createdAt) {
  if (!createdAt)
    return current;
  if (!current || createdAt > current)
    return createdAt;
  return current;
}
// src/core/control-chars.ts
var ANSI_SEQUENCE = /(?:\x1B\[|\x9B)[0-?]*[ -\/]*[@-~]|(?:\x1B\]|\x9D)[^\x07\x1B\x9C\n]*(?:\x07|\x1B\\|\x9C)?|(?:\x1B[PX^_]|[\x90\x98\x9E\x9F])[^\x1B\x9C\n]*(?:\x1B\\|\x9C)?|\x1B[ -\/]*[0-~]/g;
var CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;
function stripControlChars(text) {
  return text.replace(/\r\n?/g, `
`).replace(ANSI_SEQUENCE, "").replace(CONTROL_CHARS, "");
}
// src/core/feed.ts
var FEED_PROTOCOL_VERSION = 1;
var FEED_SERVER_FRAME_KINDS = ["hello", "message", "status", "replayed", "binding", "history", "error"];
var FEED_CLIENT_FRAME_KINDS = ["subscribe", "history"];

class FeedError extends Error {
  name = "FeedError";
  code;
  remoteCode;
  constructor(code, message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.code = code;
    this.remoteCode = opts.remoteCode;
  }
}
function isFeedError(e) {
  const o = e;
  return typeof o === "object" && o !== null && o.name === "FeedError" && typeof o.code === "string";
}
var stripString = (_key, v) => typeof v === "string" ? stripControlChars(v) : v;
function encodeFrame(frame) {
  return JSON.stringify(frame, stripString) + `
`;
}
var FEED_MAX_LINE = 1024 * 1024;

class FeedLineDecoder {
  maxLine;
  buf = "";
  spent = false;
  constructor(maxLine = FEED_MAX_LINE) {
    this.maxLine = maxLine;
  }
  push(chunk) {
    if (this.spent)
      return [];
    const out = [];
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf(`
`)) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.length > this.maxLine)
        return this.overflow(out);
      const item = parseLine(line);
      if (item)
        out.push(item);
    }
    if (this.buf.length > this.maxLine)
      return this.overflow(out);
    return out;
  }
  overflow(out) {
    this.spent = true;
    this.buf = "";
    out.push({ kind: "error", code: "line_too_long", message: `line exceeds ${this.maxLine} characters` });
    return out;
  }
}
function parseLine(line) {
  const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (trimmed.trim() === "")
    return null;
  try {
    return { kind: "json", value: JSON.parse(trimmed) };
  } catch {
    return { kind: "error", code: "bad_json", message: "line is not valid JSON" };
  }
}
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isStr = (v) => typeof v === "string";
function stripStrings(v) {
  if (typeof v === "string")
    return stripControlChars(v);
  if (Array.isArray(v))
    return v.map(stripStrings);
  if (isObj(v)) {
    const out = {};
    for (const k of Object.keys(v))
      out[k] = stripStrings(v[k]);
    return out;
  }
  return v;
}
var isOptStr = (v) => v === undefined || typeof v === "string";

class Bad extends Error {
}
function need(ok, what) {
  if (!ok)
    throw new Bad(what);
}
function msgFrom(o) {
  need(o.dir === "in" || o.dir === "out", "message.dir");
  need(isStr(o.id) && isStr(o.ts), "message.id/ts");
  need(isObj(o.channel) && isStr(o.channel.id) && isStr(o.channel.name), "message.channel");
  need(isOptStr(o.thread_id) && isOptStr(o.thread_title), "message.thread_id/thread_title");
  need(typeof o.is_root === "boolean", "message.is_root");
  need(isObj(o.sender) && isStr(o.sender.id) && isStr(o.sender.handle) && (o.sender.kind === "agent" || o.sender.kind === "human"), "message.sender");
  need(o.to === undefined || isObj(o.to) && isStr(o.to.handle) && isOptStr(o.to.context_id), "message.to");
  need(typeof o.targeted === "boolean", "message.targeted");
  need(isStr(o.type) && isStr(o.text), "message.type/text");
  const channel = o.channel;
  const sender = o.sender;
  const m = {
    t: "message",
    dir: o.dir,
    id: o.id,
    ts: o.ts,
    channel: { id: channel.id, name: channel.name },
    is_root: o.is_root,
    sender: { id: sender.id, handle: sender.handle, kind: sender.kind },
    targeted: o.targeted,
    type: o.type,
    text: o.text
  };
  if (o.thread_id !== undefined)
    m.thread_id = o.thread_id;
  if (o.thread_title !== undefined)
    m.thread_title = o.thread_title;
  if (o.to !== undefined) {
    const to = o.to;
    m.to = to.context_id !== undefined ? { handle: to.handle, context_id: to.context_id } : { handle: to.handle };
  }
  return m;
}
function serverFrom(t, o) {
  switch (t) {
    case "hello": {
      need(typeof o.v === "number" && Number.isInteger(o.v), "hello.v");
      need(isStr(o.software_id) && isStr(o.software_version) && isStr(o.context_id), "hello.software/context");
      need(isObj(o.agent) && isStr(o.agent.id) && isStr(o.agent.handle), "hello.agent");
      need(isOptStr(o.label) && isOptStr(o.cwd), "hello.label/cwd");
      const agent = o.agent;
      const h = {
        t: "hello",
        v: o.v,
        software_id: o.software_id,
        software_version: o.software_version,
        agent: { id: agent.id, handle: agent.handle },
        context_id: o.context_id
      };
      if (o.label !== undefined)
        h.label = o.label;
      if (o.cwd !== undefined)
        h.cwd = o.cwd;
      return h;
    }
    case "message":
      return msgFrom(o);
    case "status": {
      need(o.state === "connected" || o.state === "reconnecting" || o.state === "stopped", "status.state");
      need(isOptStr(o.reason), "status.reason");
      const s = { t: "status", state: o.state };
      if (o.reason !== undefined)
        s.reason = o.reason;
      return s;
    }
    case "replayed":
      need(typeof o.count === "number" && Number.isInteger(o.count) && o.count >= 0, "replayed.count");
      return { t: "replayed", count: o.count };
    case "binding":
      need(Array.isArray(o.thread_ids) && o.thread_ids.every(isStr), "binding.thread_ids");
      return { t: "binding", thread_ids: [...o.thread_ids] };
    case "history":
      need(isStr(o.req) && typeof o.more === "boolean" && Array.isArray(o.messages), "history");
      return {
        t: "history",
        req: o.req,
        messages: o.messages.map((m) => {
          need(isObj(m), "history.messages[]");
          return msgFrom(m);
        }),
        more: o.more
      };
    case "error": {
      need(isStr(o.code) && isStr(o.message) && isOptStr(o.req), "error");
      const e = { t: "error", code: o.code, message: o.message };
      if (o.req !== undefined)
        e.req = o.req;
      return e;
    }
    default:
      return null;
  }
}
function clientFrom(t, o) {
  switch (t) {
    case "subscribe": {
      need(o.replay === undefined || typeof o.replay === "number" && Number.isInteger(o.replay) && o.replay >= 0, "subscribe.replay");
      const s = { t: "subscribe" };
      if (o.replay !== undefined)
        s.replay = o.replay;
      return s;
    }
    case "history": {
      need(isStr(o.req) && isStr(o.channel_id) && isOptStr(o.before), "history.req/channel_id/before");
      need(typeof o.limit === "number" && Number.isInteger(o.limit) && o.limit > 0, "history.limit");
      const h = { t: "history", req: o.req, channel_id: o.channel_id, limit: o.limit };
      if (o.before !== undefined)
        h.before = o.before;
      return h;
    }
    default:
      return null;
  }
}
function parseWith(value, build) {
  if (!isObj(value) || !isStr(value.t))
    return { kind: "error", message: "frame is not an object with a string `t`" };
  try {
    const frame = build(value.t, stripStrings(value));
    return frame === null ? { kind: "skip" } : { kind: "frame", frame };
  } catch (e) {
    if (e instanceof Bad)
      return { kind: "error", message: `malformed ${value.t} frame: bad ${e.message}` };
    throw e;
  }
}
function parseServerFrame(value) {
  return parseWith(value, serverFrom);
}
function parseClientFrame(value) {
  return parseWith(value, clientFrom);
}
var FEED_RING_MAX_EVENTS = 500;
var FEED_RING_MAX_BYTES = 2 * 1024 * 1024;
var utf8 = new TextEncoder;

class FeedRing {
  maxEvents;
  maxBytes;
  entries = [];
  total = 0;
  constructor(maxEvents = FEED_RING_MAX_EVENTS, maxBytes = FEED_RING_MAX_BYTES) {
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
  }
  push(event) {
    const line = encodeFrame(event);
    const entry = { event, line, bytes: utf8.encode(line).length };
    this.entries.push(entry);
    this.total += entry.bytes;
    while (this.entries.length > 1 && (this.entries.length > this.maxEvents || this.total > this.maxBytes)) {
      this.total -= this.entries.shift().bytes;
    }
    return entry;
  }
  last(n) {
    if (n === undefined || n >= this.entries.length)
      return this.entries.slice();
    return n <= 0 ? [] : this.entries.slice(-n);
  }
  get size() {
    return this.entries.length;
  }
  get bytes() {
    return this.total;
  }
}
// src/core/tail-render.ts
var BODY_CAP_ROWS = 8;
var TAIL_SGR = {
  dim: "38;5;243",
  mute: "38;5;247",
  bright: "97",
  amber: "38;5;214",
  green: "38;5;78",
  blue: "38;5;75",
  greenHalf: "38;5;29",
  blueHalf: "38;5;25"
};
function paint(segs, color) {
  let out = "";
  for (const [style, text] of segs) {
    if (text === "")
      continue;
    out += color && style !== "none" ? `\x1B[${TAIL_SGR[style]}m${text}\x1B[0m` : text;
  }
  return out;
}
var BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
var LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function cleanText(s) {
  return stripControlChars(String(s ?? "")).replace(BIDI, "").replace(LONE_SURROGATE, "�");
}
function cleanLine(s) {
  return cleanText(s).replace(/[\n\t]/g, " ");
}
var ZERO = [
  [768, 879],
  [1155, 1161],
  [1425, 1469],
  [1471, 1471],
  [1473, 1474],
  [1476, 1477],
  [1479, 1479],
  [1552, 1562],
  [1611, 1631],
  [1648, 1648],
  [1750, 1756],
  [1759, 1764],
  [1767, 1768],
  [1770, 1773],
  [2304, 2306],
  [2364, 2364],
  [2369, 2376],
  [2381, 2381],
  [3633, 3633],
  [3636, 3642],
  [3655, 3662],
  [6832, 6911],
  [7616, 7679],
  [8203, 8207],
  [8232, 8238],
  [8288, 8292],
  [8400, 8447],
  [12441, 12442],
  [65024, 65039],
  [65056, 65071],
  [65279, 65279],
  [127995, 127999],
  [917760, 917999]
];
var WIDE = [
  [4352, 4447],
  [8986, 8987],
  [9001, 9002],
  [9193, 9196],
  [9200, 9200],
  [9203, 9203],
  [9725, 9726],
  [9748, 9749],
  [9800, 9811],
  [9855, 9855],
  [9875, 9875],
  [9889, 9889],
  [9898, 9899],
  [9917, 9918],
  [9924, 9925],
  [9934, 9934],
  [9940, 9940],
  [9962, 9962],
  [9970, 9971],
  [9973, 9973],
  [9978, 9978],
  [9981, 9981],
  [9989, 9989],
  [9994, 9995],
  [10024, 10024],
  [10060, 10060],
  [10062, 10062],
  [10067, 10069],
  [10071, 10071],
  [10133, 10135],
  [10160, 10160],
  [10175, 10175],
  [11035, 11036],
  [11088, 11088],
  [11093, 11093],
  [11904, 12350],
  [12353, 13311],
  [13312, 19903],
  [19968, 40959],
  [40960, 42191],
  [43360, 43391],
  [44032, 55203],
  [63744, 64255],
  [65040, 65049],
  [65072, 65135],
  [65280, 65376],
  [65504, 65510],
  [126980, 126980],
  [127183, 127183],
  [127374, 127374],
  [127377, 127386],
  [127462, 127487],
  [127488, 127743],
  [127744, 128591],
  [128640, 128767],
  [128992, 129003],
  [129280, 129535],
  [129648, 129791],
  [131072, 262141]
];
function inRanges(cp, table) {
  for (const [lo, hi] of table) {
    if (cp < lo)
      return false;
    if (cp <= hi)
      return true;
  }
  return false;
}
function charWidth(cp) {
  if (cp < 32 || cp >= 127 && cp < 160)
    return 0;
  if (cp < 768)
    return 1;
  if (inRanges(cp, ZERO))
    return 0;
  if (inRanges(cp, WIDE))
    return 2;
  return 1;
}
function cells(s) {
  const out = [];
  let joining = false;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    const w = charWidth(cp);
    const prev = out[out.length - 1];
    const afterZwj = joining;
    joining = false;
    if (prev) {
      if (afterZwj && (cp >= 126976 || cp >= 8592 && cp <= 11263)) {
        prev.t += ch;
        prev.w = Math.max(prev.w, 2);
        continue;
      }
      if (w === 0 && prev.w > 0) {
        prev.t += ch;
        if ((cp === 65039 || cp === 8419) && prev.w === 1)
          prev.w = 2;
        joining = cp === 8205;
        continue;
      }
      if (cp >= 127462 && cp <= 127487 && prev.ri) {
        prev.t += ch;
        prev.ri = false;
        continue;
      }
    }
    out.push({ t: ch, w, ...cp >= 127462 && cp <= 127487 ? { ri: true } : {} });
    joining = cp === 8205;
  }
  return out;
}
var PLAIN_ASCII = /^[\x20-\x7e]*$/;
function stringWidth(s) {
  if (PLAIN_ASCII.test(s))
    return s.length;
  let w = 0;
  for (const c of cells(s))
    w += c.w;
  return w;
}
function truncateTo(s, max) {
  if (max <= 0)
    return "";
  if (stringWidth(s) <= max)
    return s;
  let out = "";
  let w = 0;
  for (const c of cells(s)) {
    if (w + c.w > max - 1)
      break;
    out += c.t;
    w += c.w;
  }
  return out + "…";
}
function trimSpaces(s) {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 32)
    end--;
  return end === s.length ? s : s.slice(0, end);
}
function expandTabs(line) {
  if (!line.includes("\t"))
    return line;
  const parts = line.split("\t");
  let out = parts[0];
  let col = stringWidth(out);
  for (let i = 1;i < parts.length; i++) {
    const n = 4 - col % 4;
    out += " ".repeat(n) + parts[i];
    col += n + stringWidth(parts[i]);
  }
  return out;
}
function hardBreak(token, width) {
  const rows = [];
  let cur = "";
  let w = 0;
  for (const c of cells(token)) {
    if (w + c.w > width && cur !== "") {
      rows.push(cur);
      cur = "";
      w = 0;
    }
    cur += c.t;
    w += c.w;
  }
  if (cur !== "")
    rows.push(cur);
  return rows;
}
function wrapLine(raw, width) {
  const line = expandTabs(raw).trimEnd();
  const lead = /^ */.exec(line)[0].length;
  const indent = Math.min(lead, Math.floor(width / 2));
  const pad = " ".repeat(indent);
  const rest = line.slice(lead);
  if (rest === "")
    return [""];
  const avail = width - indent;
  const rows = [];
  let cur = "";
  let curW = 0;
  const flush = () => {
    rows.push(pad + trimSpaces(cur));
    cur = "";
    curW = 0;
  };
  for (const tok of rest.split(/( +)/)) {
    if (tok === "")
      continue;
    const tw = stringWidth(tok);
    if (tok[0] === " ") {
      if (curW === 0)
        continue;
      if (curW + tw <= avail) {
        cur += tok;
        curW += tw;
      } else
        flush();
    } else if (curW + tw <= avail) {
      cur += tok;
      curW += tw;
    } else if (tw <= avail) {
      if (curW > 0)
        flush();
      cur = tok;
      curW = tw;
    } else {
      if (curW > 0)
        flush();
      const parts = hardBreak(tok, avail);
      for (let i = 0;i < parts.length - 1; i++)
        rows.push(pad + parts[i]);
      cur = parts[parts.length - 1] ?? "";
      curW = stringWidth(cur);
    }
  }
  if (cur !== "" || rows.length === 0)
    flush();
  return rows;
}
function bodyOf(m) {
  return cleanText(m.text).trimEnd();
}
function bodyRows(m, contentWidth) {
  const body = bodyOf(m);
  if (body === "")
    return [];
  const rows = [];
  for (const line of body.split(`
`))
    rows.push(...wrapLine(line, contentWidth));
  return rows;
}
var MIN_WIDTH = 12;
function messageLayout(dir, width) {
  const w = Math.max(MIN_WIDTH, width);
  const indent = dir === "out" ? w >= 100 ? Math.floor(w / 4) : w >= 50 ? 4 : 0 : 0;
  return { indent, content: Math.max(4, w - indent - 2) };
}
function isCapped(m, width) {
  return bodyRows(m, messageLayout(m.dir, width).content).length > BODY_CAP_ROWS;
}
var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var two = (n) => String(n).padStart(2, "0");
function clockOf(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime()))
    return "--:--:--";
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
function dayKey(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function dayLabel(ts) {
  const d = new Date(ts);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
function segsWidth(segs) {
  let w = 0;
  for (const [, t] of segs)
    w += stringWidth(t);
  return w;
}
function truncateSegs(segs, max) {
  if (segsWidth(segs) <= max)
    return segs;
  const out = [];
  let room = max - 1;
  let last = "dim";
  for (const [style, text] of segs) {
    if (room <= 0)
      break;
    last = style;
    const w = stringWidth(text);
    if (w <= room) {
      out.push([style, text]);
      room -= w;
      continue;
    }
    let part = "";
    for (const c of cells(text)) {
      if (c.w > room)
        break;
      part += c.t;
      room -= c.w;
    }
    out.push([style, part]);
    room = 0;
  }
  out.push([last, "…"]);
  return out;
}
function wrapSegs(segs, width) {
  const rows = [];
  let cur = [];
  let w = 0;
  for (const [style, text] of segs) {
    for (const c of cells(text)) {
      if (w + c.w > width && w > 0) {
        rows.push(cur);
        cur = [["none", "  "]];
        w = 2;
      }
      const tail = cur[cur.length - 1];
      if (tail && tail[0] === style)
        tail[1] += c.t;
      else
        cur.push([style, c.t]);
      w += c.w;
    }
  }
  if (cur.length)
    rows.push(cur);
  return rows;
}
var SESSION_COLS = 12;
function look(m) {
  const dirOut = m.dir === "out";
  if (m.targeted === false)
    return { bar: dirOut ? "blueHalf" : "greenHalf", who: "mute", text: "mute" };
  return { bar: dirOut ? "blue" : "green", who: "bright", text: "none" };
}
function typeLabel(m) {
  const t = cleanLine(m.type).trim();
  if (t === "" || t === "text")
    return null;
  return { text: t, style: t === "question" || t === "task" ? "amber" : "dim" };
}
function headerParts(m, o, folded) {
  const lk = look(m);
  const at = [m.targeted ? "amber" : lk.who, "@"];
  const handle = cleanLine(m.sender.handle);
  const to = m.to ? cleanLine(m.to.handle) : "";
  let who;
  if (m.dir === "out")
    who = to === "" ? [] : [["dim", " to "], at, [lk.who, to]];
  else
    who = [["dim", " "], at, [lk.who, handle]];
  const session = o.showSession && m.session !== undefined ? `[${truncateTo(cleanLine(m.session), SESSION_COLS)}] ` : "";
  const title = !m.is_root ? cleanLine(m.thread_title ?? "").trim() : null;
  return {
    lead: `${folded ? "▸" : "▾"} ${session}${clockOf(m.ts)} #${cleanLine(m.channel.name)}`,
    who,
    label: typeLabel(m),
    title
  };
}
function headerSegs(p, avail, reserve) {
  const fixed = [["dim", p.lead], ...p.who];
  if (p.label)
    fixed.push(["dim", " "], [p.label.style, p.label.text]);
  const tail = [["dim", ":"]];
  if (p.title === null)
    return [...fixed, ...tail];
  const base = segsWidth(fixed) + segsWidth(tail) + 2;
  const room = avail - base - reserve - 1;
  if (p.title === "" || room < 1)
    return [...fixed, ["dim", " ↳"], ...tail];
  return [...fixed, ["dim", ` ↳ ${truncateTo(p.title, room)}`], ...tail];
}
function renderMessage(m, o) {
  const fold = o.fold ?? "open";
  const { indent, content } = messageLayout(m.dir, o.width);
  const lk = look(m);
  const barChar = o.selected ? "┃" : "│";
  const prefix = () => [["none", " ".repeat(indent)], [lk.bar, barChar], ["none", " "]];
  const row = (segs) => paint([...prefix(), ...segs], o.color);
  const rows = [];
  const parts = headerParts(m, o, fold === "folded");
  if (fold === "folded") {
    const body2 = bodyOf(m);
    const lines = body2 === "" ? [] : body2.split(`
`);
    const at = lines.findIndex((l) => l.trim() !== "");
    const first = at < 0 ? "" : expandTabs(lines[at]).trim();
    const more = at < 0 ? 0 : lines.length - 1 - at;
    let suffix = more > 0 ? ` (+${more})` : "";
    if (content - stringWidth(suffix) < 8)
      suffix = "";
    const sw = stringWidth(suffix);
    const reserve = first === "" ? 0 : 1 + Math.min(20, stringWidth(first));
    let head2 = headerSegs(parts, content - sw, reserve);
    if (segsWidth(head2) > content - sw)
      head2 = truncateSegs(head2, content - sw);
    const left = content - sw - segsWidth(head2) - 1;
    const segs = [...head2];
    if (first !== "" && left >= 2)
      segs.push(["none", " "], [lk.text, truncateTo(first, left)]);
    if (suffix !== "")
      segs.push(["dim", suffix]);
    rows.push(row(segs));
    return rows;
  }
  const head = headerSegs(parts, content, 0);
  if (segsWidth(head) <= content)
    rows.push(row(head));
  else
    for (const r of wrapSegs(head, content))
      rows.push(row(r));
  const body = bodyRows(m, content);
  const capped = fold === "open" && body.length > BODY_CAP_ROWS;
  for (const line of capped ? body.slice(0, BODY_CAP_ROWS) : body)
    rows.push(row([[lk.text, line]]));
  if (capped)
    rows.push(row([["dim", truncateTo(`(+${body.length - BODY_CAP_ROWS} lines)`, content)]]));
  return rows;
}
function clipRow(row, width) {
  if (width <= 0)
    return "";
  if (stringWidth(stripSgrCodes(row)) <= width)
    return row;
  let out = "";
  let used = 0;
  let sgr = false;
  outer:
    for (const part of row.split(/(\x1b\[[0-9;]*m)/)) {
      if (part.startsWith("\x1B[") && part.endsWith("m")) {
        out += part;
        sgr = true;
        continue;
      }
      for (const c of cells(part)) {
        if (used + c.w > width)
          break outer;
        out += c.t;
        used += c.w;
      }
    }
  return sgr ? out + "\x1B[0m" : out;
}
function stripSgrCodes(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
function centered(text, width, style, color) {
  const w = Math.max(MIN_WIDTH, width);
  const label = truncateTo(text, w);
  const pad = Math.max(0, Math.floor((w - stringWidth(label)) / 2));
  return paint([["none", " ".repeat(pad)], [style, label]], color);
}
function dateSeparator(ts, width, color) {
  return centered(`── ${dayLabel(ts)} ──`, width, "dim", color);
}
function newDivider(width, color) {
  return centered("── new ──", width, "amber", color);
}
var CACHE_MAX_ENTRIES = 8000;
function createRenderCache() {
  return { rows: new Map, hits: 0, misses: 0 };
}
function renderTranscript(messages, view, o) {
  const rows = [];
  const spans = [];
  let day = null;
  for (const m of messages) {
    const start = rows.length;
    const d = dayKey(m.ts);
    if (d !== "" && d !== day) {
      rows.push(dateSeparator(m.ts, o.width, o.color));
      day = d;
    }
    if (view.unreadFromKey != null && m.key === view.unreadFromKey)
      rows.push(newDivider(o.width, o.color));
    const fold = view.fold?.(m.key) ?? "open";
    const selected = m.key === view.selectedKey;
    const ck = `${m.key}|${o.width}|${fold}|${selected ? 1 : 0}|${o.color ? 1 : 0}|${o.showSession ? 1 : 0}`;
    let mrows = o.cache?.rows.get(ck);
    if (mrows)
      o.cache.hits++;
    else {
      mrows = renderMessage(m, { width: o.width, color: o.color, fold, selected, showSession: o.showSession });
      if (o.cache) {
        o.cache.misses++;
        if (o.cache.rows.size >= CACHE_MAX_ENTRIES)
          o.cache.rows.clear();
        o.cache.rows.set(ck, mrows);
      }
    }
    rows.push(...mrows);
    spans.push({ key: m.key, start, end: rows.length - 1 });
  }
  return { rows, spans };
}
function viewport(t, height, o) {
  const h = Math.max(1, height);
  const maxTop = Math.max(0, t.rows.length - h);
  let top = o.follow ? maxTop : Math.min(Math.max(0, o.prevTop), maxTop);
  if (!o.follow && o.selectedKey != null) {
    const span = t.spans.find((s) => s.key === o.selectedKey);
    if (span) {
      if (span.end - span.start + 1 > h)
        top = span.start;
      else if (span.start < top)
        top = span.start;
      else if (span.end >= top + h)
        top = span.end - h + 1;
      top = Math.min(top, maxTop);
    }
  }
  return { rows: t.rows.slice(top, top + h), top };
}
var STATE_TEXT = {
  waiting: ["waiting for a Bridge session…", "dim"],
  connected: ["connected", "green"],
  reconnecting: ["reconnecting", "amber"],
  stopped: ["stopped", "dim"],
  ended: ["session ended — waiting…", "dim"]
};
function renderHeader(info, width, color) {
  const w = Math.max(MIN_WIDTH, width);
  const [stateText, stateStyle] = STATE_TEXT[info.state];
  const segs = [["bright", "bridge tail"]];
  if (info.handle)
    segs.push(["dim", " · "], ["dim", `@${cleanLine(info.handle)}`]);
  if (info.label)
    segs.push(["dim", " · "], ["dim", cleanLine(info.label)]);
  segs.push(["dim", " · "], [stateStyle, stateText]);
  return paint(truncateSegs(segs, w), color);
}
var HINTS = "j/k move · enter fold · e fold all · q quit";
function renderFooter(info, width, color) {
  const w = Math.max(MIN_WIDTH, width);
  const counts = `${info.total} ${info.total === 1 ? "message" : "messages"} · ${info.ins} in · ${info.outs} out`;
  const full = `${counts} · ${HINTS}`;
  return paint([["dim", stringWidth(full) <= w ? full : truncateTo(counts, w)]], color);
}
// src/core/tail-state.ts
var TAIL_MAX_MESSAGES = 2000;
function initialTailState(size = { cols: 80, rows: 24 }) {
  return {
    messages: [],
    fold: new Map,
    selected: null,
    follow: true,
    unreadFrom: null,
    unread: 0,
    focused: true,
    connection: "waiting",
    links: new Map,
    agent: null,
    label: null,
    size,
    quit: false
  };
}
function messageKey(m, session) {
  return session === undefined ? m.id : `${session}\x00${m.id}`;
}
function hasMessage(state, key) {
  return state.messages.some((m) => m.key === key);
}
function clearUnread(s) {
  return s.unread === 0 && s.unreadFrom === null ? s : { ...s, unread: 0, unreadFrom: null };
}
function addMessage(s, m, session, history = false) {
  const key = messageKey(m, session);
  if (hasMessage(s, key))
    return s;
  const tm = { ...m, key, ...session !== undefined ? { session } : {} };
  const at = Date.parse(tm.ts);
  let i = s.messages.length;
  if (!Number.isNaN(at)) {
    while (i > 0) {
      const prev = Date.parse(s.messages[i - 1].ts);
      if (Number.isNaN(prev) || prev <= at)
        break;
      i--;
    }
  }
  const atEnd = i === s.messages.length;
  let messages = [...s.messages.slice(0, i), tm, ...s.messages.slice(i)];
  let fold = s.fold;
  if (messages.length > TAIL_MAX_MESSAGES) {
    const dropped = messages.slice(0, messages.length - TAIL_MAX_MESSAGES);
    messages = messages.slice(dropped.length);
    if (dropped.some((d) => fold.has(d.key))) {
      const next2 = new Map(fold);
      for (const d of dropped)
        next2.delete(d.key);
      fold = next2;
    }
  }
  let next = { ...s, messages, fold };
  if (next.selected === null || !messages.some((x) => x.key === next.selected))
    next = { ...next, selected: messages[0].key };
  if (s.follow)
    next = { ...next, selected: messages[messages.length - 1].key };
  if (atEnd && !history && tm.dir === "in" && (!s.follow || !s.focused)) {
    next = { ...next, unread: next.unread + 1, unreadFrom: next.unreadFrom ?? key };
  }
  return next;
}
function setLink(s, session, state) {
  const links = new Map(s.links);
  if (state === null)
    links.delete(session);
  else
    links.set(session, state);
  const all = [...links.values()];
  const connection = all.includes("connected") ? "connected" : all.includes("reconnecting") ? "reconnecting" : all.includes("stopped") ? "stopped" : "ended";
  return s.connection === connection && s.links.get(session) === state ? s : { ...s, links, connection };
}
function move(s, to) {
  if (s.messages.length === 0)
    return s;
  const i = Math.max(0, Math.min(s.messages.length - 1, to));
  return { ...s, selected: s.messages[i].key, follow: i === s.messages.length - 1 };
}
function setFold(s, key, f) {
  const fold = new Map(s.fold);
  if (f === "open")
    fold.delete(key);
  else
    fold.set(key, f);
  return { ...s, fold };
}
function onKey(s0, key) {
  const s = clearUnread({ ...s0, focused: true });
  const idx = s.messages.findIndex((m) => m.key === s.selected);
  switch (key) {
    case "j":
    case "down":
      return move(s, idx + 1);
    case "k":
    case "up":
      return move(s, idx - 1);
    case "g":
      return move(s, 0);
    case "G":
      return move(s, s.messages.length - 1);
    case "enter": {
      const m = s.messages[idx];
      if (!m)
        return s;
      const f = s.fold.get(m.key) ?? "open";
      if (f === "folded")
        return setFold(s, m.key, "open");
      if (f === "open" && isCapped(m, s.size.cols))
        return setFold(s, m.key, "full");
      return setFold(s, m.key, "folded");
    }
    case "e": {
      const anyOpen = s.messages.some((m) => (s.fold.get(m.key) ?? "open") !== "folded");
      const fold = new Map;
      if (anyOpen)
        for (const m of s.messages)
          fold.set(m.key, "folded");
      return { ...s, fold };
    }
    case "q":
    case "ctrl-c":
      return { ...s, quit: true };
    default:
      return s;
  }
}
function tailReduce(s, ev) {
  switch (ev.type) {
    case "frame": {
      const f = ev.frame;
      if (f.t === "message")
        return addMessage(s, f, ev.session, ev.history);
      if (f.t === "status")
        return setLink(s, ev.session ?? "", f.state);
      return s;
    }
    case "key":
      return onKey(s, ev.key);
    case "focus":
      return ev.focused ? clearUnread({ ...s, focused: true }) : s.focused ? { ...s, focused: false } : s;
    case "resize":
      return { ...s, size: { cols: ev.cols, rows: ev.rows } };
    case "attached":
      return { ...setLink(s, ev.session ?? "", "connected"), agent: ev.agent, label: ev.label };
    case "detached": {
      const next = setLink(s, ev.session ?? "", null);
      return ev.agent !== undefined || ev.label !== undefined ? { ...next, agent: ev.agent ?? null, label: ev.label ?? null } : next;
    }
  }
}
var ESCAPE = /^\x1b(?:\[[0-?]*[ -\/]*[@-~]|O[@-~])/;
function parseTailInput(chunk) {
  const out = [];
  let rest = chunk;
  while (rest !== "") {
    const esc = ESCAPE.exec(rest);
    if (esc) {
      const seq = esc[0];
      rest = rest.slice(seq.length);
      if (seq === "\x1B[A" || seq === "\x1BOA")
        out.push({ type: "key", key: "up" });
      else if (seq === "\x1B[B" || seq === "\x1BOB")
        out.push({ type: "key", key: "down" });
      else if (seq === "\x1B[I")
        out.push({ type: "focus", focused: true });
      else if (seq === "\x1B[O")
        out.push({ type: "focus", focused: false });
      continue;
    }
    const ch = String.fromCodePoint(rest.codePointAt(0));
    rest = rest.slice(ch.length);
    if (ch === "\x03")
      out.push({ type: "key", key: "ctrl-c" });
    else if (ch === "\r" || ch === `
`)
      out.push({ type: "key", key: "enter" });
    else if (ch !== "\x1B")
      out.push({ type: "key", key: ch });
  }
  return out;
}
// src/core/b64url.ts
function b64url(bytes) {
  let bin = "";
  for (const b of bytes)
    bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(value) {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

class B64urlError extends Error {
  name = "B64urlError";
}
var B64URL = /^[A-Za-z0-9_-]*$/;
function b64urlDecode(s) {
  if (!B64URL.test(s))
    throw new B64urlError("not base64url: characters outside [A-Za-z0-9_-]");
  if (s.length % 4 === 1)
    throw new B64urlError(`not base64url: impossible length ${s.length}`);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0;i < bin.length; i++)
    out[i] = bin.charCodeAt(i);
  return out;
}
function randomB64url(nBytes) {
  return b64url(crypto.getRandomValues(new Uint8Array(nBytes)));
}
async function sha256B64url(text) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

// src/core/jwk.ts
var B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
function isB64url32(v) {
  return typeof v === "string" && B64URL_32.test(v) && b64url(b64urlDecode(v)) === v;
}
function isP256PublicJwk(j) {
  const o = j;
  return !!o && o.kty === "EC" && o.crv === "P-256" && isB64url32(o.x) && isB64url32(o.y);
}
function isP256PrivateJwk(j) {
  return isP256PublicJwk(j) && isB64url32(j.d);
}
function publicPart(j) {
  return { kty: "EC", crv: "P-256", x: j.x, y: j.y };
}
function jwkThumbprint(j) {
  return sha256B64url(JSON.stringify({ crv: j.crv, kty: j.kty, x: j.x, y: j.y }));
}

// src/core/signer.ts
var KEY_ALG = { name: "ECDSA", namedCurve: "P-256" };
var SIGN_ALG = { name: "ECDSA", hash: "SHA-256" };
async function softwareSigner(jwk) {
  if (!isP256PrivateJwk(jwk))
    throw new Error("not a P-256 private JWK");
  const key = await crypto.subtle.importKey("jwk", { ...publicPart(jwk), d: jwk.d }, KEY_ALG, false, ["sign"]);
  const publicJwk = publicPart(jwk);
  return {
    alg: "ES256",
    keyStorage: "software",
    publicJwk,
    jkt: await jwkThumbprint(publicJwk),
    async sign(data) {
      const sig = new Uint8Array(await crypto.subtle.sign(SIGN_ALG, key, new Uint8Array(data)));
      if (sig.length !== 64)
        throw new Error(`ES256 signature must be 64 bytes r||s, got ${sig.length}`);
      return sig;
    }
  };
}
async function generateSoftwareKey() {
  const kp = await crypto.subtle.generateKey(KEY_ALG, true, ["sign", "verify"]);
  const j = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const privateJwk = { kty: "EC", crv: "P-256", x: j.x, y: j.y, d: j.d };
  return { privateJwk, signer: await softwareSigner(privateJwk) };
}
// src/core/deadline.ts
function deadline(ms, ...parents) {
  const ac = new AbortController;
  const already = parents.find((p) => p?.aborted);
  if (already) {
    ac.abort(already.reason);
    return { signal: ac.signal, clear() {} };
  }
  const timer = setTimeout(() => ac.abort(new DOMException(`deadline timed out after ${ms} ms`, "TimeoutError")), ms);
  timer.unref?.();
  const listeners = [];
  for (const p of parents) {
    if (!p)
      continue;
    const fn = () => ac.abort(p.reason);
    p.addEventListener("abort", fn, { once: true });
    listeners.push({ p, fn });
  }
  return {
    signal: ac.signal,
    clear() {
      clearTimeout(timer);
      for (const { p, fn } of listeners)
        p.removeEventListener("abort", fn);
    }
  };
}
// src/core/jws.ts
async function signJwt(signer, header, claims) {
  const input = `${b64urlJson({ ...header, alg: signer.alg })}.${b64urlJson(claims)}`;
  const sig = await signer.sign(new TextEncoder().encode(input));
  return `${input}.${b64url(sig)}`;
}
var newJti = () => randomB64url(16);

// src/core/dpop.ts
function normalizeHtu(url) {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error(`DPoP htu must be http(s), got ${u.protocol}`);
  return `${u.protocol}//${u.host}${u.pathname}`;
}
var HTTP_FORM = { "ws:": "http:", "wss:": "https:", "http:": "http:", "https:": "https:" };
function apiOrigin(apiUrl, allowWsPath = false) {
  const u = new URL(apiUrl);
  const scheme = HTTP_FORM[u.protocol];
  if (!scheme)
    throw new Error(`the Bridge API URL must be http(s) or ws(s), got ${u.protocol}`);
  const pathOk = /^\/*$/.test(u.pathname) || allowWsPath && u.pathname === "/ws";
  if (!pathOk || u.search || u.hash || u.username || u.password) {
    throw new Error(`the Bridge API URL must be an origin like https://bridge-api.example.com — got ${JSON.stringify(apiUrl)}`);
  }
  return new URL(`${scheme}//${u.host}`).origin;
}
function httpHtu(apiUrl, path) {
  const pathname = "/" + path.split(/[?#]/, 1)[0].replace(/^\/+/, "");
  return normalizeHtu(`${apiOrigin(apiUrl)}${pathname}`);
}
function wsHtu(apiUrl) {
  return normalizeHtu(`${apiOrigin(apiUrl, true)}/ws`);
}
var accessTokenHash = (accessToken) => sha256B64url(accessToken);
async function dpopProof(signer, clock, p) {
  if (p.accessToken === "")
    throw new Error("DPoP proof: empty access token");
  if (p.nonce === "")
    throw new Error("DPoP proof: empty nonce");
  return signJwt(signer, { typ: "dpop+jwt", jwk: signer.publicJwk }, {
    jti: newJti(),
    htm: p.htm.toUpperCase(),
    htu: normalizeHtu(p.htu),
    iat: clock.nowS(),
    ...p.accessToken !== undefined ? { ath: await accessTokenHash(p.accessToken) } : {},
    ...p.nonce !== undefined ? { nonce: p.nonce } : {}
  });
}
// src/core/assertion.ts
var CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
var ASSERTION_TTL_S = 60;
function clientAssertion(signer, clock, installationId, issuer) {
  const iat = clock.nowS();
  return signJwt(signer, { typ: "client-authentication+jwt", kid: signer.jkt }, { iss: installationId, sub: installationId, aud: issuer, jti: newJti(), iat, exp: iat + ASSERTION_TTL_S });
}
// src/core/clock.ts
var IMF_FIXDATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
var MAX_CLOCK_OFFSET_MS = 24 * 60 * 60 * 1000;

class Clock {
  now;
  offsetMs = 0;
  constructor(now = Date.now) {
    this.now = now;
  }
  nowS() {
    return Math.floor((this.now() + this.offsetMs) / 1000);
  }
  observe(dateHeader) {
    if (typeof dateHeader !== "string" || !IMF_FIXDATE.test(dateHeader))
      return;
    const t = Date.parse(dateHeader);
    if (!Number.isFinite(t))
      return;
    const offset = t - this.now();
    if (Math.abs(offset) > MAX_CLOCK_OFFSET_MS)
      return;
    this.offsetMs = offset;
  }
  offset() {
    return this.offsetMs;
  }
}
// src/core/join-state.ts
var JOIN_STATE = /^brg_js_(0|[1-9][0-9]{0,14})_[0-9A-Za-z]{49}$/;
function isJoinState(s) {
  return typeof s === "string" && JOIN_STATE.test(s);
}
function joinStateSeq(s) {
  const m = JOIN_STATE.exec(s);
  return m ? Number(m[1]) : null;
}
// src/core/token-errors.ts
class OAuthError extends Error {
  name = "OAuthError";
  error;
  status;
  description;
  retryAfterS;
  dpopNonce;
  constructor(i) {
    super(`agent-auth: ${i.error}${i.description ? ` ${i.description}` : ""} (${i.status})`);
    this.error = i.error;
    this.status = i.status;
    this.description = i.description;
    this.retryAfterS = i.retryAfterS;
    this.dpopNonce = i.dpopNonce;
  }
}
function isOAuthError(e) {
  const o = e;
  return typeof o === "object" && o !== null && o.name === "OAuthError" && typeof o.error === "string" && typeof o.status === "number";
}

class TransportError extends Error {
  name = "TransportError";
}

class DiscoveryError extends Error {
  name = "DiscoveryError";
}

class AbortedError extends Error {
  name = "AbortedError";
}
function isTransportFailure(e) {
  const name = e?.name;
  return name === "TimeoutError" || name === "TransportError";
}
function isCallerAbort(e) {
  const name = e?.name;
  return name === "AbortedError" || name === "AbortError";
}
var GONE_REASONS = ["installation_locked", "installation_revoked", "installation_expired", "installation_unknown", "agent_deactivated"];
function isGoneReason(d) {
  return GONE_REASONS.includes(d);
}
function assertNever(x) {
  throw new Error(`unhandled case: ${JSON.stringify(x)}`);
}
var DEFAULT_RETRY_AFTER_S = 30;
function retryAfter(s) {
  return typeof s === "number" && Number.isFinite(s) && s >= 0 ? Math.max(1, Math.ceil(s)) : DEFAULT_RETRY_AFTER_S;
}
function classifyTokenError(e) {
  if (!isOAuthError(e))
    return isTransportFailure(e) ? { kind: "transient" } : isCallerAbort(e) ? { kind: "aborted" } : { kind: "refused" };
  if (e.status === 429)
    return { kind: "rate_limited", retryAfterS: retryAfter(e.retryAfterS) };
  if (e.status >= 500)
    return { kind: "transient" };
  switch (e.error) {
    case "unauthorized_client":
      if (e.description?.startsWith("client_too_old:") || e.description?.startsWith("client_blocked:"))
        return { kind: "too_old" };
      return { kind: "refused" };
    case "invalid_client":
      if (isGoneReason(e.description))
        return { kind: "installation_gone", reason: e.description };
      if (e.description === "assertion_invalid")
        return { kind: "clock" };
      return { kind: "refused" };
    case "invalid_grant":
      if (e.description?.startsWith("rfc014_retired:"))
        return { kind: "update_required" };
      if (e.description === "session_revoked")
        return { kind: "session_revoked" };
      if (e.description === "session_limit")
        return { kind: "session_limit" };
      return { kind: "refused" };
    case "invalid_request":
      return e.description === "corrupt_state" ? { kind: "corrupt_state" } : { kind: "refused" };
    case "invalid_dpop_proof":
      if (e.description?.startsWith("dpop_proof_required:"))
        return { kind: "update_required" };
      return e.description === "key_already_enrolled" ? { kind: "refused" } : { kind: "new_proof" };
    case "use_dpop_nonce":
      return { kind: "new_proof" };
    case "unsupported_grant_type":
      return { kind: "update_required" };
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down" };
    default:
      return { kind: "refused" };
  }
}
// src/core/protocol.ts
var GRANT_ENROLMENT_KEY = "urn:bridge:params:oauth:grant-type:enrolment-key";
var GRANT_DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
var GRANT_CLIENT_CREDENTIALS = "client_credentials";
var MINT_TIMEOUT_MS = 30000;
var MINT_BUDGET_MS = 90000;
var DISCOVERY_TIMEOUT_MS = 1e4;
var METADATA_TTL_MS = 60 * 60000;
function callerCancelled(signal) {
  return !!signal?.aborted && signal.reason?.name !== "TimeoutError";
}
function abortable(p, signal) {
  if (!signal)
    return p;
  const why = () => callerCancelled(signal) ? new AbortedError("cancelled by the caller", { cause: signal.reason }) : signal.reason;
  if (signal.aborted)
    return Promise.reject(why());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(why());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => (signal.removeEventListener("abort", onAbort), resolve(v)), (e) => (signal.removeEventListener("abort", onAbort), reject(e)));
  });
}
async function exchange(f, url, init, callerSignal) {
  let res;
  let text;
  try {
    res = await f(url, init);
    text = await res.text();
  } catch (e) {
    if (callerCancelled(callerSignal))
      throw new AbortedError("cancelled by the caller", { cause: callerSignal.reason });
    throw new TransportError(`Bridge agent-auth ${new URL(url).pathname}: no answer (${e?.message ?? e})`, { cause: e });
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { res, json };
}
function retryAfterS(ra, now = Date.now()) {
  if (ra === null || ra.trim() === "")
    return;
  if (/^\s*\d+(\.\d+)?\s*$/.test(ra))
    return Number(ra);
  const t = Date.parse(ra);
  return Number.isFinite(t) ? Math.max(0, (t - now) / 1000) : undefined;
}
function toOAuthError(res, json) {
  const o = json !== null && typeof json === "object" && !Array.isArray(json) ? json : {};
  const retry = retryAfterS(res.headers.get("retry-after"));
  return new OAuthError({
    error: typeof o.error === "string" && o.error !== "" ? o.error : res.status === 429 ? "rate_limited" : `http_${res.status}`,
    status: res.status,
    description: typeof o.error_description === "string" ? o.error_description : undefined,
    retryAfterS: retry,
    dpopNonce: res.headers.get("dpop-nonce") ?? undefined
  });
}
function assertSameAuthority(apiUrl, m) {
  const origin = apiOrigin(apiUrl);
  if (m.issuer !== `${origin}/api/agent-auth`) {
    throw new DiscoveryError(`Bridge agent-auth discovery issuer ${JSON.stringify(m.issuer)} does not match ${origin} — refusing it`);
  }
  for (const k of ["token_endpoint", "revocation_endpoint", "authorization_endpoint", "device_authorization_endpoint"]) {
    const v = m[k];
    if (v === undefined)
      continue;
    let o;
    try {
      o = new URL(v).origin;
    } catch {
      throw new DiscoveryError(`Bridge agent-auth discovery ${k} is not a URL — refusing it`);
    }
    if (o !== origin)
      throw new DiscoveryError(`Bridge agent-auth discovery ${k} points at ${o}, not ${origin} — refusing it`);
  }
}
function supportsKeyCredentials(m) {
  return Array.isArray(m.grant_types_supported) && m.grant_types_supported.includes(GRANT_CLIENT_CREDENTIALS);
}

class TokenClient {
  nonces = new Map;
  metadata = new Map;
  clock;
  clientId;
  f;
  ttlMs;
  softwareId;
  softwareVersion;
  discoveryMs;
  mintMs;
  mintBudgetMs;
  constructor(o) {
    if (typeof o.clientId !== "string" || o.clientId === "")
      throw new Error("TokenClient needs the runtime's public clientId");
    this.clock = o.clock;
    this.clientId = o.clientId;
    this.f = o.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.ttlMs = o.metadataTtlMs ?? METADATA_TTL_MS;
    this.softwareId = o.softwareId;
    this.softwareVersion = o.softwareVersion;
    this.discoveryMs = o.timeouts?.discoveryMs ?? DISCOVERY_TIMEOUT_MS;
    this.mintMs = o.timeouts?.mintMs ?? MINT_TIMEOUT_MS;
    this.mintBudgetMs = o.timeouts?.mintBudgetMs ?? MINT_BUDGET_MS;
  }
  identityFields() {
    return {
      ...this.softwareId ? { software_id: this.softwareId } : {},
      ...this.softwareVersion ? { software_version: this.softwareVersion } : {}
    };
  }
  discover(apiUrl, signal) {
    const origin = apiOrigin(apiUrl);
    const hit = this.metadata.get(origin);
    if (hit && Date.now() - hit.at < this.ttlMs)
      return abortable(hit.p, signal);
    const p = (async () => {
      const dl = deadline(this.discoveryMs);
      try {
        const { res, json } = await exchange(this.f, `${origin}/.well-known/oauth-authorization-server/api/agent-auth`, {
          headers: { Accept: "application/json" },
          signal: dl.signal
        });
        if (!res.ok)
          throw toOAuthError(res, json);
        const m = json;
        if (!m || typeof m.token_endpoint !== "string" || typeof m.issuer !== "string") {
          throw new DiscoveryError(`Bridge agent-auth discovery returned no token endpoint — is ${origin} a Bridge API?`);
        }
        assertSameAuthority(origin, m);
        return m;
      } finally {
        dl.clear();
      }
    })();
    this.metadata.set(origin, { at: Date.now(), p });
    p.catch(() => {
      if (this.metadata.get(origin)?.p === p)
        this.metadata.delete(origin);
    });
    return abortable(p, signal);
  }
  async deviceAuthorization(m, installationName, o = {}) {
    const dl = deadline(this.mintMs, o.signal);
    let res, json;
    try {
      ({ res, json } = await exchange(this.f, m.device_authorization_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: this.clientId, installation_name: installationName }),
        signal: dl.signal
      }, o.signal));
    } finally {
      dl.clear();
    }
    if (!res.ok)
      throw toOAuthError(res, json);
    const d = json;
    if (typeof d?.device_code !== "string" || typeof d?.user_code !== "string" || typeof d?.verification_uri !== "string") {
      throw new OAuthError({ error: "invalid_response", status: res.status, description: "device authorization answered without device_code + user_code + verification_uri" });
    }
    return d;
  }
  async postDpop(url, signer, build, hasAssertion, signal) {
    const origin = new URL(url).origin;
    const budget = deadline(this.mintBudgetMs, signal);
    try {
      let nonceRetried = false;
      let proofRetried = false;
      let assertionRetried = false;
      for (;; ) {
        const body = await build();
        const proof = await dpopProof(signer, this.clock, { htm: "POST", htu: url, nonce: this.nonces.get(origin) });
        const attempt = deadline(this.mintMs, budget.signal);
        let res, json;
        try {
          ({ res, json } = await exchange(this.f, url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json", DPoP: proof },
            body: JSON.stringify(body),
            signal: attempt.signal
          }, signal));
        } finally {
          attempt.clear();
        }
        this.clock.observe(res.headers.get("date"));
        const nonce = res.headers.get("dpop-nonce");
        if (nonce)
          this.nonces.set(origin, nonce);
        if (res.ok)
          return json;
        const err = toOAuthError(res, json);
        if (err.error === "use_dpop_nonce" && nonce && !nonceRetried) {
          nonceRetried = true;
          continue;
        }
        if (err.error === "invalid_dpop_proof" && err.description !== "key_already_enrolled" && !err.description?.startsWith("dpop_proof_required:") && !proofRetried) {
          proofRetried = true;
          continue;
        }
        if (hasAssertion && err.error === "invalid_client" && err.description === "assertion_invalid" && !assertionRetried) {
          assertionRetried = true;
          continue;
        }
        throw err;
      }
    } finally {
      budget.clear();
    }
  }
  static enrolled(json) {
    const j = json;
    if (typeof j?.installation_id !== "string" || !isJoinState(j?.join_state)) {
      throw new OAuthError({ error: "invalid_response", status: 200, description: "enrolment answered without installation_id + join_state" });
    }
    return j;
  }
  async enrolWithKey(m, signer, p, o = {}) {
    return TokenClient.enrolled(await this.postDpop(m.token_endpoint, signer, async () => ({
      grant_type: GRANT_ENROLMENT_KEY,
      enrolment_key: p.enrolmentKey,
      installation_name: p.installationName,
      key_storage: signer.keyStorage,
      ...this.identityFields()
    }), false, o.signal));
  }
  async exchangeCode(m, signer, p, o = {}) {
    return TokenClient.enrolled(await this.postDpop(m.token_endpoint, signer, async () => ({
      grant_type: "authorization_code",
      code: p.code,
      code_verifier: p.verifier,
      redirect_uri: p.redirectUri,
      client_id: this.clientId,
      key_storage: signer.keyStorage,
      ...this.identityFields()
    }), false, o.signal));
  }
  async pollDeviceCode(m, signer, deviceCode, o = {}) {
    return TokenClient.enrolled(await this.postDpop(m.token_endpoint, signer, async () => ({ grant_type: GRANT_DEVICE_CODE, device_code: deviceCode, client_id: this.clientId, key_storage: signer.keyStorage, ...this.identityFields() }), false, o.signal));
  }
  async mint(m, signer, p, o = {}) {
    const json = await this.postDpop(m.token_endpoint, signer, async () => ({
      grant_type: GRANT_CLIENT_CREDENTIALS,
      client_id: p.installationId,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(signer, this.clock, p.installationId, m.issuer),
      join_state: p.joinState,
      attempt: p.attempt,
      session_key: p.sessionKey,
      ...p.reconnect ? { reconnect: "true" } : {},
      ...p.platform ? { platform: p.platform } : {},
      ...p.clientVersion ? { client_version: p.clientVersion } : {},
      ...this.identityFields()
    }), true, o.signal);
    if (json?.token_type !== "DPoP" || typeof json?.access_token !== "string" || !isJoinState(json?.join_state) || typeof json?.session_id !== "string") {
      throw new OAuthError({ error: "invalid_response", status: 200, description: "mint answered without a DPoP token + join_state + session_id" });
    }
    return json;
  }
  async revoke(m, signer, p, o = {}) {
    const json = await this.postDpop(m.revocation_endpoint, signer, async () => ({
      client_id: p.installationId,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(signer, this.clock, p.installationId, m.issuer),
      join_state: p.joinState,
      ...p.attempt ? { attempt: p.attempt } : {},
      scope: p.scope,
      ...p.sessionKey ? { session_key: p.sessionKey } : {}
    }), true, o.signal);
    if (json?.ok !== true)
      throw new OAuthError({ error: "invalid_response", status: 200, description: 'revoke answered without {"ok":true}' });
  }
}
function isKeyAlreadyEnrolled(e) {
  return isOAuthError(e) && e.error === "invalid_dpop_proof" && e.description === "key_already_enrolled";
}
export { ADDRESSED_REASONS, BROADCAST_REASONS, isAddressed, WS_CLOSE_CODES, classifyClose, reconnectDelay, closeOutcome, DEFAULT_HOLDER_VERSION, decideLock, KNOWN_FORMAT, classifyVersioned, isNewerFormat, userAgent, identityTokenClientOptions, Dedupe, MAX_REPLAY_AGE_MS, sinceParam, advanceCursor, stripControlChars, FEED_PROTOCOL_VERSION, FEED_SERVER_FRAME_KINDS, FEED_CLIENT_FRAME_KINDS, FeedError, isFeedError, encodeFrame, FEED_MAX_LINE, FeedLineDecoder, parseServerFrame, parseClientFrame, FEED_RING_MAX_EVENTS, FEED_RING_MAX_BYTES, FeedRing, BODY_CAP_ROWS, TAIL_SGR, cleanText, cleanLine, charWidth, stringWidth, truncateTo, bodyRows, messageLayout, isCapped, clockOf, dayKey, renderMessage, clipRow, dateSeparator, newDivider, createRenderCache, renderTranscript, viewport, renderHeader, renderFooter, TAIL_MAX_MESSAGES, initialTailState, messageKey, hasMessage, tailReduce, parseTailInput, randomB64url, isP256PublicJwk, isP256PrivateJwk, jwkThumbprint, softwareSigner, generateSoftwareKey, deadline, normalizeHtu, apiOrigin, httpHtu, wsHtu, dpopProof, CLIENT_ASSERTION_TYPE, ASSERTION_TTL_S, clientAssertion, MAX_CLOCK_OFFSET_MS, Clock, isJoinState, joinStateSeq, OAuthError, isOAuthError, TransportError, DiscoveryError, AbortedError, GONE_REASONS, assertNever, classifyTokenError, MINT_TIMEOUT_MS, MINT_BUDGET_MS, METADATA_TTL_MS, supportsKeyCredentials, TokenClient, isKeyAlreadyEnrolled };
