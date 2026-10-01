/**
 * Strip terminal control sequences and control characters from text written by
 * someone else, before it reaches the host's terminal (RFC-022 D2).
 *
 * Measured 2026-10-01 on Claude Code 2.1.286: escape sequences in a channel
 * notification's content are RENDERED by the host, so any member of a channel
 * could style text in this user's terminal — colour, bold, concealed or inverted
 * text, enough to make a message look like host output. The server strips at
 * write time too, but rows stored before that, and any server this plugin talks
 * to that predates it, are not covered. This side never depends on that.
 *
 * SOURCE: `@bridge/agent-sdk` `src/core/control-chars.ts` — the rule from "What
 * goes" down is the same text, and `test/fixtures/control-chars.json` is a copy
 * of the SDK's vectors. Both move onto the vendored SDK in 0.27.0 (RFC-018 S5).
 *
 * What goes: complete escape sequences (CSI, OSC, DCS/SOS/PM/APC, two-character
 * escapes) as whole units, so a pasted coloured log loses its codes rather than
 * leaving `[32m` litter; then every remaining C0 control except `\n` and `\t`,
 * DEL, and the C1 block. `\r\n` and a lone `\r` become `\n` — a bare carriage
 * return lets later text overwrite the start of the line.
 *
 * A string sequence (OSC and friends) never matches across a newline: an
 * unterminated `ESC ]` must not swallow the rest of the message.
 *
 * Pure, linear-time (every quantified class is disjoint from what follows it),
 * and idempotent: the output contains no ESC or C1 character for a second pass to
 * act on.
 */
const ANSI_SEQUENCE =
  /(?:\x1B\[|\x9B)[0-?]*[ -\/]*[@-~]|(?:\x1B\]|\x9D)[^\x07\x1B\x9C\n]*(?:\x07|\x1B\\|\x9C)?|(?:\x1B[PX^_]|[\x90\x98\x9E\x9F])[^\x1B\x9C\n]*(?:\x1B\\|\x9C)?|\x1B[ -\/]*[0-~]/g;
const CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

export function stripControlChars(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(ANSI_SEQUENCE, "").replace(CONTROL_CHARS, "");
}

/** A `notifications/claude/channel` payload: the text the host prints, and its tag attributes. */
export interface ChannelParams {
  content?: unknown;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * The strip applied to one channel notification: `content`, and every STRING value
 * in `meta` (a sender name is written by someone else just as the text is). Other
 * meta values pass through untouched. Returns a new object; never throws.
 */
export function sanitizeChannelParams<T extends ChannelParams>(params: T): T {
  const out: ChannelParams = { ...params };
  if (typeof out.content === "string") out.content = stripControlChars(out.content);
  if (out.meta && typeof out.meta === "object") {
    const meta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out.meta)) meta[k] = typeof v === "string" ? stripControlChars(v) : v;
    out.meta = meta;
  }
  return out as T;
}
