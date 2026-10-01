/**
 * `@bridge/agent-sdk` — the default entry point: the runtime on Web globals
 * (`fetch`, `WebSocket`, `crypto.subtle`), with injectable `Clock`, `Timer` and
 * `Random` (RFC-018 D1/D3). `createRuntime(ports)`, `AgentClient` and `Session`
 * land here (S1.3) — see `docs/RFC-018-agent-sdk-and-openclaw.md`.
 */
export * from "./runtime/index";
