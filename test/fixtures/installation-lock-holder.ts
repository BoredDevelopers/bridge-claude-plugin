// Child process for the multi-process lock test: on "go", take the installation
// lock and log in/out around a short critical section.
import { appendFileSync } from "fs";
import { withInstallationLock } from "../../auth/node/lock";
import { readyThenGo } from "./go-signal";

const dir = process.argv[2]!;
await readyThenGo();
await withInstallationLock(dir, async () => {
  appendFileSync(`${dir}/log`, `in ${process.pid}\n`);
  await Bun.sleep(150);
  appendFileSync(`${dir}/log`, `out ${process.pid}\n`);
});
