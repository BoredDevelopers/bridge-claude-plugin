/**
 * RFC-022 D2 — terminal control sequences never reach the host's terminal.
 *
 * `fixtures/control-chars.json` is a copy of the vectors in `@bridge/agent-sdk`
 * (and the server tests the same file), so the three copies of the rule cannot
 * drift apart quietly. The end-to-end half — a hostile frame from the server
 * arriving stripped on the MCP surface — lives in delivery-reasons.test.ts, next
 * to the stub that can inject one.
 */
import { describe, test, expect } from "bun:test";
import { stripControlChars, sanitizeChannelParams } from "../control-chars";
import fixture from "./fixtures/control-chars.json";

describe("stripControlChars (fixtures/control-chars.json)", () => {
  for (const v of fixture.vectors) {
    test(v.name, () => {
      expect(stripControlChars(v.input)).toBe(v.output);
    });
  }

  test("no ESC, C0 (bar \\n \\t), DEL or C1 survives in any output", () => {
    for (const v of fixture.vectors) expect(stripControlChars(v.input)).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/);
  });

  test("the fixture is not vacuous: it has vectors, and some of them change", () => {
    expect(fixture.vectors.length).toBeGreaterThan(15);
    expect(fixture.vectors.filter((v) => v.input !== v.output).length).toBeGreaterThan(10);
  });
});

describe("sanitizeChannelParams", () => {
  test("strips content and every string in meta; leaves other values alone", () => {
    const out = sanitizeChannelParams({
      content: "\x1b[31mred\x1b[0m",
      meta: { sender: "\x1b[8maio\x1b[28m", dropped: 3, type: "text" },
    });
    expect(out).toEqual({ content: "red", meta: { sender: "aio", dropped: 3, type: "text" } });
  });

  test("does not mutate its input", () => {
    const params = { content: "a\x07", meta: { sender: "b\x07" } };
    sanitizeChannelParams(params);
    expect(params).toEqual({ content: "a\x07", meta: { sender: "b\x07" } });
  });

  test("tolerates a payload with no content or meta", () => {
    expect(sanitizeChannelParams({})).toEqual({});
  });
});
