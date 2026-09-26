/** auth/core's public surface — what `@bridge/agent-sdk` will export. Encoding helpers stay internal. */
import { test, expect } from "bun:test";
import * as core from "../auth/core";

test("the barrel exports the public surface and nothing internal", () => {
  const exported = Object.keys(core).sort();
  for (const name of [
    "softwareSigner",
    "generateSoftwareKey",
    "jwkThumbprint",
    "dpopProof",
    "wsHtu",
    "httpHtu",
    "apiOrigin",
    "TokenClient",
    "DiscoveryError",
    "AbortedError",
    "normalizeHtu",
    "clientAssertion",
    "CLIENT_ASSERTION_TYPE",
    "Clock",
    "isJoinState",
    "joinStateSeq",
    "classifyTokenError",
    "OAuthError",
    "isOAuthError",
    "TransportError",
    "assertNever",
  ]) {
    expect(exported).toContain(name);
  }
  for (const internal of ["b64url", "b64urlDecode", "b64urlJson", "randomB64url", "sha256B64url", "signJwt", "newJti"]) {
    expect(exported).not.toContain(internal);
  }
});
