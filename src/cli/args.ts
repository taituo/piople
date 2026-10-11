import { parseArgs } from "node:util";

/**
 * `parseArgs` in strict mode throws on an unknown option or an option without its value, and uncaught that is a stack trace of
 * Node\'s own files. A person who mistyped a flag gets the sentence and exit status 2 instead.
 */
export const parseOrExit: typeof parseArgs = ((config: Parameters<typeof parseArgs>[0]) => {
  try {
    return parseArgs(config);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`error: ${message.split(". To specify")[0]}\n`);
    process.exit(2);
  }
}) as typeof parseArgs;
