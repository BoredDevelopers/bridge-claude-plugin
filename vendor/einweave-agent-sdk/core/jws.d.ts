import type { Signer } from "./signer";
export declare function signJwt(signer: Signer, header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string>;
/** 128-bit random `jti` — fresh for every assertion and proof (both are single-use server-side, E12). */
export declare const newJti: () => string;
