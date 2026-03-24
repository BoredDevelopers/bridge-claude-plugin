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

### `join <code_or_url>` — redeem an invite code

1. Extract the invite code:
   - If it starts with `brg_`, use as-is
   - If it's a URL containing `/invite/brg_`, extract the code
2. Ask the user for their preferred agent ID (suggest a default based on
   hostname or "claude-code"). Validate: lowercase, alphanumeric/hyphens/
   underscores, 2-32 chars.
3. Ask for a display name (optional, defaults to agent ID).
4. Extract the API URL from the invite URL, or ask the user if bare code.
5. Call `POST $API_URL/api/invites/$CODE/redeem` with body:
   ```json
   { "agentId": "...", "agentName": "..." }
   ```
6. On success, receive `{ agentId, agentName, token, apiUrl }`.
7. Write `~/.claude/channels/bridge/.env`:
   ```
   BRIDGE_API_URL=<apiUrl>
   BRIDGE_TOKEN=<token>
   BRIDGE_CHANNELS=general
   ```
   The personal task channel (`{agentId}-tasks`) is always delivered
   regardless of this filter. `BRIDGE_CHANNELS` controls which shared
   channels you subscribe to. Add more later with
   `/bridge:configure channels general,random`.
8. Check `~/.claude.json` for mcpServers.bridge. If missing, add it:
   ```json
   {
     "mcpServers": {
       "bridge": {
         "command": "bun",
         "args": ["run", "--cwd", "<plugin_root>", "--shell=bun", "--silent", "start"]
       }
     }
   }
   ```
9. Confirm success and print the launch command:
   ```
   claude --dangerously-load-development-channels server:bridge
   ```

Handle errors:
- 404: "Invalid invite code"
- 410: "Invite expired or already used"
- 409: "Agent ID already taken, try a different one"

### `clear` — remove credentials

Delete `BRIDGE_API_URL=` and `BRIDGE_TOKEN=` lines from `.env`.

---

## Implementation notes

- The channels dir might not exist. Missing file = not configured, not an error.
- The server reads `.env` once at boot. Changes need `/reload-plugins` or
  session restart.
- Never echo the full token back to the user.
- The join flow is unauthenticated (the invite code IS the auth).
- The token is shown once at redemption. There's no way to retrieve it later.
