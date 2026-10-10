/**
 * Where the control socket of one Claude Code session lives. The hook and the MCP
 * server compute it independently, so this is the one definition both import.
 *
 * Keyed by the Claude Code process id: hooks get it as `CLAUDE_PID`; the server,
 * which sits behind a `bun run` wrapper and has no `CLAUDE_PID`, finds it by
 * walking its ancestry (the same walk the session map uses). Not the session id:
 * the server keeps the id it was spawned with while `--resume` and `/clear`
 * change the hook's.
 *
 * A Unix socket path is capped at ~104 bytes on macOS. A state dir deep enough to
 * overflow it (a test tmpdir, a long home) moves the socket to a short per-user
 * tmp dir, named by a hash of the state dir so two state dirs never share one.
 */
import { createHash } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const MAX_SOCKET_PATH = 100;

export function ctlSocketPath(stateDir: string, claudePid: number): string {
  const direct = join(stateDir, "ctl", `c${claudePid}.sock`);
  if (Buffer.byteLength(direct) <= MAX_SOCKET_PATH) return direct;
  const tag = createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  return join(tmpdir(), `einweave-ctl-${userInfo().uid}`, `c${claudePid}-${tag}.sock`);
}
