import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/index.ts";

/** Found by feeding the tools bad database paths: raw Node stack traces, and an empty path that silently wrote nowhere. */
const run = (script: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--no-warnings", script, ...args], { encoding: "utf8", env: { ...process.env, PIO_DATA: "", ...env } });

test("an empty database path is an error: it used to open a private temporary database and lose every write", () => {
  assert.throws(() => new Store(""), /bad-db-path/);
  assert.throws(() => new Store("   "), /bad-db-path/);
  const viaFlag = run("src/cli/main.ts", ["--db", "", "--as", "human:alice", "create", "--id", "c1", "--title", "t"]);
  assert.equal(viaFlag.status, 1);
  assert.match(viaFlag.stderr, /^error: bad-db-path/);
  const viaEnv = run("src/cli/main.ts", ["--as", "human:alice", "create", "--id", "c1", "--title", "t"], { PIO_DATA: "" });
  assert.equal(viaEnv.status, 1, "an exported but empty PIO_DATA is the same mistake");
  assert.match(viaEnv.stderr, /^error: bad-db-path/);
});

test("a path that is not a usable database ends in a one-line error, never a Node stack trace, and never touches the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "piople-open-"));
  const notDb = join(dir, "notes.txt");
  writeFileSync(notDb, "my precious notes\n");
  const folder = join(dir, "folder");
  mkdirSync(folder);
  const truncated = join(dir, "t.sqlite");
  const good = join(dir, "g.sqlite");
  assert.equal(run("src/cli/main.ts", ["--db", good, "--as", "human:alice", "create", "--id", "c1", "--title", "t"]).status, 0);
  writeFileSync(truncated, readFileSync(good).subarray(0, 100));
  for (const [what, path] of [["a text file", notDb], ["a directory", folder], ["a truncated database", truncated]] as const) {
    for (const [script, args] of [["src/cli/main.ts", ["--as", "human:alice", "events", "--context", "c1"]], ["src/cli/admin.ts", ["list-routers"]]] as const) {
      const r = run(script, ["--db", path, ...args]);
      assert.equal(r.status, 1, `${what} via ${script}`);
      assert.match(r.stderr, /^error: cannot-open-database: /, `${what} via ${script}: ${r.stderr.slice(0, 120)}`);
      assert.doesNotMatch(r.stderr, /node:internal|file:\/\/|\n\s+at /, `${what} via ${script}: no stack trace`);
    }
  }
  assert.equal(readFileSync(notDb, "utf8"), "my precious notes\n", "the file that was not a database is untouched");
  const mcp = run("src/mcp/server.ts", [], { PIO_DATA: notDb });
  assert.equal(mcp.status, 1);
  assert.match(mcp.stderr, /^piople-mcp: cannot-open-database/);
});

test("the HTTP server refuses a bad PIO_PORT with one line, says when the port is taken, and does not read an empty port as 'pick one'", async () => {
  const net = await import("node:net");
  const dir = mkdtempSync(join(tmpdir(), "piople-port-"));
  const env = { PIO_DATA: join(dir, "p.sqlite") };
  for (const bad of ["abc", "99999", "-5", "80.5", ""]) {
    const r = spawnSync(process.execPath, ["--no-warnings", "src/http/main.ts"], { encoding: "utf8", env: { ...process.env, ...env, PIO_PORT: bad }, timeout: 15_000 });
    assert.equal(r.status, 1, `PIO_PORT=${JSON.stringify(bad)}: ${r.stdout}${r.stderr.slice(0, 100)}`);
    assert.match(r.stderr, /^error: bad-port: /, `PIO_PORT=${JSON.stringify(bad)}`);
    assert.doesNotMatch(r.stderr, /node:net|\n\s+at /, "no stack trace");
  }
  const taken = net.createServer();
  await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
  const port = (taken.address() as import("node:net").AddressInfo).port;
  const clash = spawnSync(process.execPath, ["--no-warnings", "src/http/main.ts"], { encoding: "utf8", env: { ...process.env, ...env, PIO_PORT: String(port) }, timeout: 15_000 });
  taken.close();
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /^error: cannot listen on 127\.0\.0\.1:\d+: the port is already in use/);
  assert.doesNotMatch(clash.stderr, /node:events|\n\s+at /, "no stack trace");
});

test("an empty PIO_BIND is refused: it used to bind the API to every network interface", () => {
  const dir = mkdtempSync(join(tmpdir(), "piople-bind-"));
  const r = spawnSync(process.execPath, ["--no-warnings", "src/http/main.ts"], { encoding: "utf8", env: { ...process.env, PIO_DATA: join(dir, "p.sqlite"), PIO_PORT: "0", PIO_BIND: "" }, timeout: 15_000 });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr.slice(0, 100)}`);
  assert.match(r.stderr, /^error: bad-bind: /);
  assert.equal(r.stdout, "", "it never started listening");
});
