---
name: update
description: Show whether this Bridge plugin window (or another one on this machine) needs updating, and the one next step to take. Use when the user says /bridge:update, asks if Bridge needs updating, or a Bridge notice mentioned an update/stale copy/superseded window.
user-invocable: true
allowed-tools:
  - Bash(claude agents --json)
---

# /bridge:update — is Bridge up to date, and where

Arguments passed: `$ARGUMENTS`

---

## What to do

1. **Call the `status` Bridge tool.** It carries everything this needs:
   `version` (this window's own plugin build), `installed_version` (what
   Claude Code actually has on disk right now, best-effort — `null` if it
   can't be determined), `stale_since` (set once this window's own files have
   been superseded on disk, RFC-017 D7 — `null` while current), `server_versions`
   (`minimum`/`recommended`/`pending_minimum`/`minimum_from`, from the Bridge
   server), `advice` (`ok` / `update_available` / `update_required_by <date>`,
   or `null` against an older server that doesn't send it), and
   `other_processes` — every OTHER Bridge plugin window on this machine, each
   with `pid`, `version`, `state`, `tty`, `termProgram`, `cwd`, `sessionKey`.

2. **Optionally cross-check with `claude agents --json`** (a Bash call) to help
   put a human label on an `other_processes` entry — e.g. matching a `pid` to a
   session's working directory or name. Treat it as a nicety only:
   - the command may not exist on this Claude Code version — if it errors or
     is missing, skip this step silently and use `status`'s own fields;
   - never block on it, and never let it override what `status` said.

3. **Render one compact table**, this window first, then any other windows:

   | window | version | state |
   |---|---|---|
   | this window | `version` (+ " (installed: `installed_version`)" if different and known) | current / **STALE since `stale_since`** |
   | pid `p.pid` | `p.version` | `p.state`, `p.tty` (`p.termProgram`), `p.cwd` |

   Then one line for the server: "Bridge accepts ≥ `server_versions.minimum`,
   recommends `server_versions.recommended`" (add "; will require ≥
   `pending_minimum` from `minimum_from`" if present).

4. **Give exactly ONE next step**, in this priority order:
   - `advice` is `update_required_by <date>` or `too old` was seen elsewhere →
     **`/plugin update bridge`, then `/reload-plugins`** (urgent — a deadline
     or an outright refusal).
   - `stale_since` is set (this window's own files are gone from disk) →
     **`/reload-plugins`** to switch this window onto what's actually
     installed.
   - `advice` is `update_available` → `/plugin update bridge`, then
     `/reload-plugins` (optional, not urgent).
   - Another window in `other_processes` is on a version below this one, and
     the person seems to want Bridge active there → name it: "close or
     `/reload-plugins` the window on `tty` (`termProgram`, `cwd`)".
   - None of the above → "nothing to do — this window is current."

## Notes
- `status` always answers, even unconfigured/disconnected — this skill works
  in every state.
- Don't dump the raw JSON; the table plus the one next step is the whole point.
- This is about the PLUGIN build, not the Bridge session lock (`/bridge:connect
  takeover` moves the SOCKET between windows of one session; this skill is
  about which FILES on disk each window is running).
