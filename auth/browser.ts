/**
 * Can this machine show a browser, and open one (RFC-014 §7.2). Headless ⇒ the
 * device flow: SSH, CI, or Linux/BSD with no display (az / gh / entire-cli
 * heuristics). `BRIDGE_BROWSER=none` never opens one — the URL is printed instead.
 */
type Env = Record<string, string | undefined>;

export function isHeadless(env: Env, platform: string = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return true;
  if (env.CI) return true;
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    const wsl = !!env.WSL_DISTRO_NAME;
    return !wsl && !env.DISPLAY && !env.WAYLAND_DISPLAY;
  }
  return false;
}

export function browserDisabled(env: Env): boolean {
  return (env.BRIDGE_BROWSER ?? "").trim().toLowerCase() === "none";
}

/** Open `url` in the default browser; false when that could not be started. */
export async function openBrowser(url: string, platform: string = process.platform): Promise<boolean> {
  const argv =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", '""', url]
        : ["xdg-open", url];
  try {
    const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    const code = await Promise.race([proc.exited, Bun.sleep(5000).then(() => 0)]);
    return code === 0;
  } catch {
    return false;
  }
}
