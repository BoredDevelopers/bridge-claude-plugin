/**
 * `createRuntime(ports?)` (RFC-018 S1.3 plan) — one per process. Defaults every
 * port to the Web global it wraps; a caller overrides only the ones it needs
 * (a test's fake `fetch` + fake `WebSocket` + fake `timer`, or a runtime that
 * has no `WebSocket` global at all and must supply `ws`).
 */
import type { Runtime, RuntimePorts } from "./ports";
export declare function createRuntime(ports?: RuntimePorts): Runtime;
