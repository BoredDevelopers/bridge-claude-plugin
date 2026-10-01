import type { Clock } from "./clock";
import type { Signer } from "./signer";
export declare const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/** Well inside the 300 s ceiling: a stale assertion is useless to anyone who logs it. */
export declare const ASSERTION_TTL_S = 60;
export declare function clientAssertion(signer: Signer, clock: Clock, installationId: string, issuer: string): Promise<string>;
