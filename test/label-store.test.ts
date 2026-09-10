/**
 * Pure storage for the per-session display label (rename feature, P1).
 *
 * Keyed by SESSION_KEY (resume-stable), NOT CLAUDE_CODE_SESSION_ID (which
 * changes on every `--continue` — see server.ts:94-111). Mirrors the cursor
 * persistence idiom at server.ts:452-507 (cursorFileFor / readCursorFile /
 * atomic tmp+rename write / sweepCursors), but as a pure module with no
 * top-level side effects so it can be unit-tested directly — server.ts itself
 * has zero exports and runs `connectUnlessDuplicate()` on load.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { labelFileFor, readLabelFile, writeLabelFile, clearLabelFile, sweepLabelFiles } from "../label-store";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-label-store-"));
});
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("labelFileFor", () => {
  test("returns dir/.session-label-<key>", () => {
    expect(labelFileFor(dir, "abc123")).toBe(join(dir, ".session-label-abc123"));
  });

  test("sanitises characters outside [a-zA-Z0-9_-]", () => {
    expect(labelFileFor(dir, "abc/def:123 ghi!")).toBe(
      join(dir, ".session-label-abc_def_123_ghi_")
    );
  });
});

describe("writeLabelFile / readLabelFile", () => {
  test("round-trips a plain label", () => {
    writeLabelFile(dir, "sess1", "Researcher");
    expect(readLabelFile(dir, "sess1")).toBe("Researcher");
  });

  test("round-trips a label with spaces and unicode", () => {
    const label = "Jörgen's Café Session 🌍 v2";
    writeLabelFile(dir, "sess2", label);
    expect(readLabelFile(dir, "sess2")).toBe(label);
  });

  test("write is atomic — no partial/tmp file left behind", () => {
    writeLabelFile(dir, "sess3", "Atomic Test");
    const names = readdirSync(dir);
    expect(names).toEqual([".session-label-sess3"]);
    expect(names.some((n) => n.includes(".tmp"))).toBe(false);
  });

  test("readLabelFile returns null when the file is missing", () => {
    expect(readLabelFile(dir, "does-not-exist")).toBeNull();
  });
});

describe("clearLabelFile", () => {
  test("removes a stored label so readLabelFile returns null", () => {
    writeLabelFile(dir, "sess4", "To Be Cleared");
    expect(readLabelFile(dir, "sess4")).toBe("To Be Cleared");
    clearLabelFile(dir, "sess4");
    expect(readLabelFile(dir, "sess4")).toBeNull();
  });

  test("clearing a missing file is a no-op", () => {
    expect(() => clearLabelFile(dir, "never-existed")).not.toThrow();
    expect(readLabelFile(dir, "never-existed")).toBeNull();
  });
});

describe("sweepLabelFiles", () => {
  test("removes stale files, keeps fresh ones, and never removes currentPath", () => {
    const maxAgeMs = 24 * 60 * 60 * 1000;
    const oldMtime = new Date(Date.now() - maxAgeMs - 60_000);

    writeLabelFile(dir, "stale", "Stale Session");
    writeLabelFile(dir, "fresh", "Fresh Session");
    writeLabelFile(dir, "current", "Current Session");

    const staleFile = labelFileFor(dir, "stale");
    const currentFile = labelFileFor(dir, "current");

    // Backdate both the stale file AND the current file — the current file
    // must survive sweep purely because it IS current, not because it's fresh.
    utimesSync(staleFile, oldMtime, oldMtime);
    utimesSync(currentFile, oldMtime, oldMtime);

    sweepLabelFiles(dir, currentFile, maxAgeMs);

    expect(existsSync(staleFile), "stale, non-current file must be swept").toBe(false);
    expect(existsSync(labelFileFor(dir, "fresh")), "fresh file must remain").toBe(true);
    expect(existsSync(currentFile), "currentPath must never be removed, even when backdated").toBe(true);
  });
});
