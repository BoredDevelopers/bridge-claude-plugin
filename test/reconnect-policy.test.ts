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
