/**
 * RFC-028 D3/D8 -- the hold verbs behind `/einweave:take|release|handover|scope`: take,
 * release, handover, scope, the takeable list and the agent's sessions. Pure of the MCP
 * server: the HTTP calls come in as `deps.api`, so every rule below runs against a fake.
 *
 * The one rule that shapes the module: **the server acts by id**. A person types `2`, a
 * link, an id or a few words; this file turns that into a thread (or session) id and the
 * server is only ever asked about the id. `N` means "item N of the list THIS session showed
 * last" -- kept here, in `memory`. When there is no such list (none shown, the last one was
 * another kind of list, N is past its end), nothing is acted on and the fresh list is shown
 * instead: a stale number is never guessed into a thread.
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SEARCH_PAGES = 4;
const SEARCH_PAGE_SIZE = 50;

export type ListKind = "takeable" | "held" | "sessions";
export interface ListItem {
  id: string;
  /** What the person saw next to the number: a thread title or a session label. */
  label: string;
}
export interface ListMemory {
  kind: ListKind;
  items: ListItem[];
  /** handover step 2: the thread the shown sessions are candidates for. */
  thread?: ListItem;
}

/** What a person typed after the verb. */
export type Ref =
  | { kind: "none" }
  | { kind: "all" }
  | { kind: "index"; n: number }
  | { kind: "id"; id: string }
  | { kind: "search"; text: string };

/**
 * `N` | a link or id (the LAST uuid in it: the thread/session id is the last path segment of
 * a link) | `all` | anything else = search words.
 */
export function parseRef(raw: unknown): Ref {
  if (raw === undefined || raw === null) return { kind: "none" };
  const s = String(raw).trim();
  if (!s) return { kind: "none" };
  if (/^all$/i.test(s)) return { kind: "all" };
  const n = /^#?(\d{1,3})$/.exec(s);
  if (n) return { kind: "index", n: Number(n[1]) };
  const ids = s.match(UUID_RE);
  if (ids && ids.length > 0) return { kind: "id", id: ids[ids.length - 1]!.toLowerCase() };
  return { kind: "search", text: s };
}

export interface ApiResult {
  status: number;
  body: any;
}

export interface HoldsDeps {
  api(method: string, path: string, body?: unknown): Promise<ApiResult>;
  /** This session's grant id and agent id (known once authenticated). */
  mySessionId(): string;
  myAgentId(): string;
  /** A channel name or id to its id, or null. */
  resolveChannelId(ref: string): Promise<string | null>;
  /** The server stored a new scope for this session. */
  onScope(scope: { mode: string; channelIds: string[] }): void;
  /** The scope the server last reported for this session, if any. */
  currentScope(): { mode: string; channelIds: string[] } | null;
}

interface TakeableRow {
  thread: { id: string; title: string };
  channel: { id: string; name: string };
  hold: { state: "unheld" | "parked" | "held"; holder: { id: string; label: string | null; online: boolean; parked: boolean } | null };
  why: "addressed" | "participant";
}

interface SessionRow {
  id: string;
  label: string | null;
  kind: string | null;
  scope: { mode: string; channelIds: string[] };
  state: "live" | "parked";
  online: boolean;
  holds: string[];
}

const nameOf = (label: string | null | undefined, id: string): string => label || `session ${id.slice(-4)}`;

function describeTakeable(r: TakeableRow): string {
  const h = r.hold;
  const state =
    h.state === "unheld"
      ? "unheld"
      : h.state === "parked"
        ? `parked (${nameOf(h.holder?.label, h.holder?.id ?? "")} is offline)`
        : `held by ${nameOf(h.holder?.label, h.holder?.id ?? "")} (online)`;
  return `#${r.channel.name} · ${r.thread.title} — ${state}, ${r.why === "addressed" ? "addressed to you" : "you took part"}`;
}

function errorText(res: ApiResult): string {
  const e = res.body?.error;
  return typeof e === "string" ? e : `HTTP ${res.status}`;
}

export function createHolds(deps: HoldsDeps) {
  let memory: ListMemory | null = null;

  function numbered(items: string[]): string {
    return items.map((t, i) => `${i + 1}. ${t}`).join("\n");
  }

  async function fetchTakeable(p: { channel?: string; limit?: number; cursor?: string }): Promise<{ rows: TakeableRow[]; next: string | null }> {
    const q = new URLSearchParams({ takeable: "1" });
    if (p.channel) q.set("channel", p.channel);
    if (p.limit) q.set("limit", String(p.limit));
    if (p.cursor) q.set("cursor", p.cursor);
    const res = await deps.api("GET", `/api/threads?${q}`);
    if (res.status === 404) throw new Error(`Channel ${p.channel} not found, or not visible to this agent.`);
    if (res.status >= 400) throw new Error(`Bridge API error ${res.status}: ${errorText(res)}`);
    return { rows: (res.body?.threads ?? []) as TakeableRow[], next: typeof res.body?.next === "string" ? res.body.next : null };
  }

  /** Show the takeable list (and remember it: the numbers refer to THIS list from now on). */
  async function showTakeable(p: { channel?: string; limit?: number; cursor?: string; lead?: string } = {}): Promise<string> {
    const { rows, next } = await fetchTakeable(p);
    memory = { kind: "takeable", items: rows.map((r) => ({ id: r.thread.id, label: r.thread.title })) };
    const lead = p.lead ? `${p.lead}\n\n` : "";
    if (rows.length === 0) return `${lead}No threads to take: nothing open is addressed to this agent or has it taking part, outside what this session already holds.`;
    return (
      `${lead}Threads this session could take (pick with take N, a link, an id, or words from the title):\n` +
      numbered(rows.map(describeTakeable)) +
      (next ? `\nMore: take again with cursor "${next}".` : "")
    );
  }

  async function fetchSessions(agentId: string): Promise<SessionRow[]> {
    const res = await deps.api("GET", `/api/agents/${encodeURIComponent(agentId)}/sessions`);
    if (res.status === 403) throw new Error("Only the agent itself and its managers can see its sessions.");
    if (res.status >= 400) throw new Error(`Bridge API error ${res.status}: ${errorText(res)}`);
    return (res.body?.sessions ?? []) as SessionRow[];
  }

  /** The threads THIS session holds, with titles: the sessions list names the ids, the thread read names the rest. */
  async function heldNow(): Promise<ListItem[]> {
    const me = (await fetchSessions(deps.myAgentId())).find((s) => s.id === deps.mySessionId());
    const ids = me?.holds ?? [];
    return await Promise.all(
      ids.map(async (id): Promise<ListItem> => {
        const res = await deps.api("GET", `/api/threads/${encodeURIComponent(id)}/messages?limit=1`);
        const title = res.status === 200 ? res.body?.thread?.title : undefined;
        return { id, label: typeof title === "string" && title ? title : id };
      })
    );
  }

  async function showHeld(lead?: string, verb = "release"): Promise<string> {
    const items = await heldNow();
    memory = { kind: "held", items };
    const l = lead ? `${lead}\n\n` : "";
    if (items.length === 0) return `${l}This session holds no threads.`;
    return `${l}Threads this session holds (pick with ${verb} N, a link, an id, or words from the title):\n${numbered(items.map((i) => i.label))}`;
  }

  /** N of the list last shown, if it is the kind of list this verb works on. */
  function fromMemory(kind: ListKind, n: number): ListItem | null {
    if (!memory || memory.kind !== kind) return null;
    return memory.items[n - 1] ?? null;
  }

  function matches(items: ListItem[], text: string): ListItem[] {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((i) => words.every((w) => i.label.toLowerCase().includes(w)));
  }

  /** Several matches: show them (they become THE list) and ask for one. */
  function showMatches(kind: ListKind, found: ListItem[], text: string, verb: string): string {
    memory = { kind, items: found };
    return `${found.length} threads match "${text}" -- pick one (${verb} N, or its id):\n${numbered(found.map((i) => i.label))}`;
  }

  async function searchTakeable(text: string): Promise<ListItem[]> {
    const found: ListItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < SEARCH_PAGES; page++) {
      const { rows, next } = await fetchTakeable({ limit: SEARCH_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      const words = text.toLowerCase().split(/\s+/).filter(Boolean);
      for (const r of rows) {
        const hay = `${r.thread.title} ${r.channel.name}`.toLowerCase();
        if (words.every((w) => hay.includes(w))) found.push({ id: r.thread.id, label: describeTakeable(r) });
      }
      if (!next) break;
      cursor = next;
    }
    return found;
  }

  return {
    /** What a verb last showed -- tests and `status` read it. */
    memory: () => memory,
    forget: () => {
      memory = null;
    },

    /** `list_threads(takeable)` and `take` with no argument. */
    listTakeable: showTakeable,
    /** The few threads `status` / the connect result name: unheld and parked ones, best first. */
    async needSomeone(limit = 5): Promise<{ lines: string[]; text: string }> {
      const { rows } = await fetchTakeable({ limit: 10 });
      const open = rows.filter((r) => r.hold.state !== "held").slice(0, limit);
      memory = { kind: "takeable", items: open.map((r) => ({ id: r.thread.id, label: r.thread.title })) };
      const lines = open.map(describeTakeable);
      return { lines, text: lines.length ? `Threads that need someone (take N):\n${numbered(lines)}` : "" };
    },

    async take(p: { ref?: unknown; confirm?: unknown; channel?: string; cursor?: string }): Promise<string> {
      const ref = parseRef(p.ref);
      if (ref.kind === "none" || ref.kind === "all") {
        return await showTakeable({ ...(p.channel ? { channel: p.channel } : {}), ...(p.cursor ? { cursor: p.cursor } : {}) });
      }
      let target: ListItem;
      if (ref.kind === "index") {
        const item = fromMemory("takeable", ref.n);
        if (!item) return await showTakeable({ lead: `There is no ${ref.n} in the list this session last showed (none shown, another kind of list, or it is shorter). Nothing was taken.` });
        target = item;
      } else if (ref.kind === "id") {
        target = { id: ref.id, label: ref.id };
      } else {
        const found = await searchTakeable(ref.text);
        if (found.length === 0) return await showTakeable({ lead: `No takeable thread matches "${ref.text}". Nothing was taken.` });
        if (found.length > 1) return showMatches("takeable", found, ref.text, "take");
        target = found[0]!;
      }
      const res = await deps.api("POST", `/api/threads/${encodeURIComponent(target.id)}/hold`, { action: "take", ...(p.confirm === true ? { confirm: true } : {}) });
      if (res.status === 409 && res.body?.error === "holder_online") {
        const h = res.body?.holder ?? {};
        const who = nameOf(h.label, String(h.id ?? ""));
        return (
          `${who} is online and working on this. Take it anyway?\n` +
          `Ask the person; if they agree, call take again with ref "${target.id}" and confirm: true. Nothing was taken.`
        );
      }
      if (res.status === 404 || res.status === 403) {
        return await showTakeable({ lead: `That thread cannot be taken (${errorText(res)}) -- the list may have changed. Nothing was taken.` });
      }
      if (res.status >= 400) throw new Error(`Bridge API error ${res.status}: ${errorText(res)}`);
      const moved = res.body?.moved ? ` ${res.body.moved} open entr${res.body.moved === 1 ? "y" : "ies"} moved to this session.` : "";
      return res.body?.changed === false
        ? `This session already held ${target.label}.`
        : `This session now holds ${target.label}.${moved} Reply with thread_id "${target.id}".`;
    },

    async release(p: { ref?: unknown }): Promise<string> {
      const ref = parseRef(p.ref);
      if (ref.kind === "none") return await showHeld();
      const releaseOne = async (item: ListItem): Promise<string> => {
        const res = await deps.api("POST", `/api/threads/${encodeURIComponent(item.id)}/hold`, { action: "release" });
        if (res.status >= 400) throw new Error(`Bridge API error ${res.status}: ${errorText(res)}`);
        return res.body?.changed === false ? `${item.label} was not held by this session.` : `Released ${item.label}.`;
      };
      if (ref.kind === "all") {
        const held = await heldNow();
        if (held.length === 0) return "This session holds no threads.";
        const out: string[] = [];
        for (const item of held) out.push(await releaseOne(item));
        memory = { kind: "held", items: [] };
        return out.join("\n");
      }
      if (ref.kind === "index") {
        const item = fromMemory("held", ref.n);
        if (!item) return await showHeld(`There is no ${ref.n} in the list this session last showed (none shown, another kind of list, or it is shorter). Nothing was released.`);
        return await releaseOne(item);
      }
      if (ref.kind === "id") return await releaseOne({ id: ref.id, label: ref.id });
      const held = await heldNow();
      const found = matches(held, ref.text);
      if (found.length === 0) return await showHeld(`This session holds no thread matching "${ref.text}". Nothing was released.`);
      if (found.length > 1) return showMatches("held", found, ref.text, "release");
      return await releaseOne(found[0]!);
    },

    /** Step 1 picks the thread, step 2 (`to`) the session. */
    async handover(p: { ref?: unknown; to?: unknown }): Promise<string> {
      const ref = parseRef(p.ref);
      const to = parseRef(p.to);
      let thread: ListItem | null = null;
      if (ref.kind === "none") {
        // `handover` with only `to`: the thread step 1 left pending.
        if (to.kind !== "none" && memory?.kind === "sessions" && memory.thread) thread = memory.thread;
        else return await showHeld(undefined, "handover");
      } else if (ref.kind === "index") {
        thread = fromMemory("held", ref.n);
        if (!thread) return await showHeld(`There is no ${ref.n} in the list this session last showed (none shown, another kind of list, or it is shorter). Nothing was handed over.`, "handover");
      } else if (ref.kind === "id") {
        thread = { id: ref.id, label: ref.id };
      } else if (ref.kind === "search") {
        const found = matches(await heldNow(), ref.text);
        if (found.length === 0) return await showHeld(`This session holds no thread matching "${ref.text}". Nothing was handed over.`, "handover");
        if (found.length > 1) return showMatches("held", found, ref.text, "handover");
        thread = found[0]!;
      } else {
        return "handover moves one thread at a time: name the thread (N, a link, an id or words from its title).";
      }

      const sessions = (await fetchSessions(deps.myAgentId())).filter((s) => s.id !== deps.mySessionId() && s.kind !== "observer");
      const describe = (s: SessionRow) => `${nameOf(s.label, s.id)} — ${s.kind ?? "session"}, ${s.state === "live" ? (s.online ? "online" : "live") : "parked"}, holds ${s.holds.length}`;
      const items = sessions.map((s): ListItem => ({ id: s.id, label: describe(s) }));
      const list = (lead: string) => {
        memory = { kind: "sessions", items, thread: thread! };
        return items.length === 0
          ? `${lead}This agent has no other session to hand ${thread!.label} to.`
          : `${lead}Hand ${thread!.label} to which session? (handover again with to: N, a session id, or part of its label)\n${numbered(items.map((i) => i.label))}`;
      };

      if (to.kind === "none" || to.kind === "all") return list("");
      let target: ListItem | undefined;
      if (to.kind === "index") {
        target = memory?.kind === "sessions" && memory.thread?.id === thread.id ? memory.items[to.n - 1] : undefined;
        if (!target) return list(`There is no ${to.n} in the session list this session last showed for this thread. Nothing was handed over.\n\n`);
      } else if (to.kind === "id") {
        target = items.find((i) => i.id === to.id) ?? { id: to.id, label: to.id };
      } else {
        const found = matches(items, to.text);
        if (found.length === 0) return list(`No other session of this agent matches "${to.text}". Nothing was handed over.\n\n`);
        if (found.length > 1) return list(`${found.length} sessions match "${to.text}".\n\n`);
        target = found[0]!;
      }
      const res = await deps.api("POST", `/api/threads/${encodeURIComponent(thread.id)}/hold`, { action: "handover", to: target.id });
      if (res.status >= 400) throw new Error(`Bridge API error ${res.status}: ${errorText(res)}`);
      memory = null;
      return res.body?.changed === false ? `${target.label.split(" — ")[0]} already held ${thread.label}.` : `Handed ${thread.label} to ${target.label.split(" — ")[0]}.`;
    },

    /** `/einweave:scope #a #b | all | none`; no argument shows the scope. */
    async scope(p: { channels?: unknown }): Promise<string> {
      const raw = p.channels;
      const tokens = (Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(/[\s,]+/) : [])
        .map((t) => t.trim().replace(/^#/, ""))
        .filter(Boolean);
      if (tokens.length === 0) return describeScope(deps.currentScope());
      let mode: "all" | "none" | "channels";
      let channelIds: string[] = [];
      if (tokens.length === 1 && /^all$/i.test(tokens[0]!)) mode = "all";
      else if (tokens.length === 1 && /^none$/i.test(tokens[0]!)) mode = "none";
      else {
        mode = "channels";
        const missing: string[] = [];
        for (const t of tokens) {
          const id = await deps.resolveChannelId(t);
          if (id) channelIds.push(id);
          else missing.push(t);
        }
        if (missing.length > 0) throw new Error(`No channel named ${missing.map((m) => `#${m}`).join(", ")} (or not visible to this agent). Scope was not changed.`);
        channelIds = [...new Set(channelIds)];
      }
      const res = await deps.api("PUT", "/api/sessions/me/scope", { mode, channelIds });
      if (res.status >= 400) throw new Error(`Bridge API error ${res.status}: ${errorText(res)}`);
      const scope = res.body?.scope ?? { mode, channelIds };
      deps.onScope(scope);
      return describeScope(scope, true);
    },

    /** `list_sessions`: the agent's sessions (its own, or its managers' view). */
    async listSessions(p: { agentId?: string }): Promise<string> {
      const agentId = p.agentId || deps.myAgentId();
      const sessions = await fetchSessions(agentId);
      if (sessions.length === 0) return "No live or parked sessions.";
      const me = deps.mySessionId();
      const lines = sessions.map(
        (s) =>
          `${nameOf(s.label, s.id)}${s.id === me ? " (this session)" : ""} — id ${s.id}, ${s.kind ?? "kind unknown"}, ${s.state === "live" ? (s.online ? "online" : "live") : "parked"}, scope ${scopeShort(s.scope)}, holds ${s.holds.length}`
      );
      return numbered(lines);
    },
  };
}

function scopeShort(scope: { mode: string; channelIds: string[] }): string {
  return scope.mode === "all" ? "all channels" : scope.mode === "none" ? "no channel" : `${scope.channelIds.length} channel(s) (${scope.channelIds.join(", ")})`;
}

export function describeScope(scope: { mode: string; channelIds: string[] } | null, changed = false): string {
  if (!scope) return "Scope: not known yet (this session has not authenticated).";
  return `${changed ? "Scope set. " : ""}Scope: ${scopeShort(scope)} -- unheld work in these reaches this session while the agent has no live gateway; threads it holds always arrive.`;
}
