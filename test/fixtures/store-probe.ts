// Runs one store operation in a CHILD process, so a regression that spins or sleeps
// synchronously (which no in-process test timeout can interrupt) shows up as a
// killed child instead of a hung test runner. Prints the outcome.
import * as store from "../../auth/node/store";

const [mode, dir] = [process.argv[2]!, process.argv[3]!];
try {
  if (mode === "attempt") await store.createOrReadAttempt(dir);
  if (mode === "rename-eperm") {
    store.__io.renameSync = (() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    }) as any;
    store.writeState(dir, "brg_js_1_" + "A".repeat(49));
  }
  process.stdout.write("ok");
} catch (e) {
  process.stdout.write((e as Error).name + ":" + (e as Error).message.slice(0, 40));
}
