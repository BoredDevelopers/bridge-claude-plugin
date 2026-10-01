/**
 * SOURCE: Claude Code plugin `claude-channel-bridge` 0.26.2 (commit c8b0db6),
 * `auth/core/signer.ts`. BYTE-IDENTICAL below the marker — RFC-018 D1/D10: the
 * plugin's auth/core files "move into @bridge/agent-sdk unchanged", and until the
 * plugin re-platforms onto this package (S5) the two copies are kept identical by
 * `test/byte-identity.test.ts` against the pinned original in
 * `fixtures/plugin-core/signer.ts`.
 */
/**
 * The only thing that ever touches key material (RFC-016 E10). Everything else
 * — assertions, DPoP proofs, enrolment — signs through `Signer`, never raw key
 * bytes, so a Secure Enclave / TPM backend later is a new `Signer`, not a
 * protocol change. `keyStorage` is what the client declares at enrolment.
 */
import { type EcPrivateJwk, type EcPublicJwk } from "./jwk";
export type KeyStorage = "software" | "hardware";
export interface Signer {
    readonly alg: "ES256";
    readonly keyStorage: KeyStorage;
    readonly publicJwk: EcPublicJwk;
    /** RFC 7638 thumbprint of `publicJwk` — the server's `jkt`. */
    readonly jkt: string;
    /** ES256 over `data`: raw IEEE P1363 r‖s, exactly 64 bytes (never DER). */
    sign(data: Uint8Array): Promise<Uint8Array>;
}
/** A software key loaded from `key.json`. Imported NON-extractable: nothing can read `d` back out of it. */
export declare function softwareSigner(jwk: EcPrivateJwk): Promise<Signer>;
/** A fresh key per enrolment (E1: never reused). The caller persists `privateJwk` 0600. */
export declare function generateSoftwareKey(): Promise<{
    privateJwk: EcPrivateJwk;
    signer: Signer;
}>;
