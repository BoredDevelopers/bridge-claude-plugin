/**
 * Small pure-ish pieces of sign-in: headless detection, and the SDK core's discovery
 * checks the plugin relies on before it opens a loopback login.
 */
import { describe, test, expect } from "bun:test";
import { isHeadless } from "../auth/browser";
import { TokenClient, Clock, supportsKeyCredentials, type AuthMetadata } from "../vendor/bridge-agent-sdk/core/index.js";

describe("headless detection", () => {
  test("SSH and CI are headless everywhere; Linux needs a display; macOS is not", () => {
    expect(isHeadless({ SSH_CONNECTION: "a" }, "darwin")).toBe(true);
    expect(isHeadless({ CI: "true" }, "darwin")).toBe(true);
    expect(isHeadless({}, "darwin")).toBe(false);
    expect(isHeadless({}, "linux")).toBe(true);
    expect(isHeadless({ DISPLAY: ":0" }, "linux")).toBe(false);
    expect(isHeadless({ WAYLAND_DISPLAY: "w" }, "linux")).toBe(false);
    expect(isHeadless({ WSL_DISTRO_NAME: "Ubuntu" }, "linux")).toBe(false);
  });
});

describe("discovery", () => {
  test("a pre-RFC-016 server (no client_credentials) is recognised", () => {
    const m = { grant_types_supported: ["authorization_code", "refresh_token"] } as AuthMetadata;
    expect(supportsKeyCredentials(m)).toBe(false);
    expect(supportsKeyCredentials({ ...m, grant_types_supported: ["client_credentials"] })).toBe(true);
    expect(supportsKeyCredentials({} as AuthMetadata)).toBe(false);
  });
});

describe("discovery authority (RFC 8414 §3.3)", () => {
  const api = "https://bridge-api.example.test";
  const meta = (over: Partial<AuthMetadata> = {}): AuthMetadata => ({
    issuer: `${api}/api/agent-auth`,
    authorization_endpoint: `${api}/api/agent-auth/authorize`,
    device_authorization_endpoint: `${api}/api/agent-auth/device_authorization`,
    token_endpoint: `${api}/api/agent-auth/token`,
    revocation_endpoint: `${api}/api/agent-auth/revoke`,
    bridge_connect_done_uri: "https://bridge-web.example.test/connect/done",
    ...over,
  });

  /** The discovery the login uses (auth/login.ts), answering `doc` — the authority check runs inside it. */
  const discover = (url: string, doc: AuthMetadata) =>
    new TokenClient({ clock: new Clock(), clientId: "t", fetch: (async () => Response.json(doc)) as never }).discover(url);

  test("the API's own document is accepted (a trailing slash on the URL too; the web done-URI may differ)", async () => {
    await expect(discover(api, meta())).resolves.toBeDefined();
    await expect(discover(`${api}/`, meta())).resolves.toBeDefined();
  });

  test("a different issuer is refused", async () => {
    await expect(discover(api, meta({ issuer: "https://evil.example.test/api/agent-auth" }))).rejects.toThrow(/issuer/);
  });

  test("a credential endpoint on another origin is refused, even with the right issuer", async () => {
    await expect(discover(api, meta({ token_endpoint: "https://evil.example.test/token" }))).rejects.toThrow(/token_endpoint/);
    await expect(discover(api, meta({ revocation_endpoint: "http://bridge-api.example.test/revoke" }))).rejects.toThrow(/revocation_endpoint/);
  });
});
