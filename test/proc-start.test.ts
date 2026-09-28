import { expect, test } from "bun:test";
import { procStartOf, legacyProcStartOf, procStartMatches } from "../proc-start";

test("the normalized start time is the same whatever TZ/locale the READER runs in", () => {
  const mine = procStartOf(process.pid);
  expect(mine).not.toBe("");
  const other = Bun.spawnSync(
    ["bun", "-e", `import { procStartOf } from "${import.meta.dir}/../proc-start"; process.stdout.write(procStartOf(${process.pid}))`],
    { env: { ...process.env, TZ: "Asia/Kolkata", LC_ALL: "sv_SE.UTF-8" } }
  );
  expect(new TextDecoder().decode(other.stdout)).toBe(mine);
});

test("a ≤ 0.26.0 record (the reader's local rendering) still matches; anything else does not", () => {
  expect(procStartMatches(process.pid, procStartOf(process.pid))).toBe(true);
  expect(procStartMatches(process.pid, legacyProcStartOf(process.pid))).toBe(true);
  expect(procStartMatches(process.pid, "Thu Jan  1 00:00:00 1970")).toBe(false);
  expect(procStartMatches(process.pid, "")).toBe(false);
});
