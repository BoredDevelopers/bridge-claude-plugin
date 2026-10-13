/**
 * Which Bridge entry a `UserPromptSubmit` prompt delivered (RFC-027 D4/D7).
 *
 * Measured on Claude Code 2.1.296 (2026-10-10): when the host hands a channel
 * notification to the model, `UserPromptSubmit` fires with `prompt` set to the
 * whole rendered tag, one prompt per entry:
 *
 *   <channel source="plugin:einweave:einweave" channel_id="…" message_id="…" …>
 *   body
 *   </channel>
 *
 * `source` is `plugin:einweave:einweave` when installed as a plugin, `einweave` from a
 * project `.mcp.json`. The meta attributes follow in the order `routeInbound`
 * builds them: `channel_id`, then `message_id`, then the sender-controlled ones.
 *
 * ONLY the leading tag counts. The host escapes `</channel>` inside a body but not
 * an opening tag, so a sender can write `<channel source="einweave" message_id="X">`
 * into a message (measured). Reading past the first tag, or taking a `message_id`
 * that comes after a sender-controlled attribute, would let any channel member
 * confirm an entry the model never saw. A typed prompt that merely starts with a
 * tag can confirm only ids this process holds pending (the control socket's rule).
 */
const LEADING_TAG = /^\s*<channel source="(?:plugin:einweave:)?einweave"(?: channel_id="[A-Za-z0-9_-]{1,64}")? message_id="([A-Za-z0-9_-]{1,64})"[ >]/;

/** The entry id a prompt delivered, or null when the prompt is not a Bridge channel turn. */
export function deliveredEntryId(prompt: unknown): string | null {
  if (typeof prompt !== "string") return null;
  return LEADING_TAG.exec(prompt)?.[1] ?? null;
}
