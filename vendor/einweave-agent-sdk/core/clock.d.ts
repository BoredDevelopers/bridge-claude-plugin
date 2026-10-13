/** A `Date` further off than this is a broken proxy or cache, not a clock to follow. */
export declare const MAX_CLOCK_OFFSET_MS: number;
export declare class Clock {
    private readonly now;
    private offsetMs;
    constructor(now?: () => number);
    /** Seconds since the epoch on the server's clock — the `iat` for every JWT we sign. */
    nowS(): number;
    /**
     * Learn the offset from an HTTP `Date` header. Only an IMF-fixdate within
     * MAX_CLOCK_OFFSET_MS is learnt; anything else keeps the last offset (`Date.parse`
     * alone would take "1" as the year 2001).
     *
     * Bias: `Date` is truncated to the second, so the learnt server time is up to 1 s in
     * the PAST — `iat` runs ≤ 1 s early, far inside the server's ±300 s window.
     */
    observe(dateHeader: string | null | undefined): void;
    offset(): number;
}
