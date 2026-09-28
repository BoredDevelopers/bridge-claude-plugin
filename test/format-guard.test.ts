/** format-guard.ts (RFC-017 D8): the on-disk format guard, in isolation. */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVersioned, isNewerFormat, KNOWN_FORMAT } from "../format-guard";

function tmp() {
  return mkdtempSync(join(tmpdir(), "format-guard-"));
}

describe("readVersioned", () => {
  test("a missing file is absent", () => {
    const dir = tmp();
    try {
      expect(readVersioned(join(dir, "nope.json"))).toEqual({ kind: "absent" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("corrupt JSON is absent, same as today's behaviour", () => {
    const dir = tmp();
    try {
      const p = join(dir, "x.json");
      writeFileSync(p, "{not json");
      expect(readVersioned(p).kind).toBe("absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a JSON array or a bare scalar is absent — this guard is for objects only", () => {
    const dir = tmp();
    try {
      const arr = join(dir, "arr.json");
      writeFileSync(arr, "[1,2,3]");
      expect(readVersioned(arr).kind).toBe("absent");
      const scalar = join(dir, "scalar.json");
      writeFileSync(scalar, "42");
      expect(readVersioned(scalar).kind).toBe("absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing `format` field reads as format 0 — every file 0.25 ever wrote", () => {
    const dir = tmp();
    try {
      const p = join(dir, "x.json");
      writeFileSync(p, JSON.stringify({ a: 1 }));
      expect(readVersioned<{ a: number }>(p)).toEqual({ kind: "ok", format: 0, data: { a: 1 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("format exactly at knownMax is ok; one past it is newer", () => {
    const dir = tmp();
    try {
      const p = join(dir, "x.json");
      writeFileSync(p, JSON.stringify({ format: 5, a: 1 }));
      expect(readVersioned<{ a: number; format?: number }>(p, 5)).toEqual({ kind: "ok", format: 5, data: { format: 5, a: 1 } });
      expect(readVersioned(p, 4)).toEqual({ kind: "newer", format: 5 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-numeric or negative `format` field is treated as 0, not trusted verbatim", () => {
    const dir = tmp();
    try {
      const p1 = join(dir, "x.json");
      writeFileSync(p1, JSON.stringify({ format: "99" }));
      expect(readVersioned(p1, 0).kind).toBe("ok");
      const p2 = join(dir, "y.json");
      writeFileSync(p2, JSON.stringify({ format: -1 }));
      expect(readVersioned(p2, 0).kind).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("KNOWN_FORMAT is 0 today — nothing in this release bumps it", () => {
    expect(KNOWN_FORMAT).toBe(0);
  });
});

describe("isNewerFormat", () => {
  test("true only for a genuinely higher format; false for absent, corrupt, and known formats", () => {
    const dir = tmp();
    try {
      expect(isNewerFormat(join(dir, "absent.json"))).toBe(false);
      const corrupt = join(dir, "corrupt.json");
      writeFileSync(corrupt, "{{{");
      expect(isNewerFormat(corrupt)).toBe(false);
      const known = join(dir, "known.json");
      writeFileSync(known, JSON.stringify({ format: 0 }));
      expect(isNewerFormat(known)).toBe(false);
      const newer = join(dir, "newer.json");
      writeFileSync(newer, JSON.stringify({ format: 1 }));
      expect(isNewerFormat(newer)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
