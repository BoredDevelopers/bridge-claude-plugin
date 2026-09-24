/**
 * Loopback + PKCE authorization (RFC 8252, RFC 7636, RFC 9207) — the plugin half.
 *
 * The listener binds 127.0.0.1 on an ephemeral port for exactly one answer:
 * - only `GET /callback`, only with `Host: 127.0.0.1:<port>` (a DNS-rebinding page
 *   reaches us under its own hostname), only with our `state` and the issuer we
 *   discovered (`iss`, RFC 9207 — a mix-up defence);
 * - it holds that one response open while the code is exchanged, then 302s the
 *   browser to Bridge's hosted `/connect/done?result=…` — this process never renders
 *   a page of its own;
 * - it closes after the answer or after `timeoutMs`.
 */
import type { AuthMetadata } from "./oauth";
import { CLIENT_ID } from "./oauth";

export type LoopbackAnswer = { code: string } | { error: string };

/** Longest the browser's callback request is held open waiting for the outcome. */
const HOLD_MS = 120_000;

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

export interface LoopbackLogin {
  /** Where to send the person's browser. */
  authorizeUrl: string;
  redirectUri: string;
  verifier: string;
  /** Resolves with the callback's answer (or `{error:"timeout"}`). */
  answer: Promise<LoopbackAnswer>;
  /** Finish the held browser response with the outcome, and close the listener. */
  finish(result: "connected" | "denied" | "error"): void;
  close(): void;
}

export async function startLoopback(
  meta: AuthMetadata,
  installationName: string,
  opts: { timeoutMs?: number; doneUri?: string } = {}
): Promise<LoopbackLogin> {
  const { verifier, challenge } = await pkcePair();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const doneUri = opts.doneUri ?? meta.bridge_connect_done_uri;

  let settle!: (a: LoopbackAnswer) => void;
  const answer = new Promise<LoopbackAnswer>((r) => (settle = r));
  let answered = false;
  let finished = false;
  // The outcome every held browser response waits for (a reload or prefetch of the
  // callback gets the same answer as the first hit, not a misleading "error").
  let settleOutcome!: (r: "connected" | "denied" | "error") => void;
  const outcome = new Promise<"connected" | "denied" | "error">((r) => (settleOutcome = r));
  const held = () => outcome.then((r) => doneResponse(r));

  const doneResponse = (result: string) =>
    doneUri
      ? Response.redirect(`${doneUri}?result=${result}`, 302)
      : new Response(result === "connected" ? "Machine connected. You can now close the tab/window and return to your terminal." : `Sign-in ${result}.`, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // Bun's default 10 s idle timeout would cut the held response while the code is
    // exchanged and the profile lock is waited for; the hold is bounded below instead.
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "GET" || url.pathname !== "/callback") return new Response("Not found", { status: 404 });
      if (req.headers.get("host") !== `127.0.0.1:${server.port}`) return new Response("Forbidden", { status: 403 });
      if (url.searchParams.get("state") !== state) return new Response("Bad request", { status: 400 });
      if (answered) return held();
      const iss = url.searchParams.get("iss");
      // RFC 9207: a server that advertises the parameter must send it; a different
      // issuer means the code came from somewhere else.
      if (iss !== meta.issuer) {
        answered = true;
        settle({ error: "issuer_mismatch" });
        return doneResponse("error");
      }
      answered = true;
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      settle(err ? { error: err } : code ? { code } : { error: "invalid_response" });
      // Hold the browser until the caller has exchanged the code and knows the
      // outcome — never forever.
      setTimeout(() => settleOutcome("error"), HOLD_MS).unref?.();
      return held();
    },
  });

  const redirectUri = `http://127.0.0.1:${server.port}/callback`;
  const authorize = new URL(meta.authorization_endpoint);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    installation_name: installationName,
  }).toString();

  const close = () => {
    clearTimeout(timer);
    // Let a held response flush before the socket goes.
    setTimeout(() => server.stop(true), 250).unref?.();
  };
  const timer = setTimeout(() => {
    if (!answered) {
      answered = true;
      settle({ error: "timeout" });
    }
    close();
  }, opts.timeoutMs ?? 10 * 60_000);
  timer.unref?.();

  return {
    authorizeUrl: authorize.toString(),
    redirectUri,
    verifier,
    answer,
    finish(result) {
      if (finished) return;
      finished = true;
      settleOutcome(result);
      close();
    },
    close() {
      if (!answered) {
        answered = true;
        settle({ error: "cancelled" });
      }
      settleOutcome("error");
      close();
    },
  };
}
