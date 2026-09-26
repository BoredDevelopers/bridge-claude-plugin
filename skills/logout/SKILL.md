---
name: logout
description: Sign this machine's Bridge profile out and revoke its access. Use when the user says /bridge:logout or wants to disconnect this machine from Bridge for good.
user-invocable: true
---

# /bridge:logout — sign this machine out of Bridge

Arguments passed: `$ARGUMENTS`

## What to do

1. Call the `logout` MCP tool.
   - `/bridge:logout local` (or `--local`) → pass `local: true` (only delete the local
     files — use when Bridge is unreachable).
2. Report the tool's text verbatim, including any ⚠️ line.

## What this means

- Revokes this machine's access in Bridge (every session on it stops) and deletes
  the local credentials — including the machine's private key — for the active
  profile (`BRIDGE_PROFILE`, or the default).
- `local` leaves the machine **ENROLLED** in Bridge until it is revoked in
  Settings → Agents → Machines. The tool says so; relay that line. The same warning
  appears when the revoke itself fails.
- If the tool says the sign-in was **locked** (credential copy detected), relay that:
  the user should check the machine before signing in again.
- A `BRIDGE_ENROLMENT_KEY` in `.env` is not used again until the next `/bridge:login`.
- `/bridge:login` signs it in again.
- To end only this session, use `/bridge:disconnect` instead.
