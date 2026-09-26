/**
 * Device authorization polling (RFC 8628 §3.4–3.5). `poll` is ONE token request — under
 * RFC-016 with a fresh DPoP proof by the new key every time (C8: the key on the poll
 * that collects the approval is the one registered).
 *
 * Every answer goes through the §3.3 classifier, exhaustively:
 *   - `pending` (authorization_pending): poll again after the interval;
 *   - `slow_down`: the interval grows by 5 s FOR GOOD (§3.5), then poll again;
 *   - `rate_limited` (429): wait its Retry-After on top of the interval, once;
 *   - `transient` / `new_proof` (no answer, 5xx, a proof the in-request retry could not
 *     fix): keep polling until the deadline;
 *   - `aborted`: the caller cancelled;
 *   - anything else ends the flow with the server's `error` (access_denied,
 *     expired_token, …).
 */
import { assertNever, classifyTokenError, isOAuthError, type DeviceAuthorization, type EnrolGrant } from "./core";

export type DeviceOutcome = { ok: true; grant: EnrolGrant } | { ok: false; error: string };

export async function pollDevice(
  poll: () => Promise<EnrolGrant>,
  auth: DeviceAuthorization,
  opts: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}
): Promise<DeviceOutcome> {
  // The wait between polls ends early on a cancel. An in-flight POLL is deliberately NOT
  // aborted: it may be the one carrying the approval — the server then has enrolled the
  // key, and only the answer lets the caller revoke it (a dropped answer = a live
  // machine nobody holds).
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((r) => {
        const done = () => (clearTimeout(t), r());
        const t = setTimeout(done, ms);
        opts.signal?.addEventListener("abort", done, { once: true });
      }));
  const now = opts.now ?? Date.now;
  let intervalS = Math.max(1, auth.interval || 5);
  let extraS = 0;
  const deadline = now() + auth.expires_in * 1000;
  for (;;) {
    await sleep((intervalS + extraS) * 1000);
    extraS = 0;
    if (opts.signal?.aborted) return { ok: false, error: "cancelled" };
    if (now() > deadline) return { ok: false, error: "expired_token" };
    try {
      return { ok: true, grant: await poll() };
    } catch (e) {
      const a = classifyTokenError(e);
      switch (a.kind) {
        case "pending":
        case "transient":
        case "new_proof":
          continue;
        case "slow_down":
          intervalS += 5;
          continue;
        case "rate_limited":
          extraS = a.retryAfterS;
          continue;
        case "aborted":
          return { ok: false, error: "cancelled" };
        case "installation_gone":
        case "clock":
        case "session_revoked":
        case "session_limit":
        case "corrupt_state":
        case "update_required":
        case "refused":
          return { ok: false, error: isOAuthError(e) ? e.error : e instanceof Error ? e.message : String(e) };
        default:
          return assertNever(a);
      }
    }
  }
}
