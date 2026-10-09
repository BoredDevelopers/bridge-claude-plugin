/**
 * `bun run release` — publish the version on main. Run it on main AFTER the PR that
 * bumps `package.json` + `.claude-plugin/plugin.json` has merged and CI is green.
 *
 *   1. Preflight: HEAD is origin/main, tree clean, the two versions agree and are a
 *      plain x.y.z, tag `v<version>` does not exist yet, every CI check on HEAD passed.
 *   2. Tag `v<version>` (annotated) on HEAD and push it.
 *   3. Pin the marketplace listing (`BoredDevelopers/bored-marketplace`) to that tag:
 *      `source.ref` + `source.sha`, from a FRESH clone; `claude plugin validate` it;
 *      commit, push.
 *   4. Print the steps only a person does: the server's recommended version, the post.
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
  // An unfinished check has no conclusion yet (null), so it is refused here too.
  const bad = runs.filter((r) => !["success", "skipped", "neutral"].includes(r.conclusion ?? ""));
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

  // 1. Preflight.
  await $`git -C ${root} fetch --quiet --tags origin main`;
  const head = (await $`git -C ${root} rev-parse HEAD`.text()).trim();
  const main_ = (await $`git -C ${root} rev-parse origin/main`.text()).trim();
  if (head !== main_) throw new Error(`HEAD ${head.slice(0, 7)} is not origin/main ${main_.slice(0, 7)} — release from main`);
  if ((await $`git -C ${root} status --porcelain`.text()).trim()) throw new Error("working tree is not clean");
  const version = releaseVersion(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
    JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"))
  );
  const tag = `v${version}`;
  if ((await $`git -C ${root} ls-remote --tags origin refs/tags/${tag}`.text()).trim()) {
    throw new Error(`tag ${tag} already exists — bump the version first`);
  }
  const runs = JSON.parse(
    await $`gh api repos/${PLUGIN_REPO}/commits/${head}/check-runs --jq '[.check_runs[] | {name, status, conclusion}]'`.text()
  );
  const ci = ciVerdict(runs);
  if (ci) throw new Error(ci);
  step(`${version} at ${head.slice(0, 7)} — ${runs.length} CI checks green`);

  // 2. Tag.
  step(`tag ${tag} and push it`);
  if (!dry) {
    await $`git -C ${root} tag -a ${tag} -m ${`${PLUGIN_NAME} ${version}`} ${head}`;
    await $`git -C ${root} push --quiet origin refs/tags/${tag}`;
  }

  // 3. Listing, from a fresh clone so a stale local checkout cannot be what ships.
  const dir = mkdtempSync(join(tmpdir(), "bored-marketplace-"));
  try {
    await $`git clone --quiet --depth 1 git@github.com:${MARKETPLACE_REPO}.git ${dir}`;
    const file = join(dir, MARKETPLACE_FILE);
    const next = pinListing(readFileSync(file, "utf8"), version, head);
    writeFileSync(file, next);
    // Claude Code's own check of the file it will read; any error stops the push.
    await $`claude plugin validate ${dir}`;
    step(`pin the listing to ${tag} (${head.slice(0, 7)}) and push`);
    if (dry) {
      console.log((await $`git -C ${dir} diff`.text()).trim());
    } else {
      await $`git -C ${dir} commit --quiet -am ${`${PLUGIN_NAME} ${version}`}`;
      await $`git -C ${dir} push --quiet origin HEAD:main`;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 4. What only a person does.
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
