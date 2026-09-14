/** Creates a harness temp root, never cleans it up, then exits normally.
 * Used to prove the process-exit cleanup registry removes leaked roots. */
import { tmpRoot } from "../helpers.ts";

process.stdout.write(`${tmpRoot()}\n`);
