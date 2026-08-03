# Channels not arriving — finding what's missing

> **Confirmed 2026-08-03:** the one real-world case of this (WSL) was cause **A**
> below — a telemetry opt-out variable blocking the feature-flag fetch. Removing
> it fixed delivery. Check A first; the ordering below is otherwise unchanged
> from the original diagnosis.

**Symptom this is for:** Bridge's tools work — `/bridge:status` responds, `read_messages` returns data, the agent shows as connected — but messages only appear when you explicitly ask for them. Nothing arrives on its own.

That specific half-working pattern is diagnostic. It is almost never the Bridge plugin, your token, or your config.

## Why the dangerous flag hasn't helped

Claude Code puts **two** gates in front of channel registration, and they fail identically and silently:

| Gate | What it is | Does `--dangerously-load-development-channels` bypass it? |
|------|-----------|------------------------------------------------------------|
| `tengu_harbor` | Server-side master switch for the entire channels feature. Defaults to **off**. | **No** |
| `tengu_harbor_ledger` | Anthropic's approved-plugin allowlist. Bridge isn't on it. | Yes |

`tengu_harbor` is checked **first**. If it's off, the code returns before the dev flag is ever looked at — so no amount of fiddling with the command line can fix it. Meanwhile Bridge's tools keep working, because they're ordinary MCP calls that never touch the channel path. Hence "it half works."

So the first question isn't "is my flag right." It's **"is the channels feature switched on for my account at all."**

## Step 1 — run the collector

Save this as `check.sh` **in the same environment you run `claude` from** (on Windows: inside WSL, not PowerShell or Git Bash), then run `bash check.sh`. It only reads and prints — it changes nothing.

```bash
#!/usr/bin/env bash
# Bridge channel diagnostic — read-only.

echo "===== 1. WHICH CLAUDE ====="
command -v claude || echo "claude NOT FOUND on PATH"
claude --version 2>&1 | head -1
echo

echo "===== 2. PLATFORM ====="
uname -srm
if grep -qi microsoft /proc/version 2>/dev/null; then
  echo "WSL: yes  ($(grep -oi 'microsoft.*' /proc/version 2>/dev/null | head -1))"
else
  echo "WSL: no"
fi
echo "HOME=$HOME"
echo

echo "===== 3. BUN (Bridge's MCP server needs it) ====="
command -v bun || echo "bun NOT FOUND on PATH"
bun --version 2>&1 | head -1
echo

echo "===== 4. TELEMETRY / PROXY ENV ====="
for v in CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC DISABLE_TELEMETRY \
         DISABLE_ERROR_REPORTING HTTPS_PROXY HTTP_PROXY https_proxy http_proxy NO_PROXY; do
  printf '%-45s %s\n' "$v" "${!v:-<unset>}"
done
echo

echo "===== 5. settings.json env block ====="
python3 - <<'PY' 2>/dev/null || echo "(python3 unavailable or settings.json unreadable)"
import json, os
p = os.path.expanduser("~/.claude/settings.json")
if not os.path.exists(p):
    print("no ~/.claude/settings.json")
else:
    d = json.load(open(p))
    keys = ("env", "channelsEnabled", "allowedChannelPlugins")
    sub = {k: d[k] for k in keys if k in d}
    print(json.dumps(sub, indent=2) if sub else "none of env/channelsEnabled/allowedChannelPlugins set")
PY
echo

echo "===== 6. CHANNEL FEATURE FLAGS  <-- the important one ====="
python3 - <<'PY' 2>/dev/null || echo "(python3 unavailable or ~/.claude.json unreadable)"
import json, os
p = os.path.expanduser("~/.claude.json")
if not os.path.exists(p):
    print("NO ~/.claude.json AT THIS PATH")
else:
    f = json.load(open(p)).get("cachedGrowthBookFeatures")
    if not f:
        print("NO CACHED FLAGS  <-- flag fetch has never succeeded")
    else:
        h = {k: v for k, v in f.items() if k.startswith("tengu_harbor")}
        print(json.dumps(h, indent=2) if h else "no tengu_harbor* keys present")
PY
echo

echo "===== 7. BRIDGE PLUGIN INSTALL ====="
python3 - <<'PY' 2>/dev/null || echo "(python3 unavailable or installed_plugins.json unreadable)"
import json, os
p = os.path.expanduser("~/.claude/plugins/installed_plugins.json")
if not os.path.exists(p):
    print("no installed_plugins.json")
else:
    d = json.load(open(p)).get("plugins", {})
    hits = {k: [{"scope": e.get("scope"), "version": e.get("version")} for e in v]
            for k, v in d.items() if "bridge" in k.lower()}
    print(json.dumps(hits, indent=2) if hits else "BRIDGE NOT INSTALLED")
PY
echo

echo "===== 8. STRAY WINDOWS-SIDE CONFIG (WSL only) ====="
found=0
for d in /mnt/c/Users/*/.claude.json; do
  [ -e "$d" ] && { echo "also exists: $d"; found=1; }
done
[ "$found" -eq 0 ] && echo "none found (good, or not WSL)"
echo
echo "===== END ====="
```

Start `claude` at least once before running this, so section 6 reflects a recent fetch rather than something stale.

### Known-good output for comparison

From a machine where Bridge channels work (macOS, Claude Code 2.1.220):

```
===== 4. TELEMETRY / PROXY ENV =====
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC      <unset>
DISABLE_TELEMETRY                             <unset>
...all unset...

===== 6. CHANNEL FEATURE FLAGS =====
{
  "tengu_harbor": true,
  "tengu_harbor_permissions": true,
  "tengu_harbor_ledger": [
    {"marketplace": "claude-plugins-official", "plugin": "discord"},
    {"marketplace": "claude-plugins-official", "plugin": "telegram"},
    {"marketplace": "claude-plugins-official", "plugin": "fakechat"},
    {"marketplace": "claude-plugins-official", "plugin": "imessage"}
  ]
}
```

Note the ledger holds exactly four plugins and Bridge is not among them. That's expected and normal — that's what the dev flag is for.

### Reading section 6

| What you see | What it means |
|---|---|
| `NO CACHED FLAGS` or `NO ~/.claude.json AT THIS PATH` | The flag fetch has **never succeeded**. This is the answer. Go to causes **A** and **B**. |
| `"tengu_harbor": false` | Gate 1 is closed. Go to causes **A**, **B**, **C**. |
| `"tengu_harbor": true` | Inconclusive — see the note below. Go to Step 2. |

`true` is not proof it's working. This file is a *cache* of the last successful fetch, and there's a known bug where the flag evaluates `false` at runtime while the cache still reads `true`. A `true` here narrows things down but doesn't clear gate 1, which is why Step 2 exists.

## Step 2 — get the runtime verdict

This is the decisive one, because it's the live evaluation rather than a cached value.

```bash
claude --debug --dangerously-load-development-channels plugin:bridge@bored-marketplace
```

Accept the "I am using this for local development" prompt. Let it start, then in another WSL terminal:

```bash
grep -i channel ~/.claude/debug/*.txt | tail -20
```

The skip reason names which gate rejected it:

| Message | Which gate | Meaning |
|---|---|---|
| `channels feature is not currently available` | **Gate 1** | Feature switched off for your account. Causes A/B/C. |
| `not on the approved channels allowlist` | **Gate 2** | The dev flag didn't apply. Check the exact command form (below). |
| `not in --channels list for this session` | **Gate 2** | Known bug in some versions — update Claude Code. |
| `Listening for channel messages from: ...` | none | Both gates passed. Problem is elsewhere. |

## Causes and fixes

### A. Telemetry opt-out is blocking the flag fetch

If `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `DISABLE_TELEMETRY` is set (section 4, or the `env` block in section 5), that's very likely it. Those variables block the feature-flag request, and the flag then falls back to its `false` default. Feature entitlement and telemetry unfortunately share one kill switch.

**Fix:** remove the variable **entirely**. Setting it to `0` does *not* work — the key merely existing is enough. Check `~/.bashrc`, `~/.zshrc`, `~/.profile`, and the `env` block of `~/.claude/settings.json`. Then restart Claude Code and re-run section 6.

### B. WSL can't reach the flag service

This is the most likely WSL-specific cause. WSL2 sits behind its own NAT with a separate DNS resolver, and Windows proxy/VPN settings **do not** automatically propagate into the distro. A corporate proxy, VPN, or DNS filter that Windows handles transparently can silently block the request from inside WSL — producing exactly the same `false` default as cause A, with no error anywhere.

**Check:** if section 4 shows proxy variables set, confirm they're actually correct inside WSL. If they're unset but your company requires a proxy, that's the problem. Basic reachability test:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://api.anthropic.com/
```

Anything other than an HTTP status code (hangs, DNS failure, TLS error) means WSL networking is the issue, and that's worth fixing regardless.

### C. Your account isn't in the rollout

The channels feature has been rolled out gradually and some plans have been excluded — there are multiple reports of this. Nothing to configure; the cache flips to `true` when your account is included. If A and B are both clean and gate 1 still reports unavailable, this is where you've landed.

### D. Version

The gate was introduced around 2.1.114. Compare section 1 against **2.1.220**, which is known to work. Update if you're behind.

### E. Wrong command form (gate 2 only)

If gate 1 is fine and you're being rejected at gate 2, the exact invocation matters:

```bash
# correct
claude --dangerously-load-development-channels plugin:bridge@bored-marketplace

# wrong — no marketplace suffix
claude --dangerously-load-development-channels plugin:bridge

# wrong — --channels alone can't work, Bridge isn't on the allowlist
claude --channels plugin:bridge@bored-marketplace
```

Pass the dev flag **on its own**. Adding `--channels` alongside it does not extend the bypass to those entries, and combining them has been reported to fail.

### F. Running the Windows build from inside WSL

If section 1 shows `claude` resolving under `/mnt/c/...`, or section 8 finds a Windows-side `.claude.json`, you may be running the Windows binary via WSL interop. Windows PATH leaks into WSL, so this happens by accident. Native Windows has a separate, unfixed bug where channel notifications are dropped even when everything else works.

**Fix:** install Claude Code inside the WSL distro and make sure `~/.local/bin` (or wherever it lands) comes *before* the `/mnt/c/...` entries in your WSL `PATH`.

## What won't help

- **`channelsEnabled` in managed settings** — tier-gated to `team` and `enterprise` accounts, ignored on personal plans.
- **Editing `cachedGrowthBookFeatures` by hand** — the value is re-evaluated at runtime, so the edit doesn't stick.
- **Reinstalling Bridge, regenerating the token, changing `BRIDGE_CHANNELS`** — none of these touch either gate.

## What to send back

1. Full output of `check.sh`
2. The matching line(s) from Step 2's `grep`
3. Your plan tier (Pro / Max / Team / Enterprise)

That's enough to tell exactly which gate is closing and whether it's fixable on your end.
