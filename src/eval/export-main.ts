import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Store } from "../core/index.ts";
import { exportLabelled } from "./export.ts";

/**
 * node src/eval/export-main.ts --db ./data/p.sqlite --out my-messages.json [--min-length 2] [--redact] [--since SEQ]
 * Writes an evaluation dataset from the messages people posted into channels themselves (their own choice of place).
 * Then: node src/eval/main.ts --dataset my-messages.json [--classifier jev --send-to-external --context 1]
 * The file contains real message text: keep it local, review it, and remember --send-to-external shows it to a third party.
 */
const { values } = parseArgs({ options: { db: { type: "string" }, out: { type: "string" }, "min-length": { type: "string" }, redact: { type: "boolean" }, since: { type: "string" } }, strict: true });
if (!values.out) { process.stderr.write("usage: export-main --db <sqlite> --out <file.json> [--min-length N] [--redact] [--since SEQ]\n"); process.exit(2); }
const store = new Store(values.db ?? process.env.PIO_DATA ?? "./data/piople.sqlite");
try {
  const d = exportLabelled(store, { minLength: values["min-length"] === undefined ? undefined : Number(values["min-length"]), redact: values.redact, since: values.since === undefined ? undefined : Number(values.since) });
  writeFileSync(values.out, JSON.stringify(d, null, 1), { mode: 0o600 });
  process.stdout.write(`${d.cases.length} labelled messages from ${new Set(d.cases.map((c) => c.sender)).size} people in ${new Set(d.cases.map((c) => c.expect)).size} channels -> ${values.out}\n`);
} finally {
  store.close();
}
