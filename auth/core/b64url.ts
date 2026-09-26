/**
 * base64url without padding (RFC 7515 §2) and the hashes built on it.
 *
 * PURE: WebCrypto + TextEncoder + atob/btoa only — no Node `Buffer`, no Bun API —
 * so `auth/core/` can move into `@bridge/agent-sdk` unchanged (RFC-016 §5).
 */
export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlJson(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomB64url(nBytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(nBytes)));
}

export async function sha256B64url(text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}
