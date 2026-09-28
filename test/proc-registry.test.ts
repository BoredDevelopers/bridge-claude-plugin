/** proc-registry.ts (RFC-017 D2): the process registry, in isolation. */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeProc,
  updateProcState,
  removeProc,
  listProcs,
  procsDir,
  PROC_FORMAT,
  __ps,
  __clock,
  type ProcInfo,
} from "../proc-registry";

function tmp() {
  return mkdtempSync(join(tmpdir(), "proc-registry-"));
}

const savedPidAlive = __ps.pidAlive;
const savedProcStartOf = __ps.procStartOf;
const savedNow = __clock.now;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  __ps.pidAlive = savedPidAlive;
  __ps.procStartOf = savedProcStartOf;
  __clock.now = savedNow;
});

function info(over: Partial<ProcInfo> = {}): ProcInfo {
  return {
    pid: process.pid,
    procStart: "fixed-start-time",
    software: "bridge-claude-plugin",
    version: "0.26.0",
    sessionKey: "sess-a",
    profile: "default",
    claudePid: 999,
    tty: "ttys001",
    termProgram: "iTerm.app",
    cwd: "/repo",
    state: "disconnected",
    ...over,
  };
}

describe("writeProc / removeProc", () => {
  test("writes 0600 in a 0700 procs/ directory, with the format field added", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeProc(dir, info({ pid: 12345 }));
    const file = join(procsDir(dir), "12345.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(procsDir(dir)).mode & 0o777).toBe(0o700);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    expect(rec.format).toBe(PROC_FORMAT);
    expect(rec.sessionKey).toBe("sess-a");
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  test("write is atomic — no partial/tmp file left behind", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeProc(dir, info({ pid: 111 }));
    const names = readdirSync(procsDir(dir));
    expect(names).toEqual(["111.json"]);
  });

  test("startedAt is stamped from the injected clock, not passed in", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    __clock.now = () => Date.parse("2026-01-02T03:04:05.000Z");
    writeProc(dir, info({ pid: 1122 }));
    const rec = JSON.parse(readFileSync(join(procsDir(dir), "1122.json"), "utf8"));
    expect(rec.startedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  test("removeProc deletes it; a second call is a harmless no-op", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeProc(dir, info({ pid: 222 }));
    const file = join(procsDir(dir), "222.json");
    expect(existsSync(file)).toBe(true);
    removeProc(dir, 222);
    expect(existsSync(file)).toBe(false);
    expect(() => removeProc(dir, 222)).not.toThrow();
  });
});

describe("updateProcState", () => {
  test("patches state in place, keeping every other field", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeProc(dir, info({ pid: 333, state: "disconnected" }));
    updateProcState(dir, 333, "connected");
    const rec = JSON.parse(readFileSync(join(procsDir(dir), "333.json"), "utf8"));
    expect(rec.state).toBe("connected");
    expect(rec.sessionKey).toBe("sess-a");
  });

  test("a missing record is a no-op, never throws", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(() => updateProcState(dir, 999999, "connected")).not.toThrow();
  });

  test("D8: an unknown key already in the record survives the rewrite (read-modify-write, not a fresh object)", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeProc(dir, info({ pid: 1313 }));
    const file = join(procsDir(dir), "1313.json");
    const withExtra = { ...JSON.parse(readFileSync(file, "utf8")), futureField: "kept-me" };
    writeFileSync(file, JSON.stringify(withExtra));
    updateProcState(dir, 1313, "connected");
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.futureField).toBe("kept-me");
    expect(after.state).toBe("connected");
  });

  test("D8: never rewrites a record at a format newer than this build's own", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeProc(dir, info({ pid: 444 }));
    const file = join(procsDir(dir), "444.json");
    const newer = JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), format: 99 });
    writeFileSync(file, newer);
    updateProcState(dir, 444, "connected");
    expect(readFileSync(file, "utf8")).toBe(newer);
  });
});

describe("listProcs (C10)", () => {
  test("lists a live process (pid alive, procStart matches)", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    __ps.pidAlive = (pid) => pid === 555;
    __ps.procStartOf = (pid) => (pid === 555 ? "start-555" : "");
    writeProc(dir, info({ pid: 555, procStart: "start-555" }));
    const listed = listProcs(dir);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.pid).toBe(555);
  });

  test("a dead pid is swept, not listed", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    __ps.pidAlive = () => false;
    __ps.procStartOf = () => "start-666"; // matches — isolates the pidAlive check specifically
    writeProc(dir, info({ pid: 666, procStart: "start-666" }));
    expect(listProcs(dir)).toEqual([]);
    expect(existsSync(join(procsDir(dir), "666.json"))).toBe(false); // swept
  });

  test("a REUSED pid (same number, different process: procStart mismatch) is swept, not listed", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    __ps.pidAlive = () => true; // something with this pid is alive right now…
    __ps.procStartOf = () => "a-completely-different-start-time"; // …but it is not who wrote this record
    writeProc(dir, info({ pid: 777, procStart: "start-777" }));
    expect(listProcs(dir)).toEqual([]);
    expect(existsSync(join(procsDir(dir), "777.json"))).toBe(false); // swept
  });

  test("finding 11d: an unverifiable procStart (empty at write time) is neither swept nor asserted live — listed with verified:false", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    __ps.pidAlive = () => true;
    __ps.procStartOf = () => ""; // "unknown" is never allowed to compare equal to "unknown"
    writeProc(dir, info({ pid: 888, procStart: "" }));
    const listed = listProcs(dir);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.pid).toBe(888);
    expect(listed[0]!.verified).toBe(false);
    expect(existsSync(join(procsDir(dir), "888.json")), "unverifiable must never be swept — that would be a guess").toBe(true);
  });

  test("finding 11d: `ps` unavailable RIGHT NOW (procStartOf returns \"\") never sweeps a record with a genuine recorded procStart — unverifiable, not dead", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    __ps.pidAlive = () => true; // the pid genuinely is alive (process.kill does not need `ps`)
    __ps.procStartOf = () => ""; // but `ps` itself cannot be run right now (e.g. Windows, or off PATH)
    writeProc(dir, info({ pid: 890, procStart: "a-genuine-recorded-start-time" }));
    const listed = listProcs(dir);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.verified).toBe(false);
    expect(existsSync(join(procsDir(dir), "890.json"))).toBe(true);
  });

  test("finding 11d: a record BOTH sides can compare, and DO agree, is listed verified:true", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    __ps.pidAlive = () => true;
    __ps.procStartOf = () => "start-891";
    writeProc(dir, info({ pid: 891, procStart: "start-891" }));
    const listed = listProcs(dir);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.verified).toBe(true);
  });

  test("excludePid omits the caller's own record without judging its liveness", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    __ps.pidAlive = () => false; // even "dead" by this check — excludePid short-circuits first
    writeProc(dir, info({ pid: 999 }));
    expect(listProcs(dir, 999)).toEqual([]);
    expect(existsSync(join(procsDir(dir), "999.json"))).toBe(true); // NOT swept: never judged at all
  });

  test("D8: a record at a format newer than this build knows is neither listed nor swept", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    __ps.pidAlive = () => false; // would be swept as dead, if this build were allowed to judge it
    writeProc(dir, info({ pid: 1010 }));
    const file = join(procsDir(dir), "1010.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), format: 99 }));
    expect(listProcs(dir)).toEqual([]); // not reported…
    expect(existsSync(file)).toBe(true); // …but never touched either
  });

  test("no procs/ directory at all: empty, never throws", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(listProcs(dir)).toEqual([]);
  });

  test("a corrupt record is treated as absent (swept), like every other store here", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(procsDir(dir), { recursive: true });
    writeFileSync(join(procsDir(dir), "1234.json"), "{not json");
    expect(listProcs(dir)).toEqual([]);
    expect(existsSync(join(procsDir(dir), "1234.json"))).toBe(false);
  });

  test("a non-<pid>.json name in procs/ is ignored", () => {
    const dir = tmp();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(procsDir(dir), { recursive: true });
    writeFileSync(join(procsDir(dir), "not-a-pid.json"), "{}");
    expect(listProcs(dir)).toEqual([]);
    expect(existsSync(join(procsDir(dir), "not-a-pid.json"))).toBe(true); // untouched, not ours to sweep
  });
});
