# Bridge connect-on-demand — Design

**Date:** 2026-09-11
**Repo:** `bridge-claude-plugin` (plugin-only; NO Bridge-API change)
**Target release:** 0.17.0

## Goal

Make the Bridge plugin **available in every session/repo** while a session
**joins Bridge only when the user asks**. Today, loading the plugin
auto-connects (`connectUnlessDuplicate()` at startup), so every enabled session
appears on Bridge as `jorgen-mac` — the churn that motivated session labels.
Split *availability* (plugin loaded, tools answerable) from *connection* (WS
joined), and gate connection behind an explicit, persisted **connect-intent**.

## Non-goals

- Killing/reaping **another** session (the `disconnect_context` research) — out
  of scope. This feature is **self**-connect / self-disconnect only.
- Any Bridge-API server change. Self-disconnect is client-side WS lifecycle; the
  server already handles a closed socket (presence offline, GC, TTL).
- Autoconnect toggles / per-repo allowlists — explicitly rejected: **manual
  only** (one launch env for `claudeb` is the only auto path).

## Decisions (locked with the user)

1. **Manual only** — no autoconnect setting. `claudeb` connects on launch via an
   env; every other launch (VS Code extension, plain `claude`) is manual.
2. **`claudeb` connects on launch**; VS Code / plain `claude` stay manual.
3. **Bridge tools while disconnected → error with hint** (not lazy-connect).
4. **Connect-intent persists per `SESSION_KEY`** — survives reconnect and
   `claude -c`; explicit disconnect sticks.
5. **`/bridge:connect [name]`** — name optional; keep **`/bridge:rename`** for
   live rename while connected.
6. Env name `BRIDGE_AUTOCONNECT`; tool names `connect` / `disconnect`.
7. `/bridge:configure` wizard text upgraded in this build.

## Architecture

### Two axes, now independent

- **Availability**: plugin enabled (recommended at **user scope** post-ship → all
  repos). The MCP server process spawns per session and its tools are always
  answerable — even with no token and no connection.
- **Connection**: the WebSocket join. Gated behind `wantConnected`.

### Connect-intent resolution (startup)

A per-session boolean persisted keyed by `SESSION_KEY`, in a new
`connect-store.ts` that mirrors `label-store.ts` (atomic tmp+rename, `0700`
dir, age-based sweep, never sweeps the current key's file).

```
persisted = readConnectState(STATE_DIR, SESSION_KEY)   // boolean | undefined
wantConnected = persisted ?? (process.env.BRIDGE_AUTOCONNECT === "1")
```

- **First launch** of a key (no stored state): seed from env. `claudeb` sets
  `BRIDGE_AUTOCONNECT=1` → connect. VS Code / plain `claude` → no env → idle.
- **Thereafter**: persisted state governs. `/bridge:connect` writes `true`,
  `/bridge:disconnect` writes `false`. So an explicit disconnect sticks across
  resume even for a `claudeb` session, and a connected session stays connected
  across drop / `claude -c`.

`wantConnected` is the single source of truth guarding every connect path:
startup, `scheduleReconnect`, and the liveness-timer / pong self-heal.

### Config gate change (server.ts:84-93)

Today: missing `BRIDGE_API_URL`/`BRIDGE_TOKEN` → `process.exit(1)` (server dies).
New: **do not exit** — stay alive, tools answerable. Rationale: an
installed-but-unconfigured user must still get working `configure`/`status`/
`connect` tools and guidance, not a dead server.

Two distinct states, distinct hints (do not conflate):
- **not configured** (`!API_URL || !TOKEN`) → *"run /bridge:configure"*
- **not connected** (`wantConnected === false`, creds fine) → *"run /bridge:connect"*

**Safety of dropping `exit(1)`:** every creds-consuming path must stay behind the
creds guard so nothing runs with an empty token — verified sites: `apiFetch`
(only reached through the guarded Bridge tools) and `connectWs` (only reached when
`wantConnected && API_URL && TOKEN`). The implementer must confirm there is no
*unconditional startup* `apiFetch` call (e.g. server.ts:724) that would now fire
with empty creds; if there is, it moves behind the guard.

## Components

### `connect-store.ts` (new, pure)
- `connectStateFileFor(dir, key)` → `.connect-state-<sanitized key>`
- `readConnectState(dir, key): boolean | undefined`
- `writeConnectState(dir, key, on: boolean)` (atomic; `mkdir 0700`)
- `sweepConnectStateFiles(dir, currentPath, maxAgeMs)`
Same shape/tests as `label-store.ts`, so it is unit-testable without spawning.

### `server.ts`
- Introduce `let wantConnected = false;` resolved at startup (above).
- Startup (line 2431): `if (!shuttingDown && wantConnected) connectUnlessDuplicate();`
- **Reconnect suppression:** put the guard as an early return at the TOP of
  `scheduleReconnect()` — `if (!wantConnected) return;` — so the single check
  covers BOTH callers (the ws `close` handler ~912 and the liveness timer ~935)
  and the pong self-heal. Do not guard each caller separately. On explicit
  `disconnect`, also clear any pending `reconnectTimer`/`livenessTimer` and
  `ws.close()`.
- Config: replace `process.exit(1)` with a stored "no creds" state; `connectWs`
  and `connect` tool guard on `API_URL && TOKEN`, else return guidance.
- New tools:
  - **`connect`** (optional `label`): if `label`, run the existing
    `set_session_label` path (writes label store, patches live `sessionInfo`);
    set `wantConnected = true`; `writeConnectState(..., true)`; if creds present
    call `connectUnlessDuplicate()`, else return the configure hint. Idempotent.
  - **`disconnect`**: `wantConnected = false`; `writeConnectState(..., false)`;
    clear reconnect/liveness timers; `ws?.close()`; release nothing else.
    Idempotent.
- **Bridge tools** (`reply`, `list_channels`, `list_agents`, `list_contexts`,
  `read_messages`, `claim_task`, `update_task_status`, `cancel_task`,
  `list_my_tasks`) — these call **`apiFetch` (REST)**, NOT the WebSocket, so the
  guard is on intent/creds, not on `ws` state. Two-tier, in a shared helper:
  1. `!API_URL || !TOKEN` → *"Bridge not configured — run /bridge:configure."*
  2. else `!wantConnected` → *"Bridge not connected — run /bridge:connect first."*
  3. else proceed. Gate on the **intent** `wantConnected` (the master "on Bridge"
     switch), NOT on live ws-open: if intent is true but the ws is mid-reconnect,
     REST still works (`reply` already appends a "may not reach this session"
     warning via `connectionState()`).
- **New `status` tool** (always-on, never gated): returns
  `connectionStatus()` (already defined, server.ts:963) plus `wantConnected`,
  `configured` (`!!(API_URL && TOKEN)`), and the current label. `/bridge:status`
  calls this so it renders correctly even when disconnected/unconfigured.
- **Always-on tools:** `connect`, `disconnect`, `status`, `set_session_label`.
  `set_session_label` when disconnected just writes the label store (applied on
  next connect); it does not require a socket.
- `sweepConnectStateFiles(...)` alongside the existing label/cursor sweeps.

### Skills (new + edited)
- **`skills/connect/SKILL.md`** — `/bridge:connect [name]`. No arg → connect with
  derived/stored name. Arg → connect + set label. `user-invocable: true`.
- **`skills/disconnect/SKILL.md`** — `/bridge:disconnect`. Leaves Bridge; stays
  loaded; reconnect suppressed until next `/bridge:connect`.
- **`skills/status/SKILL.md`** (edit) — add a **connected / disconnected** line
  (read from the `connection` block the `list_channels` tool already returns, or
  a lightweight status tool). Must render sensibly when disconnected.
- **`skills/rename/SKILL.md`** (unchanged behavior) — still live-renames a
  connected session; note it errors/hints if disconnected.
- **`skills/configure/SKILL.md`** (edit) — wizard text: after saving the token,
  explain the connect model (available everywhere, `/bridge:connect` to join,
  `claudeb` auto-connects) and recommend enabling at user scope.

### `claudeb` alias (user's `~/.zshrc`, documented here)
Adds `BRIDGE_AUTOCONNECT=1`, keeps `--plugin-dir <repo>` and optional
`BRIDGE_SESSION_LABEL="$label"`. `claudeb Reviewer` = launch connected as
Reviewer; `claudeb` = launch connected, derived name.

### Version
`package.json` + `.claude-plugin/plugin.json` 0.16.0 → **0.17.0**
(`version-sync.test.ts` gate).

## Data flow

```
launch → resolve SESSION_KEY → read connect-store + label-store
  wantConnected = persisted ?? (BRIDGE_AUTOCONNECT==="1")
  if wantConnected && creds → connectUnlessDuplicate() → connectWs (auth frame carries label)
  else → idle; tools answerable; Bridge (REST) tools return the not-connected hint

/bridge:connect [name] → connect tool
  (set label if given) → wantConnected=true → persist true → connectWs

/bridge:disconnect → disconnect tool
  wantConnected=false → persist false → clear timers → ws.close (no reconnect)

drop / claude -c → same SESSION_KEY → persisted governs → restore prior state
```

## Error handling / edge cases

- **No token + connect**: return the configure hint; do not crash; do not spin
  reconnect.
- **Disconnect then socket-tool**: hint, not a stale/hung call.
- **Reconnect suppression**: a deliberate `disconnect` must not be undone by the
  liveness timer or pong self-heal — both gated on `wantConnected`.
- **Duplicate instance**: existing session-lock path unchanged; a duplicate that
  wins the lock still only connects when `wantConnected`.
- **Label composition**: `connect [name]` and `rename [name]` and
  `BRIDGE_SESSION_LABEL` all funnel through the one label store + the suffixed
  `deriveContextLabel` shape; precedence unchanged (env override → stored → derived).

## Testing (spawn-based, plugin style + pure units)

- `connect-store.test.ts` (pure): read/write/sweep, sanitized filename, absent →
  `undefined`, current file never swept. Prove each guard red by mutation.
- Spawn tests:
  - No token → server **stays alive**, tools answerable, `connect` returns the
    configure hint (was: process exits).
  - Idle (no env, no state) → not connected; a Bridge REST tool returns the
    **not-connected** hint.
  - **Two-tier hint**: no creds → a Bridge tool returns the **not-configured**
    hint; creds present + `wantConnected=false` → the **not-connected** hint.
    (Distinct messages — mutation: collapse both branches to one and prove a test
    reds.)
  - `BRIDGE_AUTOCONNECT=1` → connects on launch.
  - `connect` tool → connects; `connect Reviewer` → label applied + connected.
  - `disconnect` → closes, and **stays closed** (liveness/pong do not reconnect)
    — mutation: remove the `wantConnected` early-return in `scheduleReconnect()`
    and prove the test reconnects.
  - `status` tool (always-on): reports `configured`/`wantConnected`/ws-state
    correctly in each of {unconfigured, idle, connected, disconnected}; works
    when disconnected (mutation: gate it and prove `/bridge:status` breaks idle).
  - Persistence: connect, restart same SESSION_KEY → still connected; disconnect,
    restart → still disconnected; both override the env per the precedence rule
    (`persisted ?? env`).
- `version-sync.test.ts` stays green at 0.17.0.

Every guard proven red by mutation before it is trusted.
