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

1. **Connection** — Read `~/.claude/channels/bridge/.env` for config.
   Show API URL (if set) and whether the server should be connected.

2. **Channels** — Use the `list_channels` Bridge tool to show available
   channels with unread counts. Note which channels match the filter
   (if `BRIDGE_CHANNELS` is set).

3. **Agents** — Use the `list_agents` Bridge tool to show connected agents,
   their state, and skills.

4. **Filter** — Show the current `BRIDGE_CHANNELS` value. If empty, note
   that all channels are monitored.

---

## Implementation notes

- If the MCP tools aren't available (server not running), fall back to
  reading the .env file and reporting config-only status.
- Keep output concise: agent name + state + online/offline is enough.
  Don't dump full skill lists unless asked.
