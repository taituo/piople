import { existsSync } from "node:fs";
import { parseOrExit } from "./args.ts";
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
// Help that was asked for goes to stdout (so `piople --help | grep post` and `| less` work); a mistake goes to stderr.
const helpAsked = op === "help" || argv.includes("--help") || argv.includes("-h");

if (helpAsked || !op || !opDef(op)) {
  const lines = Object.entries(OPS).map(([n, o]) =>
    `  ${n.padEnd(17)} ${[...o.required.map((k) => `--${k} <v>`), ...(o.optional ?? []).map((k) => `[--${k} <v>]`)].join(" ")}\n  ${"".padEnd(17)} ${o.description}`);
  (helpAsked ? process.stdout : process.stderr).write(`usage: piople [--db path] [--as actor] <op> [--arg value ...]\n\n${lines.join("\n")}\n`);
  process.exit(helpAsked || !op ? 0 : 2);
}

const head = parseOrExit({ args: argv.slice(0, opIdx), options: { db: { type: "string" }, as: { type: "string" } }, strict: true });
const opArgs: Record<string, string> = {};
for (let i = opIdx + 1; i < argv.length;) {
  const k = argv[i]!;
  // `--name=value` as well as `--name value` (the first "=" splits: the value may contain more)
  const eq = k.startsWith("--") ? k.indexOf("=") : -1;
  if (eq > 2) { opArgs[k.slice(2, eq)] = k.slice(eq + 1); i += 1; continue; }
  const v = argv[i + 1];
  if (!k.startsWith("--") || v === undefined) {
    process.stderr.write(`error: expected --name value (or --name=value) pairs, got ${k}\n`);
    process.exit(2);
  }
  opArgs[k.slice(2)] = v;
  i += 2;
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

/** Operations that only look. On a mistyped database they would create an empty one and answer with an empty list. */
const READERS = new Set(["targets", "events", "inbox", "work-list", "decision-get", "route-pending", "route-targets", "route-recent"]);

let store: Store;
try {
  const dbPath = head.values.db ?? process.env.PIO_DATA ?? "./data/piople.sqlite";
  if (READERS.has(op) && !existsSync(dbPath)) {
    process.stderr.write(`error: no database at ${dbPath} (nothing was created; check --db or PIO_DATA)\n`);
    process.exit(1);
  }
  store = new Store(dbPath);
} catch (e) {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
try {
  process.stdout.write(JSON.stringify(runOp(store, as, op, opArgs), null, 2) + "\n");
} catch (e) {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
} finally {
  store.close();
}
