/**
 * Pure storage for the per-session connect-intent boolean (connect-on-demand
 * feature). Mirrors label-store.ts / test/label-store.test.ts exactly —
 * same cursor-persistence idiom, same atomic tmp+rename write — differing
 * only in filename prefix (`.connect-state-`) and value shape (boolean, not
 * string).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, utimesSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectStateFileFor, readConnectState, writeConnectState, sweepConnectStateFiles } from "../connect-store";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-connect-store-"));
});
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("connectStateFileFor", () => {
  test("returns dir/.connect-state-<key>", () => {
    expect(connectStateFileFor(dir, "abc123")).toBe(join(dir, ".connect-state-abc123"));
  });

  test("sanitises characters outside [a-zA-Z0-9_-]", () => {
    expect(connectStateFileFor(dir, "abc/def:123 ghi!")).toBe(
      join(dir, ".connect-state-abc_def_123_ghi_")
    );
  });
});

describe("writeConnectState / readConnectState", () => {
  test("round-trips true", () => {
    writeConnectState(dir, "sess1", true);
    expect(readConnectState(dir, "sess1")).toBe(true);
  });

  test("round-trips false", () => {
    writeConnectState(dir, "sess2", false);
    expect(readConnectState(dir, "sess2")).toBe(false);
  });

  test("write is atomic — no partial/tmp file left behind", () => {
    writeConnectState(dir, "sess3", true);
    const names = readdirSync(dir);
    expect(names).toEqual([".connect-state-sess3"]);
    expect(names.some((n) => n.includes(".tmp"))).toBe(false);
  });

  test("readConnectState returns undefined when the file is missing", () => {
    expect(readConnectState(dir, "does-not-exist")).toBeUndefined();
  });

  test("creates a non-existent nested directory before writing", () => {
    const nested = join(dir, "a", "b");
    writeConnectState(nested, "sess5", true);
    expect(readConnectState(nested, "sess5")).toBe(true);
  });
});

describe("D8: never clobbers content this store did not write (RFC-017 C7)", () => {
  test("a foreign / future-format file survives a write attempt byte-identical", () => {
    const file = connectStateFileFor(dir, "sess6");
    writeFileSync(file, '{"format":99,"connected":true}');
    const before = readFileSync(file, "utf8");
    writeConnectState(dir, "sess6", false);
    expect(readFileSync(file, "utf8")).toBe(before);
    // Degrades to the caller's own default rather than crashing — never a partial read.
    expect(readConnectState(dir, "sess6")).toBeUndefined();
  });

  test("its OWN values ('0' / '1') are still freely overwritten", () => {
    writeConnectState(dir, "sess7", true);
    writeConnectState(dir, "sess7", false);
    expect(readConnectState(dir, "sess7")).toBe(false);
  });

  test("finding 11e: plain garbage (not a newer-format record) is corrupt — overwritten, not protected forever", () => {
    const file = connectStateFileFor(dir, "sess8");
    writeFileSync(file, "not json at all");
    writeConnectState(dir, "sess8", true);
    expect(readConnectState(dir, "sess8")).toBe(true);
  });

  test("finding 11e: a JSON object with no `format` field (or format 0) is also corrupt, not a newer window's file", () => {
    const file = connectStateFileFor(dir, "sess9");
    writeFileSync(file, '{"connected":true}');
    writeConnectState(dir, "sess9", true);
    expect(readConnectState(dir, "sess9")).toBe(true);

    const file2 = connectStateFileFor(dir, "sess10");
    writeFileSync(file2, '{"format":0,"connected":true}');
    writeConnectState(dir, "sess10", true);
    expect(readConnectState(dir, "sess10")).toBe(true);
  });
});

describe("sweepConnectStateFiles", () => {
  test("removes stale files, keeps fresh ones, and never removes currentPath", () => {
    const maxAgeMs = 24 * 60 * 60 * 1000;
    const oldMtime = new Date(Date.now() - maxAgeMs - 60_000);

    writeConnectState(dir, "stale", true);
    writeConnectState(dir, "fresh", true);
    writeConnectState(dir, "current", true);

    const staleFile = connectStateFileFor(dir, "stale");
    const currentFile = connectStateFileFor(dir, "current");

    // Backdate both the stale file AND the current file — the current file
    // must survive sweep purely because it IS current, not because it's fresh.
    utimesSync(staleFile, oldMtime, oldMtime);
    utimesSync(currentFile, oldMtime, oldMtime);

    sweepConnectStateFiles(dir, currentFile, maxAgeMs);

    expect(existsSync(staleFile), "stale, non-current file must be swept").toBe(false);
    expect(existsSync(connectStateFileFor(dir, "fresh")), "fresh file must remain").toBe(true);
    expect(existsSync(currentFile), "currentPath must never be removed, even when backdated").toBe(true);
  });

  test("never throws on a missing dir", () => {
    const missing = join(dir, "does-not-exist");
    expect(() => sweepConnectStateFiles(missing, join(missing, ".connect-state-x"), 1000)).not.toThrow();
  });
});

/** RFC-017 P0/C8: real 0.25 output (test/fixtures/generate-v025.ts) must still load. */
describe("C8: the v025 fixture loads", () => {
  test("readConnectState reads 0.25's own file", () => {
    const v025 = fileURLToPath(new URL("./fixtures/v025", import.meta.url));
    expect(readConnectState(v025, "fixture-session")).toBe(true);
  });
});
