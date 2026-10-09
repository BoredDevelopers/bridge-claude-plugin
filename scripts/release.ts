/**
 * `bun run release` — publish the version on main. Run it on main AFTER the PR that
 * bumps `package.json` + `.claude-plugin/plugin.json` has merged and CI is green.
 *
 *   1. Preflight: HEAD is origin/main, tree clean, the two versions agree and are a
 *      plain x.y.z, tag `v<version>` is absent or already on HEAD, every CI check passed.
 *   2. Prepare the marketplace listing (`BoredDevelopers/bored-marketplace`) from a
 *      FRESH clone: pin `source.ref` + `source.sha`; `claude plugin validate` it.
 *      Nothing has been pushed yet, so any failure so far leaves no trace.
 *   3. Tag `v<version>` (annotated) on HEAD and push it.
 *   4. Commit and push the listing.
 *   5. Print the steps only a person does: the server's recommended version, the post.
 *
 * RESUMABLE: if step 3 or 4 fails (network, a concurrent push to the marketplace), run
 * it again — a tag already on HEAD is kept, a listing already pinned is left alone.
 *
 * WHY PINNED. The listing used to point at this repo with no ref, so every merge to
 * main shipped to anyone who ran `/plugin update`, and the listing's `version` was a
 * hand-kept label that drifted (it said 0.21.0 while 0.27.0 ran). Pinned, a merge
 * ships nothing; a release is this one command.
 *
 * NO `version` IN THE LISTING. Claude Code docs (marketplace reference, Plugin
 * entries): "When `plugin.json` also sets `version`, `plugin.json` takes precedence
 * and `claude plugin validate` warns." It never decided anything — it could only
 * lie. The entry's version is removed; the pinned commit's plugin.json is the version.
 *
 * `--dry-run` runs every check and prints what it would do, changing nothing.
 */
import { $ } from "bun";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLUGIN_REPO = "BoredDevelopers/bridge-claude-plugin";
const MARKETPLACE_REPO = "BoredDevelopers/bored-marketplace";
const MARKETPLACE_FILE = ".claude-plugin/marketplace.json";
const PLUGIN_NAME = "bridge";

/** The version both files declare, or why there isn't one. */
export function releaseVersion(pkg: { version?: unknown }, manifest: { version?: unknown }): string {
  if (pkg.version !== manifest.version) {
    throw new Error(`package.json says ${pkg.version}, .claude-plugin/plugin.json says ${manifest.version} — bump both`);
  }
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    throw new Error(`version ${JSON.stringify(pkg.version)} is not a plain x.y.z`);
  }
  return pkg.version;
}

/** CI on the release commit: at least one check, and every one finished and passed. */
export function ciVerdict(runs: Array<{ name: string; status: string; conclusion: string | null }>): string | null {
  if (runs.length === 0) return "no CI checks on this commit — wait for CI, or push it";
  // Only `success`: an unfinished check (conclusion null) or a skipped one is not proof.
  const bad = runs.filter((r) => r.conclusion !== "success");
  return bad.length ? `CI not green: ${bad.map((r) => `${r.name} (${r.conclusion ?? r.status})`).join(", ")}` : null;
}

/**
 * The listing with the plugin pinned to the release. Returns the new file text; every
 * other plugin and field is left exactly as it was, except the entry's `version`, which
 * is removed (see above). Throws if the plugin is not listed once, or if the listing
 * would go BACKWARDS — older than the tag it pins (or, before the first pinned release,
 * the hand-kept version it still carries).
 */
export function pinListing(text: string, version: string, sha: string): string {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a full commit sha: ${sha}`);
  const listing = JSON.parse(text) as { plugins?: Array<Record<string, any>> };
  const entries = (listing.plugins ?? []).filter((p) => p.name === PLUGIN_NAME);
  if (entries.length !== 1) throw new Error(`expected one "${PLUGIN_NAME}" entry in the listing, found ${entries.length}`);
  const entry = entries[0]!;
  const pinned = typeof entry.source?.ref === "string" ? entry.source.ref.replace(/^v/, "") : entry.version;
  if (typeof pinned === "string" && /^\d+\.\d+\.\d+$/.test(pinned) && compare(version, pinned) < 0) {
    throw new Error(`listing already pins ${pinned}; refusing to go back to ${version}`);
  }
  delete entry.version;
  entry.source = { ...entry.source, ref: `v${version}`, sha };
  return JSON.stringify(listing, null, 2) + "\n";
}

/** The commit an annotated (or lightweight) tag points at, from `git ls-remote` output. */
export function peeled(lsRemote: string): string | null {
  const lines = lsRemote.trim().split("\n").filter(Boolean).map((l) => l.split(/\s+/));
  const deref = lines.find(([, ref]) => ref?.endsWith("^{}"));
  return (deref ?? lines[0])?.[0] ?? null;
}

/**
 * What to do about tag `tag`, so a release that stopped halfway can simply be run
 * again: already on HEAD remotely → done; only locally on HEAD → push it; absent →
 * create and push. On any OTHER commit it refuses — that version was released from
 * somewhere else, and the fix is a new version, never moving a published tag.
 */
export function tagAction(remote: string | null, local: string | null, head: string, tag: string): "create" | "push" | "done" {
  if (remote) {
    if (remote === head) return "done";
    throw new Error(`tag ${tag} is already published at ${remote.slice(0, 7)}, not HEAD ${head.slice(0, 7)} — bump the version`);
  }
  if (local && local !== head) {
    throw new Error(`a local tag ${tag} points at ${local.slice(0, 7)}, not HEAD — delete it (git tag -d ${tag}) and re-run`);
  }
  return local ? "push" : "create";
}

function compare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry-run");
  const step = (msg: string) => console.log(`${dry ? "[dry-run] " : ""}▸ ${msg}`);
  const root = (await $`git rev-parse --show-toplevel`.text()).trim();

  // 1. Preflight. (No `--tags`: a local tag that differs from the remote's would abort
  // the fetch; tags are read below, remote and local separately.)
  await $`git -C ${root} fetch --quiet origin main`;
  const head = (await $`git -C ${root} rev-parse HEAD`.text()).trim();
  const main_ = (await $`git -C ${root} rev-parse origin/main`.text()).trim();
  if (head !== main_) throw new Error(`HEAD ${head.slice(0, 7)} is not origin/main ${main_.slice(0, 7)} — release from main`);
  if ((await $`git -C ${root} status --porcelain`.text()).trim()) throw new Error("working tree is not clean");
  const version = releaseVersion(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
    JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"))
  );
  const tag = `v${version}`;
  // Refs passed as values, not template text: `{…}` is brace syntax in Bun's shell.
  const [tagRef, tagDeref, tagCommit] = [`refs/tags/${tag}`, `refs/tags/${tag}^{}`, `refs/tags/${tag}^{commit}`];
  const remoteTag = peeled(await $`git -C ${root} ls-remote origin ${tagRef} ${tagDeref}`.text());
  const localTag = (await $`git -C ${root} rev-parse -q --verify ${tagCommit}`.nothrow().text()).trim() || null;
  const tagging = tagAction(remoteTag, localTag, head, tag);
  const runs = JSON.parse(
    await $`gh api repos/${PLUGIN_REPO}/commits/${head}/check-runs?per_page=100 --jq '[.check_runs[] | {name, status, conclusion}]'`.text()
  );
  const ci = ciVerdict(runs);
  if (ci) throw new Error(ci);
  step(`${version} at ${head.slice(0, 7)} — ${runs.length} CI checks green`);

  const dir = mkdtempSync(join(tmpdir(), "bored-marketplace-"));
  try {
    // 2. The listing, prepared and validated BEFORE anything is pushed, from a fresh
    // clone so a stale local checkout cannot be what ships.
    await $`git clone --quiet --depth 1 git@github.com:${MARKETPLACE_REPO}.git ${dir}`;
    const file = join(dir, MARKETPLACE_FILE);
    const current = readFileSync(file, "utf8");
    const next = pinListing(current, version, head);
    writeFileSync(file, next);
    // Claude Code's own check of the file it will read; any error stops here.
    await $`claude plugin validate ${dir}`;

    // 3. Tag. Resumable: a run that stopped after tagging finds the tag on HEAD and
    // goes on; a tag on any other commit refuses (tagAction).
    if (tagging === "done") step(`tag ${tag} already on ${head.slice(0, 7)} — kept`);
    else {
      step(`tag ${tag}${tagging === "push" ? " (exists locally)" : ""} and push it`);
      if (!dry) {
        if (tagging === "create") await $`git -C ${root} tag -a ${tag} -m ${`${PLUGIN_NAME} ${version}`} ${head}`;
        await $`git -C ${root} push --quiet origin refs/tags/${tag}`;
      }
    }

    // 4. Pin.
    if (next === current) step(`listing already pins ${tag} — nothing to push`);
    else {
      step(`pin the listing to ${tag} (${head.slice(0, 7)}) and push`);
      if (dry) console.log((await $`git -C ${dir} diff`.text()).trim());
      else {
        await $`git -C ${dir} commit --quiet -am ${`${PLUGIN_NAME} ${version}`}`;
        await $`git -C ${dir} push --quiet origin HEAD:main`;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 5. What only a person does.
  console.log(`
${dry ? "Dry run — nothing was pushed." : `Released ${PLUGIN_NAME} ${version}.`} Then:
  1. Server nudge: set EINWEAVE_CLIENT_RECOMMENDED_CLAUDE_CODE=${version} in the NAS .env, then
     ssh jorgen_admin@thenas "cd /volume1/docker/bridge && sudo /usr/local/bin/docker compose up -d api"
  2. Post it in #einweave → releases.
  3. Each machine: /plugin update ${PLUGIN_NAME}, then restart Claude Code (or turn on auto-update).`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`release: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
