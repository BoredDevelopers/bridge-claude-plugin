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
 * ── HOW TO RUN IT ────────────────────────────────────────────────────────────
 * Two things are required, and the test SKIPS rather than passing vacuously if
 * either is missing:
 *
 *   BRIDGE_API_DIR            <bridge>/packages/api
 *   BRIDGE_TEST_PG_ADMIN_URL  a Postgres 18 to create scratch databases in.
 *                             Defaults to the server repo's test container
 *                             (`docker compose -f docker-compose.test.yml up -d`
 *                             in that repo, or `bun run test` there).
 *
 * ⚠️ REWRITTEN 2026-08-02, AND THE REASON MATTERS. This test seeded SQLite via
 * `bun:sqlite` and a `DB_PATH`, relying on `src/db/index.ts` building the schema
 * as an import side effect. The server repo retired SQLite for Postgres, which
 * deleted DB_PATH and moved schema creation into `runMigrations()`. Because the
 * gate above is an env var nobody sets, NONE of that was noticed: the test kept
 * reporting `(skip)` and the suite kept reporting green, for the one subsystem
 * that has already shipped a total outage. Wired up, it failed with `no such
 * table: agents`.
 *
 * The seeding below therefore goes through the SERVER'S OWN drizzle schema
 * rather than hand-written SQL. Hand-written column lists are exactly what
 * rotted: they keep parsing long after the schema has moved. Going through
 * `schema.pg` means a rename breaks this file loudly instead of silently.
 */
import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const API_DIR = process.env.BRIDGE_API_DIR ?? "";
const HAVE_SERVER = !!API_DIR && (await Bun.file(join(API_DIR, "src/index.ts")).exists().catch(() => false));

// Same default as the server repo's scripts/run-tests.ts, so a developer who
// has that suite working already has this one working.
const ADMIN_URL =
  process.env.BRIDGE_TEST_PG_ADMIN_URL ?? "postgres://bridge:bridge-test-not-a-secret@127.0.0.1:5433/bridge";

/** Is there actually a Postgres behind ADMIN_URL? Probe, don't assume. */
async function pgReachable(): Promise<boolean> {
  try {
    const probe = new Bun.SQL(ADMIN_URL);
    await probe`SELECT 1`;
    await probe.close();
    return true;
  } catch {
    return false;
  }
}
const HAVE_PG = HAVE_SERVER ? await pgReachable() : false;

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Torn down in afterAll so a failed assertion cannot leak a scratch database.
let dropDb: (() => Promise<void>) | null = null;
afterAll(async () => {
  if (dropDb) await dropDb();
});

describe.skipIf(!HAVE_SERVER || !HAVE_PG)("inbound routing", () => {
  test(
    "targeted messages bypass the channel filter; untargeted ones respect it",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "bridge-plugin-test-"));

      // ── a scratch database, created and dropped by this test ───────────────
      // A unique name per run: this suite may run concurrently with the server
      // repo's own, which uses `bridge_test_*` against the same instance.
      const dbName = `bridge_plugin_it_${Date.now()}_${process.pid}`;
      const admin = new Bun.SQL(ADMIN_URL);
      await admin.unsafe(`CREATE DATABASE "${dbName}"`);
      const dbUrl = ADMIN_URL.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);

      // The pool below must be closed before the database can be dropped, so
      // both live in the teardown closure rather than in the test body.
      let closeApiPool: (() => Promise<void>) | null = null;
      dropDb = async () => {
        try { if (closeApiPool) await closeApiPool(); } catch {}
        try { await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); } catch {}
        try { await admin.close(); } catch {}
        dropDb = null;
      };

      // ⚠️ MIGRATE EXPLICITLY. `src/index.ts` — what `bun start` and the spawn
      // below run — does NOT create the schema; only `entrypoint.ts` calls
      // `runMigrations()`, and that is the Docker path. Starting the server
      // against an empty database without this line yields a server that boots
      // and then fails on every query.
      process.env.DATABASE_URL = dbUrl;
      const api: any = await import(join(API_DIR, "src/db/index.ts"));
      await api.runMigrations();
      closeApiPool = async () => { await api.closePool(); };

      const TOK_ME = "tok-me", TOK_OTHER = "tok-other";
      const { db, schema } = api;

      // Only the NOT NULL columns are set; `created_at` and friends carry schema
      // defaults. Fewer fields named here is fewer things to rot.
      await db.insert(schema.agents).values([
        { id: "me", name: "Me", tokenHash: sha(TOK_ME) },
        { id: "other", name: "Other", tokenHash: sha(TOK_OTHER) },
      ]);

      // NOT `me-tasks`: an agent's own task channel bypasses the filter by
      // design (it is its inbox), so using it as the "filtered" case would be a
      // control that cannot fail. `other-tasks` models the real situation —
      // another agent's channel that we are not subscribed to.
      for (const c of ["general", "other-tasks"]) {
        await db.insert(schema.channels).values({ id: c, name: c });
        // Interest in BOTH, including the filtered one: without it the server
        // never routes the untargeted message at all, and case B would pass
        // because nothing was sent rather than because the client dropped it.
        await db
          .insert(schema.agentInterests)
          .values({ agentId: "me", interestType: "channel", interestValue: c })
          .onConflictDoNothing();
      }

      const PORT = String(4700 + Math.floor(Number(process.hrtime.bigint() % 200n)));
      const URL_ = `http://localhost:${PORT}`;
      const server = Bun.spawn(["bun", join(API_DIR, "src/index.ts")], {
        env: {
          ...process.env, DATABASE_URL: dbUrl, PORT,
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

      // `pool` is the documented raw escape hatch for the few statements drizzle
      // cannot express; a one-column lookup does not warrant importing drizzle's
      // operators into this repo. Parameterised, and deliberately UNNAMED — a
      // named prepared statement is the pg footgun the server repo warns about.
      const ctxRows = await api.pool.query("SELECT id FROM agent_contexts WHERE agent_id = $1", ["me"]);
      const ctx = ctxRows.rows[0]?.id;
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
