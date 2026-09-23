/**
 * Every test stub binds 127.0.0.1 — never Bun.serve's wildcard default.
 *
 * WHY (measured 2026-09-23). The plugin tests intermittently failed with
 * "plugin never connected to the stub": the plugin's WebSocket errored on every
 * retry while the stub sat listening. The stubs used `Bun.serve({ port: 0 })`,
 * a WILDCARD bind on a random port, and the plugin connects to 127.0.0.1:<port>.
 * macOS lets a wildcard bind take a port another process already holds on
 * 127.0.0.1 specifically — and connections to 127.0.0.1:<port> then reach THAT
 * process, not the stub. Proven directly: a wildcard Bun.serve bound Ollama's
 * 127.0.0.1 port without error, and a GET to it came back as Ollama's HTML.
 * With ~68 apps (editors, language servers, Ollama, Figma…) on loopback ports
 * in the ephemeral range, ~0.4% of stub starts collided — about a 40% chance
 * of one failure per full run.
 *
 * Binding 127.0.0.1 explicitly makes the kernel refuse a taken port, so the
 * collision cannot happen. This test keeps a new stub from reintroducing it.
 */
import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("every Bun.serve stub in test/ binds hostname 127.0.0.1", () => {
  const offenders: string[] = [];
  for (const f of readdirSync(import.meta.dir)) {
    if (!f.endsWith(".ts") || f === "stub-loopback-bind.test.ts") continue;
    const src = readFileSync(join(import.meta.dir, f), "utf8");
    // The options object of each Bun.serve call, up to its handler — where
    // port/hostname are declared in every stub here.
    for (const m of src.matchAll(/Bun\.serve\(\{([\s\S]*?)(?:fetch|websocket)\b/g)) {
      if (!/hostname:\s*"127\.0\.0\.1"/.test(m[1]!)) {
        offenders.push(`${f}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
