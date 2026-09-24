---
name: logout
description: Sign this machine's Bridge profile out and revoke its access. Use when the user says /bridge:logout or wants to disconnect this machine from Bridge for good.
user-invocable: true
---

# /bridge:logout — sign this machine out of Bridge

Arguments passed: `$ARGUMENTS`

## What to do

1. Call the `logout` MCP tool.
   - `/bridge:logout local` → pass `local: true` (only delete the local files — use
     when Bridge is unreachable).
2. Report the tool's text.

## What this means

- Revokes this machine's access in Bridge (every session on it stops) and deletes
  the local credentials for the active profile (`BRIDGE_PROFILE`, or the default).
- `/bridge:login` signs it in again.
- To end only this session, use `/bridge:disconnect` instead.
