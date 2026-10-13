/**
 * Shared harness for tests that run the real MCP server (server.ts over stdio) against the strict
 * agent-auth stub with an enrolled profile: start it, call its tools, read `status`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startAuthStub } from "./agent-auth-stub";
import { enrolledProfile } from "./key-fixtures";

const SERVER = new URL("../server.ts", import.meta.url).pathname;
const SESSION = "11111111-2222-3333-4444-555555555555";

export type Stub = ReturnType<typeof startAuthStub>;

/** One plugin process in `dir` (kept when `keepDir`, so a second process can restart in it). */
export async function withPlugin<T>(
  stub: Stub,
  dir: string,
  env: Record<string, string>,
  fn: (client: Client, notices: () => string[]) => Promise<T>
): Promise<T> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [SERVER],
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dir,
      EINWEAVE_STATE_DIR: dir,
      EINWEAVE_API_URL: stub.url,
      EINWEAVE_AUTOCONNECT: "1",
      EINWEAVE_BROWSER: "none",
      CLAUDE_CODE_SESSION_ID: SESSION,
      CLAUDE_CODE_SSE_PORT: "",
      ...env,
    } as Record<string, string>,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  const seen: string[] = [];
  client.fallbackNotificationHandler = async (n: any) => {
    if (typeof n?.params?.content === "string") seen.push(n.params.content);
  };
  try {
    await client.connect(transport);
    return await fn(client, () => seen);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function setup(env: Record<string, string> = {}, fn: (c: Client, notices: () => string[], stub: Stub, dir: string) => Promise<void>, stubOpts: Parameters<typeof startAuthStub>[0] = {}) {
  const stub = startAuthStub(stubOpts);
  const dir = mkdtempSync(join(tmpdir(), "kind-"));
  try {
    await enrolledProfile(stub, dir);
    await withPlugin(stub, dir, env, (c, n) => fn(c, n, stub, dir));
  } finally {
    stub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function status(client: Client): Promise<any> {
  const r: any = await client.callTool({ name: "status", arguments: {} });
  return JSON.parse(r.content[0].text);
}
export async function connect(client: Client, args: Record<string, unknown>): Promise<string> {
  const r: any = await client.callTool({ name: "connect", arguments: args });
  return r.content?.[0]?.text ?? "";
}
export async function until(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await Bun.sleep(25);
  }
  return pred();
}
