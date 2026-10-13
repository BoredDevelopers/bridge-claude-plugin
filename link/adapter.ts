/**
 * The `channel` delivery adapter (RFC-027 D7): every entry the SDK `Session` hands
 * over becomes one `notifications/claude/channel`, and nothing else happens here —
 * the entry stays PENDING until the model has it (the `UserPromptSubmit` hook
 * confirms it over the control socket, or a read tool returns it). Never acked on push.
 *
 * Tag shape is load-bearing: the hook reads `message_id` from the LEADING tag only
 * and only right after `source` and an optional `channel_id` (delivery/tags.ts), so
 * those two keys come first in `meta`, in that order, for every kind — a task event's
 * or an action's entry id rides as `message_id` too: it is the id the hook confirms.
 */
import type { DeliveryAdapter, Entry, Inbound } from "../vendor/einweave-agent-sdk/index.js";
import { isAddressed } from "../vendor/einweave-agent-sdk/core/index.js";

export type ChannelMeta = Record<string, string>;
export type Rendered = {
  content: string;
  meta: ChannelMeta;
};

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The sending session's grant, or "" — an `unattributed_` sentinel is a value, not an address. */
export function senderGrant(msg: Inbound): string {
  const meta = parseMetadata(msg.metadata);
  const raw = msg.senderContextId ?? meta.senderContextId;
  return typeof raw === "string" && raw && !raw.startsWith("unattributed_") ? raw : "";
}

export function renderMessage(msg: Inbound): Rendered {
  const meta = parseMetadata(msg.metadata);
  const out: ChannelMeta = {
    channel_id: msg.channelId ?? "",
    message_id: msg.id,
    sender: msg.agentName ?? msg.senderName ?? msg.agentId ?? "unknown",
    ...(msg.senderHandle ? { sender_handle: msg.senderHandle } : {}),
    sender_id: msg.agentId ?? msg.userId ?? "",
    type: msg.type ?? "text",
    // RFC-012 slice 5.2: the SURROGATE thread id — the reply key, present on roots too.
    ...(msg.threadId ? { thread_id: msg.threadId } : {}),
    ts: msg.createdAt ?? "",
  };
  if (str(meta.routedTo)) out.routed_to = str(meta.routedTo);
  // RFC-027 D2: `context_id` is the TARGET session's grant id.
  if (str(meta.contextId)) {
    out.context_id = str(meta.contextId);
    if (str(meta.contextLabel)) out.context_label = str(meta.contextLabel);
  }
  const from = senderGrant(msg);
  if (from) out.sender_context_id = from;
  if (str(meta.contextUnavailable)) out.context_unavailable = str(meta.contextUnavailable);
  return { content: msg.content ?? "", meta: out };
}

export function render(entry: Entry): Rendered {
  switch (entry.kind) {
    case "message":
      return renderMessage(entry.message);
    case "task_event": {
      const e = entry.event;
      const reason = e.reason ? ` — ${e.reason}` : "";
      return {
        content: `Task ${e.taskId}: ${e.change} (status ${e.status})${reason}`,
        meta: {
          message_id: entry.id,
          type: "task_event",
          thread_id: e.threadId,
          task_id: e.taskId,
          change: e.change,
          status: e.status,
          ts: e.occurredAt,
        },
      };
    }
    case "action_request": {
      const a = entry.action;
      let params = "";
      try {
        params = a.params === undefined || a.params === null ? "" : ` ${JSON.stringify(a.params)}`;
      } catch {}
      return { content: `Action requested: ${a.action}${params}`, meta: { message_id: entry.id, type: "action_request", action: a.action } };
    }
  }
}

export interface AdapterDeps {
  /** `mcp.notification` for `notifications/claude/channel` (the sanitising choke point). */
  notify(r: Rendered): Promise<void>;
  /** Resolves once the host can take notifications (first tool call, or a fallback timeout). */
  ready(): Promise<void>;
  /** This session's own grant id and agent id, once authenticated. */
  myGrant(): string;
  myAgentId(): string;
  /** An id this session sent (the reply tool records them). */
  isOwnSend(id: string): boolean;
  /** Our own send came back: settle it without surfacing (`ack dismissed`). */
  dismiss(id: string): void;
  /** The host accepted it — the missed tracker and the feed tap hang off this. */
  pushed(entry: Entry, rendered: Rendered): void;
  /**
   * A push threw: drop the entry from the SDK's pending set WITHOUT acking, so a redelivery or
   * the reconcile re-pushes it (the Session skips anything it still holds as pending).
   */
  unhold(id: string): void;
  /** A push threw: surface it (a silent inbound failure looks exactly like a quiet channel). */
  failed(entry: Entry, err: unknown): void;
}

/**
 * An entry that is never surfaced to the model: our own send coming back (even targeted at us
 * — the model can pass its own context_id to `reply`), the agent's other sessions' broadcasts,
 * and anything targeted at ANOTHER session of this agent (the server routes targets itself, RFC-027 D2;
 * this is the client's own check that a mis-route never surfaces in the wrong window). Shared by
 * the push path and `read_deliveries`, so both treat the same entries the same way.
 */
export function shouldDismiss(entry: Entry, d: Pick<AdapterDeps, "myGrant" | "myAgentId" | "isOwnSend">): boolean {
  if (entry.kind !== "message") return false;
  const mine = d.myGrant();
  const m = entry.message;
  const ownSend = (mine && senderGrant(m) === mine) || d.isOwnSend(entry.id);
  const ownAgentBroadcast = !!m.agentId && m.agentId === d.myAgentId() && !isAddressed(m.deliveryReasons);
  const meta = parseMetadata(m.metadata);
  const forOtherSession = !!mine && str(meta.contextId) !== "" && str(meta.contextId) !== mine && meta.contextAgentId === d.myAgentId();
  return !!(ownSend || ownAgentBroadcast || forOtherSession);
}

export function channelAdapter(d: AdapterDeps): DeliveryAdapter {
  return {
    mode: "channel",
    async push(entry) {
      if (shouldDismiss(entry, d)) {
        d.dismiss(entry.id);
        return;
      }
      await d.ready();
      let rendered: Rendered;
      try {
        rendered = render(entry);
        await d.notify(rendered);
      } catch (err) {
        try {
          d.unhold(entry.id);
        } finally {
          d.failed(entry, err);
        }
        throw err;
      }
      d.pushed(entry, rendered);
    },
  };
}
