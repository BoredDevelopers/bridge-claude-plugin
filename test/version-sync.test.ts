/**
 * The version lives in TWO files and nothing kept them honest.
 *
 * `package.json` is what the code reads — `server.ts:17-20` imports it and uses
 * it for both the MCP handshake and the `clientVersion` reported to Bridge on
 * auth. `.claude-plugin/plugin.json` is what the marketplace reads to decide
 * whether an installed copy is stale.
 *
 * So a bump to one and not the other is silent and split-brained in the worst
 * direction: the marketplace can believe everyone is current while the running
 * plugin reports something else to the server, or the reverse — users never
 * offered an update for a build that has already shipped. Neither shows up as
 * an error anywhere, and the release step that keeps them aligned is a human
 * remembering to edit two files.
 *
 * Found during the 0.12.0 release, where exactly that hand-sync was required.
 */
import { test, expect } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import manifest from "../.claude-plugin/plugin.json" with { type: "json" };

test("package.json and plugin.json declare the same version", () => {
  expect(manifest.version).toBe(pkg.version);
});

test("the version is a plain semver triple", () => {
  // Guards the typo class that a string comparison alone would accept —
  // "0.12" or "v0.12.0" would still match each other while breaking the
  // marketplace's ordering.
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
});
