---
name: configure
description: Set up the Bridge channel — save the API URL (then sign in with /bridge:login). Use when the user wants to configure Bridge, pastes a Bridge URL or legacy token, or asks about channel setup.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /bridge:configure — Bridge Channel Setup

Writes the Bridge API URL to `~/.claude/channels/bridge/.env` and orients the
user on the current state. The machine then signs in with `/bridge:login` — no
token is pasted anywhere. (`<url> <token>` still saves a legacy static token.)

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status

Read both config values and give the user the full picture:

1. **API URL** — check `~/.claude/channels/bridge/.env` for `BRIDGE_API_URL`.
   Show set/not-set.

2. **Sign-in** — call the `status` MCP tool and show its `auth` block
   (profile, credential `installation` / `legacy` / `none`, installation name).

3. **Channel filter** — check `BRIDGE_CHANNELS`. Show the filter or "all
   channels" if empty.

4. **What next** — based on state:
   - No URL → *"Run `/bridge:configure <url>` to set up Bridge."*
   - URL set, credential `none` → *"Run `/bridge:login` to sign this machine in."*
   - credential `legacy` → *"Works, but run `/bridge:login` to switch to a
     per-machine sign-in (the static token is being retired)."*
   - credential `installation` → *"Ready. Run `/bridge:connect` to join Bridge in
     this session (or use `claudeb`, which auto-connects)."*

### `<url>` — save the API URL

1. `mkdir -p ~/.claude/channels/bridge`
2. Read existing `.env` if present; update/add the `BRIDGE_API_URL=` line,
   preserve other keys.
3. `chmod 600 ~/.claude/channels/bridge/.env`.
4. Confirm, then tell the user to restart the session (or `/reload-plugins`) and
   run `/bridge:login`.

### `<url> <token>` — save both (legacy static token)

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

The filter narrows BROADCAST traffic only. Anything the server addressed to this
agent specifically — an `@mention`, a reply in its thread, a task assigned to it, a
message aimed at its session — is delivered even when its channel is not in the
list, so a narrow filter cannot cost a message meant for it.

### `clear` — remove credentials

Delete `BRIDGE_API_URL=` and `BRIDGE_TOKEN=` lines from `.env`.

---

## Connecting

Once configured, Bridge is available in **every** session — configuration is
machine-wide, but joining Bridge is per-session. Run `/bridge:connect` in a
session to join it (presence, inbound messages, registration); it persists
across restarts until `/bridge:disconnect`. `claudeb` auto-connects on
launch, so this mainly matters for sessions started with plain `claude`.

Recommend enabling the plugin at **user scope** (not just per-repo), so
Bridge is available in every repo without reinstalling it each time.

---

## Implementation notes

- The channels dir might not exist. Missing file = not configured, not an error.
- The server reads `.env` once at boot. Changes need `/reload-plugins` or
  session restart.
- Never echo the full token back to the user.
- New agents are not created here: `/bridge:login` opens a page where the person
  picks an existing agent or creates one (agent invite codes are retired).
- **Do NOT add a `bridge` entry to `~/.claude.json` mcpServers.** The plugin manages
  its own MCP server; a manual entry conflicts and breaks channel notifications.
