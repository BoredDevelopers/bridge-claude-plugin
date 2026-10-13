/**
 * What the PERSON is told about a closed socket (`status`, notices). The
 * classification (which close is which class) and the reconnect schedule are the
 * SDK's (`classifyClose` / `reconnectDelay` in vendor/einweave-agent-sdk/core) — the
 * SDK reconnects; this file only words it.
 */
import { UPDATE_HOWTO } from "./update-howto";
import type { CloseClass } from "./vendor/einweave-agent-sdk/core/index.js";
export type { CloseClass };

/**
 * Just enough of the new holder's identity (RFC-017 D2/D3's lock record) to name it in a
 * notice — pid, version, tty, terminal, cwd. Every field is optional: server.ts reads it
 * best-effort (D3: "names the new holder from the lock record when readable"), and a
 * record it cannot read at all means `describeClose` falls back to a generic phrase.
 */
export interface HolderIdentity {
  pid: number;
  version?: string;
  tty?: string;
  termProgram?: string;
  cwd?: string;
}

/** "pid 123, 0.26.0, ttys003 (iTerm), ~/Code/x" — omits whatever a partial record lacks. */
function describeHolder(h: HolderIdentity): string {
  const parts = [`pid ${h.pid}`, h.version, h.tty ? (h.termProgram ? `${h.tty} (${h.termProgram})` : h.tty) : h.termProgram, h.cwd];
  return parts.filter((p): p is string => !!p).join(", ");
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function parseSemver(v: string | undefined): [number, number, number] | null {
  if (v === undefined) return null;
  const m = SEMVER_RE.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * True only when `other` is a STRICTLY newer, well-formed semver than `mine` — a missing
 * or unparseable `other` (same "never guess" spirit as lock-decision.ts's own present-
 * but-unparseable rule) is never "newer". Duplicated in miniature rather than imported
 * from lock-decision.ts — same "each pure module owns its own comparator" idiom as
 * proc-registry.ts's liveness check and stale-watcher.ts's own semver parser.
 */
function isNewerThan(other: string | undefined, mine: string): boolean {
  const o = parseSemver(other);
  const m = parseSemver(mine);
  if (!o || !m) return false;
  for (let i = 0; i < 3; i++) if (o[i] !== m[i]) return o[i] > m[i];
  return false;
}

/** A human-readable reason for `status` and notifications. */
export function describeClose(
  cls: CloseClass,
  code: number | undefined,
  reason: string | undefined,
  /** Whether THIS close made the plugin delete the installation's files (4008 revoked / locked). */
  opts: { keyDeleted?: boolean; supersededBy?: HolderIdentity; myVersion?: string } = {}
): string {
  const tail = `${code ?? "?"}${reason ? ` "${reason}"` : ""}`;
  switch (cls) {
    case "session-cap":
      return `too many live sessions for this agent (${tail}) — close another session, or wait for a slot`;
    case "credential":
      switch (code) {
        case 4001:
          return `Bridge refused this session's access token (${tail}) — a new one is minted; if this keeps happening, run /einweave:login`;
        case 4003:
          return `agent deactivated or workspace archived (${tail}) — retrying slowly; an admin can reactivate it, otherwise run /einweave:login`;
        default:
          return `Bridge refused this session's credential (${tail}) — retrying slowly; if this keeps happening, run /einweave:login`;
      }
    case "expired":
      return `access token expired (${tail}) — refreshing`;
    case "evicted":
      return `this session was evicted to make room under the agent's live-session cap (${tail}) — reconnecting with a new session`;
    case "revoked":
      if (reason === "session revoked") return `this session was revoked in Bridge (${tail}) — /einweave:connect starts a new session`;
      if (reason === "installation revoked")
        return `this machine was signed out of Bridge (${tail}) — run /einweave:login to connect it again`;
      if (reason === "installation locked")
        return `credential copy detected — Bridge LOCKED this machine's sign-in because a copy of its credential was used somewhere else (${tail})${opts.keyDeleted ? "; its key was deleted here" : ""} — check this machine, then run /einweave:login to re-enrol`;
      return `token revoked (${tail}) — run /einweave:login, then /einweave:connect`;
    case "superseded": {
      const who = opts.supersededBy ? describeHolder(opts.supersededBy) : "another window";
      // Finding 6: only a genuinely NEWER holder gets the update prompt — equal, older or
      // unknown (no record, or a version this build cannot read) is a plain takeover
      // (a person's own /einweave:connect takeover, possibly onto an older window on
      // purpose), so telling the person to update would be wrong.
      if (opts.myVersion && isNewerThan(opts.supersededBy?.version, opts.myVersion)) {
        return `Bridge moved to a newer plugin in ${who} (${tail}) — /reload-plugins here to update this window; /einweave:connect takeover to move Bridge back`;
      }
      return opts.supersededBy
        ? `another window took over Bridge (${who}) (${tail}) — /einweave:connect takeover moves it back`
        : `another window took over Bridge (${tail}) — /einweave:connect takeover moves it back`;
    }
    case "too-old":
      return `this plugin is too old for Bridge (${tail}) — ${UPDATE_HOWTO}`;
    case "session-in-use":
      return `this session is already connected from another process (${tail}) — /einweave:status shows which; /einweave:connect takeover moves it here`;
    default:
      return `connection closed (${tail})`;
  }
}
