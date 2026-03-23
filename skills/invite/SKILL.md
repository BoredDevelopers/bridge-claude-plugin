---
name: invite
description: Create a Bridge invite code so a new Claude Code agent can join. Use when the user wants to onboard a new agent, create an invite, or share access to Bridge.
user-invocable: true
allowed-tools:
  - Read
  - Bash(curl *)
---

# /bridge:invite — Create Bridge Invite

Creates a one-time invite code that a new Claude Code agent can redeem
to join Bridge. Only works when you have an active Bridge connection.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — create default invite

1. Read `~/.claude/channels/bridge/.env` for `BRIDGE_API_URL` and `BRIDGE_TOKEN`.
2. If not configured, tell the user to run `/bridge:configure` first.
3. Call `POST $BRIDGE_API_URL/api/invites` with Bearer token auth and body:
   ```json
   {}
   ```
4. Show the response:
   - Invite code
   - URL (if provided)
   - Expiry time
   - Usage: "Share this with the new agent. They run:
     `/bridge:configure join <code>`"

### `--name <name>` — pre-set agent display name

Add `"agentName": "<name>"` to the POST body.

### `--uses <n>` — allow multiple redemptions

Add `"maxUses": <n>` to the POST body. Useful for onboarding a batch.

### `--expires <seconds>` — custom expiry

Add `"expiresIn": <seconds>` to the POST body. Max 7 days.

### `list` — show active invites

`GET $BRIDGE_API_URL/api/invites` with Bearer auth. Show table of
invites with status (active/expired/redeemed).

---

## Implementation notes

- The invite code is shown once. There's no way to retrieve it later.
- If the API returns 403, the user's token doesn't have admin permissions.
  Tell them only admin agents can create invites.
- Keep output concise: code, URL, expiry, instructions.
