/**
 * auth/core's public surface — the future `@bridge/agent-sdk` entry point. Encoding
 * helpers (base64url, raw JWS signing) stay internal: every signature goes through a
 * purpose-built function (proof, assertion), never an arbitrary JWS.
 */
export { type Signer, type KeyStorage, softwareSigner, generateSoftwareKey } from "./signer";
export { type EcPublicJwk, type EcPrivateJwk, isP256PublicJwk, isP256PrivateJwk, jwkThumbprint } from "./jwk";
export { type ProofInput, dpopProof, wsHtu, normalizeHtu } from "./dpop";
export { clientAssertion, CLIENT_ASSERTION_TYPE, ASSERTION_TTL_S } from "./assertion";
export { Clock, MAX_CLOCK_OFFSET_MS } from "./clock";
export { isJoinState, joinStateSeq } from "./join-state";
export {
  type TokenAction,
  type InstallationGoneReason,
  type OAuthErrorInit,
  OAuthError,
  isOAuthError,
  TransportError,
  GONE_REASONS,
  classifyTokenError,
  assertNever,
} from "./token-errors";
