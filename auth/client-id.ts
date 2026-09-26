/**
 * This plugin's PUBLIC OAuth client id (RFC-016 §3.2, the server's `AGENT_AUTH_CLIENTS`).
 * Plugin-specific on purpose: auth/core (the future `@bridge/agent-sdk`) has no client id
 * of its own — every runtime passes its own to `TokenClient` and the loopback flow.
 */
export const PLUGIN_CLIENT_ID = "bridge-claude-plugin";
