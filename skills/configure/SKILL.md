---
name: configure
description: Set up the Bridge channel — save the API URL and agent token. Use when the user wants to configure Bridge, pastes a Bridge token, or asks about channel setup.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /bridge:configure — Bridge Channel Setup

Writes the Bridge API URL and agent token to `~/.claude/channels/bridge/.env`
and orients the user on the current state.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status

Read both config values and give the user the full picture:

1. **API URL** — check `~/.claude/channels/bridge/.env` for `BRIDGE_API_URL`.
   Show set/not-set.

2. **Token** — check for `BRIDGE_TOKEN`. Show set/not-set; if set, show
   first 8 chars masked (`abc12345...`).

3. **Channel filter** — check `BRIDGE_CHANNELS`. Show the filter or "all
   channels" if empty.

4. **What next** — based on state:
   - No URL/token → *"Run `/bridge:configure <url> <token>` to connect."*
   - Both set → *"Ready. Restart the session with `--channels plugin:bridge`
     to connect."*

### `<url> <token>` — save both

1. Parse `$ARGUMENTS`: first arg is URL (starts with http), second is token.
2. `mkdir -p ~/.claude/channels/bridge`
3. Read existing `.env` if present; update/add `BRIDGE_API_URL=` and
   `BRIDGE_TOKEN=` lines, preserve other keys (`BRIDGE_CHANNELS` etc).
4. `chmod 600 ~/.claude/channels/bridge/.env` — token is a credential.
5. Confirm, then show the status view.

### `channels <list>` — set channel filter

1. Parse comma-separated channel names from `$ARGUMENTS` after "channels".
2. Read `.env`, update `BRIDGE_CHANNELS=` line.
3. Write back. Confirm.
4. Note: changes need session restart or `/reload-plugins`.

### `clear` — remove credentials

Delete `BRIDGE_API_URL=` and `BRIDGE_TOKEN=` lines from `.env`.

---

## Implementation notes

- The channels dir might not exist. Missing file = not configured, not an error.
- The server reads `.env` once at boot. Changes need `/reload-plugins` or
  session restart.
- Never echo the full token back to the user.
