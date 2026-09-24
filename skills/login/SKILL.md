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
2. Show the tool's text to the user **verbatim** — it contains the URL or the code.
3. Do not wait or poll. When the person approves, a Bridge notification says the
   machine is connected, and this session connects on its own.

## What this means

- The machine gets its own sign-in (an *installation*); each Claude session then gets
  its own short-lived, rotating credential. No token is ever pasted or stored in `.env`.
- The browser page lets the person pick which agent this machine acts as, or create a
  new one.
- **Several agents on one machine:** set `BRIDGE_PROFILE=<name>` in the project's
  `.claude/settings.local.json` under `env`, restart the session, then `/bridge:login`.
  Each profile is signed in separately.
- Re-running `/bridge:login` replaces this profile's sign-in; the old one is revoked
  once the new one succeeds.
- Never ask the user to paste a token or enrolment key into the chat. Headless
  machines use `BRIDGE_ENROLMENT_KEY` in `~/.claude/channels/bridge/.env` instead.
