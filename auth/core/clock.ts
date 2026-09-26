/**
 * The server's clock, as far as this client can tell (RFC-016 E12). Assertions
 * and proofs are accepted within ±300 s of the SERVER's time; a laptop that is
 * minutes off would otherwise fail every mint. Token-endpoint responses carry
 * `Date`; the offset is re-learnt from every one of them. Pure.
 */
export class Clock {
  private offsetMs = 0;
  constructor(private readonly now: () => number = Date.now) {}

  /** Seconds since the epoch on the server's clock — the `iat` for every JWT we sign. */
  nowS(): number {
    return Math.floor((this.now() + this.offsetMs) / 1000);
  }

  /** Learn the offset from an HTTP `Date` header (1 s resolution; absent/garbage is ignored). */
  observe(dateHeader: string | null | undefined): void {
    const t = Date.parse(dateHeader ?? "");
    if (Number.isFinite(t)) this.offsetMs = t - this.now();
  }

  offset(): number {
    return this.offsetMs;
  }
}
