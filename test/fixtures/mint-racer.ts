// Child process for the "several Claude sessions on one machine" test: a whole
// CredentialManager (its own session key) on a SHARED profile directory. On "go" it
// mints `rounds` times (forgetting the token in between, so every round is a real mint
// under the installation lock) and proves each token on a DPoP-checked API request.
import { CredentialManager } from "../../auth/manager";
import { resolveProfile } from "../../auth/profile";
import { readyThenGo } from "./go-signal";

const [dir, apiUrl, rounds] = [process.argv[2]!, process.argv[3]!, Number(process.argv[4] ?? "3")];
const m = new CredentialManager({
  profile: resolveProfile(dir, undefined),
  envApiUrl: apiUrl,
  staleStaticTokenPresent: false,
  enrolmentKey: "",
  sessionKey: () => `p${process.pid}`,
  sessionKeyReady: async () => {},
  platform: "test-os",
  clientVersion: "9.9.9",
  env: {},
  onAccessRotated: () => {},
  onLoggedIn: () => {},
  onLoggedOut: () => {},
  notify: () => {},
  log: () => {},
  prompt: { available: () => false, show: () => {}, confirm: async () => false },
});
await readyThenGo();
const out = { tokens: [] as string[], statuses: [] as number[], errors: [] as string[] };
for (let i = 0; i < rounds; i++) {
  try {
    out.tokens.push(await m.accessToken());
    const { headers } = await m.httpAuth("GET", "/api/channels");
    out.statuses.push((await fetch(`${apiUrl}/api/channels`, { headers })).status);
  } catch (e) {
    out.errors.push(e instanceof Error ? e.message : String(e));
  }
  m.invalidateAccess();
}
m.stop();
process.stdout.write(JSON.stringify(out));
