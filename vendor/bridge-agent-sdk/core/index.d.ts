/**
 * The SDK's `/core` entry point — sans-I/O (RFC-018 D1): wire types, DPoP and
 * assertion signing, join-state rules, close classification, the lock-ownership
 * rule, the format-guard rules, `deadline()`, and branded errors. No `node:`
 * imports, no sockets, no ambient timers (tsconfig.core.json enforces it).
 *
 * SOURCE: plugin c8b0db6 `auth/core/index.ts`. Everything from the marker below is
 * BYTE-IDENTICAL to that file (test/byte-identity.test.ts, fixtures/plugin-core/index.ts)
 * — the new SDK-only modules (reconnect-policy, lock-decision, format-guard, software,
 * wire, dedupe, cursor, control-chars, feed, tail-render, tail-state) are re-exported ABOVE the marker instead of interleaved, so the
 * guarded region matches the plugin file exactly.
 */
export * from "./reconnect-policy";
export * from "./lock-decision";
export * from "./format-guard";
export * from "./software";
export * from "./wire";
export * from "./dedupe";
export * from "./cursor";
export * from "./control-chars";
export * from "./feed";
export * from "./tail-render";
export * from "./tail-state";
/**
 * auth/core's public surface — the future `@bridge/agent-sdk` entry point. Encoding
 * helpers (base64url, raw JWS signing) stay internal: every signature goes through a
 * purpose-built function (proof, assertion), never an arbitrary JWS.
 */
export { type Signer, type KeyStorage, softwareSigner, generateSoftwareKey } from "./signer";
export { type Deadline, deadline } from "./deadline";
export { type EcPublicJwk, type EcPrivateJwk, isP256PublicJwk, isP256PrivateJwk, jwkThumbprint } from "./jwk";
export { type ProofInput, dpopProof, wsHtu, httpHtu, apiOrigin, normalizeHtu } from "./dpop";
export { clientAssertion, CLIENT_ASSERTION_TYPE, ASSERTION_TTL_S } from "./assertion";
export { Clock, MAX_CLOCK_OFFSET_MS } from "./clock";
export { isJoinState, joinStateSeq } from "./join-state";
export { type TokenAction, type InstallationGoneReason, type OAuthErrorInit, OAuthError, isOAuthError, TransportError, DiscoveryError, AbortedError, GONE_REASONS, classifyTokenError, assertNever, } from "./token-errors";
export { type AuthMetadata, type EnrolGrant, type MintGrant, type MintInput, type RevokeInput, type CallOpts, type DeviceAuthorization, type TokenClientOptions, type FetchLike, TokenClient, supportsKeyCredentials, isKeyAlreadyEnrolled, METADATA_TTL_MS, MINT_BUDGET_MS, MINT_TIMEOUT_MS, } from "./protocol";
