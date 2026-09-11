# Bridge connect-on-demand — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Bridge plugin available in every session while a session joins Bridge only on explicit `/bridge:connect` (or `BRIDGE_AUTOCONNECT=1`, which `claudeb` sets). Intent persists per `SESSION_KEY`.

**Architecture:** Plugin-only (`bridge-claude-plugin`). New pure `connect-store.ts` (mirrors `label-store.ts`). `server.ts` gains a `wantConnected` master switch gating startup connect + reconnect; drops `process.exit(1)` on missing creds; adds `connect`/`disconnect`/`status` tools; guards the REST tools with a two-tier configured/connected check. New `connect`/`disconnect` skills; `status`/`configure` skills updated. Version → 0.17.0. NO Bridge-API change.

**Tech Stack:** Bun + TypeScript, `@modelcontextprotocol/sdk`, spawn-based tests (`bun test`).

**Spec:** `docs/superpowers/specs/2026-09-11-connect-on-demand-design.md` (read it before starting).

**Test note:** the full suite spins real WS and takes ~150s. Run the single file under change (`bun test test/<file>.test.ts`) during a task; run the whole suite once at the end. `bun test`, NOT `bun run test`. Prove every new guard red by mutation before trusting it.

---

## File Structure

- Create `connect-store.ts` — pure persistence of the per-session connect-intent boolean (mirror of `label-store.ts`).
- Create `test/connect-store.test.ts` — pure unit tests (mirror `test/label-store.test.ts`).
- Modify `server.ts` — `wantConnected` resolution + startup gate; config gate (no `exit(1)`); `connect`/`disconnect`/`status` tools; REST-tool two-tier guard; `scheduleReconnect` early-return; sweep call.
- Create `test/connect-on-demand.test.ts` — spawn tests for the above.
- Create `skills/connect/SKILL.md`, `skills/disconnect/SKILL.md`.
- Modify `skills/status/SKILL.md`, `skills/configure/SKILL.md`, `skills/rename/SKILL.md` (add a "disconnected" note).
- Modify `package.json` + `.claude-plugin/plugin.json` → `0.17.0`.
- Modify `~/.zshrc` `claudeb` → add `BRIDGE_AUTOCONNECT=1` (rollout step; user's dotfile).

---

## Task 1: `connect-store.ts` (pure module)

**Files:**
- Create: `connect-store.ts`
- Test: `test/connect-store.test.ts`

- [ ] **Step 1: Read the template.** Read `label-store.ts` and `test/label-store.test.ts` in full — `connect-store.ts` mirrors it exactly, differing only in filename prefix and that the value is a boolean, not a string.

- [ ] **Step 2: Write the failing test** `test/connect-store.test.ts`, mirroring `test/label-store.test.ts`. Cover:
  - `connectStateFileFor(dir,key)` sanitizes the key like `labelFileFor` (`[^a-zA-Z0-9_-]` → `_`) and uses prefix `.connect-state-`.
  - `readConnectState` returns `undefined` when the file is absent; `true` after `writeConnectState(dir,key,true)`; `false` after `writeConnectState(dir,key,false)`.
  - `writeConnectState` creates `dir` if missing (write against a fresh tmp dir persists, not silently no-ops).
  - `sweepConnectStateFiles` deletes `.connect-state-*` older than maxAge, skips `currentPath`, never throws on a missing dir.

- [ ] **Step 3: Run the test, verify it fails**
  Run: `bun test test/connect-store.test.ts`
  Expected: FAIL (module/exports missing).

- [ ] **Step 4: Implement `connect-store.ts`** — copy `label-store.ts` structure, changing prefix to `.connect-state-` and the value type to boolean. Reference implementation:

```ts
/**
 * Per-session connect-intent persistence — pure module, no top-level side
 * effects. Mirrors label-store.ts (which mirrors the cursor idiom). Keyed by
 * SESSION_KEY (resume-stable), so a session's connected/disconnected choice
 * survives reconnect and `claude -c`. Wired into server.ts: resolution is
 * `readConnectState(...) ?? (BRIDGE_AUTOCONNECT==="1")`; connect/disconnect
 * tools write it.
 */
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";

const PREFIX = ".connect-state-";

export function connectStateFileFor(dir: string, key: string): string {
  return join(dir, `${PREFIX}${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`);
}

/** true / false as stored, or undefined when there is no file. */
export function readConnectState(dir: string, key: string): boolean | undefined {
  try {
    const raw = readFileSync(connectStateFileFor(dir, key), "utf8").trim();
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {}
  return undefined;
}

export function writeConnectState(dir: string, key: string, on: boolean): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = connectStateFileFor(dir, key);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, (on ? "1" : "0") + "\n", { mode: 0o600 });
    renameSync(tmp, target);
  } catch {}
}

export function sweepConnectStateFiles(dir: string, currentPath: string, maxAgeMs: number): void {
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(PREFIX)) continue;
      const path = join(dir, name);
      if (path === currentPath) continue;
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {}
    }
  } catch {}
}
```

- [ ] **Step 5: Run the test, verify it passes**
  Run: `bun test test/connect-store.test.ts` → PASS.

- [ ] **Step 6: Prove the guards red by mutation** — e.g. break the sanitize regex, or make `readConnectState` return `true` for `"0"`; confirm a test reds; revert.

- [ ] **Step 7: typecheck + commit**
  Run: `bunx tsc --noEmit` (0 errors). Commit `connect-store.ts` + its test.

---

## Task 2: Config gate — stay alive without creds

**Files:**
- Modify: `server.ts:84-93` (the `if (!API_URL || !TOKEN) { … process.exit(1) }` block)
- Test: `test/connect-on-demand.test.ts`

- [ ] **Step 1: Read the spawn-test harness** — read `test/session-rename-tool.test.ts` (and any shared helper it uses) to learn how a test spawns `server.ts` with env and drives MCP over stdio. New spawn tests mirror it.

- [ ] **Step 2: Write the failing test** in `test/connect-on-demand.test.ts`: spawn `server.ts` with NO `BRIDGE_TOKEN` (and a temp `HOME`/state dir). Assert the process **stays alive** and answers `tools/list` (it must NOT exit). Expected currently: FAIL (server exits 1).

- [ ] **Step 3: Run → verify fail.** `bun test test/connect-on-demand.test.ts`.

- [ ] **Step 4: Implement.** Replace the `process.exit(1)` block: keep the stderr guidance, set a module flag (e.g. keep using `API_URL`/`TOKEN` emptiness directly — no new flag needed), and DO NOT exit. Ensure nothing later in top-level startup calls `apiFetch`/`connectWs` unconditionally with empty creds (audit server.ts:724 and the startup tail; move any such call behind the `wantConnected && creds` gate added in Task 3).

- [ ] **Step 5: Run → pass.** Commit.

---

## Task 3: `wantConnected` resolution + startup gate

**Files:**
- Modify: `server.ts` (startup tail ~2431; add module state + resolution near where `sessionLabel` is resolved after `SESSION_KEY` settles)
- Test: `test/connect-on-demand.test.ts`

- [ ] **Step 1: Write failing tests** (spawn):
  - No env, no stored state → server does NOT connect (assert no "WebSocket connected"/no auth within a short window, or `status` shows `wantConnected:false`).
  - `BRIDGE_AUTOCONNECT=1` + creds → connects (existing "authenticated as …" stderr or `status`).
  - Precedence: pre-seed a `.connect-state-<key>` = `0` with `BRIDGE_AUTOCONNECT=1` → does NOT connect (persisted `false` wins over env, per `persisted ?? env`).

- [ ] **Step 2: Run → fail** (today it always auto-connects).

- [ ] **Step 3: Implement.** Add `let wantConnected = false;`. After `SESSION_KEY` is settled and the label is resolved (next to the existing `sessionLabel = SESSION_LABEL_OVERRIDE || …` line), add:
  ```ts
  wantConnected = readConnectState(STATE_DIR, SESSION_KEY)
    ?? (process.env.BRIDGE_AUTOCONNECT === "1");
  sweepConnectStateFiles(STATE_DIR, connectStateFileFor(STATE_DIR, SESSION_KEY), CURSOR_SWEEP_MAX_AGE_MS);
  ```
  Import the three functions from `./connect-store`. Change the startup connect line (~2431) to:
  ```ts
  if (!shuttingDown && wantConnected && API_URL && TOKEN) connectUnlessDuplicate();
  ```

- [ ] **Step 4: Run → pass. Mutation:** force `wantConnected = true` regardless of state; confirm the "idle by default" test reds; revert. Commit.

---

## Task 4: `connect` + `disconnect` tools

**Files:**
- Modify: `server.ts` (tool list ~1423-1640, and the tool-dispatch switch)
- Test: `test/connect-on-demand.test.ts`

- [ ] **Step 1: Write failing tests** (spawn): start idle (no env). Call the `connect` tool → session connects (auth stderr / `status.wantConnected:true`) and `.connect-state-<key>` becomes `1`. Call `connect` with `{label:"Reviewer"}` → the label is applied (auth frame / label file). Call `disconnect` → ws closes, `.connect-state-<key>` becomes `0`.

- [ ] **Step 2: Run → fail** (tools absent).

- [ ] **Step 3: Implement** both tool schemas + handlers:
  - `connect` (input: optional `label:string`): if `label` provided, run the existing `set_session_label` code path (write label store + patch live `sessionInfo`); set `wantConnected = true`; `writeConnectState(STATE_DIR, SESSION_KEY, true)`; if `API_URL && TOKEN` call `connectUnlessDuplicate()`, else return the **not-configured** hint. Return a short status string. Idempotent (connecting when already connected is a no-op beyond persisting).
  - `disconnect`: `wantConnected = false`; `writeConnectState(STATE_DIR, SESSION_KEY, false)`; clear `reconnectTimer`/`livenessTimer`; `ws?.close()`. Idempotent. Return status.

- [ ] **Step 4: Run → pass. Mutation:** make `disconnect` skip `writeConnectState`; confirm the persistence test (Task 5/here) reds; revert. Commit.

---

## Task 5: Reconnect suppression

**Files:**
- Modify: `server.ts` (`scheduleReconnect()` ~941; close handler ~912; liveness ~924-935)
- Test: `test/connect-on-demand.test.ts`

- [ ] **Step 1: Write the failing test** (spawn): connect, then `disconnect`, then confirm the socket **stays closed** — no "reconnecting"/"WebSocket connected" stderr for a few seconds after disconnect. Also: persistence — restart the server with the SAME `SESSION_KEY` (temp state dir preserved) after a disconnect → still disconnected; after a connect → still connected.

- [ ] **Step 2: Run → fail** (today `close` schedules a reconnect regardless).

- [ ] **Step 3: Implement.** Add to the TOP of `scheduleReconnect()`:
  ```ts
  if (!wantConnected) return;
  ```
  Leave the close handler and liveness timer calling `scheduleReconnect()` as-is — the single early-return covers them and the pong self-heal.

- [ ] **Step 4: Run → pass. Mutation:** remove the early-return; confirm "stays closed" reds; revert. Commit.

---

## Task 6: REST-tool two-tier guard

**Files:**
- Modify: `server.ts` (tool-dispatch handlers for `reply`, `list_channels`, `list_agents`, `list_contexts`, `read_messages`, `claim_task`, `update_task_status`, `cancel_task`, `list_my_tasks`)
- Test: `test/connect-on-demand.test.ts`

- [ ] **Step 1: Write failing tests** (spawn):
  - No creds → calling `list_channels` returns the **not-configured** hint (mentions `/bridge:configure`), not a network error.
  - Creds present, `wantConnected=false` → `list_channels` returns the **not-connected** hint (mentions `/bridge:connect`).
  - After `connect` → `list_channels` proceeds (or returns real data / a normal error, not the hint).
  - `status`, `connect`, `disconnect`, `set_session_label` are NOT gated (work while idle).

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** a shared helper, e.g.:
  ```ts
  function requireBridge(): { error: string } | null {
    if (!API_URL || !TOKEN) return { error: "Bridge not configured — run /bridge:configure to set your API URL and token." };
    if (!wantConnected) return { error: "Bridge not connected — run /bridge:connect first." };
    return null;
  }
  ```
  Call it at the top of each REST tool handler; if it returns an error, return that as the tool result (same result shape the other tools use for errors). Do NOT gate `connect`/`disconnect`/`status`/`set_session_label`.

- [ ] **Step 4: Run → pass. Mutation:** collapse the two branches into one message; confirm a hint test reds; revert. Commit.

---

## Task 7: `status` tool + skills

**Files:**
- Modify: `server.ts` (add `status` tool)
- Create: `skills/connect/SKILL.md`, `skills/disconnect/SKILL.md`
- Modify: `skills/status/SKILL.md`, `skills/configure/SKILL.md`, `skills/rename/SKILL.md`
- Test: `test/connect-on-demand.test.ts`

- [ ] **Step 1: Write failing test** (spawn): the `status` tool (always-on) returns an object with `wantConnected` (bool), `configured` (bool), and the existing `connectionStatus()` fields, in each of {unconfigured, idle, connected} — and works while disconnected.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `status` tool**: returns `{ ...connectionStatus(), wantConnected, configured: !!(API_URL && TOKEN), label: <current stored/resolved label> }`. Not gated.

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Write the skills.** Mirror the frontmatter of existing skills (`name`, `description`, `user-invocable: true`, `allowed-tools` as needed):
  - `skills/connect/SKILL.md` — `/bridge:connect [name]`: no arg → call `connect`; arg → call `connect` with `label`. Explain it joins Bridge (presence + inbound) for this session and persists.
  - `skills/disconnect/SKILL.md` — `/bridge:disconnect`: call `disconnect`; explain the plugin stays loaded, Bridge tools will hint until reconnect, and reconnect is suppressed until `/bridge:connect`.
  - `skills/status/SKILL.md` — call the new `status` tool; render connected/idle/unconfigured clearly (must not depend on `list_channels`, which is now gated).
  - `skills/configure/SKILL.md` — after saving the token, add wizard text: Bridge is available in every session; use `/bridge:connect` to join (or `claudeb`, which auto-connects); recommend enabling at user scope for all repos.
  - `skills/rename/SKILL.md` — add one line: if the session is not connected, renaming still stores the name (applied on next connect).

- [ ] **Step 6: Commit** (server + skills).

---

## Task 8: Version bump + `claudeb`

**Files:**
- Modify: `package.json`, `.claude-plugin/plugin.json`
- Test: `test/version-sync.test.ts`
- Modify (rollout): `~/.zshrc` `claudeb`

- [ ] **Step 1: Bump both** `package.json` and `.claude-plugin/plugin.json` `version` 0.16.0 → `0.17.0`.

- [ ] **Step 2: Run** `bun test test/version-sync.test.ts` → PASS (both agree).

- [ ] **Step 3: Full suite.** Run `bun test` (whole suite, ~150s). Expected: all green (was 69 pass / 1 skip / 0 fail + the new tests). Confirm the log shows the new test files ran.

- [ ] **Step 4: typecheck.** `bunx tsc --noEmit` → 0.

- [ ] **Step 5: Commit** the version bump.

- [ ] **Step 6: `claudeb` (rollout, user's dotfile — apply at ship, not in the worktree).** Add `BRIDGE_AUTOCONNECT=1` to both branches of the `claudeb()` function in `~/.zshrc`, alongside the existing `--plugin-dir`/`BRIDGE_SESSION_LABEL`. Document in the finishing notes; do not commit (it is outside the repo).

---

## Finishing

- [ ] Run the FULL suite once more (`bun test`) and `bunx tsc --noEmit`; confirm both green and that the new spawn tests actually ran (read the log tally).
- [ ] Dispatch `/bridge-review` is a backend-API skill — NOT applicable (plugin-only). Instead do a final read-through of the `server.ts` diff for the guard placement and the config-gate audit (no unconditional startup `apiFetch`).
- [ ] Use `superpowers:finishing-a-development-branch` to open the PR (branch `feat/connect-on-demand`).
- [ ] Rollout notes (post-merge, Jörgen's client): publish 0.17.0 semantics via `git pull` on the plugin repo `main`; add `BRIDGE_AUTOCONNECT=1` to `claudeb`; optionally enable at user scope for all-repo availability; the `installPath`→repo edit still governs the VS Code extension path.

---

## Unresolved questions

1. `status` tool `label` field — return the RAW stored label, or the suffixed `deriveContextLabel` form the server shows? (Raw is simpler for the skill; suffixed matches what other agents see.)
2. Spawn tests need a real Bridge server to fully assert "connected". Does the existing harness point at a live/test Bridge, or assert on the connect *attempt* (stderr) only? Mirror whatever `session-rename-tool.test.ts` does — confirm during Task 2.
