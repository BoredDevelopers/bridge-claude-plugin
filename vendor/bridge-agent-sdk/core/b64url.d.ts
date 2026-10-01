/**
 * SOURCE: Claude Code plugin `claude-channel-bridge` 0.26.2 (commit c8b0db6),
 * `auth/core/b64url.ts`. BYTE-IDENTICAL below the marker — RFC-018 D1/D10: the
 * plugin's auth/core files "move into @bridge/agent-sdk unchanged", and until the
 * plugin re-platforms onto this package (S5) the two copies are kept identical by
 * `test/byte-identity.test.ts` against the pinned original in
 * `fixtures/plugin-core/b64url.ts`.
 */
/**
 * base64url without padding (RFC 7515 §2) and the hashes built on it.
 *
 * PURE: WebCrypto + TextEncoder + atob/btoa only — no Node `Buffer`, no Bun API —
 * so `auth/core/` can move into `@bridge/agent-sdk` unchanged (RFC-016 §5).
 */
export declare function b64url(bytes: Uint8Array): string;
export declare function b64urlJson(value: unknown): string;
/** Input that is not unpadded base64url (wrong alphabet, padding, or an impossible length). */
export declare class B64urlError extends Error {
    readonly name = "B64urlError";
}
export declare function b64urlDecode(s: string): Uint8Array<ArrayBuffer>;
export declare function randomB64url(nBytes: number): string;
export declare function sha256B64url(text: string): Promise<string>;
