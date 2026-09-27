/**
 * The installation lock (auth/node/lock.ts, RFC-016 §5.2): mkdir + a 120 s TIME-based
 * stale break — never pid liveness, never a heartbeat — and its coexistence with a stale
 * 0.24 process's `.lock` in the same profile.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withInstallationLock, sweepLockTombstones, STALE_MS, LOCK_WAIT_MS, HOLD_BUDGET_MS, LOCK_DIR_NAME, __lockIo } from "../auth/node/lock";
import { spawnRacers } from "./fixtures/go-signal";
import { withProfileLock as withProfileLock024 } from "./fixtures/v024/lock";

const DEAD_PID = 2 ** 22 + 12345;
const lockOf = (dir: string) => join(dir, LOCK_DIR_NAME);
const age = (path: string, ms: number) => {
  const t = new Date(Date.now() - ms);
  utimesSync(path, t, t);
};
const plant = (lockDir: string, owner: object) => {
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify(owner));
};

describe("installation lock (RFC-016 §5.2: mkdir + 120 s time-based stale break)", () => {
  test("8 processes racing to break the same stale lock: never two inside", async () => {
    const holder = fileURLToPath(new URL("./fixtures/installation-lock-holder.ts", import.meta.url));
    for (let t = 0; t < 6; t++) {
      const dir = mkdtempSync(join(tmpdir(), "lock-mp-"));
      try {
        plant(lockOf(dir), { pid: process.pid, nonce: "stale" });
        age(lockOf(dir), STALE_MS + 5_000);
        const ps = await spawnRacers(8, ["bun", holder, dir]);
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

  test("stale is by AGE only: a dead pid's young lock is waited for; a live pid's 121 s-old lock is broken", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-age-"));
    const stop = new AbortController(); // an early failure must not leave the waiter polling for 150 s
    try {
      // Dead holder, fresh lock: NOT broken (pid liveness is deliberately not consulted).
      plant(lockOf(dir), { pid: DEAD_PID, nonce: "dead" });
      const waiter = withInstallationLock(dir, async () => "got it", { signal: stop.signal });
      expect(await Promise.race([waiter, Bun.sleep(600).then(() => "waited")])).toBe("waited");
      // Just under the threshold: still waiting.
      age(lockOf(dir), STALE_MS - 5_000);
      expect(await Promise.race([waiter, Bun.sleep(400).then(() => "still waiting")])).toBe("still waiting");
      // Over 120 s: broken, even though its holder (this very process) is alive.
      writeFileSync(join(lockOf(dir), "owner.json"), JSON.stringify({ pid: process.pid, nonce: "live" }));
      age(lockOf(dir), STALE_MS + 1_000);
      expect(await waiter).toBe("got it");
    } finally {
      stop.abort();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("breaking is serialized: while another breaker holds `.break`, a stale lock is left to it (deterministic L3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-brk-"));
    const stop = new AbortController();
    try {
      plant(lockOf(dir), { pid: process.pid, nonce: "stale" });
      age(lockOf(dir), STALE_MS + 5_000);
      mkdirSync(`${lockOf(dir)}.break`); // a breaker mid-break (young: < 10 s)
      const waiter = withInstallationLock(dir, async () => "got it", { signal: stop.signal });
      expect(await Promise.race([waiter, Bun.sleep(700).then(() => "waited")])).toBe("waited");
      expect(JSON.parse(readFileSync(join(lockOf(dir), "owner.json"), "utf8")).nonce).toBe("stale");
      rmSync(`${lockOf(dir)}.break`, { recursive: true, force: true }); // the breaker finished without breaking
      expect(await waiter).toBe("got it");
    } finally {
      stop.abort();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a holder is never refreshed (no heartbeat): its lock ages from acquisition", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-nohb-"));
    try {
      let mtimeDrift = -1;
      await withInstallationLock(dir, async () => {
        age(lockOf(dir), 60_000);
        await Bun.sleep(5_600);
        mtimeDrift = Date.now() - statSync(lockOf(dir)).mtimeMs;
      });
      expect(mtimeDrift).toBeGreaterThan(60_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("a holder whose lock was taken over never deletes the new owner's lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-own-"));
    try {
      await withInstallationLock(dir, async () => {
        rmSync(lockOf(dir), { recursive: true, force: true });
        plant(lockOf(dir), { pid: process.pid, nonce: "someone-else" });
      });
      expect(existsSync(join(lockOf(dir), "owner.json"))).toBe(true);
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
          withInstallationLock(dir, async () => {
            inside++;
            maxInside = Math.max(maxInside, inside);
            await Bun.sleep(30);
            inside--;
          })
        )
      );
      expect(maxInside).toBe(1);
      expect(existsSync(lockOf(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the holder is handed ONE deadline for all its work, and it aborts when spent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-hold-"));
    try {
      const reason = await withInstallationLock(
        dir,
        ({ signal }) => new Promise<string>((resolve) => signal.addEventListener("abort", () => resolve((signal.reason as Error).name))),
        { holdMs: 200 }
      );
      expect(reason).toBe("TimeoutError");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a holder budget at or past the stale break is refused (it would be broken while live)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-hold-"));
    try {
      await expect(withInstallationLock(dir, async () => 1, { holdMs: STALE_MS })).rejects.toBeInstanceOf(RangeError);
      expect(existsSync(lockOf(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("release never deletes a NEWER owner's lock that replaced ours between the check and the removal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-rel-"));
    const saved = __lockIo.renameSync;
    try {
      let raced = false;
      __lockIo.renameSync = ((from: any, to: any) => {
        if (!raced && String(from) === lockOf(dir)) {
          raced = true; // our lock was broken as stale and re-taken, right after our nonce check
          rmSync(lockOf(dir), { recursive: true, force: true });
          plant(lockOf(dir), { pid: process.pid, nonce: "newer" });
        }
        return saved(from, to);
      }) as any;
      expect(await withInstallationLock(dir, async () => "done")).toBe("done");
      expect(raced).toBe(true);
      expect(JSON.parse(readFileSync(join(lockOf(dir), "owner.json"), "utf8")).nonce).toBe("newer");
    } finally {
      __lockIo.renameSync = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("release tombstones a failed release left behind are swept at open once older than the stale break — never a young one, never anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-tomb-"));
    try {
      const old = join(dir, `${LOCK_DIR_NAME}.released-${crypto.randomUUID()}`);
      const young = join(dir, `${LOCK_DIR_NAME}.released-${crypto.randomUUID()}`);
      plant(old, { pid: 1, nonce: "old" });
      plant(young, { pid: 1, nonce: "young" });
      age(old, STALE_MS + 5_000);
      plant(lockOf(dir), { pid: 1, nonce: "live" });
      age(lockOf(dir), STALE_MS + 5_000); // a stale LOCK is the lock's business, not this sweep's
      mkdirSync(join(dir, ".lock")); // 0.24's
      age(join(dir, ".lock"), STALE_MS + 5_000);
      expect(sweepLockTombstones(dir)).toBe(1);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(young)).toBe(true);
      expect(existsSync(lockOf(dir))).toBe(true);
      expect(existsSync(join(dir, ".lock"))).toBe(true);
      expect(sweepLockTombstones(join(dir, "missing"))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a release that keeps failing never replaces fn's result — it is logged, and a transient one is retried", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-relfail-"));
    const saved = __lockIo.rmSync;
    try {
      const logs: string[] = [];
      __lockIo.rmSync = (() => {
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      }) as any;
      expect(await withInstallationLock(dir, async () => "result", { log: (m) => logs.push(m) })).toBe("result");
      expect(logs.join()).toContain("could not release");
      // Transient once, then fine: released cleanly, nothing logged.
      __lockIo.rmSync = saved;
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);
      let once = true;
      __lockIo.rmSync = ((p: any, o: any) => {
        if (once) {
          once = false;
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        }
        return saved(p, o);
      }) as any;
      const logs2: string[] = [];
      expect(await withInstallationLock(dir, async () => "again", { log: (m) => logs2.push(m) })).toBe("again");
      expect(logs2).toEqual([]);
      expect(existsSync(lockOf(dir))).toBe(false);
    } finally {
      __lockIo.rmSync = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("owner.json cannot be written (ENOSPC): the ownerless lock is taken down and the error surfaces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-own-w-"));
    const saved = __lockIo.writeFileSync;
    try {
      __lockIo.writeFileSync = (() => {
        throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      }) as any;
      await expect(withInstallationLock(dir, async () => 1, { waitMs: 500 })).rejects.toMatchObject({ code: "ENOSPC" });
      expect(existsSync(lockOf(dir))).toBe(false);
    } finally {
      __lockIo.writeFileSync = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("breaking a stale lock fails with a REAL error (EACCES): surfaced at once, not waited out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-brk-err-"));
    const saved = __lockIo.rmSync;
    try {
      plant(lockOf(dir), { pid: process.pid, nonce: "stale" });
      age(lockOf(dir), STALE_MS + 5_000);
      __lockIo.rmSync = ((p: any, o: any) => {
        if (String(p) === lockOf(dir)) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return saved(p, o);
      }) as any;
      await expect(withInstallationLock(dir, async () => 1, { waitMs: 800 })).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      __lockIo.rmSync = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale at exactly 120 s (RFC-016 §5.2 — not a tunable); a holder's budget ends before it; a waiter outwaits one stale holder", () => {
    expect(STALE_MS).toBe(120_000);
    expect(HOLD_BUDGET_MS).toBeLessThan(STALE_MS);
    expect(LOCK_WAIT_MS).toBeGreaterThan(STALE_MS);
  });
});

/**
 * test/fixtures/v024/lock.ts is a VERBATIM copy of 0.24's auth/lock.ts
 * (`git show c32ead6:auth/lock.ts`), pinned by hash.
 */
describe("a stale 0.24 process in the same profile (cross-version lock safety)", () => {
  test("the 0.24 fixture is 0.24's auth/lock.ts, byte for byte", () => {
    const src = readFileSync(new URL("./fixtures/v024/lock.ts", import.meta.url), "utf8");
    expect(createHash("sha256").update(src).digest("hex")).toBe("7da5f802d2509d7063e4931d430b9f6f8a4c8d927326feca04e66f037b7e62b4");
  });

  test("0.24's stale break (dead pid) never removes a young 0.25 lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-x-"));
    try {
      // A 0.25 holder whose pid is gone but whose lock is young: 0.25 waits it out (age
      // only); 0.24's dead-pid rule must not get to judge it at all.
      plant(lockOf(dir), { pid: DEAD_PID, nonce: "v025" });
      const r = await Promise.race([withProfileLock024(dir, async () => "0.24 ran"), Bun.sleep(1_500).then(() => "0.24 blocked")]);
      expect(r).toBe("0.24 ran");
      expect(JSON.parse(readFileSync(join(lockOf(dir), "owner.json"), "utf8")).nonce).toBe("v025");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a held 0.24 lock and a held 0.25 lock neither block nor break each other", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-x-"));
    try {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const v024 = withProfileLock024(dir, () => held);
      await Bun.sleep(50);
      // 0.25 gets in while 0.24 holds `.lock` …
      expect(await Promise.race([withInstallationLock(dir, async () => "0.25 ran"), Bun.sleep(1_000).then(() => "0.25 blocked")])).toBe("0.25 ran");
      // … and a 0.24 lock aged past 0.25's 120 s rule is not 0.25's to break.
      age(join(dir, ".lock"), STALE_MS + 5_000);
      await withInstallationLock(dir, async () => {});
      expect(existsSync(join(dir, ".lock", "owner.json"))).toBe(true);
      release();
      await v024;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
