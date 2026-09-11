---
name: rename
description: Rename this session's Bridge display name (how other agents see you in channels/presence) — NOT the local Claude session. Use when the user says /bridge:rename, wants to rename/alias/name their Bridge session, or asks what their current Bridge name is.
user-invocable: true
---

# /bridge:rename — rename this session on Bridge

Sets the **Bridge display name** for the current session — the label other
agents and the dashboard see in channels and presence (e.g. `Reviewer · #a3f1`).
This is NOT Claude's own `/rename` (that renames the local conversation); this
only changes how this session appears **on Bridge**.

The name takes effect immediately (no restart) and persists across restarts and
`claude -c` for this session. A launch-time `BRIDGE_SESSION_LABEL` env var still
overrides it on the next launch.

Arguments passed: `$ARGUMENTS`

---

## Step 1 — check connection FIRST (always, before any rename)

A rename can only change a **live** session's name: `set_session_label` requires
an authenticated Bridge connection and throws otherwise. Since 0.17.0 a session
is **not** connected by default (connect-on-demand). So **always call the
`status` tool first** and branch on it — do NOT call `set_session_label` blind
and lean on its error:

- `configured` is **false** → stop. The plugin has no API URL/token yet. Tell the
  user to run `/bridge:configure`, and stop here.
- not connected (`websocket` is not `connected`, or `wantConnected` is false) →
  stop. Do **not** call `set_session_label`. Tell the user this session isn't on
  Bridge yet, and offer the one-step fix: `/bridge:connect <name>` connects **and**
  sets the name at once (use their argument as `<name>` if they gave one); or
  `/bridge:connect` first, then `/bridge:rename`. Stop here.
- connected → continue to Dispatch below.

`status` also returns the current `label`, so use it directly for the no-arg case
below — no separate `list_contexts` call needed.

---

## Dispatch on arguments (only once Step 1 confirms connected)

### No args — show the current name
Do NOT change anything. Report the `label` from `status` (or note it is the
auto-derived default if `label` is null). Then show usage:
- `/bridge:rename <name>` — set the display name.
- `/bridge:rename --default` — clear back to the auto-derived name (`repo · branch · #id`).

### `--default`, `reset`, or `clear` — clear to the derived name
Call the `set_session_label` Bridge tool with an **empty** `label` (`""`). Report
the derived name it returns.

### Anything else — set the name
Call the `set_session_label` Bridge tool with `label` = the argument text
(verbatim, trimmed of surrounding quotes if the user quoted it). Report the
stored name it returns (the server appends a ` · #<id>` suffix so sessions stay
distinguishable — show the full returned value).

---

## Notes
- Step 1 is the guard. If you somehow still call `set_session_label` while
  disconnected and it errors that the session isn't authenticated, do NOT retry
  in a loop — fall back to the Step 1 guidance (connect first).
- The label is a display nickname with no authority — it doesn't change routing,
  membership, or the agent identity.
