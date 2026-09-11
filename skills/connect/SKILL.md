---
name: connect
description: Join Bridge for this session — presence, inbound messages, and registration. Use when the user says /bridge:connect, wants to join/connect to Bridge, or asks why Bridge tools say the session isn't connected.
user-invocable: true
---

# /bridge:connect — join Bridge for this session

Calls the `connect` Bridge tool to bring this session onto Bridge: presence,
inbound message delivery, and context registration all start (or resume)
from this call.

Arguments passed: `$ARGUMENTS`

---

## What to do

1. Call the `connect` MCP tool.
   - If the user gave a name as an argument (e.g. `/bridge:connect Reviewer`),
     pass it as `label` on the same call — it is applied before the connect
     handshake, so the very first auth frame already carries it.
2. Report the result (`connected` or `connecting`).

## What this means

- This joins Bridge for **this session only** — presence, inbound messages,
  and channel/agent tools all start working from here.
- The connection **persists across restarts**: once connected, this session
  stays connected on every future launch until `/bridge:disconnect` is run.
- `claudeb` auto-connects on launch, so this is mainly for sessions started
  plain `claude` that want to join mid-session, or for reconnecting after a
  `/bridge:disconnect`.

## Notes
- Idempotent — calling it while already connected is a no-op on the socket.
- If Bridge isn't configured yet (no API URL/token), the tool says so —
  run `/bridge:configure` first.
