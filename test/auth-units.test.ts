/** Small pure-ish pieces of auth/ (RFC-014 §7.2): device polling, headless detection, the profile lock. */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollDevice } from "../auth/device";
import { isHeadless } from "../auth/browser";
import { withProfileLock } from "../auth/lock";
import { assertSameAuthority, type AuthMetadata } from "../auth/oauth";
import { writeSession, sessionFileFor, sweepSessions } from "../auth/store";

function tokenServer(answers: string[]) {
  let i = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const a = answers[Math.min(i++, answers.length - 1)]!;
      return a === "ok"
        ? Response.json({ installation_token: "brg_it_x", installation_id: "i1" })
        : Response.json({ error: a }, { status: 400 });
    },
  });
  const meta = { token_endpoint: `http://127.0.0.1:${server.port}/token` } as AuthMetadata;
  return { meta, polls: () => i, stop: () => server.stop(true) };
}

const auth = { device_code: "dc", user_code: "U", verification_uri: "v", expires_in: 600, interval: 5 };

describe("device polling (RFC 8628 §3.5)", () => {
  test("pending waits, slow_down adds 5 s for good, then success", async () => {
    const s = tokenServer(["authorization_pending", "slow_down", "authorization_pending", "ok"]);
    const waits: number[] = [];
    try {
      const r = await pollDevice(s.meta, auth, { sleep: async (ms) => void waits.push(ms) });
      expect(r).toEqual({ ok: true, grant: { installation_token: "brg_it_x", installation_id: "i1" } });
      expect(waits).toEqual([5000, 5000, 10000, 10000]);
    } finally {
      s.stop();
    }
  });

  test("access_denied ends the flow; the deadline ends it too", async () => {
    const denied = tokenServer(["access_denied"]);
    try {
      expect(await pollDevice(denied.meta, auth, { sleep: async () => {} })).toEqual({ ok: false, error: "access_denied" });
    } finally {
      denied.stop();
    }
    const pending = tokenServer(["authorization_pending"]);
    let t = 0;
    try {
      const r = await pollDevice(pending.meta, { ...auth, expires_in: 20 }, {
        sleep: async (ms) => void (t += ms),
        now: () => t,
      });
      expect(r).toEqual({ ok: false, error: "expired_token" });
    } finally {
      pending.stop();
    }
  });
});

describe("headless detection", () => {
  test("SSH and CI are headless everywhere; Linux needs a display; macOS is not", () => {
    expect(isHeadless({ SSH_CONNECTION: "a" }, "darwin")).toBe(true);
    expect(isHeadless({ CI: "true" }, "darwin")).toBe(true);
    expect(isHeadless({}, "darwin")).toBe(false);
    expect(isHeadless({}, "linux")).toBe(true);
    expect(isHeadless({ DISPLAY: ":0" }, "linux")).toBe(false);
    expect(isHeadless({ WAYLAND_DISPLAY: "w" }, "linux")).toBe(false);
    expect(isHeadless({ WSL_DISTRO_NAME: "Ubuntu" }, "linux")).toBe(false);
  });
});

describe("profile lock", () => {
  test("8 processes racing to break the same dead lock: never two inside", async () => {
    const holder = new URL("./fixtures/lock-holder.ts", import.meta.url).pathname;
    for (let t = 0; t < 6; t++) {
      const dir = mkdtempSync(join(tmpdir(), "lock-mp-"));
      try {
        mkdirSync(join(dir, ".lock"));
        writeFileSync(join(dir, ".lock", "owner.json"), JSON.stringify({ pid: 2 ** 22 + 4242, nonce: "dead" }));
        const startAt = Date.now() + 600;
        const ps = Array.from({ length: 8 }, () => Bun.spawn(["bun", holder, dir, String(startAt)], { stderr: "pipe" }));
        const codes = await Promise.all(ps.map((p) => p.exited));
        expect(codes.every((c) => c === 0)).toBe(true);
        let inside = 0;
        let max = 0;
        const lines = readFileSync(join(dir, "log"), "utf8").trim().split("\n");
        for (const l of lines) {
          inside += l.startsWith("in") ? 1 : -1;
          max = Math.max(max, inside);
        }
        expect(lines).toHaveLength(16);
        expect(max).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 60_000);

  test("the holder's heartbeat keeps a long-held lock fresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-hb-"));
    try {
      let age = Infinity;
      await withProfileLock(dir, async () => {
        const old = new Date(Date.now() - 5 * 60_000);
        utimesSync(join(dir, ".lock"), old, old);
        await Bun.sleep(5_600);
        age = Date.now() - statSync(join(dir, ".lock")).mtimeMs;
      });
      expect(age).toBeLessThan(2_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("a holder whose lock was taken over never deletes the new owner's lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-own-"));
    try {
      await withProfileLock(dir, async () => {
        // Simulate: our lock was broken and someone else now holds it.
        rmSync(join(dir, ".lock"), { recursive: true, force: true });
        mkdirSync(join(dir, ".lock"));
        writeFileSync(join(dir, ".lock", "owner.json"), JSON.stringify({ pid: process.pid, nonce: "someone-else" }));
      });
      expect(existsSync(join(dir, ".lock", "owner.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serializes critical sections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-"));
    try {
      let inside = 0;
      let maxInside = 0;
      await Promise.all(
        Array.from({ length: 5 }, () =>
          withProfileLock(dir, async () => {
            inside++;
            maxInside = Math.max(maxInside, inside);
            await Bun.sleep(30);
            inside--;
          })
        )
      );
      expect(maxInside).toBe(1);
      expect(existsSync(join(dir, ".lock"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a lock held by a dead pid is broken; a live holder's is not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-stale-"));
    try {
      mkdirSync(join(dir, ".lock"));
      writeFileSync(join(dir, ".lock", "owner.json"), JSON.stringify({ pid: 2 ** 22 + 12345 }));
      expect(await withProfileLock(dir, async () => "got it")).toBe("got it");

      mkdirSync(join(dir, ".lock"));
      writeFileSync(join(dir, ".lock", "owner.json"), JSON.stringify({ pid: process.ppid, nonce: "live" }));
      const waiter = withProfileLock(dir, async () => "after abandoned");
      const race = await Promise.race([waiter, Bun.sleep(600).then(() => "waited")]);
      expect(race).toBe("waited");
      // A live holder's lock is NOT broken on a 60 s age (heartbeat, slow HTTP, sleep)…
      const minute = new Date(Date.now() - 60_000);
      utimesSync(join(dir, ".lock"), minute, minute);
      expect(await Promise.race([waiter, Bun.sleep(400).then(() => "still waiting")])).toBe("still waiting");
      // …only once it is abandoned (untouched for over 10 min).
      const old = new Date(Date.now() - 11 * 60_000);
      utimesSync(join(dir, ".lock"), old, old);
      expect(await waiter).toBe("after abandoned");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("session file sweep", () => {
  test("drops session files idle past the limit, keeps fresh ones and the current one", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-"));
    try {
      const s = { sessionId: "s", refreshToken: "r", installationId: "i" };
      for (const k of ["old", "fresh", "current"]) writeSession(dir, k, s);
      const old = new Date(Date.now() - 9 * 86_400_000);
      utimesSync(sessionFileFor(dir, "old"), old, old);
      utimesSync(sessionFileFor(dir, "current"), old, old);
      sweepSessions(dir, sessionFileFor(dir, "current"), 8 * 86_400_000);
      expect(existsSync(sessionFileFor(dir, "old"))).toBe(false);
      expect(existsSync(sessionFileFor(dir, "fresh"))).toBe(true);
      expect(existsSync(sessionFileFor(dir, "current"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("discovery authority (RFC 8414 §3.3)", () => {
  const api = "https://bridge-api.example.test";
  const meta = (over: Partial<AuthMetadata> = {}): AuthMetadata => ({
    issuer: `${api}/api/agent-auth`,
    authorization_endpoint: `${api}/api/agent-auth/authorize`,
    device_authorization_endpoint: `${api}/api/agent-auth/device_authorization`,
    token_endpoint: `${api}/api/agent-auth/token`,
    revocation_endpoint: `${api}/api/agent-auth/revoke`,
    bridge_connect_done_uri: "https://bridge-web.example.test/connect/done",
    ...over,
  });

  test("the API's own document is accepted (a trailing slash on the URL too; the web done-URI may differ)", () => {
    expect(() => assertSameAuthority(api, meta())).not.toThrow();
    expect(() => assertSameAuthority(`${api}/`, meta())).not.toThrow();
  });

  test("a different issuer is refused", () => {
    expect(() => assertSameAuthority(api, meta({ issuer: "https://evil.example.test/api/agent-auth" }))).toThrow(/issuer/);
  });

  test("a credential endpoint on another origin is refused, even with the right issuer", () => {
    expect(() => assertSameAuthority(api, meta({ token_endpoint: "https://evil.example.test/token" }))).toThrow(/token_endpoint/);
    expect(() => assertSameAuthority(api, meta({ revocation_endpoint: "http://bridge-api.example.test/revoke" }))).toThrow(/revocation_endpoint/);
  });
});
