---
name: status
description: Show Bridge channel connection state, available channels, and connected agents. Use when the user asks about Bridge status, connected agents, or channel info.
user-invocable: true
allowed-tools:
  - Read
  - Bash(curl *)
---

# /bridge:status — Bridge Channel Status

Shows the current state of the Bridge connection.

Arguments passed: `$ARGUMENTS`

---

## What to show

**Always call the `status` Bridge tool FIRST.** Unlike `list_channels` /
`list_agents`, it is not gated — it answers whether Bridge is unconfigured,
configured-but-idle, or connected, which decides everything else below.

It returns `{ configured, wantConnected, websocket, receiving_messages,
agent, context_id, channel_filter, auth, label, tail }` (`tail` = the launcher
for the full-message viewer, see `/bridge:tail`; `auth` = the sign-in:
profile, credential, installation, `key_storage`, `key_thumbprint`, `problem`).

### 1. Unconfigured (`configured: false`)

Bridge has no API URL, or this machine is not signed in (or its sign-in was
locked / revoked). Report `auth.problem` plainly and stop — don't call any other
Bridge tool, they'll just repeat the same thing. Next step: whatever it names
(`/bridge:configure` for the URL, `/bridge:login` to sign in).

### 2. Idle (`configured: true`, `wantConnected: false`)

Bridge is set up but this session hasn't joined it (or was disconnected).
Report:
- Configured: yes.
- Connected: no — this session is not receiving Bridge messages.
- Next step: run `/bridge:connect` (or use `claudeb`, which auto-connects).

Don't call `list_channels`/`list_agents` here — they're gated and will just
return the same "not connected" hint.

### 3. Connected (`wantConnected: true`)

Report the snapshot itself:
- Websocket state (`websocket`) and whether messages are actually flowing
  (`receiving_messages` — the socket can be `connected` but not yet
  authenticated).
- Agent identity (`agent`), this session's context id (`context_id`), and
  its display label (`label`, or "derived default" if null).
- Channel filter (`channel_filter`) — "all" or the configured list.
- Sign-in (`auth`): installation name, `key_storage` (`software`), and
  `key_thumbprint`; if `auth.session` says the session was revoked, the next
  step is `/bridge:connect`.

Then, for the fuller picture, also call:
- **Channels** — the `list_channels` Bridge tool: available channels with
  unread state. Note which match the filter (if `channel_filter` narrows it).
- **Agents** — the `list_agents` Bridge tool: connected agents, their state,
  and skills.

---

## Implementation notes

- If the MCP tools aren't available at all (server not running), fall back
  to reading `~/.claude/channels/bridge/.env` and reporting config-only
  status.
- Keep output concise: agent name + state + online/offline is enough.
  Don't dump full skill lists unless asked.
