import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { Store } from "../core/index.ts";
import { HumanHarness, type Console } from "../harnesses/human.ts";
import { Host, LocalCore } from "./host.ts";
import { HttpCore } from "./http-core.ts";

/**
 * A person as a running participant:
 *   node src/hosts/watch.ts --as human:alice [--db ./data/p.sqlite]            (next to the database)
 *   PIO_TOKEN=pio_... node src/hosts/watch.ts --as human:alice --url http://core:8899
 * Shows what is new and what is owed, and lets the person answer. `help` lists the commands. Ctrl-D leaves.
 */
const { values } = parseArgs({ options: { as: { type: "string" }, db: { type: "string" }, url: { type: "string" } }, strict: true });
if (!values.as || !/^(human|agent):\S+$/.test(values.as)) {
  process.stderr.write("usage: watch --as <human:x> [--db path | --url http://core:8899 (token in PIO_TOKEN)]\n");
  process.exit(2);
}
const actor = values.as;
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
let closed = false;
rl.on("close", () => { closed = true; });
const io: Console = {
  print: (t) => console.log(t),
  read: (prompt) => (closed ? Promise.resolve(null) : new Promise((resolve) => { rl.question(prompt, resolve); rl.once("close", () => resolve(null)); })),
};
let store: Store | undefined;
let core;
if (values.url) {
  if (!process.env.PIO_TOKEN) { process.stderr.write("watch --url needs PIO_TOKEN\n"); process.exit(2); }
  core = new HttpCore(values.url, { [actor]: process.env.PIO_TOKEN });
} else {
  try {
    store = new Store(values.db ?? process.env.PIO_DATA ?? "./data/piople.sqlite");
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
  core = new LocalCore(store);
}
const host = new Host(core);
host.onError = (e) => console.error(`error (${e.context}): ${e.error instanceof Error ? e.error.message : String(e.error)}`);
await host.add({ actor, harness: new HumanHarness({ console: io }) });
host.start();
console.log(`watching as ${actor}; Ctrl-D to leave`);
await new Promise<void>((r) => rl.once("close", r));
await host.close();
store?.close();
