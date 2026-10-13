/**
 * RFC-028 D3/D6/D8 through the real MCP server: the tool surface, the hold verbs over HTTP,
 * hold_update as a non-turn status, and EINWEAVE_CHANNELS as the STARTING server scope (names -> ids).
 * (The verbs' rules are unit-tested in holds.test.ts; this proves they are wired to the tools.)
 */
import { describe, test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { setup, status, connect, until } from "./plugin-harness";

const CH_GENERAL = "02000000-0000-7000-8000-00000000000a";
const CH_OPS = "02000000-0000-7000-8000-00000000000b";
const T1 = "01990000-0000-7000-8000-000000000001";
const T2 = "01990000-0000-7000-8000-000000000002";
const SIB = "00000000-0000-7000-8000-00000000bbbb";
const CHANNELS = [{ id: CH_GENERAL, name: "general" }, { id: CH_OPS, name: "ops" }];

type Call = { method: string; path: string; body: any };

/** A server for the hold endpoints; `calls` records what the plugin asked. */
function holdApi(over: { holderOnline?: boolean } = {}) {
  const calls: Call[] = [];
  const api = async (req: Request, url: URL): Promise<Response | undefined> => {
    let body: any = null;
    if (req.method !== "GET") body = await req.json().catch(() => null);
    calls.push({ method: req.method, path: url.pathname + url.search, body });
    if (req.method === "GET" && url.pathname === "/api/threads" && url.searchParams.get("takeable") === "1") {
      return Response.json({
        threads: [
          { thread: { id: T1, title: "Fix the build" }, channel: { id: CH_GENERAL, name: "general" }, hold: { state: "unheld", holder: null }, why: "addressed" },
          { thread: { id: T2, title: "Review the PR" }, channel: { id: CH_OPS, name: "ops" }, hold: { state: "held", holder: { id: SIB, label: "Bellman #cd34", online: true, parked: false } }, why: "participant" },
        ],
        next: null,
      });
    }
    if (req.method === "POST" && /^\/api\/threads\/[^/]+\/hold$/.test(url.pathname)) {
      if (body.action === "take" && url.pathname.includes(T2) && body.confirm !== true && over.holderOnline !== false) {
        return Response.json({ error: "holder_online", holder: { id: SIB, label: "Bellman #cd34", online: true } }, { status: 409 });
      }
      return Response.json({ threadId: T1, agentId: "agent-1", hold: { state: "held" }, changed: true, moved: 2 });
    }
    if (req.method === "PUT" && url.pathname === "/api/sessions/me/scope") return Response.json({ scope: body });
    if (req.method === "GET" && url.pathname === "/api/agents/agent-1/sessions") {
      return Response.json({ sessions: [{ id: SIB, label: "Bellman #cd34", kind: "gateway", scope: { mode: "all", channelIds: [] }, state: "live", online: true, holds: [T2] }] });
    }
  };
  return { api, calls };
}

const text = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const r: any = await c.callTool({ name, arguments: args });
  return r.content?.[0]?.text ?? "";
};

describe("the tool surface (RFC-028 D7/D8)", () => {
  test("list_sessions, take, release, handover and scope exist; list_contexts and reply's context_id are gone", async () => {
    await setup({}, async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const n of ["list_sessions", "take", "release", "handover", "scope", "list_threads", "reply"]) expect(names).toContain(n);
      expect(names).not.toContain("list_contexts");
      const reply: any = tools.find((t) => t.name === "reply");
      expect(Object.keys(reply.inputSchema.properties)).toEqual(expect.arrayContaining(["take", "confirm"]));
      expect(Object.keys(reply.inputSchema.properties)).not.toContain("context_id");
      const info = client.getInstructions() ?? "";
      expect(info).not.toContain("context_id");
      expect(info).not.toContain("list_contexts");
      expect(info).toContain("handover");
      expect(info).toContain('source="einweave"');
    });
  }, 40_000);
});

describe("the hold verbs, over HTTP", () => {
  test("list_threads(takeable) and take with no ref list the same numbered list; take N acts on the id; an online holder is asked about first", async () => {
    const h = holdApi();
    await setup({}, async (client) => {
      expect(await until(async () => (await status(client)).websocket === "connected", 15_000)).toBe(true);
      const listed = await text(client, "list_threads", { takeable: true });
      expect(listed).toContain("1. #general · Fix the build — unheld");
      expect(listed).toContain("2. #ops · Review the PR — held by Bellman #cd34 (online)");
      expect(h.calls.at(-1)!.path).toBe("/api/threads?takeable=1");

      const asked = await text(client, "take", { ref: "2" });
      expect(asked).toContain("Bellman #cd34 is online and working on this. Take it anyway?");
      expect(h.calls.at(-1)).toMatchObject({ method: "POST", path: `/api/threads/${T2}/hold`, body: { action: "take" } });

      const done = await text(client, "take", { ref: T2, confirm: true });
      expect(h.calls.at(-1)).toMatchObject({ path: `/api/threads/${T2}/hold`, body: { action: "take", confirm: true } });
      expect(done).toContain("now holds");

      const direct = await text(client, "take", { ref: "1" });
      expect(h.calls.at(-1)).toMatchObject({ path: `/api/threads/${T1}/hold`, body: { action: "take" } });
      expect(direct).toContain("now holds");
    }, { api: h.api });
  }, 60_000);

  test("scope: channel names become ids on the wire, status shows what the server stored, and a bad name changes nothing", async () => {
    const h = holdApi();
    await setup({}, async (client) => {
      expect(await until(async () => (await status(client)).websocket === "connected", 15_000)).toBe(true);
      const t = await text(client, "scope", { channels: "#general ops" });
      const put = h.calls.find((c) => c.method === "PUT")!;
      expect(put.body).toEqual({ mode: "channels", channelIds: [CH_GENERAL, CH_OPS] });
      expect(t).toContain("2 channel(s)");
      expect((await status(client)).scope).toEqual({ mode: "channels", channelIds: [CH_GENERAL, CH_OPS] });
      const bad: any = await client.callTool({ name: "scope", arguments: { channels: "nope" } });
      expect(bad.isError).toBe(true);
      expect(h.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    }, { api: h.api, channels: CHANNELS });
  }, 60_000);

  test("list_sessions lists the agent's sessions", async () => {
    const h = holdApi();
    await setup({}, async (client) => {
      expect(await until(async () => (await status(client)).websocket === "connected", 15_000)).toBe(true);
      const t = await text(client, "list_sessions");
      expect(t).toContain(`Bellman #cd34 — id ${SIB}, gateway, online, scope all channels, holds 1`);
      expect(h.calls.at(-1)!.path).toBe("/api/agents/agent-1/sessions");
    }, { api: h.api });
  }, 40_000);

  test("status and a connect on a live window name the threads that need someone (the same list take N works on)", async () => {
    const h = holdApi();
    await setup({}, async (client) => {
      expect(await until(async () => (await status(client)).websocket === "connected", 15_000)).toBe(true);
      const s = await status(client);
      expect(s.threads_that_need_someone).toContain("1. #general · Fix the build — unheld");
      expect(s.threads_that_need_someone).not.toContain("Review the PR"); // held by a live sibling: nobody needs to pick it up
      expect(await connect(client, {})).toContain("Threads that need someone");
      await text(client, "take", { ref: "1" });
      expect(h.calls.at(-1)).toMatchObject({ path: `/api/threads/${T1}/hold` });
    }, { api: h.api });
  }, 60_000);
});

describe("hold_update is a status, not a turn", () => {
  test("it keeps `holds` current and never reaches the model", async () => {
    await setup({}, async (client, notices, stub) => {
      expect(await until(async () => (await status(client)).websocket === "connected", 15_000)).toBe(true);
      expect((await status(client)).holds).toEqual([T1]);
      const before = notices().length;
      const push = (payload: unknown) => { for (const ws of stub.sockets) ws.send(JSON.stringify({ v: 2, type: "hold_update", payload })); };
      const me = (await status(client)).context_id;
      push({ threadId: T2, agentId: "agent-1", holder: { id: me, label: "me", online: true, parked: false }, via: "take", by: { principalId: "agent-1", sessionId: me } });
      expect(await until(async () => ((await status(client)).holds as string[]).includes(T2), 5_000)).toBe(true);
      push({ threadId: T1, agentId: "agent-1", holder: { id: SIB, label: "Bellman #cd34", online: true, parked: false }, via: "handover", by: { principalId: "agent-1", sessionId: me } });
      expect(await until(async () => !((await status(client)).holds as string[]).includes(T1), 5_000)).toBe(true);
      expect((await status(client)).holds).toEqual([T2]);
      await Bun.sleep(300);
      expect(notices().slice(before)).toEqual([]); // no model turn, no notice
    }, { holds: [T1] });
  }, 60_000);
});

describe("EINWEAVE_CHANNELS is the starting scope (RFC-028 D6)", () => {
  test("names and ids become the scope in the first auth frame; an unknown name is told, not widened", async () => {
    await setup({ EINWEAVE_CHANNELS: `general, ${CH_OPS},nope` }, async (client, notices, stub) => {
      expect(await until(() => stub.stats.authDeclared.length >= 1, 15_000)).toBe(true);
      expect(stub.stats.authDeclared[0]).toEqual({ kind: "session", scope: { mode: "channels", channelIds: [CH_GENERAL, CH_OPS] } });
      expect(await until(() => notices().some((n) => n.includes("EINWEAVE_CHANNELS names channel(s)")), 10_000)).toBe(true);
      expect(notices().find((n) => n.includes("EINWEAVE_CHANNELS"))).toContain("nope");
      expect(await until(async () => (await status(client)).websocket === "connected", 10_000)).toBe(true);
      expect((await status(client)).scope).toEqual({ mode: "channels", channelIds: [CH_GENERAL, CH_OPS] });
    }, { channels: CHANNELS });
  }, 60_000);

  test("no EINWEAVE_CHANNELS: no scope is sent (the server keeps the grant's); a gateway sends none either", async () => {
    await setup({}, async (_c, _n, stub) => {
      expect(await until(() => stub.stats.authDeclared.length >= 1, 15_000)).toBe(true);
      expect(stub.stats.authDeclared[0]).toEqual({ kind: "session" });
    }, { channels: CHANNELS });
    await setup({ EINWEAVE_CHANNELS: "general", EINWEAVE_CONNECTION_KIND: "gateway" }, async (_c, _n, stub) => {
      expect(await until(() => stub.stats.authDeclared.length >= 1, 15_000)).toBe(true);
      expect(stub.stats.authDeclared[0]).toEqual({ kind: "gateway" });
    }, { channels: CHANNELS });
  }, 60_000);

  test("a scope a person set with the scope tool is not put back by a later reopen", async () => {
    const h = holdApi();
    await setup({ EINWEAVE_CHANNELS: "general" }, async (client, _n, stub) => {
      expect(await until(async () => (await status(client)).websocket === "connected", 15_000)).toBe(true);
      await text(client, "scope", { channels: "ops" });
      await connect(client, { kind: "gateway" }); // a reopen: the frame must not carry the environment's scope again
      expect(await until(() => stub.stats.authDeclared.length >= 2, 15_000)).toBe(true);
      expect(await until(async () => (await status(client)).websocket === "connected", 10_000)).toBe(true);
      await connect(client, { kind: "session" });
      expect(await until(() => stub.stats.authDeclared.length >= 3, 15_000)).toBe(true);
      expect(stub.stats.authDeclared[0]).toMatchObject({ scope: { mode: "channels", channelIds: [CH_GENERAL] } });
      expect(stub.stats.authDeclared[1]).toEqual({ kind: "gateway" });
      expect(stub.stats.authDeclared[2]).toEqual({ kind: "session" }); // scope omitted: the server keeps the one the person set
    }, { api: h.api, channels: CHANNELS });
  }, 60_000);
});
