/**
 * RFC-028 D3/D8: the hold verbs (holds.ts) against a fake API. The rule under test is
 * "the server acts by id": a number, a link, an id or words become an id here, and a stale
 * number is never guessed into a thread.
 */
import { describe, test, expect } from "bun:test";
import { createHolds, parseRef, describeScope, type ApiResult, type HoldsDeps } from "../holds";

const ME = "00000000-0000-7000-8000-00000000aaaa";
const AGENT = "00000000-0000-7000-8000-0000000000a1";
const T1 = "01990000-0000-7000-8000-000000000001";
const T2 = "01990000-0000-7000-8000-000000000002";
const T3 = "01990000-0000-7000-8000-000000000003";
const S2 = "00000000-0000-7000-8000-00000000bbbb";
const CH_A = "02000000-0000-7000-8000-00000000000a";
const CH_B = "02000000-0000-7000-8000-00000000000b";

type Call = { method: string; path: string; body?: any };

function takeableRow(id: string, title: string, state: "unheld" | "parked" | "held" = "unheld", holder: any = null) {
  return {
    thread: { id, title },
    channel: { id: CH_A, name: "general" },
    hold: { state, holder },
    why: "addressed",
  };
}

function fake(routes: (c: Call) => ApiResult | undefined, over: Partial<HoldsDeps> = {}) {
  const calls: Call[] = [];
  let scope: any = null;
  const deps: HoldsDeps = {
    api: async (method, path, body) => {
      const c = { method, path, body };
      calls.push(c);
      return routes(c) ?? { status: 404, body: { error: "Not found" } };
    },
    mySessionId: () => ME,
    myAgentId: () => AGENT,
    resolveChannelId: async (r) => ({ a: CH_A, b: CH_B }[r] ?? null),
    onScope: (s) => (scope = s),
    currentScope: () => scope,
    ...over,
  };
  return { holds: createHolds(deps), calls, scope: () => scope };
}

const list3 = (c: Call): ApiResult | undefined =>
  c.method === "GET" && c.path.startsWith("/api/threads?takeable=1")
    ? { status: 200, body: { threads: [takeableRow(T1, "Fix the build"), takeableRow(T2, "Review the PR", "parked", { id: S2, label: "Bellman #cd34", online: false, parked: true }), takeableRow(T3, "Deploy plan")], next: null } }
    : undefined;

describe("parseRef", () => {
  test("a number, a link or id (the last uuid), all, words, nothing", () => {
    expect(parseRef("2")).toEqual({ kind: "index", n: 2 });
    expect(parseRef("#12")).toEqual({ kind: "index", n: 12 });
    expect(parseRef(T1)).toEqual({ kind: "id", id: T1 });
    const W = "03000000-0000-7000-8000-0000000000aa";
    // The web thread URL: /w/<workspace>/c/<channel>/t/<thread>. Workspace and channel ids are uuids too.
    expect(parseRef(`https://einweave.example/w/${W}/c/${CH_A}/t/${T2}`)).toEqual({ kind: "id", id: T2 });
    expect(parseRef(`https://einweave.example/w/${W}/c/${CH_A}/t/${T2}?x=1#top`)).toEqual({ kind: "id", id: T2 });
    // A link with no /t/ segment is not a thread: it must not be read as the channel or workspace id.
    expect(parseRef(`https://einweave.example/w/${W}/c/${CH_A}`)).toEqual({ kind: "search", text: `https://einweave.example/w/${W}/c/${CH_A}` });
    expect(parseRef("ALL")).toEqual({ kind: "all" });
    expect(parseRef("fix the build")).toEqual({ kind: "search", text: "fix the build" });
    expect(parseRef("  ")).toEqual({ kind: "none" });
    expect(parseRef(undefined)).toEqual({ kind: "none" });
  });
});

describe("take: N refers to the list this session showed last, and the server is asked about the id", () => {
  test("no argument lists, numbered, and remembers the list", async () => {
    const f = fake(list3);
    const text = await f.holds.take({});
    expect(text).toContain("1. #general · Fix the build — unheld");
    expect(text).toContain("2. #general · Review the PR — parked (Bellman #cd34 is offline)");
    expect(f.holds.memory()?.items.map((i) => i.id)).toEqual([T1, T2, T3]);
  });

  test("take 2 after the list posts take for the id at position 2 -- not 'the second thing the server returns now'", async () => {
    let order = [T1, T2, T3];
    const f = fake((c) => {
      if (c.method === "GET") return { status: 200, body: { threads: order.map((id) => takeableRow(id, id)), next: null } };
      if (c.method === "POST") return { status: 200, body: { changed: true, moved: 3, hold: { state: "held" } } };
    });
    await f.holds.take({});
    order = [T3, T1, T2]; // the server's list moves on after it was shown
    const text = await f.holds.take({ ref: "2" });
    const post = f.calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe(`/api/threads/${T2}/hold`);
    expect(post.body).toEqual({ action: "take" });
    expect(text).toContain("now holds");
    expect(text).toContain("3 open entries moved");
  });

  test("a stale or absent list is never guessed: no POST, the fresh list is shown instead", async () => {
    const f = fake(list3);
    // No list shown yet.
    let text = await f.holds.take({ ref: "2" });
    expect(f.calls.some((c) => c.method === "POST")).toBe(false);
    expect(text).toContain("There is no 2 in the list this session last showed");
    expect(text).toContain("1. #general · Fix the build");
    // N past the end of the list that was shown.
    text = await f.holds.take({ ref: "9" });
    expect(f.calls.some((c) => c.method === "POST")).toBe(false);
    expect(text).toContain("There is no 9");
    // The last list shown was a different kind (held threads): N of THAT is not a thing to take.
    const g = fake((c) =>
      c.path.includes("/sessions") ? { status: 200, body: { sessions: [{ id: ME, label: "me", kind: "session", scope: { mode: "all", channelIds: [] }, state: "live", online: true, holds: [T1] }] } }
        : c.path.includes("/messages?limit=1") ? { status: 200, body: { thread: { title: "Held thing" } } }
        : list3(c));
    await g.holds.release({});
    expect(g.holds.memory()?.kind).toBe("held");
    text = await g.holds.take({ ref: "1" });
    expect(g.calls.some((c) => c.method === "POST")).toBe(false);
    expect(text).toContain("There is no 1");
  });

  test("a link or id acts on that id without needing a list", async () => {
    const f = fake((c) => (c.method === "POST" ? { status: 200, body: { changed: true, moved: 0 } } : undefined));
    await f.holds.take({ ref: `https://einweave.example/w/ws/c/${CH_A}/t/${T3}` });
    expect(f.calls).toEqual([{ method: "POST", path: `/api/threads/${T3}/hold`, body: { action: "take" } }]);
  });

  test("words: one match acts; several list and become the list; none shows the list", async () => {
    const f = fake((c) => (c.method === "POST" ? { status: 200, body: { changed: true, moved: 0 } } : list3(c)));
    await f.holds.take({ ref: "review" });
    expect(f.calls.at(-1)!.path).toBe(`/api/threads/${T2}/hold`);

    const g = fake(list3);
    const many = await g.holds.take({ ref: "general" }); // the channel name matches all three
    expect(many).toContain("3 threads match");
    expect(g.calls.some((c) => c.method === "POST")).toBe(false);
    expect(g.holds.memory()?.items).toHaveLength(3);

    const none = await g.holds.take({ ref: "zebra" });
    expect(none).toContain('No takeable thread matches "zebra"');
    expect(g.calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("take from an online holder asks first", () => {
  const online = (c: Call): ApiResult | undefined => {
    if (c.method !== "POST") return undefined;
    return c.body.confirm === true
      ? { status: 200, body: { changed: true, moved: 1, hold: { state: "held" } } }
      : { status: 409, body: { error: "holder_online", holder: { id: S2, label: "Bellman #cd34", online: true } } };
  };

  test("409 holder_online becomes the question, names the holder, and takes nothing", async () => {
    const f = fake(online);
    const text = await f.holds.take({ ref: T1 });
    expect(text).toContain("Bellman #cd34 is online and working on this. Take it anyway?");
    expect(text).toContain("confirm: true");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.body).toEqual({ action: "take" });
  });

  test("confirm: true sends the confirmation and takes it", async () => {
    const f = fake(online);
    const text = await f.holds.take({ ref: T1, confirm: true });
    expect(f.calls[0]!.body).toEqual({ action: "take", confirm: true });
    expect(text).toContain("now holds");
  });

  test("a holder with no label is still named", async () => {
    const f = fake((c) => (c.method === "POST" ? { status: 409, body: { error: "holder_online", holder: { id: S2, label: null, online: true } } } : undefined));
    expect(await f.holds.take({ ref: T1 })).toContain("session bbbb is online and working on this.");
  });
});

describe("release and handover", () => {
  const sessions = {
    sessions: [
      { id: ME, label: "me", kind: "session", scope: { mode: "all", channelIds: [] }, state: "live", online: true, holds: [T1, T2] },
      { id: S2, label: "Bellman #cd34", kind: "session", scope: { mode: "all", channelIds: [] }, state: "live", online: true, holds: [] },
      { id: "00000000-0000-7000-8000-00000000cccc", label: "watcher", kind: "observer", scope: { mode: "all", channelIds: [] }, state: "live", online: true, holds: [] },
    ],
  };
  const routes = (c: Call): ApiResult | undefined => {
    if (c.path.endsWith("/sessions")) return { status: 200, body: sessions };
    if (c.path.includes("/messages?limit=1")) return { status: 200, body: { thread: { title: c.path.includes(T1) ? "Fix the build" : "Review the PR" } } };
    if (c.method === "POST") return { status: 200, body: { changed: true, moved: 0, hold: null } };
  };

  test("release with no argument lists what this session holds; N releases that id; release all releases each", async () => {
    const f = fake(routes);
    expect(await f.holds.release({})).toContain("1. Fix the build\n2. Review the PR");
    await f.holds.release({ ref: "2" });
    expect(f.calls.at(-1)).toEqual({ method: "POST", path: `/api/threads/${T2}/hold`, body: { action: "release" } });
    const all = await f.holds.release({ ref: "all" });
    const posts = f.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.path)).toEqual([`/api/threads/${T2}/hold`, `/api/threads/${T1}/hold`, `/api/threads/${T2}/hold`]);
    expect(all).toContain("Released Fix the build.");
  });

  test("handover is two steps: the thread, then one of the agent's OTHER sessions (never itself, never an observer)", async () => {
    const f = fake(routes);
    expect(await f.holds.handover({})).toContain("1. Fix the build");
    const step2 = await f.holds.handover({ ref: "1" });
    expect(step2).toContain("1. Bellman #cd34");
    expect(step2).not.toContain("watcher");
    expect(step2).not.toContain("me —");
    expect(f.calls.some((c) => c.method === "POST")).toBe(false);
    const done = await f.holds.handover({ to: "1" }); // the thread is the one step 1 left pending
    expect(f.calls.at(-1)).toEqual({ method: "POST", path: `/api/threads/${T1}/hold`, body: { action: "handover", to: S2 } });
    expect(done).toContain("Handed Fix the build to Bellman #cd34");
    // Words pick the session too.
    await f.holds.handover({ ref: T2, to: "cd34" });
    expect(f.calls.at(-1)).toEqual({ method: "POST", path: `/api/threads/${T2}/hold`, body: { action: "handover", to: S2 } });
  });

  test("a stale session number is not guessed", async () => {
    const f = fake(routes);
    const text = await f.holds.handover({ ref: T1, to: "5" });
    expect(f.calls.some((c) => c.method === "POST")).toBe(false);
    expect(text).toContain("There is no 5");
  });
});

describe("scope: channel names become ids and the server stores them", () => {
  test("names (with or without #) resolve to ids; PUT carries ids", async () => {
    const f = fake((c) => (c.method === "PUT" ? { status: 200, body: { scope: c.body } } : undefined));
    const text = await f.holds.scope({ channels: "#a, b" });
    expect(f.calls).toEqual([{ method: "PUT", path: "/api/sessions/me/scope", body: { mode: "channels", channelIds: [CH_A, CH_B] } }]);
    expect(f.scope()).toEqual({ mode: "channels", channelIds: [CH_A, CH_B] });
    expect(text).toContain("2 channel(s)");
  });

  test("all and none are modes, not channel names", async () => {
    const f = fake((c) => (c.method === "PUT" ? { status: 200, body: { scope: c.body } } : undefined));
    await f.holds.scope({ channels: "all" });
    await f.holds.scope({ channels: ["none"] });
    expect(f.calls.map((c) => c.body)).toEqual([{ mode: "all", channelIds: [] }, { mode: "none", channelIds: [] }]);
  });

  test("an unknown channel changes nothing", async () => {
    const f = fake((c) => (c.method === "PUT" ? { status: 200, body: { scope: c.body } } : undefined));
    await expect(f.holds.scope({ channels: "a nope" })).rejects.toThrow(/No channel named #nope.*not changed/);
    expect(f.calls).toHaveLength(0);
  });

  test("no argument shows the scope the server reported", async () => {
    const f = fake(() => undefined, { currentScope: () => ({ mode: "all", channelIds: [] }) });
    expect(await f.holds.scope({})).toBe(describeScope({ mode: "all", channelIds: [] }));
    expect(describeScope(null)).toContain("not known yet");
  });
});

describe("list_sessions", () => {
  test("lists the agent's sessions with kind, state, scope and holds, and marks this one", async () => {
    const f = fake((c) =>
      c.path === `/api/agents/${AGENT}/sessions`
        ? { status: 200, body: { sessions: [
            { id: ME, label: "me #aaaa", kind: "session", scope: { mode: "all", channelIds: [] }, state: "live", online: true, holds: [T1] },
            { id: S2, label: "Bellman #cd34", kind: "gateway", scope: { mode: "none", channelIds: [] }, state: "parked", online: false, holds: [] },
          ] } }
        : undefined);
    const text = await f.holds.listSessions({});
    expect(text).toContain("me #aaaa (this session)");
    expect(text).toContain(`id ${S2}, gateway, parked, scope no channel, holds 0`);
  });

  test("a 403 says who may look", async () => {
    const f = fake(() => ({ status: 403, body: { error: "Forbidden" } }));
    await expect(f.holds.listSessions({ agentId: "x" })).rejects.toThrow(/agent itself and its managers/);
  });
});
