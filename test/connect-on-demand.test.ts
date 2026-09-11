/**
 * connect-on-demand, Task 2: staying alive when unconfigured.
 *
 * Today server.ts calls `process.exit(1)` at startup when BRIDGE_API_URL /
 * BRIDGE_TOKEN are missing, so an unconfigured install gets a dead MCP
 * server instead of working tools + guidance. This spawns server.ts with NO
 * BRIDGE_TOKEN (and no BRIDGE_API_URL) and drives it over stdio MCP, like
 * session-rename-tool.test.ts does — the only assertion that actually proves
 * "stays alive" is a successful `tools/list` round trip, since a dead child
 * would leave the request hanging (or the transport erroring on a closed
 * pipe) rather than resolving.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = new URL("../server.ts", import.meta.url).pathname;

describe("connect-on-demand: unconfigured startup", () => {
  test("stays alive and answers tools/list when unconfigured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cod-unconfigured-"));
    // Start from the real env (so `bun` resolves etc.), then strip the two
    // vars server.ts currently treats as required — a leftover BRIDGE_TOKEN
    // in the ambient env would silently defeat the "unconfigured" premise.
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    delete env.BRIDGE_API_URL;
    delete env.BRIDGE_TOKEN;
    env.CLAUDE_PLUGIN_DATA = dir;
    env.BRIDGE_STATE_DIR = dir;

    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const result = await client.listTools();
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools.length).toBeGreaterThan(0);
    } finally {
      await client.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
