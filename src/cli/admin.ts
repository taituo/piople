import { parseArgs } from "node:util";
import { Store } from "../core/index.ts";

/**
 * Operator tool: whoever can open the database file can mint credentials. Deliberately not an op
 * (not reachable over CLI/MCP/HTTP as an actor) and not an event (it is not collaboration history).
 *   node src/cli/admin.ts --db ./data/p.sqlite issue-token --actor agent:fetch
 *   node src/cli/admin.ts --db ./data/p.sqlite revoke-tokens --actor agent:fetch
 */
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { db: { type: "string" }, actor: { type: "string" } },
  allowPositionals: true,
  strict: true,
});
const cmd = positionals[0];
if (!values.actor || (cmd !== "issue-token" && cmd !== "revoke-tokens")) {
  process.stderr.write("usage: admin [--db path] (issue-token | revoke-tokens) --actor <human:x|agent:x>\n");
  process.exit(2);
}
const store = new Store(values.db ?? process.env.PIO_DATA ?? "./data/piople.sqlite");
try {
  const out = cmd === "issue-token" ? { actor: values.actor, token: store.issueToken(values.actor) } : { actor: values.actor, revoked: store.revokeTokens(values.actor) };
  process.stdout.write(JSON.stringify(out) + "\n");
} catch (e) {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
} finally {
  store.close();
}
