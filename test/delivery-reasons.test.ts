/**
 * BRIDGE_CHANNELS may narrow broadcast traffic. It must NEVER suppress a message
 * the server addressed to this session.
 *
 * WHY THIS EXISTS — a message was received and binned on 2026-07-30.
 *
 * `channelDecision()` dropped anything whose channel was not in BRIDGE_CHANNELS,
 * with one exemption: the agent's own `<agent>-tasks`. Explicit context targeting
 * bypassed it via `targetsThisSession`; `mention` and `thread` had no bypass at
 * all. So aio's in-thread reply in `aio-tasks` was delivered to all three
 * jorgen-mac sockets at 07:24:23Z and surfaced in none of them.
 *
 * The receipt still read `delivered`, because the drop happens AFTER the frame
 * arrives. That is the part that makes this worth a test rather than a patch:
 * the ledger asserted the client had a message the model never saw.
 *
 * ⚠️ THE `-tasks` EXEMPTION DESCRIBED ABOVE NO LONGER EXISTS. It was deleted
 * with the convention itself (bridge issue #13), so that paragraph is history,
 * not a description of today's code. Nothing in this file needed changing when
 * it went — which is the point: these tests were always about the REASON TIER,
 * never the channel name. Note the exemption never fired here anyway (the stub
 * authenticates as `jorgen-mac` while `CHANNEL` is `aio-tasks`), so nothing
 * would have gone red to tell you the comment had rotted.
 *
 * WHAT THESE ASSERT, AND WHY IT IS STDOUT
 * The observable is the MCP notification on stdout — `notifications/claude/channel`
 * — which is the actual model-facing surface. Asserting the absence of the
 * `FILTERED` stderr line would pass if the message were dropped one step later
 * for some unrelated reason; asserting the notification proves it arrived where
 * it has to arrive.
 *
 * THE SEAM. These drive the plugin from a stub server, so they pin the plugin
 * against the WIRE CONTRACT rather than against a particular server build:
 *   live frame  { type: "message", data: {...}, deliveryReasons: ["thread"] }
 *   replay      { type: "replay", data: { messages: [ {..., deliveryReasons } ] } }
 * The server half of the same contract is pinned in the bridge repo by
 * `packages/api/test/delivery-reasons.test.ts`, which asserts the frame it emits
 * has exactly this shape — including that `deliveryReasons` is an ARRAY beside
 * `data` and never a `{}` (it is a Map server-side, and JSON.stringify renders a
 * Map as an empty object). Both halves must move together; that is what the
 * cross-reference in each file is for.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SERVER = join(import.meta.dir, "..", "server.ts");
const CHANNEL = "aio-tasks"; // deliberately NOT in the filter below
const FILTER = "general,proj-micronomy"; // the operator's real value on 2026-07-30

type Stub = {
  port: number;
  send: (frame: unknown) => void;
  connected: () => boolean;
  stop: () => void;
};

/** Minimal Bridge server: completes the handshake, then relays what we push. */
function startStub(): Stub {
  let socket: any = null;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        let frame: any = {};
        try { frame = JSON.parse(String(raw)); } catch { return; }
        if (frame.type === "auth") {
          socket = ws;
          ws.send(JSON.stringify({
            type: "authenticated",
            data: { agentId: "jorgen-mac", agentName: "Jörgen (Mac)", contextId: "ctx-under-test" },
          }));
        }
      },
      close() { socket = null; },
    },
  });
  return {
    port: server.port!,
    send: (frame) => socket?.send(JSON.stringify(frame)),
    connected: () => socket !== null,
    stop: () => server.stop(true),
  };
}

const message = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  channelId: CHANNEL,
  agentId: "aio",
  agentName: "aio",
  content: `content of ${id}`,
  type: "text",
  createdAt: new Date().toISOString(),
  ...extra,
});

describe("BRIDGE_CHANNELS cannot suppress an addressed message", () => {
  let dir = "";
  let stub: Stub;
  let plugin: ReturnType<typeof Bun.spawn>;
  let out = "";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "dr-"));
    stub = startStub();
    plugin = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        BRIDGE_STATE_DIR: dir,
        BRIDGE_API_URL: `http://127.0.0.1:${stub.port}`,
        BRIDGE_TOKEN: "test-token",
        BRIDGE_CHANNELS: FILTER,
        CLAUDE_CODE_SESSION_ID: "11111111-2222-3333-4444-555555555555",
        CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    out = "";
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of plugin.stdout as any) out += dec.decode(chunk, { stream: true });
    })();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !stub.connected()) await Bun.sleep(50);
    expect(stub.connected(), "plugin never connected to the stub").toBe(true);
    await Bun.sleep(300); // let the authenticated frame be processed
  }, 30_000);

  afterEach(() => {
    plugin?.kill();
    stub?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Did the message reach the model-facing MCP surface? */
  async function surfaced(id: string, waitMs = 2500): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (out.includes(id) && out.includes("notifications/claude/channel")) return true;
      await Bun.sleep(50);
    }
    return false;
  }

  test("a thread reply in a filtered channel SURFACES", async () => {
    stub.send({
      type: "message",
      data: message("msg-thread-1", { parentId: "root-1" }),
      deliveryReasons: ["thread"],
    });
    expect(await surfaced("msg-thread-1")).toBe(true);
  }, 30_000);

  test("a mention in a filtered channel SURFACES", async () => {
    stub.send({
      type: "message",
      data: message("msg-mention-1"),
      deliveryReasons: ["mention"],
    });
    expect(await surfaced("msg-mention-1")).toBe(true);
  }, 30_000);

  test("an assignee reason SURFACES — a reason added later inherits the rule", async () => {
    // `assignee` did not exist when this bypass was designed. It punches through
    // because it is IN THE ADDRESSED TIER, not because anything here names it.
    // If someone re-implements this as `if (reason === "thread" || ...)`, this is
    // the test that goes red.
    stub.send({
      type: "message",
      data: message("msg-assignee-1", { type: "task" }),
      deliveryReasons: ["assignee"],
    });
    expect(await surfaced("msg-assignee-1")).toBe(true);
  }, 30_000);

  test("THE CONTROL: broadcast-only traffic in a filtered channel is still DROPPED", async () => {
    // Without this, "addressed messages arrive" could just as well mean "the
    // filter stopped working", which is a different bug with the same green test.
    stub.send({
      type: "message",
      data: message("msg-broadcast-1"),
      deliveryReasons: ["channel"],
    });
    expect(await surfaced("msg-broadcast-1", 2000)).toBe(false);
  }, 30_000);

  test("no reasons at all — an older server — keeps the old channel-only behaviour", async () => {
    // No version negotiation: a server that predates this sends no field, the
    // bypass is false, and the filter applies exactly as before.
    stub.send({ type: "message", data: message("msg-legacy-1", { parentId: "root-1" }) });
    expect(await surfaced("msg-legacy-1", 2000)).toBe(false);
  }, 30_000);

  test("THE ECHO GUARD: our own message never surfaces just because reasons exist", async () => {
    // The own-message skip used to read `!targetsThisSession` and now reads
    // `!addressedToUs`, which is a WIDER condition — so this is the regression
    // that change could cause: the session surfacing its own outbound message
    // back to itself.
    //
    // It holds because the server excludes the sender from the reason map, so an
    // own message carries [] or, when self-targeted, ["target"] — exactly what
    // the old condition covered. That is an invariant of the OTHER repo, which
    // is the kind of reasoning that is true right up until it isn't, so it gets
    // a test on this side of the seam rather than a comment.
    // IN `general`, which IS in the filter — deliberately. The first version of
    // this test put it in the filtered channel, where the channel filter drops it
    // before the own-message check ever runs: it would have passed against a
    // plugin with no echo guard at all. The message has to CLEAR the filter so
    // that the own-message skip is the only thing left that can stop it.
    stub.send({
      type: "message",
      data: message("msg-own-1", { agentId: "jorgen-mac", channelId: "general", parentId: "root-1" }),
      deliveryReasons: [],
    });
    expect(await surfaced("msg-own-1", 2000)).toBe(false);

    // Proof the channel was not what stopped it: the same channel, a different
    // sender, surfaces.
    stub.send({
      type: "message",
      data: message("msg-own-control", { channelId: "general" }),
      deliveryReasons: ["channel"],
    });
    expect(await surfaced("msg-own-control", 3000), "general must be deliverable").toBe(true);
  }, 30_000);

  test("REPLAY: an addressed message surfaces on catch-up too", async () => {
    // Catch-up is the second place the same message can be lost — a reconnecting
    // client runs the identical filter over replayed rows. In a batch the reason
    // rides ON each message rather than beside it.
    //
    // BOTH messages go in ONE batch on purpose. Replay is held behind a gate and
    // flushed on the first tool call or after a 10s fallback, so a short wait
    // makes the negative VACUOUS — the broadcast message would be "absent"
    // merely because nothing had flushed yet, and this test would pass against a
    // plugin that surfaced neither. Pairing them means the thread message
    // arriving is proof the flush happened, and only then does the broadcast
    // message still being absent mean the filter ran. Found by writing the
    // negative first and watching it pass for the wrong reason.
    stub.send({
      type: "replay",
      data: {
        messages: [
          message("msg-replay-thread", { parentId: "root-9", deliveryReasons: ["thread"] }),
          message("msg-replay-broadcast", { deliveryReasons: ["channel"] }),
        ],
      },
    });
    expect(await surfaced("msg-replay-thread", 15_000), "flush did not happen").toBe(true);
    expect(await surfaced("msg-replay-broadcast", 1000), "same flushed batch").toBe(false);
  }, 40_000);
});
