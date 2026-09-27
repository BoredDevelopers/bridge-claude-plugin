/**
 * Put an RFC-016 installation on disk the way a completed login would: a fresh
 * P-256 key registered DIRECTLY with the stub (no HTTP), then key.json + state +
 * installation.json through the real store (installation.json last).
 */
import { generateSoftwareKey } from "../auth/core/signer";
import { writeKey, writeState, writeInstallation } from "../auth/node/store";

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
