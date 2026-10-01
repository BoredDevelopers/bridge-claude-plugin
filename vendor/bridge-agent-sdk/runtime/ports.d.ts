/**
 * RFC-018 S1.3 — the default runtime's injection seam: everything `AgentClient`
 * and `Session` touch that is NOT sans-I/O core (D1's `.` entry point, "the
 * runtime on Web globals … with injectable Clock, Timer and Random"). Every
 * port here has a Web-standard shape (`fetch`, `WebSocket`) or a small
 * interface a test double / another runtime can implement in a few lines —
 * never a Node or Bun API (that split is `/node`'s job, S1.4).
 *
 * `createRuntime(ports?)` (./runtime.ts) is the one place these get defaulted.
 * Nothing else in this package reads `globalThis.fetch` or `new WebSocket(…)`
 * directly — that is what makes `AgentClient`/`Session` testable with a fake
 * server and fake time (S1.3 plan: "fake WebSocket + fake fetch + fake timers").
 */
import type { FetchLike } from "../core";
export type { FetchLike };
/** A `WebSocket`-shaped value — the real global, `ws`, or a test double. Deliberately
 * the narrow slice `Session` actually uses, not the full DOM `WebSocket` interface,
 * so a minimal fake satisfies it without stubbing unused members. */
export interface WebSocketLike {
    readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: "open" | "message" | "close" | "error", listener: (ev: {
        data?: unknown;
        code?: number;
        reason?: string;
    }) => void): void;
    removeEventListener(type: string, listener: (ev: {
        data?: unknown;
        code?: number;
        reason?: string;
    }) => void): void;
}
/** The four `readyState` values every `WebSocket` implementation shares (DOM + `ws` + Bun). */
export declare const WS_READY_STATE: {
    readonly CONNECTING: 0;
    readonly OPEN: 1;
    readonly CLOSING: 2;
    readonly CLOSED: 3;
};
export type WebSocketCtor = new (url: string) => WebSocketLike;
/** A cancellable timer — `Session`'s reconnect/watchdog/ticker never touch `setTimeout` directly. */
export interface TimerHandle {
    clear(): void;
}
/**
 * `unref` is a Node/Bun-only nicety (keeping a timer from holding the process open) —
 * `opts.unref` asks for it WHERE AVAILABLE (S1.3: "unref where available"); a browser or
 * a fake-timer test double that has no such concept is free to ignore it, which is why
 * it is an option, not a promise.
 */
export interface Timer {
    setTimeout(fn: () => void, ms: number, opts?: {
        unref?: boolean;
    }): TimerHandle;
    setInterval(fn: () => void, ms: number, opts?: {
        unref?: boolean;
    }): TimerHandle;
}
/** Wall-clock time only — NEVER the server-clock-offset `Clock` in `../core/clock.ts`
 * (that one signs proofs; this one drives the reconnect backoff and the replay cursor,
 * exactly the split `../core/cursor.ts` already documents). */
export interface WallClock {
    now(): number;
}
export type RandomFn = () => number;
/**
 * This runtime's own identity — the `(<runtime>/<v>; <os>/<arch>)` half of D4's
 * `User-Agent` (`../core/software.ts`'s `userAgent()`). The `software_id`/`software_version`
 * half is per-`AgentClient` (RFC-018 D4: "software_id is the OAuth client id"), so it is
 * NOT part of this port — a process may open several `AgentClient`s (several Bridge
 * agents) sharing one `Runtime`, each with its own software identity.
 */
export interface RuntimeIdentity {
    runtimeName: string;
    runtimeVersion: string;
    os: string;
    arch: string;
}
export interface Runtime {
    fetch: FetchLike;
    WebSocket: WebSocketCtor;
    timer: Timer;
    clock: WallClock;
    random: RandomFn;
    userAgent: RuntimeIdentity;
}
/** Every port, individually overridable — `createRuntime()`'s parameter. */
export type RuntimePorts = Partial<Runtime>;
