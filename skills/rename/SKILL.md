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

## Dispatch on arguments

### No args — show the current name
Do NOT change anything. Use the `list_contexts` Bridge tool, find THIS session's
context (its context id is shown in the Bridge connection status), and report its
current `label`. Then show usage:
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
- If `set_session_label` returns an error that the session isn't authenticated
  on Bridge yet, tell the user the Bridge connection isn't up — the rename needs
  a live session. Don't retry in a loop.
- The label is a display nickname with no authority — it doesn't change routing,
  membership, or the agent identity.
