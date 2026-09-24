/**
 * The agent authorization server's client side (RFC-014 §4.3–4.4, §6): discovery,
 * the token endpoint's grants, and RFC 7009 revocation. Pure HTTP — no files, no
 * locks; the credential manager owns those.
 */
export const CLIENT_ID = "bridge-claude-plugin";
export const GRANT_ENROLMENT_KEY = "urn:bridge:params:oauth:grant-type:enrolment-key";
export const GRANT_SESSION = "urn:bridge:params:oauth:grant-type:session";
export const GRANT_DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";

// Well inside the server's 30 s refresh grace: a lost response retried after one
// timeout must still be answered as a replay, not treated as reuse.
const TIMEOUT_MS = 10_000;

export interface AuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  device_authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  bridge_connect_done_uri?: string;
}

/** An RFC 6749 §5.2 error from the token endpoint (`invalid_grant`, `slow_down`, …). */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly status: number,
    readonly retryAfterS?: number
  ) {
    super(`agent-auth: ${error} (${status})`);
  }
}

const metadataCache = new Map<string, Promise<AuthMetadata>>();

/** RFC 8414 discovery; cached per API URL for the process (a failure is not cached). */
export function discover(apiUrl: string): Promise<AuthMetadata> {
  let p = metadataCache.get(apiUrl);
  if (!p) {
    p = (async () => {
      const res = await fetch(`${apiUrl}/.well-known/oauth-authorization-server/api/agent-auth`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Bridge agent-auth discovery failed (${res.status}) — is ${apiUrl} a Bridge API?`);
      const m = (await res.json()) as AuthMetadata;
      if (!m.token_endpoint || !m.issuer) throw new Error("Bridge agent-auth discovery returned no token endpoint");
      return m;
    })();
    metadataCache.set(apiUrl, p);
    p.catch(() => metadataCache.delete(apiUrl));
  }
  return p;
}

async function post(url: string, body: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    const retry = Number(res.headers.get("retry-after")) || undefined;
    throw new OAuthError(typeof json?.error === "string" ? json.error : `http_${res.status}`, res.status, retry);
  }
  return json;
}

export interface SessionGrant {
  installation_token: string;
  refresh_token: string;
  access_token: string;
  expires_in: number;
  session_id: string;
}

export interface RefreshGrant {
  refresh_token: string;
  access_token: string;
  expires_in: number;
}

export interface InstallationGrant {
  installation_token: string;
  installation_id: string;
}

export const token = {
  enrol: (m: AuthMetadata, enrolmentKey: string, installationName: string): Promise<InstallationGrant> =>
    post(m.token_endpoint, { grant_type: GRANT_ENROLMENT_KEY, enrolment_key: enrolmentKey, installation_name: installationName }),
  session: (
    m: AuthMetadata,
    installationToken: string,
    sessionKey: string,
    meta: { platform: string; clientVersion: string }
  ): Promise<SessionGrant> =>
    post(m.token_endpoint, {
      grant_type: GRANT_SESSION,
      installation_token: installationToken,
      session_key: sessionKey,
      platform: meta.platform,
      client_version: meta.clientVersion,
    }),
  refresh: (m: AuthMetadata, refreshToken: string): Promise<RefreshGrant> =>
    post(m.token_endpoint, { grant_type: "refresh_token", refresh_token: refreshToken }),
  authorizationCode: (m: AuthMetadata, code: string, verifier: string, redirectUri: string): Promise<InstallationGrant> =>
    post(m.token_endpoint, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
    }),
  deviceCode: (m: AuthMetadata, deviceCode: string): Promise<InstallationGrant> =>
    post(m.token_endpoint, { grant_type: GRANT_DEVICE_CODE, device_code: deviceCode, client_id: CLIENT_ID }),
};

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export function deviceAuthorization(m: AuthMetadata, installationName: string): Promise<DeviceAuthorization> {
  return post(m.device_authorization_endpoint, { client_id: CLIENT_ID, installation_name: installationName });
}

/** RFC 7009. The server always answers 200; a network failure throws. */
export async function revoke(m: AuthMetadata, tokenValue: string): Promise<void> {
  await post(m.revocation_endpoint, { token: tokenValue });
}
