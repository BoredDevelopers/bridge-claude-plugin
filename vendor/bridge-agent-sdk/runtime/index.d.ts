/**
 * `@bridge/agent-sdk`'s default entry point (RFC-018 D1/D3/S1.3): the runtime on
 * Web globals, `AgentClient` (identity + tokens + the HTTP `api`) and `Session`
 * (one WebSocket), plus `isTurnTrigger` (D8) and the persistence ports an
 * embedder or a test implements. `src/index.ts` re-exports this file verbatim.
 */
export { createRuntime } from "./runtime";
export type { Runtime, RuntimePorts, RuntimeIdentity, Timer, TimerHandle, WallClock, RandomFn, WebSocketLike, WebSocketCtor, FetchLike } from "./ports";
export { WS_READY_STATE } from "./ports";
export { AgentClient, type AgentClientOptions } from "./client";
export { AgentClientError, isAgentClientError, isTerminalCredentialError, type AgentClientErrorCode, type AgentClientErrorInit } from "./errors";
export { type Api, ApiRequestError, isApiRequestError, type ChannelSummary, type ReadStateEntry, type MarkReadResult, type MessageEnvelope, type SendBody, type SendResult, type ThreadSummary, type ThreadResult, type ThreadMessagesResult, type AgentSummary, type ContextSummary, type PresencePrincipal, type PresenceList, type TaskResult, } from "./api";
export { Session, type SessionClient, type SessionOptions, type SessionStatus, type SessionStop, type StopKind } from "./session";
export { queueAdapter, type DeliveryAdapter, type Entry, type Inbound } from "./delivery";
export { Pending, type PendingEntry, type PendingOptions } from "./pending";
export { isTurnTrigger, type TurnSelf } from "./turn-trigger";
export { memoryCredentialStore, memorySeqStore, memorySessionLock, type CredentialStore, type CredentialRecord, type Installation, type SeqStore, type SessionLock, type LockHolderInfo, } from "./store";
export { type DeviceOutcome } from "./device";
