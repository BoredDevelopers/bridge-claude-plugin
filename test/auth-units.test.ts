/** Small pure-ish pieces of auth/ (RFC-014 §7.2): device polling, headless detection, the profile lock. */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollDevice } from "../auth/device";
import { isHeadless } from "../auth/browser";
import { withProfileLock } from "../auth/lock";
import type { AuthMetadata } from "../auth/oauth";

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
      writeFileSync(join(dir, ".lock", "owner.json"), JSON.stringify({ pid: process.ppid }));
      const race = await Promise.race([withProfileLock(dir, async () => "stole"), Bun.sleep(600).then(() => "waited")]);
      expect(race).toBe("waited");
      // …until it is older than the stale threshold.
      const old = new Date(Date.now() - 60_000);
      utimesSync(join(dir, ".lock"), old, old);
      expect(await withProfileLock(dir, async () => "after stale")).toBe("after stale");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
