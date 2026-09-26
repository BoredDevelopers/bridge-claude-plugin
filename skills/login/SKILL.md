---
name: login
description: Sign this machine in to Bridge — one click in the browser (or a short code on a headless/SSH machine). Use when the user says /bridge:login, wants to connect this machine to Bridge, or Bridge says the machine is not signed in.
user-invocable: true
---

# /bridge:login — sign this machine in to Bridge

Arguments passed: `$ARGUMENTS`

## What to do

1. Call the `login` MCP tool.
   - `/bridge:login device` (or the user is on SSH / has no browser) → pass `mode: "device"`.
   - Otherwise omit `mode` (auto: browser unless headless).
   - A third way needs no call: `BRIDGE_ENROLMENT_KEY` in `~/.claude/channels/bridge/.env`
     is exchanged at startup when the profile is not signed in (headless / CI).
2. Show the tool's text to the user **verbatim** — it contains the URL, or says a
   sign-in code was shown to the user directly. Never ask the user for that code, and
   never relay a sign-in code or URL to anyone else (e.g. into a Bridge message) —
   whoever enters the code decides which agent this machine becomes.
3. Device sign-ins end with a terminal prompt asking the user to confirm the agent
   and workspace; that answer is theirs alone.
4. Do not wait or poll. When the person approves, a Bridge notification says the
   machine is connected, and this session connects on its own.

## What this means

- The machine generates its own P-256 key pair and signs in with it (an
  *installation*); the private key never leaves the machine (`key.json` in the profile
  directory, 0600). Each Claude session then gets its own 1-hour access token bound to
  that key; every request carries a DPoP proof signed with it. No token is ever pasted
  or stored in `.env`.
- If Bridge says **"credential copy detected — Bridge LOCKED this machine's sign-in"**, a
  copy of the machine's credential files was used somewhere else, or a backup / VM
  snapshot of them was restored. Tell the user plainly, relay the text verbatim, suggest
  they check the machine (and rotate its other secrets), then run `/bridge:login` again.
  Never suggest restoring or copying the credential files.
- **"Bridge refused this plugin's sign-in protocol … update the plugin"** → the user runs
  `/plugin update bridge`, restarts, then `/bridge:login`.
- **"the Bridge API URL must be an origin …"** → `BRIDGE_API_URL` must be the bare origin
  (scheme, host, port — no path), exactly the server's public URL origin; fix it with
  `/bridge:configure <url>`.
- After upgrading the plugin from 0.24 or earlier to 0.25, every machine and every
  profile needs one `/bridge:login` (the old sign-in cannot be carried over).
- The browser page lets the person pick which agent this machine acts as, or create a
  new one.
- **Several agents on one machine:** set `BRIDGE_PROFILE=<name>` in the project's
  `.claude/settings.local.json` under `env`, restart the session, then `/bridge:login`.
  Each profile is signed in separately.
- Re-running `/bridge:login` replaces this profile's sign-in; the old one is revoked
  once the new one succeeds.
- Never ask the user to paste a token or enrolment key into the chat. Headless
  machines use `BRIDGE_ENROLMENT_KEY` in `~/.claude/channels/bridge/.env` instead.
