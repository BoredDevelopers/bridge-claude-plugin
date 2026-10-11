/**
 * Seeds a scratch database for test/key-credentials-real-api.test.ts THROUGH THE API'S
 * OWN MODULES, in its own process: `bun test` runs every file in one process, and the
 * API's `db` module binds its pool to DATABASE_URL at import — importing it into the test
 * process would share (and close) one pool across files.
 *
 *   DATABASE_URL=<scratch db> bun test/fixtures/real-api-seed.ts <EINWEAVE_API_DIR> <BETTER_AUTH_SECRET>
 *
 * Prints the result as its LAST stdout line (the migration runner logs above it):
 *   { cookie, userId, sessionId, agentId, tenantId, keys: string[] }.
 *   - migrations (the server's runner — `src/index.ts` does not migrate);
 *   - a fresh workspace, and in it an agent (uuid id, display name "Me", handle `me`);
 *   - a human OWNER of the workspace and of the agent, with a fresh (step-up-fresh)
 *     better-auth session — the cookie signed exactly as better-auth signs it (the API's
 *     test/harness.ts seedAdminSession), non-`__Secure-` because the test server's public
 *     URL is http;
 *   - enrolment keys minted by the API's credential module (`mintEnrolmentKey`).
 * Rows follow the API's own test harness (seedTenant / seedAgents / seedAdminSession):
 * when the schema moves, mirror that file.
 */
import { createHmac } from "node:crypto";
import { join } from "node:path";

/** better-auth's cookie prefix (packages/api/src/better-auth.ts COOKIE_PREFIX). */
const COOKIE_PREFIX = "einweave";

const [apiDir, secret] = process.argv.slice(2);
if (!apiDir || !secret) throw new Error("usage: real-api-seed.ts <EINWEAVE_API_DIR> <BETTER_AUTH_SECRET>");

const api: any = await import(join(apiDir, "src/db/index.ts"));
await api.runMigrations();
const q = (sql: string, params: unknown[] = []) => api.pool.query(sql, params);
const now = new Date();

const tenantId = crypto.randomUUID();
await q(`INSERT INTO tenants (id, name, region, shard, created_at) VALUES ($1, 'Plugin real-API', 'eu', 0, $2)`, [tenantId, now]);
const agentId = crypto.randomUUID();
await q(`INSERT INTO agents (tenant_id, id, name, created_at) VALUES ($1, $2, 'Me', $3)`, [tenantId, agentId, now]);
await q(`INSERT INTO tenant_handles (tenant_id, principal_id, handle, folded_handle, created_at) VALUES ($1, $2, 'me', 'me', $3)`, [tenantId, agentId, now]);

const userId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
await q(`INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'Owner', 'owner@test.local', true, $2, $2)`, [userId, now]);
await q(`INSERT INTO tenant_members (tenant_id, principal_id, role, added_by, created_at) VALUES ($1, $2, 'owner', NULL, $3)`, [tenantId, userId, now]);
await q(`INSERT INTO "session" (id, token, user_id, active_tenant_id, expires_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)`, [
  sessionId,
  token,
  userId,
  tenantId,
  new Date(now.getTime() + 86_400_000),
  now,
]);
// Enrolling (and revoking for) an agent needs its OWN owner (RFC-014 §7.3).
await q(`INSERT INTO agent_managers (tenant_id, agent_id, principal_id, role, created_at) VALUES ($1, $2, $3, 'owner', $4)`, [tenantId, agentId, userId, now]);
const sig = createHmac("sha256", secret).update(token, "utf8").digest("base64");
const cookie = `${COOKIE_PREFIX}.session_token=${encodeURIComponent(`${token}.${sig}`)}`;

const creds: any = await import(join(apiDir, "src/agent-credentials.ts"));
const keys: string[] = [];
for (let i = 0; i < 4; i++) {
  const k = await creds.mintEnrolmentKey(agentId, tenantId, { id: userId, type: "human", contextId: null }, { maxUses: 50 });
  if (!k.ok) throw new Error(`mintEnrolmentKey: ${k.error}`);
  keys.push(k.key);
}
await api.closePool();
process.stdout.write(JSON.stringify({ cookie, userId, sessionId, agentId, tenantId, keys }) + "\n");
process.exit(0);
