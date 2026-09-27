/**
 * The server's clock, as far as this client can tell (RFC-016 E12). Assertions
 * and proofs are accepted within ±300 s of the SERVER's time; a laptop that is
 * minutes off would otherwise fail every mint. Token-endpoint responses carry
 * `Date`; the offset is re-learnt from every one of them. Pure.
 */
/** RFC 9110 §5.6.7 IMF-fixdate — the only `Date` form a server MUST send. */
const IMF_FIXDATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
/** A `Date` further off than this is a broken proxy or cache, not a clock to follow. */
export const MAX_CLOCK_OFFSET_MS = 24 * 60 * 60 * 1000;

export class Clock {
  private offsetMs = 0;
  constructor(private readonly now: () => number = Date.now) {}

  /** Seconds since the epoch on the server's clock — the `iat` for every JWT we sign. */
  nowS(): number {
    return Math.floor((this.now() + this.offsetMs) / 1000);
  }

  /**
   * Learn the offset from an HTTP `Date` header. Only an IMF-fixdate within
   * MAX_CLOCK_OFFSET_MS is learnt; anything else keeps the last offset (`Date.parse`
   * alone would take "1" as the year 2001).
   *
   * Bias: `Date` is truncated to the second, so the learnt server time is up to 1 s in
   * the PAST — `iat` runs ≤ 1 s early, far inside the server's ±300 s window.
   */
  observe(dateHeader: string | null | undefined): void {
    if (typeof dateHeader !== "string" || !IMF_FIXDATE.test(dateHeader)) return;
    const t = Date.parse(dateHeader);
    if (!Number.isFinite(t)) return;
    const offset = t - this.now();
    if (Math.abs(offset) > MAX_CLOCK_OFFSET_MS) return;
    this.offsetMs = offset;
  }

  offset(): number {
    return this.offsetMs;
  }
}
