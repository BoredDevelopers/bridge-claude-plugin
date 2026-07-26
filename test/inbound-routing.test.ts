/**
 * Inbound delivery, end to end: real plugin process, real Bridge server.
 *
 * WHY THIS EXISTS
 * 0.11.0 shipped `ReferenceError: senderContextId is not defined` in the inbound
 * path. Every message threw, the throw was caught and written to stderr, and the
 * MCP host discards stderr — so a total delivery outage was indistinguishable
 * from a quiet channel. It went unnoticed for hours and was only found by
 * running the plugin with stderr attached.
 *
 * Two classes of test would have caught it, and both are now in place:
 *   - `bun run typecheck` (tsconfig.json) — catches the scope error statically
 *   - this file — catches ANY inbound regression behaviourally
 *
 * WHAT IT PINS
 *   A  subscribed channel, untargeted   -> surfaces
 *   B  other channel,     untargeted    -> filtered (BRIDGE_CHANNELS honoured)
 *   C  other channel,     TARGETED      -> surfaces anyway
 *
 * C is the one that matters most: a message addressed to THIS session must
 * arrive regardless of channel subscriptions. B is its control — without it,
 * "C surfaced" could just mean the filter never ran.
 *
 * Requires the Bridge server repo. Set BRIDGE_API_DIR to
 * <bridge>/packages/api, or the suite skips rather than passing vacuously.
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const API_DIR = process.env.BRIDGE_API_DIR ?? "";
const HAVE_SERVER = !!API_DIR && (await Bun.file(join(API_DIR, "src/index.ts")).exists().catch(() => false));

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!HAVE_SERVER)("inbound routing", () => {
  test(
    "targeted messages bypass the channel filter; untargeted ones respect it",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "bridge-plugin-test-"));
      const dbPath = join(dir, "t.db");

      const seed = Bun.spawn(
        ["bun", "-e", `import("${join(API_DIR, "src/db/index.ts")}").then(()=>process.exit(0))`],
        { env: { ...process.env, DB_PATH: dbPath }, stdout: "ignore", stderr: "pipe" }
      );
      if ((await seed.exited) !== 0) throw new Error(await new Response(seed.stderr).text());

      const TOK_ME = "tok-me", TOK_OTHER = "tok-other";
      const db = new Database(dbPath);
      db.prepare("INSERT INTO agents (id,name,token_hash,created_at) VALUES (?,?,?,?)")
        .run("me", "Me", sha(TOK_ME), Date.now());
      db.prepare("INSERT INTO agents (id,name,token_hash,created_at) VALUES (?,?,?,?)")
        .run("other", "Other", sha(TOK_OTHER), Date.now());
      // NOT `me-tasks`: an agent's own task channel bypasses the filter by
      // design (it is its inbox), so using it as the "filtered" case would be a
      // control that cannot fail. `other-tasks` models the real situation —
      // another agent's channel that we are not subscribed to.
      for (const c of ["general", "other-tasks"]) {
        db.prepare("INSERT INTO channels (id,name,created_at) VALUES (?,?,?)").run(c, c, Date.now());
        // Interest in BOTH, including the filtered one: without it the server
        // never routes the untargeted message at all, and case B would pass
        // because nothing was sent rather than because the client dropped it.
        db.prepare(
          "INSERT OR IGNORE INTO agent_interests (agent_id, interest_type, interest_value) VALUES (?, 'channel', ?)"
        ).run("me", c);
      }

      const PORT = String(4700 + Math.floor(Number(process.hrtime.bigint() % 200n)));
      const URL_ = `http://localhost:${PORT}`;
      const server = Bun.spawn(["bun", join(API_DIR, "src/index.ts")], {
        env: {
          ...process.env, DB_PATH: dbPath, PORT,
          FORGE_OIDC_CLIENT_SECRET: "x",
          BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
          NODE_ENV: "test",
        },
        stdout: "ignore", stderr: "ignore",
      });
      let up = false;
      for (let i = 0; i < 80 && !up; i++) {
        try { up = (await fetch(`${URL_}/api/health`)).ok; } catch {}
        if (!up) await sleep(250);
      }
      expect(up, "bridge server did not start").toBe(true);

      const plugin = Bun.spawn(["bun", join(import.meta.dir, "..", "server.ts")], {
        env: {
          ...process.env,
          BRIDGE_API_URL: URL_, BRIDGE_TOKEN: TOK_ME,
          BRIDGE_CHANNELS: "general",          // deliberately NOT other-tasks
          BRIDGE_SESSION_KEY: "test-session",
          BRIDGE_STATE_DIR: dir, CLAUDE_PLUGIN_DATA: dir, CLAUDE_PROJECT_DIR: dir,
        },
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });

      const notes: any[] = [];
      const errLines: string[] = [];
      (async () => {
        const dec = new TextDecoder(); let buf = "";
        for await (const chunk of plugin.stdout as any) {
          buf += dec.decode(chunk);
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (line.trim()) { try { notes.push(JSON.parse(line)); } catch {} }
          }
        }
      })();
      (async () => {
        const dec = new TextDecoder();
        for await (const chunk of plugin.stderr as any) {
          for (const l of dec.decode(chunk).split("\n")) if (l.trim()) errLines.push(l);
        }
      })();

      const rpc = (o: any) => plugin.stdin.write(JSON.stringify(o) + "\n");
      rpc({ jsonrpc: "2.0", id: 1, method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
      await sleep(1500);
      rpc({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      await sleep(3500);

      const ctx = (db.prepare("SELECT id FROM agent_contexts WHERE agent_id='me'").get() as any)?.id;
      expect(ctx, "plugin never registered a context").toBeTruthy();

      const post = (channelId: string, content: string, contextId?: string) =>
        fetch(`${URL_}/api/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOK_OTHER}`, "Content-Type": "application/json" },
          body: JSON.stringify({ channelId, content, ...(contextId ? { contextId } : {}) }),
        }).then((r) => r.json());

      const count = () => notes.filter((n) => n.method === "notifications/claude/channel").length;

      const a0 = count(); await post("general", "A"); await sleep(2500);
      const gotA = count() > a0;
      const b0 = count(); await post("other-tasks", "B"); await sleep(2500);
      const gotB = count() > b0;
      const c0 = count(); await post("other-tasks", "C", ctx); await sleep(3000);
      const gotC = count() > c0;

      // The inbound path must never throw. This is the assertion that would
      // have caught 0.11.0 on the very first message.
      const threw = errLines.filter((l) => l.includes("inbound handler failed"));
      plugin.kill(); server.kill();

      expect(threw, `inbound handler threw: ${threw.join(" | ")}`).toEqual([]);
      expect(gotA, "subscribed + untargeted should surface").toBe(true);
      expect(gotB, "unsubscribed + untargeted should be filtered").toBe(false);
      expect(gotC, "TARGETED at this session must surface regardless of filter").toBe(true);
      expect(errLines.some((l) => l.includes("FILTERED ch=other-tasks")),
        "expected the client filter to log the drop").toBe(true);
    },
    120_000
  );
});
