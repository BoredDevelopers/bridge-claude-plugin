/**
 * ISO 8601 in the machine's LOCAL time, with its offset: `2026-09-28T14:22:05+02:00`.
 *
 * For every time a person reads (status, model notices). A bare `…Z` got relayed as
 * "12:22 UTC" to someone at 14:22; with the offset the instant is unchanged and still
 * machine-readable, but the wall clock is the local one. Stored records stay UTC.
 * Unparseable input is returned as given, never thrown.
 */
export function localIso(t: string | number | Date): string {
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime())) return String(t);
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}
