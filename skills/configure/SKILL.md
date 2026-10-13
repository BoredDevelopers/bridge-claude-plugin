---
name: configure
description: Set up the Bridge channel — save the API URL (then sign in with /einweave:login). Use when the user wants to configure Bridge, pastes a Bridge URL, or asks about channel setup.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /einweave:configure — Bridge Channel Setup

Writes the Bridge API URL to `~/.einweave/.env` and orients the
user on the current state. The machine then signs in with `/einweave:login` — no
token is pasted anywhere. Static tokens are retired; the server no longer
accepts them.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status

Read both config values and give the user the full picture:

1. **API URL** — check `~/.einweave/.env` for `EINWEAVE_API_URL`.
   Show set/not-set.

2. **Sign-in** — call the `status` MCP tool and show its `auth` block
   (profile, credential `installation` / `none`, installation name,
   `key_storage`, `key_thumbprint`). If it carries a `problem`, show that too.

3. **Channel filter** — check `EINWEAVE_CHANNELS`. Show the filter or "all
   channels" if empty.

4. **What next** — based on state:
   - No URL → *"Run `/einweave:configure <url>` to set up Bridge."*
   - URL set, credential `none` → *"Run `/einweave:login` to sign this machine in."*
   - credential `installation` → *"Ready. Run `/einweave:connect` to join Bridge in
     this session (or use `claudeb`, which auto-connects)."*

### `<url>` — save the API URL

The URL must be the API's bare **origin** — scheme, host, optional port, no path,
query or trailing segments (`https://bridge-api.example.com`) — and exactly the origin
the server publishes as its public URL: every request is signed over it, so another
port, scheme or host alias is refused. Strip a trailing `/`; if the user gave a path,
say it will be refused and ask for the origin.

1. `mkdir -p ~/.einweave`
2. Read existing `.env` if present; update/add the `EINWEAVE_API_URL=` line,
   preserve other keys.
3. `chmod 600 ~/.einweave/.env`.
4. Confirm, then tell the user to restart the session (or `/reload-plugins`) and
   run `/einweave:login`.

### `channels <list>` — set channel filter

1. Parse comma-separated channel names from `$ARGUMENTS` after "channels".
2. Read `.env`, update `EINWEAVE_CHANNELS=` line.
3. Write back. Confirm.
4. Note: changes need session restart or `/reload-plugins`.

The filter narrows BROADCAST traffic only. Anything the server addressed to this
agent specifically — an `@mention`, a reply in its thread, a task assigned to it, a
message aimed at its session — is delivered even when its channel is not in the
list, so a narrow filter cannot cost a message meant for it.

### `clear` — remove credentials

Delete the `EINWEAVE_API_URL=` line from `.env`.

---

## Connecting

Once configured, Bridge is available in **every** session — configuration is
machine-wide, but joining Bridge is per-session. Run `/einweave:connect` in a
session to join it (presence, inbound messages, registration); it persists
across restarts until `/einweave:disconnect`. `claudeb` auto-connects on
launch, so this mainly matters for sessions started with plain `claude`.

Recommend enabling the plugin at **user scope** (not just per-repo), so
Bridge is available in every repo without reinstalling it each time.

---

## Implementation notes

- The channels dir might not exist. Missing file = not configured, not an error.
- The server reads `.env` once at boot. Changes need `/reload-plugins` or
  session restart.
- Never echo an enrolment key back to the user, and never touch the credential
  files (`key.json`, `state`, `attempt`, `installation.json`) — `/einweave:login` and
  `/einweave:logout` own them.
- New agents are not created here: `/einweave:login` opens a page where the person
  picks an existing agent or creates one (agent invite codes are retired).
- **Do NOT add a `bridge` entry to `~/.claude.json` mcpServers.** The plugin manages
  its own MCP server; a manual entry conflicts and breaks channel notifications.
