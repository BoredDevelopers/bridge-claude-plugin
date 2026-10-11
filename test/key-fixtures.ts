/**
 * RFC-016 credential files for tests, in the SDK `fileStore`'s on-disk format
 * (vendor/bridge-agent-sdk node/store.ts): key.json + state + installation.json, all
 * 0600, installation.json LAST — its presence means "enrolled". Sync, so a test can
 * seed a directory before the plugin process starts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSoftwareKey, type EcPrivateJwk, type KeyStorage } from "../vendor/bridge-agent-sdk/core/index.js";
import { AgentClient, createRuntime } from "../vendor/bridge-agent-sdk/index.js";
import { fileStore } from "../vendor/bridge-agent-sdk/node.js";
import { PLUGIN_CLIENT_ID } from "../auth/client-id";

export interface TestInstallation {
  apiUrl: string;
  installationId: string;
  jkt: string;
  keyStorage: KeyStorage;
  installationName?: string;
}

function write(dir: string, name: string, text: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, name), text, { mode: 0o600 });
}

export function writeKey(dir: string, jwk: EcPrivateJwk): void {
  write(dir, "key.json", JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }) + "\n");
}

export function writeState(dir: string, state: string): void {
  write(dir, "state", state + "\n");
}

export function writeInstallation(dir: string, inst: TestInstallation): void {
  write(dir, "installation.json", JSON.stringify({ format: 0, ...inst }, null, 2) + "\n");
}

export function readInstallation(dir: string): TestInstallation | null {
  try {
    const j = JSON.parse(readFileSync(join(dir, "installation.json"), "utf8"));
    return typeof j?.installationId === "string" ? j : null;
  } catch {
    return null;
  }
}

export function readState(dir: string): string | null {
  try {
    return readFileSync(join(dir, "state"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Put an RFC-016 installation on disk the way a completed login would: a fresh P-256 key
 * registered DIRECTLY with the stub (no HTTP), then the files (installation.json last).
 */
export async function enrolledProfile(
  stub: { url: string; enrolDirect: (jwk: any) => { installation_id: string; join_state: string } },
  dir: string
): Promise<string> {
  const { privateJwk, signer } = await generateSoftwareKey();
  const g = stub.enrolDirect(signer.publicJwk);
  writeKey(dir, privateJwk);
  writeState(dir, g.join_state);
  writeInstallation(dir, { apiUrl: stub.url, installationId: g.installation_id, jkt: signer.jkt, keyStorage: "software" });
  return g.installation_id;
}

export function readKey(dir: string): EcPrivateJwk | null {
  try {
    return JSON.parse(readFileSync(join(dir, "key.json"), "utf8"));
  } catch {
    return null;
  }
}

export function readAttempt(dir: string): string | null {
  try {
    return readFileSync(join(dir, "attempt"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** RFC-016 C4: an attempt (32 random bytes, base64url). */
export function randomB64url(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

/** Another holder of a profile directory in THIS process: a sibling session on this machine, or a thief's copy. */
export function agentClientOn(apiUrl: string, dir: string, sessionKey: string, softwareVersion = "0.0.0"): Promise<AgentClient> {
  return AgentClient.open(createRuntime(), { apiUrl, store: fileStore(dir), softwareId: PLUGIN_CLIENT_ID, softwareVersion, sessionKey });
}
