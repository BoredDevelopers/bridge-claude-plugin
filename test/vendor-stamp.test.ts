/**
 * The vendored `@bridge/agent-sdk` build is what `tail` and the local feed run on
 * (RFC-022 D6, RFC-018 D5). `VERSION` is `<semver>+<git sha>` of the Bridge repo commit
 * it was built from, with `+dirty` appended when that tree had uncommitted changes.
 *
 * A `+dirty` stamp, or none, means the copy in this repo was never a commit anyone can
 * name — a bug report could not say what code was running. That must not be published.
 */
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const VENDOR = join(import.meta.dir, "..", "vendor", "bridge-agent-sdk");

test("the vendored SDK carries a clean <semver>+<sha> stamp", () => {
  const stamp = readFileSync(join(VENDOR, "VERSION"), "utf8").trim();
  expect(stamp).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{7,40}$/);
});

test("the entry points the plugin imports and launches are present", () => {
  for (const f of ["node.js", "node.d.ts", "core/index.js", "core/index.d.ts", "tail-cli.js"]) {
    expect(existsSync(join(VENDOR, f)), f).toBe(true);
  }
});
