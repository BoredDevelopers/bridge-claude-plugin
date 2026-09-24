// Child process for the multi-process lock test: wait for a common start instant,
// take the profile lock, log in/out around a short critical section.
import { appendFileSync } from "fs";
import { withProfileLock } from "../../auth/lock";

const [dir, startAt] = [process.argv[2]!, Number(process.argv[3])];
while (Date.now() < startAt) {}
await withProfileLock(dir, async () => {
  appendFileSync(`${dir}/log`, `in ${process.pid}\n`);
  await Bun.sleep(150);
  appendFileSync(`${dir}/log`, `out ${process.pid}\n`);
});
