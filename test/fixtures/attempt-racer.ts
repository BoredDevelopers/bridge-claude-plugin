// Child process for the E5 test: at a common instant, create-or-read the attempt
// WITHOUT the lock (as a racer past a broken lock would) and print what it got.
import { createOrReadAttempt } from "../../auth/node/store";

const [dir, startAt] = [process.argv[2]!, Number(process.argv[3])];
while (Date.now() < startAt) {}
process.stdout.write(await createOrReadAttempt(dir));
