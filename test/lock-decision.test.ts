/** lock-decision.ts (RFC-017 D3): who wins a contested session lock. Pure. */
import { describe, test, expect } from "bun:test";
import { decideLock } from "../lock-decision";

describe("decideLock", () => {
  test("no holder: acquire, whatever my version is", () => {
    expect(decideLock(null, { version: "0.25.0" })).toBe("acquire");
    expect(decideLock(null, { version: "0.26.0" })).toBe("acquire");
  });

  test("C1: a newer contender takes over from an older live holder", () => {
    expect(decideLock({ version: "0.25.0" }, { version: "0.26.0" })).toBe("takeover");
  });

  test("C2: a same-version contender stands by", () => {
    expect(decideLock({ version: "0.26.0" }, { version: "0.26.0" })).toBe("standby");
  });

  test("the auto path never downgrades: an older contender stands by against a newer holder", () => {
    expect(decideLock({ version: "0.27.0" }, { version: "0.26.0" })).toBe("standby");
  });

  test("a missing holder version counts as 0.25 or older", () => {
    expect(decideLock({}, { version: "0.26.0" })).toBe("takeover");
    expect(decideLock({}, { version: "0.25.0" })).toBe("standby"); // equal to the default
    expect(decideLock({}, { version: "0.24.0" })).toBe("standby"); // mine is OLDER than the default
  });

  test("a PRESENT but unparseable holder version never auto-takes-over — standby, unlike a MISSING one", () => {
    expect(decideLock({ version: "garbage" }, { version: "0.26.0" })).toBe("standby");
    expect(decideLock({ version: "garbage" }, { version: "0.24.0" })).toBe("standby");
  });

  test("explicit takeover always wins, even onto an OLDER version (Decided #1, Q1) — the one escape from D3's first rule", () => {
    expect(decideLock({ version: "0.27.0" }, { version: "0.26.0" }, { takeover: true })).toBe("takeover");
    expect(decideLock({ version: "0.26.0" }, { version: "0.26.0" }, { takeover: true })).toBe("takeover");
    expect(decideLock({ version: "0.25.0" }, { version: "0.26.0" }, { takeover: true })).toBe("takeover");
  });
});
