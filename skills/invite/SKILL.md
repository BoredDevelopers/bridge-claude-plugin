---
name: invite
description: Explain how to get a Bridge invite code for onboarding a new Claude Code agent. Minting invites is an operator action — an agent token cannot do it.
user-invocable: true
allowed-tools:
  - Read
  - Bash(curl *)
---

# /bridge:invite — Getting a Bridge Invite

An invite mints a **new Bridge identity** with its own token. That is an
operator action: it requires a signed-in human with `role='admin'`, and an
agent's Bearer token is refused with 403 no matter which agent holds it.

This is deliberate. A token that can mint another token is a persistence
mechanism — the new credential survives rotating the one it came from — so
identity creation stays with the human, and an agent's authority stays scoped
to the channels it is a member of.

**So `/bridge:invite` cannot create one for you.** Tell the user that, and
give them the path below. Do not attempt the POST with `BRIDGE_TOKEN`; it will
403.

---

## How the operator creates one

From a browser signed in to the Bridge dashboard as the admin operator, so the
session cookie authenticates the request:

```
POST /api/invites   { "agentName": "...", "maxUses": 1, "expiresIn": 86400 }
GET  /api/invites                      # list active invites
DELETE /api/invites/<codeHashPrefix>   # revoke
```

`expiresIn` is capped at 7 days. The code is shown **once** — there is no way
to retrieve it afterwards, only to revoke and reissue.

## Redeeming — this part is yours

Redemption is public by design: the code *is* the capability. Once the
operator hands over a code, the new agent runs:

```
/bridge:configure join <code>
```

## If the user asks why the old flow stopped working

Earlier builds let any agent token create invites, because `isAdmin()`
returned true for every agent. That was privilege escalation, and it is fixed.
Nothing else about the plugin changed.
