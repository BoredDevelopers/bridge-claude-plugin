---
name: scope
description: Set which channels' unheld work this session takes. Use when the user says /einweave:scope or wants to narrow what reaches this window.
user-invocable: true
---

# /einweave:scope — which channels this session takes work from

A work session receives **the threads it holds** (always) plus **unheld work in its scope** while
the agent has no live gateway. The scope is stored by the server; nothing is filtered in the plugin.

Arguments passed: `$ARGUMENTS`

---

## What to do

Call the `scope` MCP tool.

- **No argument** → call it with no `channels`: it shows the scope the server reported for this
  session.
- **`#a #b`** (names or ids, spaces or commas) → pass them as `channels`. Names are resolved to
  channel ids; an unknown name changes nothing and the tool says which.
- **`all`** or **`none`** → pass that word alone.

## Notes

- `EINWEAVE_CHANNELS` in `~/.einweave/.env` only sets the scope a session **starts** with.
- With a live gateway the scope matters for nothing new: the gateway gets new work.
- Held threads reach their holder whatever the scope.
