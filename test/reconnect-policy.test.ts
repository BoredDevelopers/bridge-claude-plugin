/**
 * reconnect-policy.ts — the per-close-code reconnect schedule. Pure.
 */
import { describe, test, expect } from "bun:test";
import { classifyClose, describeClose, reconnectDelay } from "../reconnect-policy";

const lo = () => 0;
const hi = () => 0.999999;

describe("classifyClose", () => {
  test("maps every server code to its class; anything else is transient", () => {
    expect(classifyClose(4007)).toBe("session-cap");
    expect(classifyClose(4001)).toBe("credential");
    expect(classifyClose(4003)).toBe("credential");
    expect(classifyClose(4008)).toBe("revoked");
    expect(classifyClose(4009)).toBe("expired");
    for (const c of [1000, 1001, 1006, 4006, 4004, 4005, undefined]) expect(classifyClose(c)).toBe("transient");
  });

  test('1011 "grant check failed" (RFC-016: the server\'s grant re-check hit a DB error) is transient — retry soon, same token', () => {
    expect(classifyClose(1011)).toBe("transient");
    expect(reconnectDelay(1, classifyClose(1011), hi)).toBeLessThanOrEqual(1000);
  });
});

describe("4008 session evicted (bridge#209: evicted at the live-session cap)", () => {
  test("is its own class: reconnect soon with a NEW session — never the revoked stop", () => {
    expect(classifyClose(4008, "session evicted")).toBe("evicted");
    expect(classifyClose(4008, "session revoked")).toBe("revoked");
    expect(classifyClose(4008, undefined)).toBe("revoked");
    expect(reconnectDelay(1, "evicted", hi)).toBeLessThanOrEqual(1000);
    expect(reconnectDelay(9, "evicted")).not.toBeNull();
    const t = describeClose("evicted", 4008, "session evicted");
    expect(t).toContain("new session");
    expect(t).not.toContain("/bridge:connect");
  });
});

describe("RFC-017 D6: superseded / too-old 4008 reasons, matched on the prefix before ':'", () => {
  test("classifyClose: 'session superseded: …' -> superseded; 'client too old: …' and 'client version withdrawn: …' (blocked) -> too-old", () => {
    expect(classifyClose(4008, "session superseded: a newer Bridge plugin took over in another window of this session")).toBe("superseded");
    expect(classifyClose(4008, "client too old: run /plugin update bridge, then /reload-plugins")).toBe("too-old");
    expect(classifyClose(4008, "client version withdrawn: run /plugin update bridge, then /reload-plugins")).toBe("too-old");
  });

  test("neither class steals an existing reason: 'session evicted' and 'session revoked' are unaffected", () => {
    expect(classifyClose(4008, "session evicted")).toBe("evicted");
    expect(classifyClose(4008, "session revoked")).toBe("revoked");
  });

  test("an unrecognised 4008 reason (even with a colon) stays 'revoked' — D6's reserved 'stop, a person must act' default", () => {
    expect(classifyClose(4008, "something new: nobody coded this yet")).toBe("revoked");
    expect(classifyClose(4008, undefined)).toBe("revoked");
  });

  test("neither class ever reconnects on its own", () => {
    expect(reconnectDelay(1, "superseded")).toBeNull();
    expect(reconnectDelay(9, "superseded")).toBeNull();
    expect(reconnectDelay(1, "too-old")).toBeNull();
    expect(reconnectDelay(9, "too-old")).toBeNull();
  });

  test("describeClose: superseded — a NEWER holder says update; equal/older/unknown says take it back", () => {
    // RFC-017 D3/finding 6: the wording must not claim "a newer plugin" took over unless
    // the holder's OWN version really is newer than this process's — a person's explicit
    // `/bridge:connect takeover` from an equal or older window is a plain takeover, not an
    // update prompt.
    const newer = describeClose("superseded", 4008, "session superseded: …", {
      supersededBy: { pid: 4242, version: "0.27.0", tty: "ttys003", termProgram: "iTerm.app", cwd: "/Users/j/Code/x" },
      myVersion: "0.26.0",
    });
    expect(newer).toContain("pid 4242");
    expect(newer).toContain("0.27.0");
    expect(newer).toContain("ttys003");
    expect(newer).toContain("iTerm.app");
    expect(newer).toContain("/Users/j/Code/x");
    expect(newer).toContain("/reload-plugins");
    expect(newer).toContain("/bridge:connect takeover");

    const equal = describeClose("superseded", 4008, "session superseded: …", {
      supersededBy: { pid: 4242, version: "0.26.0" },
      myVersion: "0.26.0",
    });
    expect(equal).not.toContain("/reload-plugins");
    expect(equal).toContain("took over Bridge");
    expect(equal).toContain("/bridge:connect takeover");

    const older = describeClose("superseded", 4008, "session superseded: …", {
      supersededBy: { pid: 4242, version: "0.20.0" },
      myVersion: "0.26.0",
    });
    expect(older).not.toContain("/reload-plugins");

    const unknown = describeClose("superseded", 4008, "session superseded: …", {
      supersededBy: { pid: 4242 },
      myVersion: "0.26.0",
    });
    expect(unknown).not.toContain("/reload-plugins");
    expect(unknown).toContain("pid 4242");

    const anonymous = describeClose("superseded", 4008, "session superseded: …");
    expect(anonymous).toContain("another window");
    expect(anonymous).toContain("/bridge:connect takeover");
    expect(anonymous).not.toContain("/reload-plugins");
  });

  test("describeClose: too-old always says the update instruction", () => {
    const text = describeClose("too-old", 4008, "client too old: run /plugin update bridge, then /reload-plugins");
    expect(text).toContain("/plugin update bridge");
    expect(text).toContain("/reload-plugins");
  });
});

describe("reconnectDelay", () => {
  test("transient: 1s → 30s, same curve as the web client", () => {
    expect(reconnectDelay(1, "transient", hi)).toBeLessThanOrEqual(1000);
    expect(reconnectDelay(1, "transient", lo)).toBe(500);
    expect(reconnectDelay(2, "transient", hi)).toBeLessThanOrEqual(2000);
    expect(reconnectDelay(6, "transient", hi)).toBeLessThanOrEqual(30_000);
    expect(reconnectDelay(50, "transient", lo)).toBe(15_000); // capped, never overflows
  });

  test("session-cap (4007): starts at 30s, caps at 5 min", () => {
    expect(reconnectDelay(1, "session-cap", lo)).toBe(15_000);
    expect(reconnectDelay(1, "session-cap", hi)).toBeLessThanOrEqual(30_000);
    expect(reconnectDelay(20, "session-cap", hi)).toBeLessThanOrEqual(300_000);
    expect(reconnectDelay(20, "session-cap", lo)).toBe(150_000);
  });

  test("credential (4001/4003): starts at 60s, caps at 5 min", () => {
    expect(reconnectDelay(1, "credential", lo)).toBe(30_000);
    expect(reconnectDelay(1, "credential", hi)).toBeLessThanOrEqual(60_000);
    expect(reconnectDelay(20, "credential", hi)).toBeLessThanOrEqual(300_000);
  });

  test("expired (4009): retries on the transient curve (the manager refreshes on the way in)", () => {
    expect(reconnectDelay(1, "expired", hi)).toBeLessThanOrEqual(1000);
    expect(reconnectDelay(1, "expired", lo)).toBe(500);
  });

  test("4008 says what to do, by reason", () => {
    expect(describeClose("revoked", 4008, "session revoked")).toContain("/bridge:connect starts a new session");
    expect(describeClose("revoked", 4008, "installation revoked")).toContain("run /bridge:login");
    // RFC-016 E8: a lock is a copy detected — say so, and how to recover.
    const locked = describeClose("revoked", 4008, "installation locked");
    expect(locked).toContain("credential copy detected");
    expect(locked).toContain("LOCKED");
    expect(locked).toContain("check this machine");
    expect(locked).toContain("/bridge:login");
    // S4: "deleted here" only when this process deleted it.
    expect(locked).not.toContain("deleted");
    const deleted = describeClose("revoked", 4008, "installation locked", { keyDeleted: true });
    expect(deleted).toContain("its key was deleted here");
    expect(deleted).toContain("/bridge:login");
  });

  test("4001 points at /bridge:login — never the retired /bridge:configure token", () => {
    const t = describeClose("credential", 4001, "Invalid token");
    expect(t).toContain("/bridge:login");
    expect(t).not.toContain("/bridge:configure");
    expect(describeClose("credential", 4003, undefined)).not.toContain("/bridge:configure");
  });

  test("revoked (4008): never reconnects on its own", () => {
    expect(reconnectDelay(1, "revoked")).toBeNull();
    expect(reconnectDelay(9, "revoked")).toBeNull();
  });

  test("equal jitter: every delay lies in [b/2, b] and two sessions do not collide", () => {
    for (let a = 1; a <= 8; a++) {
      const b = Math.min(30_000, 1000 * 2 ** (a - 1));
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        const d = reconnectDelay(a, "transient", () => r)!;
        expect(d).toBeGreaterThanOrEqual(b / 2);
        expect(d).toBeLessThanOrEqual(b);
      }
    }
    // Real randomness: 50 sessions dropped by one restart do not all pick one delay.
    const picks = new Set(Array.from({ length: 50 }, () => reconnectDelay(1, "transient")));
    expect(picks.size).toBeGreaterThan(10);
  });

  test("grows with attempts (not flat, not linear-lockstep)", () => {
    const a1 = reconnectDelay(1, "transient", lo)!;
    const a3 = reconnectDelay(3, "transient", lo)!;
    expect(a3).toBe(a1 * 4);
  });
});
