---
name: connect
description: Join Bridge for this session — presence, inbound messages, and registration. Use when the user says /einweave:connect, wants to join/connect to Bridge, or asks why Bridge tools say the session isn't connected.
user-invocable: true
---

# /einweave:connect — join Bridge for this session

Calls the `connect` Bridge tool to bring this session onto Bridge: presence,
inbound message delivery, and context registration all start (or resume)
from this call.

Arguments passed: `$ARGUMENTS`

---

## What to do

1. Call the `connect` MCP tool.
   - If the user gave a name as an argument (e.g. `/einweave:connect Reviewer`),
     pass it as `label` on the same call — it is applied before the connect
     handshake, so the very first auth frame already carries it.
   - Words in the arguments choose the **kind** and what to take:
     - `session` (the default) / `gateway` → `kind`. A window is a **work
       session**: it gets the threads it holds, plus unheld work in its scope
       while the agent has no live gateway. The **gateway** is the agent's one
       triage connection and gets all unheld work. The kind is remembered for
       this session across restarts; with no kind word the window keeps the
       kind it has. `EINWEAVE_CONNECTION_KIND=gateway` in the launch
       environment starts a window as the gateway when it has declared no kind before.
     - `gateway takeover` → `kind: "gateway"`, `takeover: "gateway"`: move the
       agent's gateway from the window that has it to this one (that window is
       told and stops being the gateway). If another window holds the gateway
       and the user did not say takeover, the connect keeps **retrying** and
       says who has it, once.
   - If the user said `/einweave:connect takeover` (or otherwise asked to take
     over / move Bridge to this window), pass `takeover: "lock"`. This claims
     the session lock from another window of this same Claude session — even
     one running an equal or newer plugin version, or the window that just
     superseded this one — and that other window is told and stops. A
     **superseded** window (RFC-017 D3) never reconnects on its own —
     `/einweave:connect takeover` (or `/einweave:disconnect` then a plain
     `/einweave:connect`) is what resumes it.
2. Report the result (`connected` or `connecting`, with `(gateway)` for a gateway).

## What this means

- This joins Bridge for **this session only** — presence, inbound messages,
  and channel/agent tools all start working from here.
- The connection **persists across restarts**: once connected, this session
  stays connected on every future launch until `/einweave:disconnect` is run.
- `claudeb` auto-connects on launch, so this is mainly for sessions started
  plain `claude` that want to join mid-session, or for reconnecting after a
  `/einweave:disconnect`.

## Notes
- Idempotent — calling it while already connected as the same kind is a no-op on
  the socket; naming the other kind reconnects as that kind.
- If Bridge isn't set up yet, the tool says what is missing — no API URL →
  `/einweave:configure`; not signed in → `/einweave:login`.
- If this session was **revoked** in Bridge, `/einweave:connect` starts a new one. A
  session **evicted** under the agent's live-session cap reconnects by itself.
- If another window of this same Claude session already holds the lock (an equal or
  newer plugin), a plain `/einweave:connect` stands by and retries — it does not take
  over. Use `/einweave:connect takeover` to move Bridge here explicitly.
- If this window should be its **own** Bridge session instead of fighting another window for
  this one, restart it with `claude --resume <session id> --fork-session` — the standby message
  prints the exact command when the session id is the conversation's own.
