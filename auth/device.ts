/**
 * Device authorization polling (RFC 8628 §3.4–3.5): `authorization_pending` waits,
 * `slow_down` adds 5 s to the interval for good, anything else ends the flow.
 */
import { OAuthError, token, type AuthMetadata, type DeviceAuthorization, type InstallationGrant } from "./oauth";

export type DeviceOutcome = { ok: true; grant: InstallationGrant } | { ok: false; error: string };

export async function pollDevice(
  meta: AuthMetadata,
  auth: DeviceAuthorization,
  opts: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}
): Promise<DeviceOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = opts.now ?? Date.now;
  let intervalS = Math.max(1, auth.interval || 5);
  const deadline = now() + auth.expires_in * 1000;
  for (;;) {
    await sleep(intervalS * 1000);
    if (opts.signal?.aborted) return { ok: false, error: "cancelled" };
    if (now() > deadline) return { ok: false, error: "expired_token" };
    try {
      return { ok: true, grant: await token.deviceCode(meta, auth.device_code) };
    } catch (e) {
      if (!(e instanceof OAuthError)) continue; // network blip: keep polling until the deadline
      if (e.error === "authorization_pending") continue;
      if (e.error === "slow_down") {
        intervalS += 5;
        continue;
      }
      return { ok: false, error: e.error };
    }
  }
}
