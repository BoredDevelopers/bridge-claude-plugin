/**
 * The one place a deadline is built (RFC-016 §5.2 lineage; the future SDK's `deadline()`).
 *
 * NEVER `AbortSignal.timeout(ms)` composed through `AbortSignal.any([...])`: it is
 * unreliable on Bun 1.3–1.4 (the scheduled abort silently never fires once the last
 * abort listener on the timeout signal is removed — coder/xum#4958, oven-sh/bun#29546)
 * and on Node (nodejs/node#57736, confirmed). We hit this for real: the installation
 * lock's hold budget never fired on Bun 1.3 (auth/node/lock.ts). The fix there and here
 * is the same shape: an explicit `AbortController` + `setTimeout`, which always fires.
 *
 * Aborts with a `DOMException("…", "TimeoutError")` — the exact reason/name every
 * caller's classification keys on (auth/core/token-errors.ts `isTransportFailure`,
 * auth/core/protocol.ts `callerCancelled`): keep that contract if this ever changes.
 * A `parents` signal that aborts first wins, WITH ITS OWN REASON (so a caller's own
 * cancel still classifies as a caller cancel, never as our timeout).
 *
 * Callers MUST call `clear()` (in a `finally`) once done with `signal` — it clears the
 * timer and detaches the parent listeners; skipping it leaks both.
 */
export interface Deadline {
  readonly signal: AbortSignal;
  clear(): void;
}

export function deadline(ms: number, ...parents: (AbortSignal | undefined)[]): Deadline {
  const ac = new AbortController();

  // A parent already gone before we start: adopt its reason and never touch a timer —
  // there is nothing left to clear.
  const already = parents.find((p) => p?.aborted);
  if (already) {
    ac.abort(already.reason);
    return { signal: ac.signal, clear() {} };
  }

  const timer = setTimeout(() => ac.abort(new DOMException(`deadline timed out after ${ms} ms`, "TimeoutError")), ms);
  // Not every runtime offers `unref` (browsers don't) — keep this file free of Node/Bun
  // ambient types (RFC-016 §5 purity: tsconfig.core.json) while still not holding a
  // process open on this timer alone.
  (timer as unknown as { unref?: () => void }).unref?.();

  const listeners: { p: AbortSignal; fn: () => void }[] = [];
  for (const p of parents) {
    if (!p) continue;
    const fn = () => ac.abort(p.reason);
    p.addEventListener("abort", fn, { once: true });
    listeners.push({ p, fn });
  }

  return {
    signal: ac.signal,
    clear() {
      clearTimeout(timer);
      for (const { p, fn } of listeners) p.removeEventListener("abort", fn);
    },
  };
}
