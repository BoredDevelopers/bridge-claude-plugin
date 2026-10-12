/**
 * The per-session control socket between this plugin's hooks and its MCP server
 * (RFC-027 D7): `<state>/ctl/c<claude-pid>.sock`, 0600. One NDJSON request and one
 * response per connection. Not the feed socket — that one stays read-only (#228).
 *
 * Four operations, nothing else:
 * - `prompt` (UserPromptSubmit): `id` is the entry the prompt delivered, if any
 *   (`tags.ts`). The server confirms it ONLY if this process holds it pending,
 *   then answers with the missed notice, if any. Sent on every prompt, so its
 *   arrival also proves the hooks run.
 * - `stop` (Stop): the turn ended.
 * - `pending`: metadata of what this process holds pending (`status`, debugging).
 * - `session` (SessionStart): `id` is the conversation id Claude Code now runs. `/clear`
 *   and an interactive `/resume` change it WITHOUT restarting this server, which keeps
 *   the id it was spawned with; the server re-keys if it differs (RFC-028 B4).
 *
 * Time is the server's clock at receipt, never the caller's.
 */
export type CtlRequest =
  | { op: "prompt"; id: string | null }
  | { op: "stop" }
  | { op: "pending" }
  | { op: "session"; id: string };

export type CtlResponse =
  | { ok: true; op: "prompt"; confirmed: boolean; context: string | null }
  | { ok: true; op: "stop" }
  | { ok: true; op: "pending"; entries: unknown[] }
  | { ok: true; op: "session"; rekeyed: boolean }
  | { ok: false; error: string };

/** A request line is tiny; anything longer is not ours. */
export const MAX_REQUEST_BYTES = 1024;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseCtlRequest(line: string): CtlRequest | null {
  if (line.length > MAX_REQUEST_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  switch (o.op) {
    case "prompt":
      if (o.id === null || o.id === undefined) return { op: "prompt", id: null };
      return typeof o.id === "string" && ID.test(o.id) ? { op: "prompt", id: o.id } : null;
    case "stop":
      return { op: "stop" };
    case "pending":
      return { op: "pending" };
    case "session":
      return typeof o.id === "string" && ID.test(o.id) ? { op: "session", id: o.id } : null;
    default:
      return null;
  }
}
