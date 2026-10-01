export interface EcPublicJwk {
    kty: "EC";
    crv: "P-256";
    x: string;
    y: string;
}
export interface EcPrivateJwk extends EcPublicJwk {
    d: string;
}
export declare function isP256PublicJwk(j: unknown): j is EcPublicJwk;
export declare function isP256PrivateJwk(j: unknown): j is EcPrivateJwk;
/** Only the public members — never let `d` ride into a header by spreading a private JWK. */
export declare function publicPart(j: EcPublicJwk): EcPublicJwk;
/**
 * RFC 7638 §3: SHA-256 over the REQUIRED members in lexicographic order —
 * `{"crv","kty","x","y"}` for EC — with no whitespace, base64url.
 * (JSON.stringify keeps insertion order, so the literal below IS the canonical form.)
 */
export declare function jwkThumbprint(j: EcPublicJwk): Promise<string>;
