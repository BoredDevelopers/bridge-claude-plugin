/**
 * auth/core/deadline.ts — the one place a deadline is built, replacing
 * `AbortSignal.timeout` composed through `AbortSignal.any` (unreliable on Bun
 * 1.3–1.4 and on Node: coder/xum#4958, oven-sh/bun#29546, nodejs/node#57736).
 * Pure.
 */
import { test, expect } from "bun:test";
import { deadline } from "../auth/core/deadline";

test("fires with a TimeoutError reason even when nothing ever listens on the signal", async () => {
  const dl = deadline(20);
  await Bun.sleep(80);
  expect(dl.signal.aborted).toBe(true);
  expect((dl.signal.reason as { name?: unknown } | undefined)?.name).toBe("TimeoutError");
  expect((dl.signal.reason as Error).message).toContain("20 ms");
  dl.clear();
});

test("fires even after a listener was added then removed before the deadline (the Bun bug shape)", async () => {
  const dl = deadline(20);
  const noop = () => {};
  // The exact shape that breaks `AbortSignal.timeout` composed through
  // `AbortSignal.any`: something (there, `AbortSignal.any`'s own follower;
  // here, a stand-in consumer like `fetch`) adds an abort listener and removes
  // it again before the timer is due. Our timer is a plain `setTimeout` on our
  // own controller — nothing about listeners on `dl.signal` can gate it.
  dl.signal.addEventListener("abort", noop);
  dl.signal.removeEventListener("abort", noop);
  await Bun.sleep(80);
  expect(dl.signal.aborted).toBe(true);
  expect((dl.signal.reason as { name?: unknown } | undefined)?.name).toBe("TimeoutError");
  dl.clear();
});

test("a parent's abort propagates its own reason, synchronously", () => {
  const parent = new AbortController();
  const dl = deadline(60_000, parent.signal);
  const reason = new Error("caller cancelled");
  parent.abort(reason);
  expect(dl.signal.aborted).toBe(true);
  expect(dl.signal.reason).toBe(reason);
  dl.clear();
});

test("multiple parents: whichever aborts first wins, with its own reason", () => {
  const a = new AbortController();
  const b = new AbortController();
  const dl = deadline(60_000, a.signal, b.signal);
  const reason = new Error("b went first");
  b.abort(reason);
  expect(dl.signal.aborted).toBe(true);
  expect(dl.signal.reason).toBe(reason);
  dl.clear();
});

test("an already-aborted parent aborts immediately with its reason; clear() is then a harmless no-op", () => {
  const parent = new AbortController();
  const reason = new Error("already gone");
  parent.abort(reason);
  const dl = deadline(60_000, parent.signal);
  expect(dl.signal.aborted).toBe(true);
  expect(dl.signal.reason).toBe(reason);
  expect(() => dl.clear()).not.toThrow();
});

test("clear() cancels the timer (no late fire) and detaches from parents (a later parent abort no longer propagates)", async () => {
  const parent = new AbortController();
  const dl = deadline(20, parent.signal);
  dl.clear();
  await Bun.sleep(80);
  expect(dl.signal.aborted).toBe(false);
  parent.abort(new Error("too late"));
  expect(dl.signal.aborted).toBe(false);
});

test("undefined parents are ignored", () => {
  const dl = deadline(60_000, undefined, undefined);
  expect(dl.signal.aborted).toBe(false);
  dl.clear();
});
