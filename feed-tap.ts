/**
 * RFC-022 D8/D10 — this session's side of the local feed: the messages it surfaced to
 * the host and the ones it sent, served over a unix socket to a `tail` running in a
 * second terminal pane.
 *
 * WHY IT EXISTS. The host's window cuts an incoming message to a short preview and
 * shows an outgoing one as `Called plugin:bridge:bridge` with no text. Nothing this
 * plugin puts in a notification changes that. `tail` is where a person reads Bridge
 * messages in full, and this module is what feeds it.
 *
 * THE ONE RULE (D8): the feed can never affect delivery. Every entry point here is
 * best-effort and swallows its own failures — a socket that will not open, a client
 * that misbehaves, a frame field of the wrong shape. The caller never awaits anything
 * on the message path and never sees a throw.
 *
 * NOTHING AT REST (D3). Messages live in the feed server's in-memory ring and nowhere
 * else. The only thing written to disk is the launcher script, which holds two paths.
 *
 * The socket, the ring and the wire format are `@bridge/agent-sdk`'s, from the vendored
 * build (`vendor/bridge-agent-sdk`, stamped by `VERSION`). This file only translates the
 * plugin's own shapes — an inbound WS message, a `reply` tool call — into feed frames.
 */
import { chmodSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// TYPES only. The vendored build is loaded with `await import()` inside startFeedTap's
// try block: a missing or half-written chunk (an update in progress) must cost this
// session its feed, not its boot.
import type { FeedServer, FeedHelloInfo } from "./vendor/bridge-agent-sdk/node.js";
import type { FeedMessage, FeedStatusState } from "./vendor/bridge-agent-sdk/core/index.js";

/** What the tap remembers about a thread, learned from its root as it passes through. */
interface ThreadNote {
  title: string;
  /** Who started it — the default recipient of this session's reply into it. */
  rootSender: string;
}

/** Threads remembered for titles and reply recipients. Oldest forgotten first. */
const THREAD_NOTES_MAX = 500;
/** A title derived from a root's first line is cut here; the server's own cap is longer. */
const DERIVED_TITLE_MAX = 80;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The first non-blank line of a message — the same idea as the server's derived title. */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > DERIVED_TITLE_MAX ? line.slice(0, DERIVED_TITLE_MAX - 1) + "…" : line;
}

export class ThreadNotes {
  private notes = new Map<string, ThreadNote>();

  note(threadId: string, n: ThreadNote): void {
    if (!threadId) return;
    this.notes.delete(threadId);
    this.notes.set(threadId, n);
    if (this.notes.size > THREAD_NOTES_MAX) this.notes.delete(this.notes.keys().next().value as string);
  }

  get(threadId: string): ThreadNote | undefined {
    return this.notes.get(threadId);
  }
}

export interface InboundContext {
  /** The channel's name when the plugin knows it; the id is shown otherwise. */
  channelName: string;
  /** The server addressed this to us (target, mention, thread, assignee) — not broadcast traffic. */
  targeted: boolean;
}

/**
 * An inbound WS message → a feed frame. `msg` is untrusted wire data, so every field is
 * read defensively; the SDK strips control characters from every string when the frame
 * is encoded, and `tail` strips again when it prints.
 *
 * The server's frame carries a display name, not a handle, and no thread title. Both
 * are read from the frame FIRST (`senderHandle`, `threadTitle`), so the day the server
 * adds them this needs no change; until then the name stands in for the handle and the
 * title comes from the root, if this session saw it.
 */
export function inboundToFeed(msg: any, ctx: InboundContext, threads: ThreadNotes): FeedMessage {
  const threadId = str(msg?.threadId);
  // Shown as a root unless the frame says otherwise (a server older than `isRoot`)…
  const isRoot = msg?.isRoot !== false;
  const sender = str(msg?.senderHandle) || str(msg?.agentName) || str(msg?.senderName) || str(msg?.agentId) || "unknown";
  const text = str(msg?.content);
  // …but REMEMBERED as the thread's root only when the frame says so: a reply mistaken
  // for a root would overwrite the title and the recipient of every later reply.
  if (threadId && msg?.isRoot === true) threads.note(threadId, { title: str(msg?.threadTitle) || firstLine(text), rootSender: sender });
  const title = str(msg?.threadTitle) || (threadId ? threads.get(threadId)?.title ?? "" : "");
  const frame: FeedMessage = {
    t: "message",
    dir: "in",
    id: str(msg?.id) || `in-${Date.now()}`,
    ts: str(msg?.createdAt) || new Date().toISOString(),
    channel: { id: str(msg?.channelId), name: ctx.channelName || str(msg?.channelId) },
    is_root: isRoot,
    // Replayed rows carry no `senderType`; a row with no agent id was written by a person.
    sender: { id: str(msg?.agentId) || str(msg?.userId), handle: sender, kind: msg?.senderType === "human" || (!str(msg?.agentId) && msg?.senderType !== "agent") ? "human" : "agent" },
    targeted: ctx.targeted,
    type: str(msg?.type) || "text",
    text,
  };
  if (threadId) frame.thread_id = threadId;
  if (title) frame.thread_title = title;
  return frame;
}

export interface OutboundSend {
  /** The id the server returned for the send. */
  id: string;
  channelId: string;
  channelName: string;
  /** Set for a reply into a thread; empty for a new root. */
  threadId: string;
  /** The server's id for the thread this send started or joined, when it returned one. */
  resultThreadId: string;
  /** The explicit title of a new root, if the caller gave one. */
  title: string;
  type: string;
  text: string;
  /** This session's agent, as the sender. */
  self: { id: string; handle: string };
  /** The caller forced a broadcast reply: it has no single recipient. */
  broadcast: boolean;
  /** The session the server actually targeted, when it targeted one. */
  targetContextId: string;
}

/**
 * A successful `reply` → a feed frame. An outgoing message is always shown as addressed
 * (`targeted: true`): it is this session's own, never broadcast noise to its reader.
 * The recipient of a thread reply is whoever started the thread, when this session saw
 * the root; a new root, a forced broadcast, and a reply into our own thread have no single
 * recipient and carry none. The targeted session rides along when the server named one.
 */
export function outboundToFeed(send: OutboundSend, threads: ThreadNotes): FeedMessage {
  const isRoot = !send.threadId;
  const threadId = send.threadId || send.resultThreadId;
  if (isRoot && threadId) threads.note(threadId, { title: send.title || firstLine(send.text), rootSender: send.self.handle });
  const note = threadId ? threads.get(threadId) : undefined;
  const frame: FeedMessage = {
    t: "message",
    dir: "out",
    id: send.id || `out-${Date.now()}`,
    ts: new Date().toISOString(),
    channel: { id: send.channelId, name: send.channelName || send.channelId },
    is_root: isRoot,
    sender: { id: send.self.id, handle: send.self.handle || "me", kind: "agent" },
    targeted: true,
    type: send.type || "text",
    text: send.text,
  };
  if (threadId) frame.thread_id = threadId;
  if (note?.title) frame.thread_title = note.title;
  if (!isRoot && !send.broadcast && note?.rootSender && note.rootSender !== send.self.handle) {
    frame.to = send.targetContextId ? { handle: note.rootSender, context_id: send.targetContextId } : { handle: note.rootSender };
  }
  return frame;
}

/** A socket-file-safe name for this session: the SDK refuses anything outside `[A-Za-z0-9._-]`. */
export function feedContextName(sessionKey: string): string {
  return sessionKey.replace(/[^A-Za-z0-9._-]/g, "_") || "session";
}

/** `<stateDir>/bin/bridge-tail` — a stable path, so a shell alias survives plugin updates. */
export function launcherPath(stateDir: string): string {
  return join(stateDir, "bin", "bridge-tail");
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Write the launcher: a two-line shell script that runs THIS plugin version's vendored
 * `tail` against THIS state dir. Rewritten on every start, so after an update the same
 * path runs the new build — the person's alias never changes. Atomic (tmp + rename): two
 * windows start at once and must not leave a half-written script.
 */
export function writeLauncher(stateDir: string, pluginRoot: string): string {
  const path = launcherPath(stateDir);
  mkdirSync(join(stateDir, "bin"), { recursive: true, mode: 0o700 });
  chmodSync(join(stateDir, "bin"), 0o700); // an existing bin/ may have been created looser
  // The runtime by absolute path: the plugin is started with Claude's PATH, and the pane
  // the launcher runs in may not have `bun` on its own.
  const script =
    "#!/bin/sh\n" +
    "# Written by the Bridge plugin on every start (RFC-022 D10). Do not edit: it is replaced.\n" +
    `exec ${shq(process.execPath)} ${shq(join(pluginRoot, "vendor", "bridge-agent-sdk", "tail-cli.js"))} --procs ${shq(stateDir)} "$@"\n`;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, script, { mode: 0o700 });
  chmodSync(tmp, 0o700);
  renameSync(tmp, path);
  return path;
}

/**
 * Remove feed sockets left by plugin processes that are gone (SIGKILL, a crash, a power
 * loss): a socket is named `p<pid>.sock`, and nothing else would ever delete one until
 * that pid happened to be reused by another plugin. Only that exact name shape is
 * touched, and only for a pid that is not alive. Never throws.
 */
export function sweepStaleFeedSockets(stateDir: string, pidAlive: (pid: number) => boolean, log: (line: string) => void): number {
  let removed = 0;
  try {
    const dir = join(stateDir, "feed");
    for (const name of readdirSync(dir)) {
      const m = /^p(\d+)\.sock$/.exec(name);
      if (!m || pidAlive(Number(m[1]))) continue;
      try {
        unlinkSync(join(dir, name));
        removed++;
      } catch {}
    }
  } catch {
    // no feed/ yet
  }
  if (removed > 0) log(`bridge channel: removed ${removed} stale feed socket(s)`);
  return removed;
}

/** How long boot waits for the feed to open before going on without it. */
const FEED_OPEN_TIMEOUT_MS = 2_000;

export interface FeedTapOptions {
  stateDir: string;
  sessionKey: string;
  hello: () => FeedHelloInfo;
  log: (line: string) => void;
}

export interface FeedTap {
  /** The socket path, once the feed is serving; "" before that or if it could not open. */
  path(): string;
  inbound(msg: any, ctx: InboundContext): void;
  outbound(send: OutboundSend): void;
  status(state: FeedStatusState, reason?: string): void;
  /** Publish `stopped`, close the socket. Never throws. */
  stop(): Promise<void>;
}

/**
 * Open the feed for this session. Resolves either way: a feed that cannot open (a live
 * socket already there, an unsafe temp dir, a platform with no unix sockets) is logged
 * and the returned tap is inert, so the session runs exactly as it did before feeds
 * existed.
 */
export async function startFeedTap(o: FeedTapOptions): Promise<FeedTap> {
  const threads = new ThreadNotes();
  let server: FeedServer | null = null;
  // Bounded: boot awaits this. A listen that never calls back must not hold the session.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not open within ${FEED_OPEN_TIMEOUT_MS} ms`)), FEED_OPEN_TIMEOUT_MS);
  });
  const opening = (async () => {
    const { feedServer } = await import("./vendor/bridge-agent-sdk/node.js");
    return feedServer({ stateDir: o.stateDir, contextId: feedContextName(o.sessionKey), hello: o.hello });
  })();
  // If the timeout wins, a late open is closed again rather than left serving unannounced.
  // `gaveUp`, not `server !== late`: this callback runs BEFORE the await below resumes, so
  // at that moment `server` is still null for a perfectly good open.
  let gaveUp = false;
  opening.then((late) => { if (gaveUp) void late.close().catch(() => {}); }, () => {});
  try {
    server = await Promise.race([opening, timedOut]);
  } catch (err) {
    gaveUp = true;
    o.log(`bridge channel: local feed not started (tail will not see this session): ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  const guard = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      o.log(`bridge channel: local feed ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return {
    path: () => server?.path ?? "",
    inbound: (msg, ctx) => guard("inbound", () => server?.publish(inboundToFeed(msg, ctx, threads))),
    outbound: (send) => guard("outbound", () => server?.publish(outboundToFeed(send, threads))),
    status: (state, reason) => guard("status", () => server?.publish(reason ? { t: "status", state, reason } : { t: "status", state })),
    async stop() {
      const s = server;
      server = null;
      if (!s) return;
      try {
        s.publish({ t: "status", state: "stopped" });
        await s.close();
      } catch {}
    },
  };
}
