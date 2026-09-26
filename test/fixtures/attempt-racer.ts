// Child process for the E5 test: on "go", create-or-read the attempt WITHOUT the
// lock (as a racer past a broken lock would) and print what it got.
import { createOrReadAttempt } from "../../auth/node/store";
import { readyThenGo } from "./go-signal";

const dir = process.argv[2]!;
await readyThenGo();
process.stdout.write(await createOrReadAttempt(dir));
