/**
 * The pre-0.30 `BRIDGE_*` environment variables, which 0.30 no longer reads. A leftover
 * one is not harmless: `BRIDGE_PROFILE` (the 0.29 login skill recommended it, per project
 * in `.claude/settings.local.json`) used to pick WHICH agent a session is — ignoring it
 * silently connects as the DEFAULT agent, the wrong identity. So any of them in the real
 * environment is a configuration error: the session names each one and does not connect.
 *
 * Presence only — a value is never read (it could be a secret, e.g. `BRIDGE_ENROLMENT_KEY`).
 * Test-only `BRIDGE_TEST_*` knobs are not listed: they were inert outside `BRIDGE_TEST=1`.
 */
const LEGACY: ReadonlyArray<readonly [string, string]> = [
  ["BRIDGE_PROFILE", "EINWEAVE_PROFILE"],
  ["BRIDGE_STATE_DIR", "EINWEAVE_STATE_DIR"],
  ["BRIDGE_API_URL", "EINWEAVE_API_URL"],
  ["BRIDGE_CHANNELS", "EINWEAVE_CHANNELS"],
  ["BRIDGE_ENROLMENT_KEY", "EINWEAVE_ENROLMENT_KEY"],
  ["BRIDGE_AUTOCONNECT", "EINWEAVE_AUTOCONNECT"],
  ["BRIDGE_SESSION_KEY", "EINWEAVE_SESSION_KEY"],
  ["BRIDGE_SESSION_LABEL", "EINWEAVE_SESSION_LABEL"],
  ["BRIDGE_BROWSER", "EINWEAVE_BROWSER"],
  ["BRIDGE_TOKEN", "nothing — static tokens are retired; sign in with /einweave:login"],
  ["BRIDGE_CONTEXT_CLAIM_MODE", "nothing — no longer used"],
];

/** These pick WHICH agent / which credentials a session uses: ignoring them means the wrong identity. */
const IDENTITY = new Set(["BRIDGE_PROFILE", "BRIDGE_STATE_DIR"]);

/** The configError text for leftover `BRIDGE_*` variables in `env`, or null when there are none. */
export function legacyEnvProblem(env: Record<string, string | undefined>): string | null {
  const found = LEGACY.filter(([name]) => Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined);
  if (found.length === 0) return null;
  const list = found.map(([name, now]) => `${name} → ${now}`).join(", ");
  const consequence = found.some(([name]) => IDENTITY.has(name))
    ? "Connecting anyway would use the wrong identity (the default agent's credentials)."
    : "They would be silently ignored, so this session would not behave as configured.";
  return `old BRIDGE_ environment variable(s) are set but no longer read: ${list}. ${consequence} Rename them (check .claude/settings.local.json and your shell profile) and restart this session.`;
}
