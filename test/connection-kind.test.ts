/**
 * RFC-028 D1/D2, through the real MCP server (server.ts over stdio) against the strict
 * agent-auth stub: what the auth frame DECLARES (kind, takeover), how `connect` maps its
 * arguments onto it, that the kind is remembered per session key, and what the person is
 * told for the three new close classes (gateway-in-use, gateway-taken-over, kind-not-allowed).
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { connectStateFileFor, connectKindFileFor, connectScopeFileFor, writeConnectState, writeConnectKind, writeScopeSet } from "../connect-store";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAuthStub } from "./agent-auth-stub";
import { enrolledProfile } from "./key-fixtures";
import { setup, withPlugin, status, connect, until } from "./plugin-harness";

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

  test("EINWEAVE_CONNECTION_KIND=gateway declares the gateway at autoconnect; a kind the person NAMED is remembered across a restart", async () => {
    const stub = startAuthStub();
    const dir = mkdtempSync(join(tmpdir(), "kind-"));
    try {
      await enrolledProfile(stub, dir);
      await withPlugin(stub, dir, { EINWEAVE_CONNECTION_KIND: "gateway" }, async (client) => {
        expect(await until(() => stub.stats.authDeclared.length >= 1, 15_000)).toBe(true);
        expect(stub.stats.authDeclared[0]).toEqual({ kind: "gateway" });
        expect(kindFile(dir)).toBeNull(); // the environment declared it, not the person: nothing is recorded
        await connect(client, { kind: "gateway" }); // naming it is a declaration
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

  test("a PLAIN connect declares nothing: a restart with EINWEAVE_CONNECTION_KIND=gateway still starts as the gateway", async () => {
    const stub = startAuthStub();
    const dir = mkdtempSync(join(tmpdir(), "kind-plain-"));
    try {
      await enrolledProfile(stub, dir);
      await withPlugin(stub, dir, {}, async (client) => {
        expect(await until(async () => (await status(client)).websocket === "connected", 15_000)).toBe(true);
        await connect(client, {});
        await connect(client, {});
        expect(kindFile(dir)).toBeNull();
      });
      const before = stub.stats.authDeclared.length;
      await withPlugin(stub, dir, { EINWEAVE_CONNECTION_KIND: "gateway" }, async () => {
        expect(await until(() => stub.stats.authDeclared.length > before, 15_000)).toBe(true);
        expect(stub.stats.authDeclared[before]).toEqual({ kind: "gateway" });
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

describe("kind precedence and persistence", () => {
  test("M2: a gateway takeover demotes the window to session, and a restart with EINWEAVE_CONNECTION_KIND=gateway STAYS session -- the record wins over the env", async () => {
    const stub = startAuthStub();
    const dir = mkdtempSync(join(tmpdir(), "kind-m2-"));
    try {
      await enrolledProfile(stub, dir);
      await withPlugin(stub, dir, { EINWEAVE_CONNECTION_KIND: "gateway" }, async (client) => {
        expect(await until(async () => (await status(client)).websocket === "connected", 15_000)).toBe(true);
        await connect(client, {}); // persists gateway
        stub.rejectNextWsAuths(1, 4008, "gateway taken over: Mac #cd34");
        stub.closeAll(1011, "restart");
        expect(await until(async () => (await status(client)).websocket.includes("taken over"), 15_000)).toBe(true);
        expect(kindFile(dir)).toBe("session");
      });
      const before = stub.stats.authDeclared.length;
      await withPlugin(stub, dir, { EINWEAVE_CONNECTION_KIND: "gateway" }, async () => {
        expect(await until(() => stub.stats.authDeclared.length > before, 20_000)).toBe(true);
        expect(stub.stats.authDeclared[before]).toEqual({ kind: "session" });
      });
    } finally {
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  test("M2: with no record the environment applies (and with neither, session)", async () => {
    await setup({ EINWEAVE_CONNECTION_KIND: "gateway" }, async (_c, _n, stub) => {
      expect(await until(() => stub.stats.authDeclared.length >= 1, 15_000)).toBe(true);
      expect(stub.stats.authDeclared[0]).toEqual({ kind: "gateway" });
    });
  }, 40_000);

  test("M3: naming the kind a window already has (before startup settles) still counts as a person's choice -- the environment does not override it", async () => {
    const stub = startAuthStub();
    const dir = mkdtempSync(join(tmpdir(), "kind-m3-"));
    try {
      await enrolledProfile(stub, dir);
      await withPlugin(stub, dir, { EINWEAVE_CONNECTION_KIND: "gateway" }, async (client) => {
        // The very first tool call: the session key has not settled, startup has not read the environment yet.
        await connect(client, { kind: "session" });
        expect(await until(() => stub.stats.authDeclared.length >= 1, 20_000)).toBe(true);
        await Bun.sleep(500);
        expect(stub.stats.authDeclared.every((d) => d.kind === "session")).toBe(true);
        expect(kindFile(dir)).toBe("session");
      });
    } finally {
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a connect refused with 'another window took over' neither changes nor remembers the kind it asked for", async () => {
    await setup({}, async (client, _n, stub, dir) => {
      expect(await until(async () => (await status(client)).websocket === "connected", 15_000)).toBe(true);
      stub.rejectNextWsAuths(1, 4008, "session superseded: another window");
      stub.closeAll(1011, "restart");
      expect(await until(async () => (await status(client)).websocket.includes("took over"), 15_000)).toBe(true);
      const kindBefore = kindFile(dir);
      const text = await connect(client, { kind: "gateway" }); // plain connect: refused while superseded
      expect(text).toContain("took over");
      expect(kindFile(dir)).toBe(kindBefore);
      expect((await status(client)).kind).toBe("session");
    });
  }, 60_000);
});

describe("a window keeps its own records young", () => {
  test("starting up touches the connect-state, kind and scope files of its key (so another window's 24 h sweep leaves them)", async () => {
    const key = "11111111-2222-3333-4444-555555555555"; // the harness's CLAUDE_CODE_SESSION_ID
    const stub = startAuthStub();
    const dir = mkdtempSync(join(tmpdir(), "kind-touch-"));
    try {
      await enrolledProfile(stub, dir);
      writeConnectState(dir, key, false); // not connected: nothing else would write these files
      writeConnectKind(dir, key, "session");
      writeScopeSet(dir, key);
      const files = [connectStateFileFor(dir, key), connectKindFileFor(dir, key), connectScopeFileFor(dir, key)];
      const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      for (const f of files) utimesSync(f, old, old);
      await withPlugin(stub, dir, {}, async (client) => {
        // Startup settles the session key first (up to a few seconds); the touch follows it.
        const fresh = () => files.every((f) => Date.now() - statSync(f).mtimeMs < 60_000);
        expect(await until(fresh, 15_000), "startup never touched the window's records").toBe(true);
      });
    } finally {
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
