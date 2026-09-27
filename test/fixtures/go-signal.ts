// Ready/go handshake for multi-process race fixtures: the child reports "ready" on
// stderr once loaded, then blocks until the parent writes a line to its stdin — so
// every racer starts at the same moment without guessing at a fixed start time.
export async function readyThenGo(): Promise<void> {
  process.stderr.write("ready\n");
  for await (const _ of Bun.stdin.stream()) return;
}

/** Parent side: spawn `n` children, wait until all are ready, then release them together. */
export async function spawnRacers(n: number, argv: string[]) {
  const ps = Array.from({ length: n }, () => Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
  await Promise.all(
    ps.map(async (p) => {
      const reader = p.stderr.getReader();
      let buf = "";
      while (!buf.includes("ready\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`racer exited before ready: ${buf}`);
        buf += new TextDecoder().decode(value);
      }
      reader.releaseLock();
    })
  );
  for (const p of ps) {
    p.stdin.write("go\n");
    p.stdin.end();
  }
  return ps;
}
