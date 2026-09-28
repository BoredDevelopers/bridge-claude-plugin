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
   - If the user said `/bridge:connect takeover` (or otherwise asked to take
     over / move Bridge to this window), pass `takeover: true`. This claims
     the session lock from another window of this same Claude session — even
     one running an equal or newer plugin version, or the window that just
     superseded this one — and that other window is told and stops. A
     **superseded** window (RFC-017 D3) never reconnects on its own —
     `/bridge:connect takeover` (or `/bridge:disconnect` then a plain
     `/bridge:connect`) is what resumes it.
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
- If Bridge isn't set up yet, the tool says what is missing — no API URL →
  `/bridge:configure`; not signed in → `/bridge:login`.
- If this session was **revoked** in Bridge, `/bridge:connect` starts a new one. A
  session **evicted** under the agent's live-session cap reconnects by itself.
- If another window of this same Claude session already holds the lock (an equal or
  newer plugin), a plain `/bridge:connect` stands by and retries — it does not take
  over. Use `/bridge:connect takeover` to move Bridge here explicitly.
