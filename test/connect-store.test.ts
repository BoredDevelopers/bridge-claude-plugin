/**
 * Pure storage for the per-session connect-intent boolean (connect-on-demand
 * feature). Mirrors label-store.ts / test/label-store.test.ts exactly —
 * same cursor-persistence idiom, same atomic tmp+rename write — differing
 * only in filename prefix (`.connect-state-`) and value shape (boolean, not
 * string).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, utimesSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectStateFileFor, readConnectState, writeConnectState, sweepConnectStateFiles, connectKindFileFor, readConnectKind, writeConnectKind, readScopeSet, writeScopeSet, connectScopeFileFor, touchSessionFiles } from "../connect-store";

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


describe("RFC-028 D1: the declared kind rides in its own file", () => {
  test("round-trips, and the 0/1 intent file a 0.30 window reads is untouched", () => {
    writeConnectState(dir, "k", true);
    writeConnectKind(dir, "k", "gateway");
    expect(readConnectKind(dir, "k")).toBe("gateway");
    expect(readConnectState(dir, "k")).toBe(true);
    expect(readFileSync(connectStateFileFor(dir, "k"), "utf8")).toBe("1\n");
    writeConnectKind(dir, "k", "session");
    expect(readConnectKind(dir, "k")).toBe("session");
  });

  test("no file, and content this store did not write, read as undefined (never a crash, never a kind)", () => {
    expect(readConnectKind(dir, "none")).toBeUndefined();
    writeFileSync(connectKindFileFor(dir, "junk"), "observer\n");
    expect(readConnectKind(dir, "junk")).toBeUndefined();
  });

  test("the sweep removes a stale kind file but keeps the current key's, backdated or not", () => {
    const maxAgeMs = 24 * 60 * 60 * 1000;
    const old = new Date(Date.now() - maxAgeMs - 60_000);
    writeConnectKind(dir, "stale", "gateway");
    writeConnectKind(dir, "current", "gateway");
    utimesSync(connectKindFileFor(dir, "stale"), old, old);
    utimesSync(connectKindFileFor(dir, "current"), old, old);
    sweepConnectStateFiles(dir, connectStateFileFor(dir, "current"), maxAgeMs, connectKindFileFor(dir, "current"));
    expect(existsSync(connectKindFileFor(dir, "stale"))).toBe(false);
    expect(existsSync(connectKindFileFor(dir, "current"))).toBe(true);
  });
});

describe("RFC-028 D6: the scope-set marker, and keeping a live window's files out of the sweep", () => {
  test("round-trips; a missing file reads false", () => {
    expect(readScopeSet(dir, "k")).toBe(false);
    writeScopeSet(dir, "k");
    expect(readScopeSet(dir, "k")).toBe(true);
  });

  test("touching a window's files refreshes their age, so another window's 24 h sweep leaves them alone", () => {
    const maxAgeMs = 24 * 60 * 60 * 1000;
    const old = new Date(Date.now() - maxAgeMs - 60_000);
    writeConnectState(dir, "alive", true);
    writeConnectKind(dir, "alive", "gateway");
    writeScopeSet(dir, "alive");
    for (const f of [connectStateFileFor(dir, "alive"), connectKindFileFor(dir, "alive"), connectScopeFileFor(dir, "alive")]) utimesSync(f, old, old);
    touchSessionFiles(dir, "alive");
    sweepConnectStateFiles(dir, connectStateFileFor(dir, "someone-else"), maxAgeMs);
    expect(readConnectKind(dir, "alive")).toBe("gateway");
    expect(readScopeSet(dir, "alive")).toBe(true);
    expect(readConnectState(dir, "alive")).toBe(true);
    // Control: untouched, the connect-state file ages out -- and with it, now, the window's kind and scope records.
    utimesSync(connectStateFileFor(dir, "alive"), old, old);
    sweepConnectStateFiles(dir, connectStateFileFor(dir, "someone-else"), maxAgeMs);
    expect(readConnectState(dir, "alive")).toBeUndefined();
    expect(readConnectKind(dir, "alive")).toBeUndefined();
    expect(readScopeSet(dir, "alive")).toBe(false);
  });

  test("a person's kind and scope choices survive an idle night: they are swept only when the window's connect-state file is gone, never on their own age", () => {
    const maxAgeMs = 24 * 60 * 60 * 1000;
    const old = new Date(Date.now() - 3 * maxAgeMs);
    writeConnectState(dir, "idle", true); // the window's own record is young (it was used today)
    writeConnectKind(dir, "idle", "gateway");
    writeScopeSet(dir, "idle");
    for (const f of [connectKindFileFor(dir, "idle"), connectScopeFileFor(dir, "idle")]) utimesSync(f, old, old);
    sweepConnectStateFiles(dir, connectStateFileFor(dir, "someone-else"), maxAgeMs);
    expect(readConnectKind(dir, "idle")).toBe("gateway");
    expect(readScopeSet(dir, "idle")).toBe(true);
  });

  test("records whose window is gone (no connect-state file) are removed, young or old; the current key's are never", () => {
    const maxAgeMs = 24 * 60 * 60 * 1000;
    writeConnectKind(dir, "gone", "gateway");
    writeScopeSet(dir, "gone");
    writeConnectKind(dir, "me", "gateway");
    writeScopeSet(dir, "me");
    sweepConnectStateFiles(dir, connectStateFileFor(dir, "me"), maxAgeMs, connectKindFileFor(dir, "me"), connectScopeFileFor(dir, "me"));
    expect(readConnectKind(dir, "gone")).toBeUndefined();
    expect(readScopeSet(dir, "gone")).toBe(false);
    expect(readConnectKind(dir, "me")).toBe("gateway");
    expect(readScopeSet(dir, "me")).toBe(true);
  });
});
