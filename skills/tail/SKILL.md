---
name: tail
description: Show how to read this session's Bridge messages in full in a second terminal pane (bridge tail). Use when the user says /bridge:tail, says Bridge messages are cut off or hard to read, asks how to see the full text of an incoming or sent message, or asks about the tail pane.
user-invocable: true
---

# /bridge:tail — read Bridge messages in full, in a second pane

The Claude window shows an incoming Bridge message as a short preview and a sent
one as a tool call with no text. `tail` is a separate viewer for a second terminal
pane: only Bridge messages, in full, live, incoming on the left and outgoing on
the right.

It cannot be opened from here. The plugin runs inside Claude and cannot create a
terminal pane, so the user starts it — once per window.

Arguments passed: `$ARGUMENTS`

---

## What to do

1. Call the `status` Bridge tool and read `tail`.
   - A path → that is the launcher. Go on to step 2.
   - `null` → this session's local feed did not start (or the plugin is older
     than 0.27.0). Say so plainly; `/bridge:update` shows whether an update is
     pending. Do not invent a path.
2. Tell the user, briefly:
   - Split the terminal (VS Code: `cmd+\`, or the split icon in the terminal
     panel; tmux: `prefix %`).
   - In the new pane run the launcher path exactly as `status` gave it.
   - Leave it open. It waits for a session, attaches, and reattaches after a
     restart.
3. Offer the one-time shortcut, so `bridge tail` works from any pane. Give them
   this line for `~/.zshrc` (or `~/.bashrc`), with the real path filled in:

   ```sh
   bridge() { [ "$1" = tail ] && shift; "<launcher path>" "$@"; }
   ```

   The path stays the same across plugin updates; the plugin rewrites the file
   it points at on every start.

## Keys, if they ask

Click a message to fold or unfold it (a long one opens fully first); the mouse
wheel moves the selection. Keys: `j`/`k` or arrows move · `enter` does what a click
does · `e` folds or unfolds all · `g`/`G` first/last · `q` quits.

With click support on, the terminal sends clicks to tail, so copying text needs
Option-drag (macOS) or Shift-drag. `--no-mouse` turns click support off.

## Notes

- Read-only. Replies are still sent from the Claude window, by the agent.
- It shows what THIS session received and sent. Several sessions on the machine:
  it picks the one started in the same folder, else the newest; `--all` shows
  every session, `--session <label>` picks one.
- Nothing is written to disk: the messages come from the running session's
  memory, so the pane starts with what the session still holds.
- Do not run the launcher yourself with a shell tool to "show" the output — it
  is a full-screen viewer for the user's terminal, not a command with a result.
