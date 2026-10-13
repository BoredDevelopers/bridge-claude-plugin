---
name: status
description: Show Bridge channel connection state, available channels, and connected agents. Use when the user asks about Bridge status, connected agents, or channel info.
user-invocable: true
allowed-tools:
  - Read
  - Bash(curl *)
---

# /einweave:status — Bridge Channel Status

Shows the current state of the Bridge connection.

Arguments passed: `$ARGUMENTS`

---

## What to show

**Always call the `status` Bridge tool FIRST.** Unlike `list_channels` /
`list_agents`, it is not gated — it answers whether Bridge is unconfigured,
configured-but-idle, or connected, which decides everything else below.

It returns `{ configured, wantConnected, websocket, receiving_messages,
agent, context_id, kind, scope, holds, threads_that_need_someone, delivery, auth, label, tail }` (`tail` = the launcher
for the full-message viewer, see `/einweave:tail`; `auth` = the sign-in:
profile, credential, installation, `key_storage`, `key_thumbprint`, `problem`).

### 1. Unconfigured (`configured: false`)

Bridge has no API URL, or this machine is not signed in (or its sign-in was
locked / revoked). Report `auth.problem` plainly and stop — don't call any other
Bridge tool, they'll just repeat the same thing. Next step: whatever it names
(`/einweave:configure` for the URL, `/einweave:login` to sign in).

### 2. Idle (`configured: true`, `wantConnected: false`)

Bridge is set up but this session hasn't joined it (or was disconnected).
Report:
- Configured: yes.
- Connected: no — this session is not receiving Bridge messages.
- Next step: run `/einweave:connect` (or use `claudeb`, which auto-connects).

Don't call `list_channels`/`list_agents` here — they're gated and will just
return the same "not connected" hint.

### 3. Connected (`wantConnected: true`)

Report the snapshot itself:
- Websocket state (`websocket`) and whether messages are actually flowing
  (`receiving_messages` — the socket can be `connected` but not yet
  authenticated).
- Agent identity (`agent`), this session's context id (`context_id`), and
  its display label (`label`, or "derived default" if null).
- Kind (`kind`: `session` = work session, `gateway` = the agent's triage connection) and,
  once authenticated, the server's `scope` (which channels' unheld work this session takes)
  and `holds` (the thread ids it holds).
- `threads_that_need_someone` (when connected): threads nobody holds that are addressed to this agent. Show
  them and offer `/einweave:take` (which lists them numbered; the bullets here are not numbers to pick from).
- Delivery (`delivery.state`) — whether what Bridge pushed actually reached the model:
  `confirmed`, `awaiting confirmation`, `idle` (nothing pushed yet), `unconfirmed`
  (entries were missed: this session runs without channels — give the person
  `delivery.hint`, which names the restart command, verbatim), or
  `hooks not reporting` (confirmation impossible here; say so, nothing is lost —
  `read_messages` / `read_thread` still return everything). Mention `delivery.pending`
  when it is not 0.
- Sign-in (`auth`): installation name, `key_storage` (`software`), and
  `key_thumbprint`; if `auth.session` says the session was revoked, the next
  step is `/einweave:connect`.

Then, for the fuller picture, also call:
- **Channels** — the `list_channels` Bridge tool: available channels with
  unread state. Note which are in this session's `scope`.
- **Agents** — the `list_agents` Bridge tool: connected agents, their state,
  and skills.

---

## Implementation notes

- If the MCP tools aren't available at all (server not running), fall back
  to reading `~/.einweave/.env` and reporting config-only
  status.
- Keep output concise: agent name + state + online/offline is enough.
  Don't dump full skill lists unless asked.
