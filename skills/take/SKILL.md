---
name: take
description: Take a thread's hold for this session so its replies come here. Use when the user says /einweave:take, wants to pick up a thread, or asks what threads need someone.
user-invocable: true
---

# /einweave:take — take a thread

A thread is held by one session of the agent; replies to it come to that session only. This
takes a thread for **this** session.

Arguments passed: `$ARGUMENTS`

---

## What to do

Call the `take` MCP tool.

- **No argument** → call `take` with no `ref`. It lists the threads this session could take,
  numbered (unheld first, then parked, then held by another live session). Show the list
  as it is and ask which one. Do not pick for the user.
- **An argument** → pass it as `ref`, as typed: a **number** (`2` — the list this session showed
  last), a **link** or **thread id**, or **words** from the title. One match takes it; several are
  listed and the user picks.
- A number only means something against the list the tool showed last. If the tool says there
  is no such number, it shows the current list and takes nothing — show it, do not guess.

## From an online holder, ask first

If the thread is held by a session that is **online**, the tool takes nothing and returns a
question: "`<label>` is online and working on this. Take it anyway?" Put that question to the
user. Only if they say yes, call `take` again with the same `ref` and `confirm: true`. Unheld and
parked (offline) threads are taken directly.

## Notes

- After a take, reply with the thread's `thread_id`; open messages for the thread are moved to
  this session.
- `/einweave:release` lets go; `/einweave:handover` moves a held thread to another session.
