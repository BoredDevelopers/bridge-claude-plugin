/**
 * Shared RFC-014 agent-auth routes for test stubs that run their OWN Bun.serve
 * app (WS + a handful of REST endpoints) and only need a WORKING plugin
 * credential, not to exercise the auth protocol itself — that is what
 * agent-auth-stub.ts (strict, reuse-is-revocation) is for.
 *
 * A stub calls `handle(req)` FIRST in its own `fetch`; a non-null Response is
 * agent-auth's to answer, `null` means "not an agent-auth route, handle it
 * yourself". Since the static BRIDGE_TOKEN is retired (RFC-014 slice 5b), every
 * stub that spawns server.ts now needs this — the plugin enrols for real via
 * BRIDGE_ENROLMENT_KEY before it can open a socket.
 */
export interface AgentAuthRoutesOptions {
  /** What a newly-enrolled installation claims to act as. */
  agentId?: string;
  accessTtlS?: number;
}

export interface AgentAuthRoutes {
  /** Call first in a stub's fetch handler; a non-null Response is already final. */
  handle(req: Request): Promise<Response | null>;
  /** A key `enrolFromKeyIfNeeded()` can redeem — call before spawning the plugin. */
  addEnrolmentKey(key: string, uses?: number): void;
}

export function createAgentAuthRoutes(opts: AgentAuthRoutesOptions = {}): AgentAuthRoutes {
  const accessTtlS = opts.accessTtlS ?? 3600;
  const agentId = opts.agentId ?? "agent-1";
  const enrolmentKeys = new Map<string, number>(); // key -> uses left
  const installations = new Set<string>(); // live installation ids
  const instTokenOwner = new Map<string, string>(); // installation_token -> installation id
  const sessionInstallation = new Map<string, string>(); // session id -> installation id
  const refreshTokenOwner = new Map<string, string>(); // refresh_token -> session id
  const access = new Map<string, { session: string; exp: number }>();

  let n = 0;
  const mint = (kind: string) => `brg_${kind}_${(++n).toString().padStart(6, "0")}${crypto.randomUUID().replace(/-/g, "")}`;

  function newInstallation() {
    const id = crypto.randomUUID();
    installations.add(id);
    const it = mint("it");
    instTokenOwner.set(it, id);
    return {
      installation_token: it,
      installation_id: id,
      agent: { id: agentId, handle: "agent-one", name: "Agent One" },
      workspace: { id: "t1", name: "Acme" },
    };
  }

  function issueAccess(sessionId: string): string {
    const at = mint("at");
    access.set(at, { session: sessionId, exp: Date.now() + accessTtlS * 1000 });
    return at;
  }

  function startSession(installationId: string) {
    const sid = crypto.randomUUID();
    sessionInstallation.set(sid, installationId);
    const it = mint("it");
    instTokenOwner.set(it, installationId);
    const rt = mint("rt");
    refreshTokenOwner.set(rt, sid);
    return {
      installation_token: it,
      refresh_token: rt,
      access_token: issueAccess(sid),
      token_type: "Bearer",
      expires_in: accessTtlS,
      session_id: sid,
    };
  }

  const err = (error: string, status = 400) => Response.json({ error }, { status });

  return {
    addEnrolmentKey(key, uses = 1) {
      enrolmentKeys.set(key, uses);
    },
    async handle(req) {
      const url = new URL(req.url);
      const issuer = `${url.origin}/api/agent-auth`;
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server/api/agent-auth") {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          device_authorization_endpoint: `${issuer}/device_authorization`,
          token_endpoint: `${issuer}/token`,
          revocation_endpoint: `${issuer}/revoke`,
        });
      }
      if (req.method !== "POST" || url.pathname !== "/api/agent-auth/token") return null;
      const body = (await req.json().catch(() => ({}))) as any;
      switch (body.grant_type) {
        case "urn:bridge:params:oauth:grant-type:enrolment-key": {
          const left = enrolmentKeys.get(body.enrolment_key) ?? 0;
          if (left <= 0) return err("invalid_grant");
          enrolmentKeys.set(body.enrolment_key, left - 1);
          return Response.json(newInstallation());
        }
        case "urn:bridge:params:oauth:grant-type:session": {
          const instId = instTokenOwner.get(body.installation_token);
          if (!instId || !installations.has(instId)) return err("invalid_grant");
          instTokenOwner.delete(body.installation_token);
          return Response.json(startSession(instId));
        }
        case "refresh_token": {
          const sid = refreshTokenOwner.get(body.refresh_token);
          if (!sid) return err("invalid_grant");
          refreshTokenOwner.delete(body.refresh_token);
          const rt = mint("rt");
          refreshTokenOwner.set(rt, sid);
          return Response.json({ refresh_token: rt, access_token: issueAccess(sid), token_type: "Bearer", expires_in: accessTtlS });
        }
        default:
          return err("unsupported_grant_type");
      }
    },
  };
}
