/**
 * RFC-017 P0 — the 0.25 cohort. test/fixtures/v025/reconnect-policy.ts and
 * .../token-errors.ts are VERBATIM copies of 0.25's own modules (`git show
 * 0e7ec8d:reconnect-policy.ts` / `:auth/core/token-errors.ts`), pinned by hash below so
 * "0.25's behaviour" cannot drift into whatever makes this pass. The three new 4008
 * reasons are copied as LITERAL STRINGS from the server's client-versions.ts
 * (CLOSE_REASONS) rather than re-derived, so a typo or a re-worded reason on either side
 * shows up here, not just in the server's own test.
 *
 * C6: every new close reason maps to a class 0.25 never retries on, and the pinned
 * token classifier treats the new OAuth error the same way. C12 (half): the pinned
 * describeClose output for the too-old reason instructs on its own.
 *
 * C8 (every v025 fixture loads) lives in test/auth-store.test.ts, next to the rest of
 * the store.ts / connect-store.ts / label-store.ts read tests it exercises.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as v025Reconnect from "./fixtures/v025/reconnect-policy";
import { OAuthError, classifyTokenError } from "./fixtures/v025/token-errors";

// Literal copies of packages/api/src/client-versions.ts's CLOSE_REASONS (RFC-017 D6/S1) —
// not imported (this is a plugin-repo test with no server checkout), so a divergence on
// either side must be caught by eye at review, which is why each is quoted with its
// source line.
const CLOSE_REASONS = {
  // client-versions.ts:213
  tooOld: "client too old: run /plugin update bridge, then /reload-plugins",
  // client-versions.ts:214
  blocked: "client version withdrawn: run /plugin update bridge, then /reload-plugins",
  // client-versions.ts:215
  superseded: "session superseded: a newer Bridge plugin took over in another window of this session",
} as const;

describe("the v025 fixture modules are 0.25's own source, byte for byte", () => {
  test("reconnect-policy.ts", () => {
    const src = readFileSync(new URL("./fixtures/v025/reconnect-policy.ts", import.meta.url), "utf8");
    expect(createHash("sha256").update(src).digest("hex")).toBe("d50caa26eb7664c7218048855dd277326d7afc09540d09cd039930a6750fe6cd");
  });
  test("auth/core/token-errors.ts", () => {
    const src = readFileSync(new URL("./fixtures/v025/token-errors.ts", import.meta.url), "utf8");
    expect(createHash("sha256").update(src).digest("hex")).toBe("0728dfe3801ad506b564789d3d887071ea5fc96143662ae921ff3723ad46cce6");
  });
});

describe("C6: pinned 0.25 never retries on a new 4008 reason", () => {
  for (const [name, reason] of Object.entries(CLOSE_REASONS)) {
    test(`classifyClose(4008, "${name}") -> revoked, reconnectDelay -> null`, () => {
      const cls = v025Reconnect.classifyClose(4008, reason);
      expect(cls).toBe("revoked");
      expect(v025Reconnect.reconnectDelay(1, cls)).toBeNull();
    });
  }

  test("an UNKNOWN close code (never used by any reason above) is transient, not revoked — the class split itself is real", () => {
    expect(v025Reconnect.classifyClose(4321, "something new")).toBe("transient");
  });
});

describe("C12 (half): the pinned describeClose instructs on its own for the too-old reason", () => {
  test('describeClose quotes CLOSE_REASONS.tooOld verbatim, so its own text carries "/plugin update bridge"', () => {
    const text = v025Reconnect.describeClose("revoked", 4008, CLOSE_REASONS.tooOld);
    expect(text).toContain("/plugin update bridge");
    expect(text).toContain(CLOSE_REASONS.tooOld);
  });

  test("every CLOSE_REASONS value fits RFC 6455's 123-byte close-reason limit", () => {
    for (const reason of Object.values(CLOSE_REASONS)) {
      expect(Buffer.byteLength(reason, "utf8")).toBeLessThanOrEqual(123);
    }
  });
});

describe("C6: the pinned 0.25 token classifier stops on the new token errors, never retries", () => {
  test('unauthorized_client / "client_too_old: …" is a non-retry kind', () => {
    const e = new OAuthError({
      error: "unauthorized_client",
      status: 400,
      description: "client_too_old: bridge-claude-plugin >= 0.26.0 required — /plugin update bridge",
    });
    const a = classifyTokenError(e);
    // 0.25 has no case for `unauthorized_client` (it predates RFC-017): the table's own
    // default is `refused` — "stop and show it, keep the files", never an automatic retry.
    // That default IS the safety property C6 checks: an error this build never coded for
    // still does not loop.
    expect(a.kind).toBe("refused");
    expect(a.kind).not.toBe("transient");
  });

  test('unauthorized_client / "client_blocked: …" is a non-retry kind', () => {
    const e = new OAuthError({
      error: "unauthorized_client",
      status: 400,
      description: "client_blocked: bridge-claude-plugin 0.25.0 is withdrawn — /plugin update bridge",
    });
    expect(classifyTokenError(e).kind).toBe("refused");
  });
});

/**
 * C8 (the lock record). server.ts has no exports and runs top-level side effects, so
 * neither its `LockRecord` type nor its `writeLockExclusive()` writer can be called, or
 * even type-checked against, from a test. This is therefore a HAND-REPRODUCED shape,
 * maintained by eye against server.ts alongside test/fixtures/generate-v025.ts's own
 * writer (whose own header makes the same admission: it reproduces the shape rather than
 * calling it). Deliberately NOT pinned to line numbers, which drift on every unrelated
 * server.ts edit — pid, procStart, sessionKey, at, nothing else, is 0.25's actual
 * pre-RFC-017 lock record, and this is what would go red if that shape were ever
 * misremembered in either file.
 */
describe("C8: the v025 lock record fixture parses as server.ts's LockRecord", () => {
  test("has exactly pid, procStart, sessionKey, at", () => {
    const raw = readFileSync(new URL("./fixtures/v025/locks/fixture-session.lock", import.meta.url), "utf8");
    const rec = JSON.parse(raw);
    expect(Object.keys(rec).sort()).toEqual(["at", "pid", "procStart", "sessionKey"]);
    expect(typeof rec.pid).toBe("number");
    expect(typeof rec.procStart).toBe("string");
    expect(rec.sessionKey).toBe("fixture-session");
    expect(typeof rec.at).toBe("string");
  });
});
