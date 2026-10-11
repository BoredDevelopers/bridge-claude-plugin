/**
 * RFC-027 T4a — the two seams between the plugin and the SDK `Session`:
 * link/client.ts (the plugin's credential as the Session's client) and
 * link/adapter.ts (entries → channel notifications, pending until the model has them).
 */
import { describe, test, expect } from "bun:test";
import { isTerminalCredentialError, isAgentClientError, type Entry, type Inbound } from "../vendor/bridge-agent-sdk/index.js";
import { CredentialError, type CredentialManager } from "../auth/manager";
import { sessionClient, toAgentClientError, credentialCause } from "../link/client";
import { channelAdapter, render, type AdapterDeps, type Rendered } from "../link/adapter";
import { deliveredEntryId } from "../delivery/tags";

const KINDS: CredentialError["kind"][] = ["not_logged_in", "profile", "api_url", "logged_out", "session_revoked", "session_limit", "too_old", "refused", "network"];

describe("link/client — credential errors keep their meaning across the seam", () => {
  test("every kind but network stops the Session; network retries", () => {
    for (const kind of KINDS) {
      const e = toAgentClientError(new CredentialError(kind, `msg ${kind}`));
      expect(isTerminalCredentialError(e)).toBe(kind !== "network");
      expect(e.message).toBe(`msg ${kind}`);
      expect(credentialCause(e)?.kind).toBe(kind);
    }
  });

  test("too_old stays too_old (the Session's own too-old stop); anything not a CredentialError retries", () => {
    expect(toAgentClientError(new CredentialError("too_old", "x")).code).toBe("too_old");
    const other = toAgentClientError(new Error("discovery 503"));
    expect(other.code).toBe("network");
    expect(isTerminalCredentialError(other)).toBe(false);
    expect(credentialCause(other)).toBeNull();
  });

  function fakeCreds(over: Partial<CredentialManager> = {}): CredentialManager {
    return { apiUrl: () => "https://b.example", wsAuth: async () => ({ token: "t", dpop: "p" }), grant: () => null, ...over } as unknown as CredentialManager;
  }

  test("wsAuth rejects with an AgentClientError carrying the CredentialError", async () => {
    const c = sessionClient(fakeCreds({ wsAuth: () => Promise.reject(new CredentialError("logged_out", "signed out")) }), { sessionKey: () => "k", softwareId: "s", softwareVersion: "0.30.0", api: async () => ({}) });
    const err = await c.wsAuth().catch((e) => e);
    expect(isAgentClientError(err)).toBe(true);
    expect(credentialCause(err)?.kind).toBe("logged_out");
  });

  test("rotate reaches the subscribed Session only until it unsubscribes", () => {
    const c = sessionClient(fakeCreds(), { sessionKey: () => "k", softwareId: "s", softwareVersion: "v", api: async () => ({}) });
    const got: string[] = [];
    const off = c.onAccessRotated((f) => got.push(f.token));
    c.rotate({ token: "a", dpop: "p" });
    off();
    c.rotate({ token: "b", dpop: "p" });
    expect(got).toEqual(["a"]);
  });

  test("api subset → the plugin's own JSON helper, on the server's paths", async () => {
    const calls: unknown[] = [];
    const c = sessionClient(fakeCreds(), { sessionKey: () => "k", softwareId: "s", softwareVersion: "v", api: async (...a) => (calls.push(a), { id: "x" }) });
    await c.api.messages.create("ch1", { content: "hi" });
    await c.api.threads.reply("t/1", { content: "yo" });
    await c.api.deliveries.list();
    expect(calls).toEqual([
      ["POST", "/api/messages", { channelId: "ch1", content: "hi" }],
      ["POST", "/api/threads/t%2F1/messages", { content: "yo" }],
      ["GET", "/api/deliveries", undefined],
    ]);
  });
});

const ME = { grant: "01992f6e-0000-7000-8000-00000000aaaa", agent: "agent-me" };

function msg(id: string, over: Partial<Inbound> = {}): Inbound {
  return {
    id,
    channelId: "01992f6e-0000-7000-8000-000000000c01",
    threadId: "01992f6e-0000-7000-8000-000000000f01",
    content: `body ${id}`,
    type: "question",
    createdAt: "2026-10-11T10:00:00Z",
    agentId: "agent-kai",
    agentName: "Kai",
    senderHandle: "kai",
    senderContextId: "01992f6e-0000-7000-8000-00000000bbbb",
    metadata: JSON.stringify({ contextId: ME.grant, contextLabel: "my window" }),
    deliveryReasons: ["broadcast" as never],
    ...over,
  } as Inbound;
}
const asEntry = (m: Inbound): Entry => ({ kind: "message", id: m.id, redelivery: false, message: m });

/** The host's rendering of a channel notification (measured shape, delivery/tags.ts). */
function hostTag(r: Rendered): string {
  const attrs = Object.entries(r.meta).map(([k, v]) => `${k}="${v}"`).join(" ");
  return `<channel source="plugin:bridge:bridge" ${attrs}>\n${r.content}\n</channel>`;
}

function harness(over: Partial<AdapterDeps> = {}) {
  const notified: Rendered[] = [];
  const dismissed: string[] = [];
  const pushed: string[] = [];
  const failed: string[] = [];
  const deps: AdapterDeps = {
    notify: async (r) => void notified.push(r),
    ready: async () => {},
    myGrant: () => ME.grant,
    myAgentId: () => ME.agent,
    isOwnSend: () => false,
    dismiss: (id) => void dismissed.push(id),
    pushed: (e) => void pushed.push(e.id),
    failed: (e) => void failed.push(e.id),
    ...over,
  };
  return { adapter: channelAdapter(deps), notified, dismissed, pushed, failed };
}

describe("link/adapter — what reaches the model", () => {
  test("a message's tag leads with channel_id then message_id, so the hook can confirm it", () => {
    const r = render(asEntry(msg("01992f6e-0000-7000-8000-0000000000a1")));
    expect(Object.keys(r.meta).slice(0, 2)).toEqual(["channel_id", "message_id"]);
    expect(deliveredEntryId(hostTag(r))).toBe(r.meta.message_id);
    expect(r.meta).toMatchObject({ sender: "Kai", sender_handle: "kai", type: "question", context_id: ME.grant, context_label: "my window", sender_context_id: "01992f6e-0000-7000-8000-00000000bbbb" });
  });

  test("task events and action requests carry their entry id as message_id, first", () => {
    const te: Entry = { kind: "task_event", id: "01992f6e-0000-7000-8000-0000000000e1", redelivery: false, event: { id: "01992f6e-0000-7000-8000-0000000000e1", taskId: "T1", threadId: "TH1", change: "assigned", status: "open", assigneeId: null, actorId: null, reason: null, occurredAt: "2026-10-11T10:00:00Z" } };
    const ar: Entry = { kind: "action_request", id: "01992f6e-0000-7000-8000-0000000000a1", redelivery: false, action: { id: "01992f6e-0000-7000-8000-0000000000a1", action: "restart", params: { force: true } } };
    for (const e of [te, ar]) {
      const r = render(e);
      expect(Object.keys(r.meta)[0]).toBe("message_id");
      expect(deliveredEntryId(hostTag(r))).toBe(e.id);
    }
    expect(render(ar).content).toBe('Action requested: restart {"force":true}');
  });

  test("own send coming back (by grant, or by sent id) → dismissed, never surfaced", async () => {
    const h = harness({ isOwnSend: (id) => id === "sent-by-tool" });
    await h.adapter.push!(asEntry(msg("a1", { senderContextId: ME.grant })));
    await h.adapter.push!(asEntry(msg("sent-by-tool")));
    expect(h.notified).toEqual([]);
    expect(h.dismissed).toEqual(["a1", "sent-by-tool"]);
  });

  test("the agent's other session: a broadcast is dismissed, an addressed one is surfaced", async () => {
    const h = harness();
    await h.adapter.push!(asEntry(msg("b1", { agentId: ME.agent })));
    await h.adapter.push!(asEntry(msg("b2", { agentId: ME.agent, deliveryReasons: ["target" as never] })));
    expect(h.dismissed).toEqual(["b1"]);
    expect(h.pushed).toEqual(["b2"]);
  });

  test("targeted at another session of this agent → dismissed; at this one → surfaced", async () => {
    const h = harness();
    await h.adapter.push!(asEntry(msg("e1", { metadata: JSON.stringify({ contextId: "other-grant", contextAgentId: ME.agent }) })));
    await h.adapter.push!(asEntry(msg("e2", { metadata: JSON.stringify({ contextId: ME.grant, contextAgentId: ME.agent }) })));
    expect(h.dismissed).toEqual(["e1"]);
    expect(h.pushed).toEqual(["e2"]);
  });

  test("nothing is pushed before the host is ready", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const h = harness({ ready: () => gate });
    const p = h.adapter.push!(asEntry(msg("c1")));
    await Bun.sleep(5);
    expect(h.notified).toEqual([]);
    open();
    await p;
    expect(h.pushed).toEqual(["c1"]);
  });

  test("a notification that fails is reported and the push rejects (the entry stays pending, unpushed)", async () => {
    const h = harness({ notify: async () => Promise.reject(new Error("transport closed")) });
    await expect(h.adapter.push!(asEntry(msg("d1")))).rejects.toThrow("transport closed");
    expect(h.failed).toEqual(["d1"]);
    expect(h.pushed).toEqual([]);
  });
});
