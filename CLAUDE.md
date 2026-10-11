# CLAUDE.md

Bridge channel plugin for Claude Code. Server: `plexodus/bridge` (its CLAUDE.md is the
fuller guide). Users install it from `bored-marketplace`, which pins a release TAG —
merging to `main` ships nothing until `bun run release`.

## Commands

```bash
bun test               # full suite (~14 min); target files while iterating
bun run typecheck      # tsc (server, auth, link, delivery, tests)
bun run release        # on main, after the version-bump PR merged + CI green: tag, pin listing (--dry-run first)
EINWEAVE_API_DIR=<bridge checkout>/packages/api bun test test/key-credentials-real-api.test.ts   # real-API gate
```

## Rules

1. **Compatibility windows (standing rule, RFC-017 D1).** Every wire-protocol change and
   every on-disk format change is expand/contract:
   - The server deploys first and accepts old AND new.
   - This plugin updates over days, never in the same hour.
   - Windows running release N−1 and N share one profile directory at the same time.
     So N writes what N−1 can read, and nothing ever deletes or rewrites a file whose
     `format` it does not know (`format-guard.ts`).
   - Old support ends only when the server raises its minimum client version.
   - **0.30.0 is the one deliberate exception (RFC-027 §5, pre-production):** protocol v2
     ships as a single cutover — server, 0.30.0 and OpenClaw 2.0.0 together; the server
     refuses v1 (4008 "client too old"). 0.30.0 also moves its state to `~/.einweave`, so
     0.29 and 0.30 windows never share a profile, lock or label file; the v024/v025
     cross-version fixtures went with it. The rule applies again from 0.30.0 onward.
2. **Close codes.** Never add a close code the plugin must act on: pre-RFC-017 clients
   retry unknown codes forever. New "stop, a person must act" signals are 4008 reasons,
   matched on the prefix before `:`. An unrecognised 4008 reason must always stop.
3. **Frozen fixtures.** `test/fixtures/v0XX/` are frozen copies of released behaviour.
   Never edit them. Add a new set per release.
4. **Prove every guard.** Break it, see the test go red, then restore it.

## Releasing

1. PR: bump `package.json` AND `.claude-plugin/plugin.json` (same x.y.z; `test/version-sync.test.ts`).
2. Merge, wait for CI on main.
3. `bun run release --dry-run`, then `bun run release` — tags `v<version>`, pins
   `bored-marketplace` to that tag + sha (no `version` in the listing: plugin.json wins).
4. Server nudge: `EINWEAVE_CLIENT_RECOMMENDED_CLAUDE_CODE=<version>` in the NAS `.env`, `up -d api`.
5. Post in #einweave → releases.
