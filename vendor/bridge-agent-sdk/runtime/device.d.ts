/**
 * Device-code polling (RFC 8628 §3.4–3.5). ADAPTED from the plugin's
 * `auth/device.ts` `pollDevice`: same loop, same exhaustive §3.3 classification,
 * but the sleep goes through `Runtime.timer`/`Runtime.clock` instead of a raw
 * `setTimeout`/`Date.now`, so a fake-timer test drives it deterministically —
 * the one thing that needed adapting to move a Claude-plugin file into the SDK.
 */
import { type DeviceAuthorization, type EnrolGrant } from "../core";
import type { Runtime } from "./ports";
export type DeviceOutcome = {
    ok: true;
    grant: EnrolGrant;
} | {
    ok: false;
    error: string;
};
export declare function pollDeviceCode(rt: Runtime, poll: () => Promise<EnrolGrant>, auth: DeviceAuthorization, opts?: {
    signal?: AbortSignal;
}): Promise<DeviceOutcome>;
