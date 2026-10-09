/**
 * `scripts/release.ts` — the checks that decide whether a release may go out, and the
 * listing edit that pins what users install. The git/gh plumbing around them is
 * exercised by `bun run release --dry-run`; these are the parts that can be wrong
 * silently.
 */
import { test, expect, describe } from "bun:test";
import { ciVerdict, pinListing, releaseVersion } from "../scripts/release";

const SHA = "f4d0019c0ffee0000000000000000000000000ab";
const LISTING = JSON.stringify(
  {
    name: "bored-marketplace",
    plugins: [
      { name: "other", source: { source: "url", url: "https://example.test/other.git" }, version: "9.9.9" },
      {
        name: "bridge",
        source: { source: "url", url: "https://github.com/BoredDevelopers/bridge-claude-plugin.git" },
        version: "0.28.0",
        tags: ["bridge"],
      },
    ],
  },
  null,
  2
);

describe("releaseVersion", () => {
  test("the version both files agree on", () => {
    expect(releaseVersion({ version: "0.28.1" }, { version: "0.28.1" })).toBe("0.28.1");
  });
  test("files that disagree refuse", () => {
    expect(() => releaseVersion({ version: "0.28.1" }, { version: "0.28.0" })).toThrow(/bump both/);
  });
  test("not a plain x.y.z refuses", () => {
    expect(() => releaseVersion({ version: "v0.28.1" }, { version: "v0.28.1" })).toThrow(/plain x\.y\.z/);
  });
});

describe("ciVerdict", () => {
  const ok = { name: "Plugin (Bun 1.3)", status: "completed", conclusion: "success" };
  test("all passed → go", () => {
    expect(ciVerdict([ok, { ...ok, name: "Plugin (Bun 1.4)" }])).toBeNull();
  });
  test("no checks at all refuses — absence is not green", () => {
    expect(ciVerdict([])).toMatch(/no CI checks/);
  });
  test("a failed or unfinished check refuses, and is named", () => {
    expect(ciVerdict([ok, { name: "Plugin (Bun 1.4)", status: "completed", conclusion: "failure" }])).toMatch(/Bun 1\.4.*failure/);
    expect(ciVerdict([{ name: "Plugin (Bun 1.3)", status: "in_progress", conclusion: null }])).toMatch(/in_progress/);
  });
});

describe("pinListing", () => {
  test("pins bridge to the tag and sha, drops its dead version, touches nothing else", () => {
    const out = JSON.parse(pinListing(LISTING, "0.28.1", SHA));
    const bridge = out.plugins.find((p: any) => p.name === "bridge");
    expect(bridge.source).toEqual({
      source: "url",
      url: "https://github.com/BoredDevelopers/bridge-claude-plugin.git",
      ref: "v0.28.1",
      sha: SHA,
    });
    expect(bridge.version).toBeUndefined(); // plugin.json wins; a listing copy can only drift
    expect(bridge.tags).toEqual(["bridge"]);
    expect(out.plugins.find((p: any) => p.name === "other")).toEqual(JSON.parse(LISTING).plugins[0]);
  });
  test("never goes backwards — from the legacy version, then from the pinned tag", () => {
    expect(() => pinListing(LISTING, "0.27.9", SHA)).toThrow(/refusing to go back/);
    const pinned = pinListing(LISTING, "0.28.1", SHA);
    expect(() => pinListing(pinned, "0.28.0", SHA)).toThrow(/already pins 0\.28\.1/);
    expect(JSON.parse(pinListing(pinned, "0.28.2", SHA)).plugins[1].source.ref).toBe("v0.28.2");
  });
  test("a short or non-hex sha refuses", () => {
    expect(() => pinListing(LISTING, "0.28.1", SHA.slice(0, 7))).toThrow(/full commit sha/);
  });
  test("bridge listed zero or two times refuses", () => {
    const none = JSON.stringify({ plugins: [] });
    expect(() => pinListing(none, "0.28.1", SHA)).toThrow(/found 0/);
    const two = JSON.stringify({ plugins: [{ name: "bridge" }, { name: "bridge" }] });
    expect(() => pinListing(two, "0.28.1", SHA)).toThrow(/found 2/);
  });
});
