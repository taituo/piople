import { existsSync } from "node:fs";
import { parseOrExit } from "./args.ts";
import { Store } from "../core/index.ts";

/**
 * Operator tool: whoever can open the database file can mint credentials. Deliberately not an op
 * (not reachable over CLI/MCP/HTTP as an actor) and not an event (it is not collaboration history).
 *   node src/cli/admin.ts --db ./data/p.sqlite issue-token --actor agent:fetch [--ttl-ms 3600000]
 *   node src/cli/admin.ts --db ./data/p.sqlite revoke-tokens --actor agent:fetch
 *   node src/cli/admin.ts --db ./data/p.sqlite list-tokens --actor agent:fetch     (never shows secrets)
 *   node src/cli/admin.ts --db ./data/p.sqlite add-router --actor agent:router      (may route submitted messages)
 *   node src/cli/admin.ts --db ./data/p.sqlite remove-router --actor agent:router
 *   node src/cli/admin.ts --db ./data/p.sqlite list-routers
 */
const { values, positionals } = parseOrExit({
  args: process.argv.slice(2),
  options: { db: { type: "string" }, actor: { type: "string" }, "ttl-ms": { type: "string" } },
  allowPositionals: true,
  strict: true,
});
const cmd = positionals[0];
const needsActor = cmd === "issue-token" || cmd === "revoke-tokens" || cmd === "list-tokens" || cmd === "add-router" || cmd === "remove-router";
if (!(needsActor && values.actor) && cmd !== "list-routers") {
  process.stderr.write("usage: admin [--db path] (issue-token [--ttl-ms N] | revoke-tokens | list-tokens | add-router | remove-router) --actor <human:x|agent:x>  |  list-routers\n");
  process.exit(2);
}
if (values["ttl-ms"] !== undefined && cmd !== "issue-token") {
  process.stderr.write("error: --ttl-ms only applies to issue-token\n");
  process.exit(2);
}
let store: Store;
try {
  const dbPath = values.db ?? process.env.PIO_DATA ?? "./data/piople.sqlite";
  // Only issuing a token and designating a router may start a database. The others look at or undo something: on a mistyped path
  // they would create an empty database and answer "revoked: 0" with exit 0, and the operator would think the token was gone
  // while the real one is still valid.
  if ((cmd === "revoke-tokens" || cmd === "list-tokens" || cmd === "remove-router" || cmd === "list-routers") && !existsSync(dbPath)) {
    process.stderr.write(`error: no database at ${dbPath} (nothing was created; check --db or PIO_DATA)\n`);
    process.exit(1);
  }
  store = new Store(dbPath);
} catch (e) {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
try {
  const ttl = values["ttl-ms"] === undefined ? undefined : Number(values["ttl-ms"]);
  const actor = values.actor!;
  const out = cmd === "issue-token" ? { actor, token: store.issueToken(actor, ttl) }
    : cmd === "list-tokens" ? { actor, tokens: store.listTokens(actor) }
    : cmd === "add-router" ? (store.addRouter(actor), { actor, router: true })
    : cmd === "remove-router" ? { actor, removed: store.removeRouter(actor) }
    : cmd === "list-routers" ? { routers: store.listRouters() }
    : { actor, revoked: store.revokeTokens(actor) };
  process.stdout.write(JSON.stringify(out) + "\n");
} catch (e) {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
} finally {
  store.close();
}
