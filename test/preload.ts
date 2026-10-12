/**
 * Every test that spawns the plugin passes `...process.env` through. A developer's shell
 * may still carry pre-0.30 BRIDGE_* variables (BRIDGE_AUTOCONNECT, BRIDGE_PROFILE, …), and the
 * plugin now REFUSES to start a session with any of them (legacy-env.ts) — which would
 * fail the whole suite on that machine for a reason that has nothing to do with the test.
 * test/legacy-env.test.ts sets its own explicitly.
 */
for (const k of Object.keys(process.env)) if (k.startsWith("BRIDGE_")) delete process.env[k];
