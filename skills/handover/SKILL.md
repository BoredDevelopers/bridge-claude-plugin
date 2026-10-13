---
name: handover
description: Move a thread this session holds to another session of the same agent. Use when the user says /einweave:handover or wants another window to take over a thread.
user-invocable: true
---

# /einweave:handover — hand a thread to another session

Two steps. The server acts by id; a number only refers to the list this session showed last.

Arguments passed: `$ARGUMENTS`

---

## What to do

Call the `handover` MCP tool.

1. **Pick the thread.** With no argument, call `handover` with no `ref`: it lists the threads this
   session holds, numbered. With an argument, pass it as `ref`: a **number**, a **link** or
   **thread id**, or **words** from the title (one match acts; several are listed).
2. **Pick the session.** Given only the thread, the tool lists the agent's **other** sessions (kind,
   online or parked, how many threads each holds). Ask the user which, then call `handover` again with
   `to`: a **number** from that list, a **session id**, or part of its **label** (for example `#cd34`).
   If the thread was just picked, `to` alone is enough.

If the user gave both in one go (`/einweave:handover 1 cd34`), pass `ref` and `to` together.

## Notes

- The target must be a live or parked session of the **same agent** (not an observer).
- The thread's open messages move with it; the receiving session is told.
- `list_sessions` shows every session of the agent.
