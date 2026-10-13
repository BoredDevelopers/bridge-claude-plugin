/**
 * What `status` says about delivery (RFC-027 D7): did the entries this session was
 * handed actually reach the model? Pure — server.ts gathers the inputs.
 *
 * - idle: nothing pushed in this process yet.
 * - unconfirmed: the hooks report, and entries the host had its chance to deliver are
 *   still unconfirmed — the session runs without channels (a restart fixes it).
 * - confirmed: a hook confirmed at least one entry, and none is missed.
 * - hooks not reporting: no control socket (no Claude pid), or none of this session's
 *   prompts reached it — confirmation is impossible; read tools still return everything.
 * - awaiting confirmation: pushed, hooks report, nothing confirmed or missed yet.
 */
export type DeliveryState = "idle" | "unconfirmed" | "confirmed" | "hooks not reporting" | "awaiting confirmation";

export const CHANNELS_LAUNCH = "claude --dangerously-load-development-channels plugin:einweave@einweave-marketplace";

export interface DeliveryInputs {
  /** The control socket is open. */
  ctl: boolean;
  /** Why it is not, when Claude Code's pid IS known; absent = the pid was not found. */
  ctlProblem?: { kind: "served-elsewhere" | "unsafe-dir" | "failed"; detail: string };
  /** Entries pushed to the host in this process. */
  pushed: number;
  /** Pushed entries a prompt found missed, still pending. */
  missed: number;
  /** Entries a hook confirmed in this process. */
  confirmed: number;
  /** Last time a hook reached the control socket. */
  lastHookAt: number | null;
}

export function deliveryState(i: DeliveryInputs): { state: DeliveryState; hint?: string } {
  if (!i.ctl && i.ctlProblem) {
    const p = i.ctlProblem;
    const why =
      p.kind === "served-elsewhere"
        ? `the control socket is served by another process (a second copy of the plugin in this Claude Code, or one still exiting) — its hooks report there, not here`
        : p.kind === "unsafe-dir"
          ? `the control socket's directory is not safe (${p.detail})`
          : `the control socket could not be opened (${p.detail})`;
    return { state: "hooks not reporting", hint: `${why} — delivery cannot be confirmed here; read tools still return everything` };
  }
  if (!i.ctl)
    return { state: "hooks not reporting", hint: "no control socket for the hooks (Claude Code's pid was not found) — delivery cannot be confirmed; read tools still return everything" };
  if (i.pushed === 0) return { state: "idle" };
  if (i.missed > 0)
    return { state: "unconfirmed", hint: `Bridge entries are not reaching the model — this session runs without channels. Restart it with: ${CHANNELS_LAUNCH}` };
  if (i.confirmed > 0) return { state: "confirmed" };
  if (i.lastHookAt === null)
    return { state: "hooks not reporting", hint: "the plugin's UserPromptSubmit hook has not reported in this session (hooks disabled, or EINWEAVE_STATE_DIR set where only the MCP server sees it?) — delivery cannot be confirmed; read tools still return everything" };
  return { state: "awaiting confirmation" };
}
