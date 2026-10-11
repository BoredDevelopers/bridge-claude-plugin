/**
 * Leftover pre-0.30 BRIDGE_* variables are REFUSED, not ignored (legacy-env.ts): ignoring
 * BRIDGE_PROFILE connects the session as the default agent — the wrong identity.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { legacyEnvProblem } from "../legacy-env";
import { createAgentAuthRoutes } from "./agent-auth-routes";
import { mintAgentToken } from "./agent-auth-stub";

const SERVER = new URL("../server.ts", import.meta.url).pathname;
const ENROLMENT_KEY = mintAgentToken("ek");

describe("legacyEnvProblem", () => {
  test("names each leftover variable with its replacement, and never its value", () => {
    const p = legacyEnvProblem({ BRIDGE_PROFILE: "work", BRIDGE_ENROLMENT_KEY: "sekret-value-123", EINWEAVE_PROFILE: "x" })!;
    expect(p).toContain("BRIDGE_PROFILE → EINWEAVE_PROFILE");
    expect(p).toContain("BRIDGE_ENROLMENT_KEY → EINWEAVE_ENROLMENT_KEY");
    expect(p).not.toContain("sekret-value-123");
    expect(p).not.toContain("work");
  });
  test("the 'wrong identity' warning only when the profile or state dir is among them", () => {
    expect(legacyEnvProblem({ BRIDGE_PROFILE: "w" })).toContain("wrong identity");
    expect(legacyEnvProblem({ BRIDGE_STATE_DIR: "/x" })).toContain("wrong identity");
    const other = legacyEnvProblem({ BRIDGE_CHANNELS: "general", BRIDGE_AUTOCONNECT: "1" })!;
    expect(other).not.toContain("wrong identity");
    expect(other).toContain("silently ignored");
    expect(other).toContain("BRIDGE_CHANNELS → EINWEAVE_CHANNELS");
    expect(other).toContain("BRIDGE_AUTOCONNECT → EINWEAVE_AUTOCONNECT");
  });
  test("nothing set (or only EINWEAVE_ / BRIDGE_TEST_ knobs) → no problem; an empty value still counts as set", () => {
    expect(legacyEnvProblem({ EINWEAVE_PROFILE: "a", BRIDGE_TEST_LIVENESS_MS: "5", PATH: "/bin" })).toBeNull();
    expect(legacyEnvProblem({ BRIDGE_PROFILE: "" })).toContain("BRIDGE_PROFILE");
  });
});

describe("a session with a leftover BRIDGE_PROFILE", () => {
  test("never connects or enrols, and status + tools name the variable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "le-"));
    const requests: string[] = [];
    const agentAuth = createAgentAuthRoutes();
    agentAuth.addEnrolmentKey(ENROLMENT_KEY);
    const stub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        requests.push(new URL(req.url).pathname);
        return (await agentAuth.handle(req)) ?? new Response("no", { status: 404 });
      },
    });
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        EINWEAVE_STATE_DIR: dir,
        EINWEAVE_API_URL: `http://127.0.0.1:${stub.port}`,
        EINWEAVE_ENROLMENT_KEY: ENROLMENT_KEY,
        EINWEAVE_AUTOCONNECT: "1",
        CLAUDE_CODE_SSE_PORT: "",
        BRIDGE_PROFILE: "work",
      } as Record<string, string>,
    });
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      await Bun.sleep(1500);
      const st: any = JSON.parse(((await client.callTool({ name: "status", arguments: {} })) as any).content[0].text);
      expect(st.configured).toBe(false);
      expect(st.auth.problem).toContain("BRIDGE_PROFILE → EINWEAVE_PROFILE");
      expect(st.receiving_messages).toBe(false);
      const tool: any = await client.callTool({ name: "list_channels", arguments: {} });
      expect(tool.content[0].text).toContain("BRIDGE_PROFILE");
      expect(requests).toEqual([]);
    } finally {
      await client.close().catch(() => {});
      stub.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
