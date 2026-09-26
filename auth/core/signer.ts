/**
 * The only thing that ever touches key material (RFC-016 E10). Everything else
 * — assertions, DPoP proofs, enrolment — signs through `Signer`, never raw key
 * bytes, so a Secure Enclave / TPM backend later is a new `Signer`, not a
 * protocol change. `keyStorage` is what the client declares at enrolment.
 */
import { isP256PrivateJwk, jwkThumbprint, publicPart, type EcPrivateJwk, type EcPublicJwk } from "./jwk";

export type KeyStorage = "software" | "hardware";

export interface Signer {
  readonly alg: "ES256";
  readonly keyStorage: KeyStorage;
  readonly publicJwk: EcPublicJwk;
  /** RFC 7638 thumbprint of `publicJwk` — the server's `jkt`. */
  readonly jkt: string;
  /** ES256 over `data`: raw IEEE P1363 r‖s, exactly 64 bytes (never DER). */
  sign(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
}

const KEY_ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_ALG = { name: "ECDSA", hash: "SHA-256" } as const;

/** A software key loaded from `key.json`. Imported NON-extractable: nothing can read `d` back out of it. */
export async function softwareSigner(jwk: EcPrivateJwk): Promise<Signer> {
  if (!isP256PrivateJwk(jwk)) throw new Error("not a P-256 private JWK");
  const key = await crypto.subtle.importKey("jwk", { ...publicPart(jwk), d: jwk.d }, KEY_ALG, false, ["sign"]);
  const publicJwk = publicPart(jwk);
  return {
    alg: "ES256",
    keyStorage: "software",
    publicJwk,
    jkt: await jwkThumbprint(publicJwk),
    async sign(data) {
      const sig = new Uint8Array(await crypto.subtle.sign(SIGN_ALG, key, data));
      if (sig.length !== 64) throw new Error(`ES256 signature must be 64 bytes r||s, got ${sig.length}`);
      return sig;
    },
  };
}

/** A fresh key per enrolment (E1: never reused). The caller persists `privateJwk` 0600. */
export async function generateSoftwareKey(): Promise<{ privateJwk: EcPrivateJwk; signer: Signer }> {
  const kp = await crypto.subtle.generateKey(KEY_ALG, true, ["sign", "verify"]);
  const j = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as { x?: string; y?: string; d?: string };
  const privateJwk: EcPrivateJwk = { kty: "EC", crv: "P-256", x: j.x!, y: j.y!, d: j.d! };
  return { privateJwk, signer: await softwareSigner(privateJwk) };
}
