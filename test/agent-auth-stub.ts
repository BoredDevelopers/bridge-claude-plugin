/**
 * A stub of Bridge's agent authorization server + just enough API/WS for the plugin
 * (RFC-014). STRICTER than the real server on purpose: no 30 s grace — presenting
 * any already-consumed installation or refresh token is REUSE, which revokes the
 * grant and is counted. A client that ever re-presents a rotated token fails loudly.
 */
export interface StubOptions {
  accessTtlS?: number;
  /** Device polls answered `authorization_pending` before success. */
  devicePending?: number;
  /** `/authorize` answers with `error=access_denied`. */
  deny?: boolean;
  agentId?: string;
  /** The first N discovery requests answer 502 (a deploy in progress). */
  discoveryFail?: number;
  /** Delay the authorization_code exchange (ms). */
  codeDelayMs?: number;
  /** Delay the session grant (ms). */
  sessionDelayMs?: number;
  /** Every /api/* request answers 401. */
  always401?: boolean;
}

type Inst = { id: string; revoked: boolean; agentId: string };
type Sess = { id: string; instId: string; key: string; revoked: boolean };

export function startAuthStub(opts: StubOptions = {}) {
  const accessTtlS = opts.accessTtlS ?? 3600;
  const insts = new Map<string, Inst>();
  const sessions = new Map<string, Sess>();
  const chain = new Map<string, { kind: "it" | "rt"; grant: string; consumed: boolean }>();
  const access = new Map<string, { session: string; exp: number }>();
  const codes = new Map<string, { challenge: string; redirect: string; used: boolean }>();
  const devices = new Map<string, { polls: number }>();
  const enrolmentKeys = new Map<string, number>(); // key -> uses left
  const stats = {
    sessionGrants: 0,
    refreshes: 0,
    enrols: 0,
    reuse: 0,
    revoked: [] as string[],
    sessionMeta: [] as { platform?: string; client_version?: string }[],
    authTokens: [] as string[],
    reauths: 0,
    discoveryHits: 0,
    apiHits: 0,
  };
  let n = 0;
  const mint = (k: string) => `brg_${k}_${(++n).toString().padStart(6, "0")}${crypto.randomUUID().replace(/-/g, "")}`;
  const sockets = new Set<any>();

  function newInstallation(agentId: string) {
    const id = crypto.randomUUID();
    insts.set(id, { id, revoked: false, agentId });
    const it = mint("it");
    chain.set(it, { kind: "it", grant: id, consumed: false });
    return { installation_token: it, installation_id: id };
  }

  function liveSession(sid: string) {
    const s = sessions.get(sid);
    return !!s && !s.revoked && !insts.get(s.instId)?.revoked;
  }

  function accessOk(tok: string | undefined | null) {
    if (!tok) return null;
    const a = access.get(tok);
    if (!a || a.exp < Date.now() || !liveSession(a.session)) return null;
    return a;
  }

  function closeGrant(grant: string, reason: string) {
    for (const ws of sockets) {
      const s = sessions.get(ws.data.session);
      if (s && (s.id === grant || s.instId === grant)) ws.close(4008, reason);
    }
  }

  const err = (error: string, status = 400) => Response.json({ error }, { status });

  function consume(tok: unknown, kind: "it" | "rt"): { error: "invalid_grant" } | { grant: string } {
    const c = typeof tok === "string" ? chain.get(tok) : undefined;
    if (!c || c.kind !== kind) return { error: "invalid_grant" };
    if (c.consumed) {
      stats.reuse++;
      if (kind === "it") insts.get(c.grant)!.revoked = true;
      else sessions.get(c.grant)!.revoked = true;
      return { error: "invalid_grant" };
    }
    c.consumed = true;
    return { grant: c.grant };
  }

  function issueAccess(session: string) {
    const at = mint("at");
    access.set(at, { session, exp: Date.now() + accessTtlS * 1000 });
    return at;
  }

  const server = Bun.serve<{ session: string }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const issuer = `${url.origin}/api/agent-auth`;
      if (url.pathname === "/ws" && srv.upgrade(req, { data: { session: "" } })) return;
      if (url.pathname === "/.well-known/oauth-authorization-server/api/agent-auth") {
        if (stats.discoveryHits++ < (opts.discoveryFail ?? 0)) return new Response("bad gateway", { status: 502 });
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          device_authorization_endpoint: `${issuer}/device_authorization`,
          token_endpoint: `${issuer}/token`,
          revocation_endpoint: `${issuer}/revoke`,
          bridge_connect_done_uri: `${url.origin}/connect/done`,
        });
      }
      if (url.pathname === "/api/agent-auth/authorize") {
        const q = url.searchParams;
        const redirect = q.get("redirect_uri")!;
        const back = new URL(redirect);
        back.searchParams.set("state", q.get("state")!);
        back.searchParams.set("iss", issuer);
        if (opts.deny) back.searchParams.set("error", "access_denied");
        else {
          const code = mint("ac");
          codes.set(code, { challenge: q.get("code_challenge")!, redirect, used: false });
          back.searchParams.set("code", code);
        }
        return Response.redirect(back.toString(), 302);
      }
      const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as any) : {};
      if (url.pathname === "/api/agent-auth/token") {
        switch (body.grant_type) {
          case "urn:bridge:params:oauth:grant-type:enrolment-key": {
            const left = enrolmentKeys.get(body.enrolment_key) ?? 0;
            if (left <= 0) return err("invalid_grant");
            enrolmentKeys.set(body.enrolment_key, left - 1);
            stats.enrols++;
            return Response.json(newInstallation(opts.agentId ?? "agent-1"));
          }
          case "urn:bridge:params:oauth:grant-type:session": {
            if (opts.sessionDelayMs) await Bun.sleep(opts.sessionDelayMs);
            const c = consume(body.installation_token, "it");
            if ("error" in c) return err(c.error);
            const inst = insts.get(c.grant)!;
            if (inst.revoked) return err("invalid_grant");
            stats.sessionGrants++;
            stats.sessionMeta.push({ platform: body.platform, client_version: body.client_version });
            for (const s of sessions.values()) if (s.instId === inst.id && s.key === body.session_key) s.revoked = true;
            const sid = crypto.randomUUID();
            sessions.set(sid, { id: sid, instId: inst.id, key: body.session_key, revoked: false });
            const it = mint("it");
            chain.set(it, { kind: "it", grant: inst.id, consumed: false });
            const rt = mint("rt");
            chain.set(rt, { kind: "rt", grant: sid, consumed: false });
            return Response.json({
              installation_token: it,
              refresh_token: rt,
              access_token: issueAccess(sid),
              token_type: "Bearer",
              expires_in: accessTtlS,
              session_id: sid,
            });
          }
          case "refresh_token": {
            const c = consume(body.refresh_token, "rt");
            if ("error" in c) return err(c.error);
            if (!liveSession(c.grant)) return err("invalid_grant");
            stats.refreshes++;
            const rt = mint("rt");
            chain.set(rt, { kind: "rt", grant: c.grant, consumed: false });
            return Response.json({ refresh_token: rt, access_token: issueAccess(c.grant), token_type: "Bearer", expires_in: accessTtlS });
          }
          case "authorization_code": {
            if (opts.codeDelayMs) await Bun.sleep(opts.codeDelayMs);
            const c = codes.get(body.code);
            if (!c || c.used || c.redirect !== body.redirect_uri || body.client_id !== "bridge-claude-plugin") return err("invalid_grant");
            const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier)));
            const want = Buffer.from(digest).toString("base64url");
            if (want !== c.challenge) return err("invalid_grant");
            c.used = true;
            return Response.json(newInstallation(opts.agentId ?? "agent-1"));
          }
          case "urn:ietf:params:oauth:grant-type:device_code": {
            const d = devices.get(body.device_code);
            if (!d) return err("invalid_grant");
            if (d.polls++ < (opts.devicePending ?? 0)) return err("authorization_pending");
            devices.delete(body.device_code);
            return Response.json(newInstallation(opts.agentId ?? "agent-1"));
          }
        }
        return err("unsupported_grant_type");
      }
      if (url.pathname === "/api/agent-auth/device_authorization") {
        const dc = mint("dc");
        devices.set(dc, { polls: 0 });
        return Response.json({
          device_code: dc,
          user_code: "BCDF-GHJK",
          verification_uri: `${url.origin}/connect`,
          expires_in: 600,
          interval: 1,
        });
      }
      if (url.pathname === "/api/agent-auth/revoke") {
        const c = chain.get(body.token);
        if (c) {
          stats.revoked.push(c.grant);
          if (c.kind === "it") {
            insts.get(c.grant)!.revoked = true;
            closeGrant(c.grant, "installation revoked");
          } else {
            sessions.get(c.grant)!.revoked = true;
            closeGrant(c.grant, "session revoked");
          }
        }
        return Response.json({});
      }
      if (url.pathname.startsWith("/api/")) {
        stats.apiHits++;
        const tok = req.headers.get("authorization")?.replace(/^Bearer /, "");
        if (opts.always401 || !accessOk(tok)) return err("unauthorized", 401);
        return Response.json([]);
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws: any) {
        sockets.add(ws);
      },
      close(ws: any) {
        sockets.delete(ws);
      },
      message(ws: any, raw) {
        let f: any = {};
        try {
          f = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (f.type === "auth") {
          stats.authTokens.push(f.token);
          const a = accessOk(f.token);
          if (!a) return ws.close(4001, "Invalid token");
          ws.data.session = a.session;
          const s = sessions.get(a.session)!;
          ws.send(JSON.stringify({ type: "authenticated", data: { agentId: "agent-1", agentName: "Agent", contextId: s.key } }));
        } else if (f.type === "reauth") {
          const a = accessOk(f.token);
          if (!a) return ws.close(4001, "Invalid token");
          stats.reauths++;
          ws.data.session = a.session;
          ws.send(JSON.stringify({ type: "reauthenticated", data: { expiresAt: a.exp } }));
        }
      },
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    issuer: `http://127.0.0.1:${server.port}/api/agent-auth`,
    stats,
    addEnrolmentKey(key: string, uses = 1) {
      enrolmentKeys.set(key, uses);
    },
    /** Enrol directly (as if a key or browser login had happened). */
    enrol: () => newInstallation(opts.agentId ?? "agent-1"),
    isRevoked: (instId: string) => insts.get(instId)?.revoked ?? false,
    revokeInstallation(instId: string) {
      insts.get(instId)!.revoked = true;
      closeGrant(instId, "installation revoked");
    },
    revokeSession(sid: string) {
      sessions.get(sid)!.revoked = true;
      closeGrant(sid, "session revoked");
    },
    /** Close every live socket with `code` / `reason`. */
    closeAll(code: number, reason: string) {
      for (const ws of sockets) ws.close(code, reason);
    },
    liveSockets: () => sockets.size,
    /** Server-side death of every access token (the client still thinks them valid). */
    expireAccess: () => access.clear(),
    sessionsFor: (instId: string) => [...sessions.values()].filter((s) => s.instId === instId),
    stop: () => server.stop(true),
  };
}
