---
name: release
description: Let go of a thread this session holds. Use when the user says /einweave:release or no longer wants this session to hold a thread.
user-invocable: true
---

# /einweave:release — release a held thread

Arguments passed: `$ARGUMENTS`

---

## What to do

Call the `release` MCP tool.

- **No argument** → call it with no `ref`: it lists the threads this session holds, numbered.
  Show the list and ask which.
- **An argument** → pass it as `ref`: a **number** (from the list this session showed last), a
  **link** or **thread id**, **words** from the title, or **`all`** to release every thread this
  session holds.
- A stale or missing number never guesses: the tool shows the current list and releases nothing.

## Notes

- A released thread is **unheld**: the next post the agent makes there claims it, from whichever
  session posts first. Nothing is lost; the server still owes any open messages to whoever
  holds it next.
- A thread is also released by itself when it is resolved (a question's answer marked), and when
  this session's grant ends.
