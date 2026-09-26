/** auth/node/store.ts (RFC-016 §5): the files, their modes and order, E5, the 0.23 retirement, 0.24 coexistence. */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, copyFileSync, chmodSync, utimesSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as store from "../auth/node/store";
import * as v024 from "./fixtures/v024/store";
import { generateSoftwareKey } from "../auth/core/signer";
import { makeJoinState } from "./dpop-verify";
import { spawnRacers } from "./fixtures/go-signal";

function tmp(prefix = "store-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("files", () => {
  test("key.json, state, installation.json and attempt are 0600 in a 0700 directory", async () => {
    const dir = join(tmp(), "profile");
    try {
      const { privateJwk, signer } = await generateSoftwareKey();
      store.writeKey(dir, privateJwk);
      store.writeState(dir, makeJoinState(0));
      store.writeInstallation(dir, { apiUrl: "http://x", installationId: "i", jkt: signer.jkt, keyStorage: "software" });
      await store.createOrReadAttempt(dir);
      for (const f of ["key.json", "state", "installation.json", "attempt"]) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(store.readKey(dir)).toEqual(privateJwk);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("state is never overwritten by an OLDER seq; equal and newer are written", () => {
    const dir = tmp();
    try {
      const s5 = makeJoinState(5);
      store.writeState(dir, s5);
      expect(store.writeStateIfNotOlder(dir, makeJoinState(4))).toBe(false);
      expect(store.readState(dir)).toBe(s5);
      const s5b = makeJoinState(5);
      expect(store.writeStateIfNotOlder(dir, s5b)).toBe(true);
      const s6 = makeJoinState(6);
      expect(store.writeStateIfNotOlder(dir, s6)).toBe(true);
      expect(store.readState(dir)).toBe(s6);
      expect(() => store.writeStateIfNotOlder(dir, "brg_js_garbage")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deleteInstallationFiles removes all four; nothing else in the directory", async () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, ".env"), "BRIDGE_API_URL=x\n");
      const { privateJwk } = await generateSoftwareKey();
      store.writeKey(dir, privateJwk);
      store.writeState(dir, makeJoinState(0));
      store.writeInstallation(dir, { apiUrl: "http://x", installationId: "i", jkt: "j", keyStorage: "software" });
      await store.createOrReadAttempt(dir);
      store.deleteInstallationFiles(dir);
      expect(readdirSync(dir).sort()).toEqual([".env"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("attempt (E5)", () => {
  test("created exclusively: a second call reuses the value; delete clears it", async () => {
    const dir = tmp();
    try {
      const a = await store.createOrReadAttempt(dir);
      expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await store.createOrReadAttempt(dir)).toBe(a);
      expect(store.readAttempt(dir)).toBe(a);
      store.deleteAttempt(dir);
      expect(store.readAttempt(dir)).toBeNull();
      expect(await store.createOrReadAttempt(dir)).not.toBe(a);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("8 processes racing to create it all end up sending the SAME value", async () => {
    const racer = fileURLToPath(new URL("./fixtures/attempt-racer.ts", import.meta.url));
    for (let t = 0; t < 5; t++) {
      const dir = tmp("attempt-mp-");
      try {
        const ps = await spawnRacers(8, ["bun", racer, dir]);
        const outs = await Promise.all(ps.map((p) => new Response(p.stdout).text()));
        expect(new Set(outs).size).toBe(1);
        expect(outs[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 60_000);

  test("a just-created EMPTY attempt is waited for, not replaced (replacing = two attempts = false lock)", async () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "attempt"), "", { mode: 0o600 });
      const value = "A".repeat(43);
      const got = store.createOrReadAttempt(dir, async (ms) => {
        await Bun.sleep(ms);
        writeFileSync(join(dir, "attempt"), value); // the other writer's second syscall lands
      });
      expect(await got).toBe(value);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Run a store operation in a child; "hung" when it has not finished in 4 s. */
async function probe(mode: string, dir: string): Promise<string> {
  const p = Bun.spawn(["bun", fileURLToPath(new URL("./fixtures/store-probe.ts", import.meta.url)), mode, dir], { stdout: "pipe" });
  const timer = setTimeout(() => p.kill(), 4_000);
  const out = await new Response(p.stdout).text();
  clearTimeout(timer);
  return (await p.exited) === 0 && out ? out : "hung";
}

describe("robustness (review fixes)", () => {
  test("an attempt that exists but cannot be read throws AttemptUnreadableError — never spins, never replaces it", async () => {
    if (process.getuid?.() === 0) return; // root reads a 000 file anyway
    const dir = tmp();
    try {
      writeFileSync(join(dir, "attempt"), "A".repeat(43), { mode: 0o600 });
      chmodSync(join(dir, "attempt"), 0o000);
      const got = await probe("attempt", dir);
      expect(got).toStartWith("AttemptUnreadableError:");
    } finally {
      try {
        chmodSync(join(dir, "attempt"), 0o600);
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Record the durability-relevant syscalls with the path each fd belongs to. */
  function recordIo() {
    const saved = { ...store.__io };
    const fdPath = new Map<number, string>();
    const log: string[] = [];
    const base = (p: string) => p.split("/").pop()!.replace(/\.\d+\.\d+\.[A-Za-z0-9_-]+\.tmp$/, ".TMP");
    store.__io.openSync = ((p: any, f: any, m: any) => {
      const fd = saved.openSync(p, f, m);
      fdPath.set(fd, statSync(p).isDirectory() ? "DIR" : base(String(p)));
      return fd;
    }) as any;
    store.__io.fsyncSync = ((fd: number) => (log.push(`fsync ${fdPath.get(fd)}`), saved.fsyncSync(fd))) as any;
    store.__io.renameSync = ((a: any, b: any) => (log.push(`rename ${base(String(a))} ${base(String(b))}`), saved.renameSync(a, b))) as any;
    return { log, restore: () => Object.assign(store.__io, saved) };
  }

  test("writeAtomic: temp fsynced BEFORE the rename, directory fsynced AFTER it (a crash never loses a written state)", () => {
    const dir = tmp();
    const r = recordIo();
    try {
      store.writeState(dir, makeJoinState(0));
      expect(r.log).toEqual(["fsync state.TMP", "rename state.TMP state", "fsync DIR"]);
    } finally {
      r.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the attempt is durable (file + directory fsynced) before createOrReadAttempt returns — fresh AND reused", async () => {
    const dir = tmp();
    const r = recordIo();
    try {
      await store.createOrReadAttempt(dir);
      expect(r.log).toEqual(["fsync attempt", "fsync DIR"]);
      r.log.length = 0;
      await store.createOrReadAttempt(dir); // another racer's value: synced before we send it
      expect(r.log).toEqual(["fsync attempt", "fsync DIR"]);
    } finally {
      r.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a transiently refused rename (EBUSY/EPERM) is retried; a persistent one throws within ~1 s and leaves no temp file", async () => {
    const dir = tmp();
    const saved = store.__io.renameSync;
    try {
      let fails = 2;
      store.__io.renameSync = ((a: any, b: any) => {
        if (fails-- > 0) throw Object.assign(new Error("busy"), { code: "EBUSY" });
        return saved(a, b);
      }) as any;
      const s0 = makeJoinState(0);
      store.writeState(dir, s0);
      expect(store.readState(dir)).toBe(s0);
      store.__io.renameSync = saved;
      // A persistent refusal, in a child (a regression that retries forever sleeps synchronously).
      const t0 = Date.now();
      expect(await probe("rename-eperm", dir)).toBe("Error:denied");
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
      expect(store.readState(dir)).toBe(s0);
    } finally {
      store.__io.renameSync = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("orphan temp files (they can hold the private key): swept at open when old, all of them on deleteInstallationFiles — never anyone else's", () => {
    const dir = tmp();
    try {
      const old = "key.json.4242.1758000000000.AbCd.tmp";
      const fresh = "state.4242.1758000000001.XyZw.tmp";
      writeFileSync(join(dir, old), '{"d":"secret"}');
      writeFileSync(join(dir, fresh), "brg_js_…");
      const t = new Date(Date.now() - store.ORPHAN_TMP_AGE_MS - 5_000);
      utimesSync(join(dir, old), t, t);
      writeFileSync(join(dir, "credentials.json.4242.1758000000000.tmp"), "{}"); // 0.23/0.24's — retireLegacy's business
      mkdirSync(join(dir, "sessions"));
      writeFileSync(join(dir, "sessions", "pid-1.json.4242-k3j2h1.tmp"), "{}"); // the hook's
      expect(store.sweepOrphanTemps(dir)).toBe(1);
      expect(existsSync(join(dir, old))).toBe(false);
      expect(existsSync(join(dir, fresh))).toBe(true); // may be a live writer's
      store.deleteInstallationFiles(dir);
      expect(readdirSync(dir).sort()).toEqual(["credentials.json.4242.1758000000000.tmp", "sessions"]);
      expect(readdirSync(join(dir, "sessions"))).toEqual(["pid-1.json.4242-k3j2h1.tmp"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("RFC-014 (0.23 / 0.24) → 0.25", () => {
  test("retires credentials.json and ONLY RFC-014 session files — the hook's session maps survive", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "credentials.json"), JSON.stringify({ apiUrl: "https://b.example", installationId: "i", installationToken: "brg_it_x", installationName: "mac" }));
      mkdirSync(join(dir, "sessions"));
      writeFileSync(join(dir, "sessions", "abc.json"), JSON.stringify({ sessionId: "s", refreshToken: "brg_rt_x", installationId: "i" }));
      writeFileSync(join(dir, "sessions", "pid-123.json"), JSON.stringify({ sessionId: "claude-session" }));
      writeFileSync(join(dir, "sessions", "sse-4567.json"), JSON.stringify({ sessionId: "claude-session" }));
      expect(store.hasLegacyCredentials(dir)).toBe(true);
      const m = store.retireLegacy(dir)!;
      expect(m).toMatchObject({ apiUrl: "https://b.example", installationName: "mac" });
      expect(existsSync(join(dir, "credentials.json"))).toBe(false);
      expect(readdirSync(join(dir, "sessions")).sort()).toEqual(["pid-123.json", "sse-4567.json"]);
      expect(store.readUpgradeMarker(dir)?.apiUrl).toBe("https://b.example");
      expect(store.hasLegacyCredentials(dir)).toBe(false);
      expect(store.retireLegacy(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a named profile's sessions/ holds only RFC-014 files: the emptied directory goes too", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "credentials.json"), "{}");
      mkdirSync(join(dir, "sessions"));
      writeFileSync(join(dir, "sessions", "k.json"), JSON.stringify({ sessionId: "s", refreshToken: "r", installationId: "i" }));
      store.retireLegacy(dir);
      expect(existsSync(join(dir, "sessions"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("0.23 temp files a crash left behind go too; the hook's own temp files and 0.25's files stay", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "credentials.json.4242.1758000000000.tmp"), JSON.stringify({ installationToken: "brg_it_x" }));
      writeFileSync(join(dir, "installation.json.4242.1758000000000.AbCd.tmp"), "{}"); // 0.25's writeAtomic: not ours to judge
      mkdirSync(join(dir, "sessions"));
      writeFileSync(join(dir, "sessions", "abc.json.4242.1758000000000.tmp"), JSON.stringify({ refreshToken: "brg_rt_x" }));
      writeFileSync(join(dir, "sessions", "pid-123.json.4242-k3j2h1.tmp"), "{}"); // hooks/session-map.ts in flight
      expect(store.hasLegacyCredentials(dir)).toBe(true); // no credentials.json at all
      store.retireLegacy(dir);
      expect(readdirSync(dir).sort()).toEqual(["installation.json.4242.1758000000000.AbCd.tmp", "sessions", "upgrade-required.json"]);
      expect(readdirSync(join(dir, "sessions"))).toEqual(["pid-123.json.4242-k3j2h1.tmp"]);
      expect(store.hasLegacyCredentials(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a profile with ONLY RFC-014 session files (credentials.json already gone) is retired too", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, "sessions"));
      writeFileSync(join(dir, "sessions", "k.json"), JSON.stringify({ sessionId: "s", refreshToken: "brg_rt_x", installationId: "i" }));
      writeFileSync(join(dir, "sessions", "sse-1.json"), JSON.stringify({ sessionId: "claude-session" }));
      expect(store.hasLegacyCredentials(dir)).toBe(true);
      expect(store.retireLegacy(dir)).not.toBeNull();
      expect(readdirSync(join(dir, "sessions"))).toEqual(["sse-1.json"]);
      expect(store.readUpgradeMarker(dir)).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A stale 0.24 process (still running after the update, or a second Claude Code on the
 * old plugin) shares the profile directory with 0.25. test/fixtures/v024/store.ts is a
 * VERBATIM copy of 0.24's auth/store.ts (`git show c32ead6:auth/store.ts`), pinned by hash
 * below so "0.24's behaviour" cannot drift into whatever makes this pass.
 */
describe("a stale 0.24 process in the same profile (cross-version safety)", () => {
  const FULL = ["installation.json", "key.json", "state", "attempt"] as const;

  async function fullProfile(dir: string) {
    const { privateJwk, signer } = await generateSoftwareKey();
    store.writeKey(dir, privateJwk);
    store.writeState(dir, makeJoinState(3));
    store.writeInstallation(dir, {
      apiUrl: "https://b.example",
      installationId: crypto.randomUUID(),
      installationName: "mac",
      enrolledAt: 1,
      jkt: signer.jkt,
      keyStorage: "software",
      agent: { id: "a", handle: "h", name: "n" },
      workspace: { id: "w", name: "W" },
    });
    await store.createOrReadAttempt(dir);
    return Object.fromEntries(FULL.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
  }

  test("the 0.24 fixture is 0.24's auth/store.ts, byte for byte", () => {
    const src = readFileSync(new URL("./fixtures/v024/store.ts", import.meta.url), "utf8");
    expect(createHash("sha256").update(src).digest("hex")).toBe("f61b9c1d1fd1edfec1536e6f2cb547e2f11023284b0323bf5be30b90a8a4e640");
  });

  test("0.24 reads a 0.25 profile as 'not signed in', and every 0.24 deletion path leaves 0.25's files intact", async () => {
    const dir = tmp("v024-");
    try {
      const before = await fullProfile(dir);
      // 0.24 finds no installation → configError "not signed in"; it never reaches a token call.
      expect(v024.readInstallation(dir)).toBeNull();
      // Every 0.24 path that deletes (logout, a refused session grant, installationRevoked,
      // completeLogin) is deleteProfileCredentials; plus the session sweep and the logout marker.
      v024.deleteProfileCredentials(dir);
      v024.sweepSessions(dir, "", 0);
      v024.deleteSession(dir, "k");
      v024.writeLoggedOutMarker(dir);
      v024.clearLoggedOutMarker(dir);
      for (const f of FULL) expect(readFileSync(join(dir, f), "utf8")).toBe(before[f]!);
      expect(store.readInstallation(dir)).not.toBeNull();
      expect(store.readKey(dir)).not.toBeNull();
      expect(store.readState(dir)).not.toBeNull();
      expect(store.readAttempt(dir)).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("0.24's readInstallation cannot parse ANY 0.25 file, even copied under its own name", async () => {
    const dir = tmp("v024-");
    const probe = tmp("v024-probe-");
    try {
      await fullProfile(dir);
      // A caller that spreads an RFC-014 object in must not get its token onto disk.
      store.writeInstallation(dir, { ...(store.readInstallation(dir) as store.Installation), installationToken: "brg_it_x" } as any);
      expect(readFileSync(join(dir, "installation.json"), "utf8")).not.toContain("installationToken");
      for (const f of FULL) {
        copyFileSync(join(dir, f), join(probe, "credentials.json"));
        expect(v024.readInstallation(probe)).toBeNull();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(probe, { recursive: true, force: true });
    }
  });

  test("0.25 writes nothing where 0.24 (or the session-map hook) deletes: no credentials.json, nothing in sessions/", async () => {
    const dir = tmp("v024-");
    try {
      await fullProfile(dir);
      store.writeStateIfNotOlder(dir, makeJoinState(4));
      store.writeLoggedOutMarker(dir);
      writeFileSync(join(dir, "credentials.json"), "{}");
      store.retireLegacy(dir); // leaves upgrade-required.json
      const names = readdirSync(dir).sort();
      expect(names).toEqual(["attempt", "installation.json", "key.json", "logged-out", "state", "upgrade-required.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
