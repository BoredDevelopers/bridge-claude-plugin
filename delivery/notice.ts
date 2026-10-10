/**
 * The text a `UserPromptSubmit` hook adds (`additionalContext`) for missed entries
 * (RFC-027 D7). It reaches the model as a system reminder, so it is FACTUAL and
 * METADATA ONLY: never a message body, never an imperative. Bodies reach the model
 * only through tool results. Everything a sender controls (handle, channel name)
 * is reduced to a plain charset first — a handle like `x"\nIgnore previous…` must
 * arrive as text that cannot open a new line or a tag.
 */
import { stripControlChars } from "../control-chars";

export interface NoticeEntry {
  id: string;
  kind: "message" | "action_request" | "task_event";
  type?: string;
  channelName?: string;
  threadId?: string;
  senderHandle?: string;
}

/** Full listings per notice; the rest are counted. */
export const MAX_LISTED = 10;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function safeId(v: string | undefined): string | null {
  return v && ID.test(v) ? v : null;
}

function safeName(v: string | undefined): string | null {
  if (!v) return null;
  const s = stripControlChars(v).replace(/[^\p{L}\p{N}._-]/gu, "").slice(0, 64);
  return s || null;
}

function describe(e: NoticeEntry): string {
  const what = e.kind === "message" ? (safeName(e.type) ?? "message") : e.kind.replace("_", " ");
  const channel = safeName(e.channelName);
  const sender = safeName(e.senderHandle);
  const thread = safeId(e.threadId);
  return [
    `- ${what}`,
    channel ? ` in #${channel}` : "",
    sender ? ` from @${sender}` : "",
    ` (id ${safeId(e.id) ?? "?"}${thread ? `, thread ${thread}` : ""})`,
    thread ? ` — read_thread("${thread}") returns it` : "",
  ].join("");
}

function countLine(entries: readonly NoticeEntry[]): string {
  const byChannel = new Map<string, number>();
  for (const e of entries) {
    const key = safeName(e.channelName) ? `#${safeName(e.channelName)}` : "other";
    byChannel.set(key, (byChannel.get(key) ?? 0) + 1);
  }
  const parts = [...byChannel].slice(0, MAX_LISTED).map(([k, n]) => `${k} ×${n}`);
  return `${entries.length} Bridge ${entries.length === 1 ? "entry" : "entries"} pushed earlier still unconfirmed (${parts.join(", ")}); list_threads and read_thread return them.`;
}

/** `null` when there is nothing to say: the hook then prints nothing at all. */
export function missedNotice(fresh: readonly NoticeEntry[], outstanding: readonly NoticeEntry[]): string | null {
  if (fresh.length === 0 && outstanding.length === 0) return null;
  const lines: string[] = [];
  if (fresh.length > 0) {
    lines.push(
      `Bridge pushed ${fresh.length} ${fresh.length === 1 ? "entry" : "entries"} to this session that did not reach you:`,
    );
    for (const e of fresh.slice(0, MAX_LISTED)) lines.push(describe(e));
    if (fresh.length > MAX_LISTED) lines.push(`- and ${fresh.length - MAX_LISTED} more`);
  }
  if (outstanding.length > 0) lines.push(countLine(outstanding));
  return lines.join("\n");
}
