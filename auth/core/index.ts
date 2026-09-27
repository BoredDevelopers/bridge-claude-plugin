/**
 * auth/core's public surface — the future `@bridge/agent-sdk` entry point. Encoding
 * helpers (base64url, raw JWS signing) stay internal: every signature goes through a
 * purpose-built function (proof, assertion), never an arbitrary JWS.
 */
export { type Signer, type KeyStorage, softwareSigner, generateSoftwareKey } from "./signer";
export { type EcPublicJwk, type EcPrivateJwk, isP256PublicJwk, isP256PrivateJwk, jwkThumbprint } from "./jwk";
export { type ProofInput, dpopProof, wsHtu, httpHtu, apiOrigin, normalizeHtu } from "./dpop";
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
  DiscoveryError,
  AbortedError,
  GONE_REASONS,
  classifyTokenError,
  assertNever,
} from "./token-errors";
export {
  type AuthMetadata,
  type EnrolGrant,
  type MintGrant,
  type MintInput,
  type RevokeInput,
  type CallOpts,
  type DeviceAuthorization,
  type TokenClientOptions,
  type FetchLike,
  TokenClient,
  supportsKeyCredentials,
  isKeyAlreadyEnrolled,
  METADATA_TTL_MS,
  MINT_BUDGET_MS,
  MINT_TIMEOUT_MS,
} from "./protocol";
