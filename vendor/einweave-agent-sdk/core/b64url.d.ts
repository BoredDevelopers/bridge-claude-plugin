/**
 * SOURCE: Claude Code plugin `claude-channel-bridge` 0.26.2 (commit c8b0db6),
 * `auth/core/b64url.ts`. Extracted unchanged from the plugin (RFC-018 D1/D10: "move into
 * @einweave/agent-sdk unchanged"); provenance only — this package owns the code now, and the
 * byte-identity guard against the plugin copy was retired in RFC-028 A3b.
 */
/**
 * base64url without padding (RFC 7515 §2) and the hashes built on it.
 *
 * PURE: WebCrypto + TextEncoder + atob/btoa only — no Node `Buffer`, no Bun API —
 * so `auth/core/` can move into `@einweave/agent-sdk` unchanged (RFC-016 §5).
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
