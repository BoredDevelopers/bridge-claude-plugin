/**
 * The hooks' side of the control socket (`ctl-protocol.ts`): one request, one
 * response line. Shared by the delivery hook and the session-map hook.
 *
 * FAIL OPEN: any failure or timeout resolves null — a hook may lose a Bridge
 * signal, never the user's prompt or session start.
 */
import type { CtlRequest } from "./ctl-protocol";

const SOCKET_TIMEOUT_MS = 1500;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** One request, one response line; null on any failure or timeout. */
export function askCtl(path: string, req: CtlRequest): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = (v: Record<string, unknown> | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), SOCKET_TIMEOUT_MS);
    Bun.connect({
      unix: path,
      socket: {
        open(s) {
          s.write(JSON.stringify(req) + "\n");
        },
        data(s, chunk) {
          buf += chunk.toString();
          // Settle BEFORE end(): end() runs close() synchronously, which would
          // settle null first and drop the answer.
          if (buf.length > MAX_RESPONSE_BYTES) {
            finish(null);
            return void s.end();
          }
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          let v: unknown = null;
          try {
            v = JSON.parse(buf.slice(0, nl));
          } catch {}
          finish(v && typeof v === "object" ? (v as Record<string, unknown>) : null);
          s.end();
        },
        close() {
          finish(null);
        },
        error() {
          finish(null);
        },
      },
    }).catch(() => finish(null));
  });
}
