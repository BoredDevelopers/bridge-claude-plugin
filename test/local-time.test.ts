import { afterAll, expect, test } from "bun:test";
import { localIso } from "../local-time";

const TZ = process.env.TZ;
afterAll(() => {
  if (TZ === undefined) delete process.env.TZ;
  else process.env.TZ = TZ;
});

test("renders the local wall clock with its offset — the same instant, not UTC", () => {
  process.env.TZ = "Europe/Stockholm";
  const s = localIso("2026-09-28T12:22:05.123Z");
  expect(s).toBe("2026-09-28T14:22:05+02:00");
  expect(new Date(s).getTime()).toBe(new Date("2026-09-28T12:22:05Z").getTime());
});

test("negative offsets, and epoch-ms input", () => {
  process.env.TZ = "America/New_York";
  expect(localIso(Date.UTC(2026, 0, 15, 12, 0, 0))).toBe("2026-01-15T07:00:00-05:00");
});

test("half-hour offsets keep their minutes", () => {
  process.env.TZ = "Asia/Kolkata";
  expect(localIso("2026-09-28T12:00:00Z")).toBe("2026-09-28T17:30:00+05:30");
});

test("unparseable input comes back unchanged, never throws", () => {
  expect(localIso("not a date")).toBe("not a date");
});
