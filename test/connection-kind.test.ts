/**
 * RFC-028 D1/D2, through the real MCP server (server.ts over stdio) against the strict
 * agent-auth stub: what the auth frame DECLARES (kind, takeover), how `connect` maps its
 * arguments onto it, that the kind is remembered per session key, and what the person is
 * told for the three new close classes (gateway-in-use, gateway-taken-over, kind-not-allowed).
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startAuthStub } from "./agent-auth-stub";
import { enrolledProfile } from "./key-fixtures";

const SERVER = new URL("../server.ts", import.meta.url).pathname;
const SESSION = "11111111-2222-3333-4444-555555555555";

type Stub = ReturnType<typeof startAuthStub>;

/** One plugin process in `dir` (kept when `keepDir`, so a second process can restart in it). */
async function withPlugin<T>(
  stub: Stub,
  dir: string,
  env: Record<string, string>,
  fn: (client: Client, notices: () => string[]) => Promise<T>
): Promise<T> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [SERVER],
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dir,
      EINWEAVE_STATE_DIR: dir,
      EINWEAVE_API_URL: stub.url,
      EINWEAVE_AUTOCONNECT: "1",
      EINWEAVE_BROWSER: "none",
      CLAUDE_CODE_SESSION_ID: SESSION,
      CLAUDE_CODE_SSE_PORT: "",
      ...env,
    } as Record<string, string>,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  const seen: string[] = [];
  client.fallbackNotificationHandler = async (n: any) => {
    if (typeof n?.params?.content === "string") seen.push(n.params.content);
  };
  try {
    await client.connect(transport);
    return await fn(client, () => seen);
  } finally {
    await client.close().catch(() => {});
  }
}

async function setup(env: Record<string, string> = {}, fn: (c: Client, notices: () => string[], stub: Stub, dir: string) => Promise<void>, stubOpts: Parameters<typeof startAuthStub>[0] = {}) {
  const stub = startAuthStub(stubOpts);
  const dir = mkdtempSync(join(tmpdir(), "kind-"));
  try {
    await enrolledProfile(stub, dir);
    await withPlugin(stub, dir, env, (c, n) => fn(c, n, stub, dir));
  } finally {
    stub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function status(client: Client): Promise<any> {
  const r: any = await client.callTool({ name: "status", arguments: {} });
  return JSON.parse(r.content[0].text);
}
async function connect(client: Client, args: Record<string, unknown>): Promise<string> {
  const r: any = await client.callTool({ name: "connect", arguments: args });
  return r.content?.[0]?.text ?? "";
}
async function until(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await Bun.sleep(25);
  }
  return pred();
}
const kindFile = (dir: string) => {
  const f = readdirSync(dir).find((n) => n.startsWith(".connect-kind-") && !n.endsWith(".tmp"));
  return f ? readFileSync(join(dir, f), "utf8").trim() : null;
};

describe("the auth frame declares a kind", () => {
  test("a window is a work session by default: kind session, no takeover", async () => {
    await setup({}, async (client, _n, stub) => {
      expect(await until(() => stub.stats.authDeclared.length >= 1, 15_000)).toBe(true);
      expect(stub.stats.authDeclared[0]).toEqual({ kind: "session" });
      expect(await until(async () => (await status(client)).websocket === "connected", 5_000)).toBe(true);
      expect((await status(client)).kind).toBe("session");
    });
  }, 40_000);

  test("EINWEAVE_CONNECTION_KIND=gateway declares the gateway at autoconnect, and a restart without it keeps it", async () => {
    const stub = startAuthStub();
    const dir = mkdtempSync(join(tmpdir(), "kind-"));
    try {
      await enrolledProfile(stub, dir);
      await withPlugin(stub, dir, { EINWEAVE_CONNECTION_KIND: "gateway" }, async (client) => {
        expect(await until(() => stub.stats.authDeclared.length >= 1, 15_000)).toBe(true);
        expect(stub.stats.authDeclared[0]).toEqual({ kind: "gateway" });
        await connect(client, {}); // an explicit connect persists what the window is
        expect(kindFile(dir)).toBe("gateway");
      });
      const before = stub.stats.authDeclared.length;
      await withPlugin(stub, dir, {}, async (client) => {
        expect(await until(() => stub.stats.authDeclared.length > before, 15_000)).toBe(true);
        expect(stub.stats.authDeclared[before]).toEqual({ kind: "gateway" });
        expect((await status(client)).kind).toBe("gateway");
      });
    } finally {
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("connect: kind and takeover map onto the frame", () => {
  test("connect {kind:'gateway'} reconnects as a gateway -- no takeover in the frame -- and persists it", async () => {
    await setup({}, async (client, _n, stub, dir) => {
      expect(await until(async () => (await status(client)).websocket === "connected", 15_000)).toBe(true);
      expect(await connect(client, { kind: "gateway" })).toContain("gateway");
      expect(await until(() => stub.stats.authDeclared.length >= 2, 10_000)).toBe(true);
      expect(stub.stats.authDeclared[1]).toEqual({ kind: "gateway" });
      expect(kindFile(dir)).toBe("gateway");
      // The same kind again is a no-op on the socket.
      expect(await until(async () => (await status(client)).websocket === "connected", 10_000)).toBe(true);
      await connect(client, { kind: "gateway" });
      await Bun.sleep(500);
      expect(stub.stats.authDeclared.length).toBe(2);
      // And back: a person demotes it explicitly.
      await connect(client, { kind: "session" });
      expect(await until(() => stub.stats.authDeclared.length >= 3, 10_000)).toBe(true);
      expect(stub.stats.authDeclared[2]).toEqual({ kind: "session" });
      expect(kindFile(dir)).toBe("session");
    });
  }, 60_000);

  test("connect {takeover:'gateway'} says takeover on the frame (kind gateway implied); takeover:'lock' never does", async () => {
    await setup({}, async (client, _n, stub) => {
      expect(await until(async () => (await status(client)).websocket === "connected", 15_000)).toBe(true);
      await connect(client, { takeover: "lock" });
      await Bun.sleep(400);
      expect(stub.stats.authDeclared.length).toBe(1); // lock takeover on a healthy socket reopens nothing
      await connect(client, { takeover: "gateway" });
      expect(await until(() => stub.stats.authDeclared.length >= 2, 10_000)).toBe(true);
      expect(stub.stats.authDeclared[1]).toEqual({ kind: "gateway", takeover: "gateway" });
    });
  }, 60_000);

  test("takeover:'gateway' with kind:'session' is refused up front -- nothing is sent", async () => {
    await setup({}, async (client, _n, stub) => {
      expect(await until(async () => (await status(client)).websocket === "connected", 15_000)).toBe(true);
      const text = await connect(client, { kind: "session", takeover: "gateway" });
      expect(text).toContain("needs kind");
      await Bun.sleep(400);
      expect(stub.stats.authDeclared.length).toBe(1);
      expect((await status(client)).kind).toBe("session");
    });
  }, 40_000);

  test("an unknown kind or takeover is an error; the pre-0.31 takeover:true still means the lock", async () => {
    await setup({}, async (client, _n, stub) => {
      expect(await until(async () => (await status(client)).websocket === "connected", 15_000)).toBe(true);
      const bad: any = await client.callTool({ name: "connect", arguments: { kind: "observer" } });
      expect(bad.isError).toBe(true);
      const bad2: any = await client.callTool({ name: "connect", arguments: { takeover: "yes" } });
      expect(bad2.isError).toBe(true);
      const ok: any = await client.callTool({ name: "connect", arguments: { takeover: true } });
      expect(ok.isError).toBeFalsy();
      await Bun.sleep(300);
      expect(stub.stats.authDeclared.length).toBe(1);
    });
  }, 40_000);
});

describe("the three new close classes say the right remedy, never 'login'", () => {
  test("gateway-in-use: retried, told ONCE with the holder's label, remedy = connect (takeover or session)", async () => {
    const reason = "gateway in use: Bellman #ab12";
    await setup({}, async (client, notices, stub) => {
      expect(await until(async () => (await status(client)).websocket === "connected", 15_000)).toBe(true);
      stub.rejectNextWsAuths(2, 4008, reason);
      await connect(client, { kind: "gateway" }); // refused, retried, refused, retried, in
      expect(await until(() => stub.stats.authDeclared.length >= 4, 40_000)).toBe(true);
      const told = () => notices().filter((c) => c.includes("Bellman #ab12"));
      expect(told()).toHaveLength(1);
      expect(told()[0]).toContain("/einweave:connect gateway takeover");
      expect(told()[0]).toContain("retrying");
      expect(told()[0]).not.toContain("/einweave:login");
      expect(await until(async () => (await status(client)).websocket === "connected", 40_000)).toBe(true); // in, once the holder went
      expect(told()).toHaveLength(1);
    });
  }, 120_000);

  test("gateway-taken-over: terminal, names the taker, remedy = connect, and the window stops being the gateway", async () => {
    await setup({ EINWEAVE_CONNECTION_KIND: "gateway" }, async (client, notices, stub, dir) => {
      expect(await until(async () => (await status(client)).websocket === "connected", 15_000)).toBe(true);
      await connect(client, {}); // persist the kind
      stub.rejectNextWsAuths(1, 4008, "gateway taken over: Mac #cd34");
      stub.closeAll(1011, "restart");
      expect(await until(async () => (await status(client)).websocket.includes("taken over"), 15_000)).toBe(true);
      const s = await status(client);
      expect(s.websocket).toContain("Mac #cd34");
      expect(s.websocket).toContain("/einweave:connect");
      expect(s.websocket).not.toContain("/einweave:login");
      expect(s.websocket).not.toContain("reconnect attempt");
      expect(notices().filter((c) => c.includes("Mac #cd34"))).toHaveLength(1);
      expect(kindFile(dir)).toBe("session"); // a plain connect now asks for no lease
      const before = stub.stats.authDeclared.length;
      await connect(client, {});
      expect(await until(() => stub.stats.authDeclared.length > before, 10_000)).toBe(true);
      expect(stub.stats.authDeclared[before]).toEqual({ kind: "session" });
    });
  }, 60_000);

  test("kind-not-allowed: terminal, names the kind, remedy = a manager or another kind -- not login", async () => {
    await setup({ EINWEAVE_CONNECTION_KIND: "gateway" }, async (client, notices, stub) => {
      stub.rejectNextWsAuths(1, 4008, "kind not allowed: gateway");
      stub.closeAll(1011, "restart");
      expect(await until(async () => (await status(client)).websocket.includes("do not allow"), 15_000)).toBe(true);
      const s = await status(client);
      expect(s.websocket).toContain("gateway");
      expect(s.websocket).toContain("manager");
      expect(s.websocket).not.toContain("/einweave:login");
      expect(s.websocket).not.toContain("reconnect attempt");
      expect(notices().filter((c) => c.includes("do not allow"))).toHaveLength(1);
    });
  }, 60_000);
});
