/**
 * `private_key_jwt` client assertion (RFC 7523 as updated by rfc7523bis;
 * RFC-016 E2): `aud` = the issuer as the SOLE value, `typ:
 * client-authentication+jwt`, `kid` = the key's jkt, `exp` ≤ `iat` + 300 s,
 * single-use `jti`. Pure.
 */
import { signJwt, newJti } from "./jws";
import type { Clock } from "./clock";
import type { Signer } from "./signer";

export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/** Well inside the 300 s ceiling: a stale assertion is useless to anyone who logs it. */
export const ASSERTION_TTL_S = 60;

export function clientAssertion(signer: Signer, clock: Clock, installationId: string, issuer: string): Promise<string> {
  const iat = clock.nowS();
  return signJwt(
    signer,
    { typ: "client-authentication+jwt", kid: signer.jkt },
    { iss: installationId, sub: installationId, aud: issuer, jti: newJti(), iat, exp: iat + ASSERTION_TTL_S }
  );
}
