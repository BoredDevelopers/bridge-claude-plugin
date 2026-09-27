/**
 * Join state `brg_js_<seq>_<43 base62><6 base62 CRC32>` (RFC-016 §3.1). The
 * client never computes the CRC (the server checks it before any DB read); it
 * only needs the sequence number, to never overwrite a newer state with an
 * older one (§3.3 "never over a higher seq"). Pure.
 */
// Exactly the server's shape (agent-tokens.ts): decimal seq, no leading zeros, ≤ 15 digits.
const JOIN_STATE = /^brg_js_(0|[1-9][0-9]{0,14})_[0-9A-Za-z]{49}$/;

export function isJoinState(s: unknown): s is string {
  return typeof s === "string" && JOIN_STATE.test(s);
}

/** The state's sequence number, or null when it is not a join state at all. */
export function joinStateSeq(s: string): number | null {
  const m = JOIN_STATE.exec(s);
  return m ? Number(m[1]) : null;
}
