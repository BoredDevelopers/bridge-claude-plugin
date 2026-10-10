/**
 * RFC-027 §5 / D7 — the one-time move of the credential profile from
 * `~/.claude/channels/bridge` to `~/.einweave`: only the profile and `.env`
 * travel, `.env` keys are renamed, nothing is overwritten, and the old directory
 * is never touched.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyState, resolveStateDir } from "../state-dir";

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) rmSync(cleanups.pop()!, { recursive: true, force: true });
});

function root() {
  const r = mkdtempSync(join(tmpdir(), "ew-mig-"));
  cleanups.push(r);
  return { legacy: join(r, "old"), fresh: join(r, "home", ".einweave") };
}

function seedLegacy(dir: string) {
  mkdirSync(join(dir, "profiles", "work"), { recursive: true });
  mkdirSync(join(dir, "locks"), { recursive: true });
  for (const f of ["key.json", "state", "attempt", "installation.json", "logged-out", "upgrade-required.json"]) writeFileSync(join(dir, f), `root ${f}`, { mode: 0o600 });
  writeFileSync(join(dir, "profiles", "work", "key.json"), "work key", { mode: 0o600 });
  writeFileSync(join(dir, "profiles", "work", "installation.json"), "work inst", { mode: 0o600 });
  mkdirSync(join(dir, "profiles", "Bad Name"), { recursive: true });
  writeFileSync(join(dir, "profiles", "Bad Name", "key.json"), "x");
  writeFileSync(join(dir, ".env"), "BRIDGE_API_URL=https://api.example\nBRIDGE_CHANNELS=general\nOTHER=1\n");
  writeFileSync(join(dir, ".last_seen-abc"), "2026-10-10T00:00:00Z");
  writeFileSync(join(dir, "locks", "abc.lock"), "{}");
  writeFileSync(join(dir, ".session-label-abc"), "label");
}

describe("migrateLegacyState", () => {
  test("carries the profiles and a renamed .env — and nothing else", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    expect(migrateLegacyState(fresh, legacy)).toEqual({ kind: "migrated", profiles: 2, env: true });
    expect(readdirSync(fresh).sort()).toEqual(
      [".env", "attempt", "installation.json", "key.json", "logged-out", "profiles", "state", "upgrade-required.json"].sort(),
    );
    expect(readdirSync(join(fresh, "profiles"))).toEqual(["work"]);
    expect(readFileSync(join(fresh, "profiles", "work", "key.json"), "utf8")).toBe("work key");
    expect(readFileSync(join(fresh, ".env"), "utf8")).toBe("EINWEAVE_API_URL=https://api.example\nEINWEAVE_CHANNELS=general\nOTHER=1\n");
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    expect(statSync(join(fresh, "key.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(fresh, ".env")).mode & 0o777).toBe(0o600);
  });

  test("the old directory is left exactly as it was", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    const before = readdirSync(legacy).sort();
    migrateLegacyState(fresh, legacy);
    expect(readdirSync(legacy).sort()).toEqual(before);
    expect(readFileSync(join(legacy, ".env"), "utf8")).toContain("BRIDGE_API_URL=");
  });

  test("never runs when the new directory exists (even empty of a profile), or there is nothing to move", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    mkdirSync(join(fresh, "ctl"), { recursive: true });
    expect(migrateLegacyState(fresh, legacy)).toEqual({ kind: "not-needed" });
    expect(existsSync(join(fresh, "key.json"))).toBe(false);
    const other = root();
    expect(migrateLegacyState(other.fresh, other.legacy)).toEqual({ kind: "not-needed" });
    expect(existsSync(other.fresh)).toBe(false);
  });

  test("a second run is a no-op; the first result stands", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    migrateLegacyState(fresh, legacy);
    writeFileSync(join(legacy, "key.json"), "rotated later in the old dir");
    expect(migrateLegacyState(fresh, legacy)).toEqual({ kind: "not-needed" });
    expect(readFileSync(join(fresh, "key.json"), "utf8")).toBe("root key.json");
  });

  test("a legacy dir with no profile and no .env still yields an (empty) new dir, no crash", () => {
    const { legacy, fresh } = root();
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, ".last_seen"), "x");
    expect(migrateLegacyState(fresh, legacy)).toEqual({ kind: "migrated", profiles: 0, env: false });
    expect(readdirSync(fresh)).toEqual([]);
  });

  test("no leftover temp directories", () => {
    const { legacy, fresh } = root();
    seedLegacy(legacy);
    migrateLegacyState(fresh, legacy);
    expect(readdirSync(join(fresh, "..")).filter((n) => n.includes("migrating"))).toEqual([]);
  });
});

describe("resolveStateDir", () => {
  test("EINWEAVE_STATE_DIR wins; BRIDGE_STATE_DIR is ignored; default ~/.einweave", () => {
    expect(resolveStateDir({ EINWEAVE_STATE_DIR: "/x" })).toBe("/x");
    expect(resolveStateDir({ BRIDGE_STATE_DIR: "/y" }).endsWith("/.einweave")).toBe(true);
  });
});
