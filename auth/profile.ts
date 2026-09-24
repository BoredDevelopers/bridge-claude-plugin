/**
 * Which credential profile this process uses (RFC-014 §7.2).
 *
 * `BRIDGE_PROFILE=<name>` selects `<stateDir>/profiles/<name>/`; unset selects the
 * state dir itself (the default profile). There is deliberately NO "active profile"
 * pointer file: several Claude sessions run concurrently on one machine, and a
 * shared pointer is exactly what gh / kubectl / az race on. Selection is per
 * process, from its environment — per project via `.claude/settings.local.json`.
 */
import { join } from "path";

export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type Profile = { name: string | null; dir: string };

export function resolveProfile(stateDir: string, raw: string | undefined): Profile | { error: string } {
  const name = (raw ?? "").trim();
  if (!name) return { name: null, dir: stateDir };
  if (!PROFILE_NAME_RE.test(name)) {
    return { error: `BRIDGE_PROFILE "${name}" is not a valid profile name (lowercase letters, digits, - and _, max 32)` };
  }
  return { name, dir: join(stateDir, "profiles", name) };
}

export function profileLabel(p: Profile): string {
  return p.name ?? "default";
}
