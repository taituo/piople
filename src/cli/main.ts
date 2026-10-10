import { parseArgs } from "node:util";
import { Store } from "../core/index.ts";
import { OPS, opDef, runOp } from "../ops.ts";

/**
 * Process-level CLI. One invocation = one operation, JSON on stdout.
 *   node src/cli/main.ts --db ./data/p.sqlite --as human:alice create --title "Checkout down"
 * Identity: --as or PIO_ACTOR. DB: --db or PIO_DATA.
 */
const argv = process.argv.slice(2);
const opIdx = argv.findIndex((x, i) => !x.startsWith("--") && (i === 0 || !["--db", "--as"].includes(argv[i - 1]!)));
const op = opIdx < 0 ? undefined : argv[opIdx];

if (!op || op === "help" || !opDef(op)) {
  const lines = Object.entries(OPS).map(([n, o]) =>
    `  ${n.padEnd(17)} ${[...o.required.map((k) => `--${k} <v>`), ...(o.optional ?? []).map((k) => `[--${k} <v>]`)].join(" ")}\n  ${"".padEnd(17)} ${o.description}`);
  process.stderr.write(`usage: piople [--db path] [--as actor] <op> [--arg value ...]\n\n${lines.join("\n")}\n`);
  process.exit(op && op !== "help" ? 2 : 0);
}

const head = parseArgs({ args: argv.slice(0, opIdx), options: { db: { type: "string" }, as: { type: "string" } }, strict: true });
const opArgs: Record<string, string> = {};
for (let i = opIdx + 1; i < argv.length; i += 2) {
  const k = argv[i]!, v = argv[i + 1];
  if (!k.startsWith("--") || v === undefined) {
    process.stderr.write(`error: expected --name value pairs, got ${k}\n`);
    process.exit(2);
  }
  opArgs[k.slice(2)] = v;
}
// A misspelt option (`--lease-mz`) must not be dropped silently: the call would run without what was meant. (Over HTTP
// and MCP extra arguments are ignored on purpose, e.g. attempts to name another actor; here a person types the flags.)
const def = opDef(op)!;
const known = new Set([...def.required, ...(def.optional ?? [])]);
const unknown = Object.keys(opArgs).filter((k) => !known.has(k));
if (unknown.length) {
  process.stderr.write(`error: unknown option ${unknown.map((k) => `--${k}`).join(", ")} for ${op} (known: ${[...known].map((k) => `--${k}`).join(" ")})\n`);
  process.exit(2);
}
const as = head.values.as ?? process.env.PIO_ACTOR;
if (!as) {
  process.stderr.write("error: identity required (--as or PIO_ACTOR)\n");
  process.exit(2);
}

const store = new Store(head.values.db ?? process.env.PIO_DATA ?? "./data/piople.sqlite");
try {
  process.stdout.write(JSON.stringify(runOp(store, as, op, opArgs), null, 2) + "\n");
} catch (e) {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
} finally {
  store.close();
}
