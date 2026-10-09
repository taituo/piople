import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EVENT_TYPES } from "../src/core/index.ts";

/**
 * Architecture as executable rules, so the code base defends its own shape (the idea from Entropi's boundaries
 * and public-surface tests). They fail loudly the day someone takes a shortcut.
 */
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const ts = (dir: string) => walk(dir).filter((f) => f.endsWith(".ts"));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const importsOf = (file: string) => [...strip(fs.readFileSync(file, "utf8")).matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]!);
const area = (file: string) => file.split(path.sep)[1]!; // src/<area>/...

// who may import whom (relative imports only; packages and node: are always fine except in the core)
const MAY_IMPORT: Record<string, string[]> = {
  core: [],
  agents: ["core"],
  sim: ["core", "agents"],
  http: ["core"],
  mcp: ["core"],
};

test("the core imports only itself and Node built-ins: no Pi, no agents, no HTTP", () => {
  for (const f of ts("src/core")) {
    for (const spec of importsOf(f)) assert.ok(spec.startsWith("node:") || spec.startsWith("./"), `${f} imports "${spec}"`);
  }
});

test("every area imports only the areas it is allowed to", () => {
  for (const f of ts("src")) {
    const me = area(f);
    assert.ok(me in MAY_IMPORT, `unknown area ${me}: add it to the architecture rules`);
    for (const spec of importsOf(f).filter((s) => s.startsWith("."))) {
      const target = path.relative(".", path.resolve(path.dirname(f), spec));
      const there = area(target);
      assert.ok(there === me || MAY_IMPORT[me]!.includes(there), `${f} imports ${spec} (${me} must not depend on ${there})`);
    }
  }
});

test("only the core touches the database directly; every other area asks the Store", () => {
  for (const f of ts("src").filter((f) => area(f) !== "core")) {
    const src = strip(fs.readFileSync(f, "utf8"));
    // read-only helper queries in the simulator/agents are allowed on the Store's db for lookups, never DDL or writes to protocol tables
    assert.ok(!/\.db\.(exec)\(/.test(src), `${f} runs raw SQL DDL`);
    assert.ok(!/(INSERT INTO|UPDATE|DELETE FROM)\s+(events|members|decisions|contexts|actors)\b/i.test(src), `${f} writes a protocol table directly: add a Store operation instead`);
  }
});

test("transports and agents never hold privileges the Store keeps for setup: HTTP only uses actor-checked operations", () => {
  const src = strip(fs.readFileSync("src/http/app.ts", "utf8"));
  assert.ok(!/store\.append\(/.test(src), "HTTP must not append events directly");
  assert.ok(!/store\.db\b/.test(src), "HTTP must not read the database directly");
});

test("the Pi packages are pinned to exact versions, and those are the installed ones (Pi Durable is experimental)", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
  for (const name of ["@earendil-works/pi-durable", "@earendil-works/pi-ai", "@earendil-works/chord"]) {
    const want = pkg.dependencies[name]!;
    assert.match(want, /^\d+\.\d+\.\d+$/, `${name} must be an exact version, not a range (${want})`);
    const have = (JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, "utf8")) as { version: string }).version;
    assert.equal(have, want, `${name} installed != pinned`);
  }
});

test("event types: the list is the public vocabulary; this snapshot changes only on purpose", () => {
  assert.deepEqual([...EVENT_TYPES], [
    "context.created", "member.joined", "message.posted", "observation.recorded", "assistance.requested", "assistance.answered",
    "decision.requested", "decision.resolved", "decision.expired", "action.proposed", "action.executed", "presence.changed", "observation.promoted",
  ]);
  assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length);
  for (const t of EVENT_TYPES) assert.match(t, /^[a-z]+\.[a-z]+$/);
});

test("event types: the code emits exactly the listed ones (nothing unlisted, nothing nobody emits)", () => {
  const emitted = new Set<string>();
  for (const f of ts("src")) for (const m of strip(fs.readFileSync(f, "utf8")).matchAll(/type:\s*"([a-z]+\.[a-z]+)"/g)) emitted.add(m[1]!);
  assert.deepEqual([...emitted].sort(), [...EVENT_TYPES].sort());
});

test("the HTTP surface is the documented one", () => {
  const src = fs.readFileSync("src/http/app.ts", "utf8");
  const routes = [...src.matchAll(/"(\/api\/v1\/[a-z]+)": \(/g)].map((m) => m[1]).sort();
  assert.deepEqual(routes, ["/api/v1/assistance", "/api/v1/contexts", "/api/v1/decisions", "/api/v1/join", "/api/v1/messages", "/api/v1/observations", "/api/v1/presence", "/api/v1/promote"]);
  for (const r of [...routes, "/api/v1/focus", "/events", "/healthz"]) assert.ok(src.includes(r), r);
});

test("no source file hard-codes a host, a user's home or a secret", () => {
  for (const f of [...ts("src"), ...ts("scripts")]) {
    const src = strip(fs.readFileSync(f, "utf8"));
    assert.ok(!/\/home\/[a-z]+\//.test(src), `${f} hard-codes a home directory`);
    assert.ok(!/gateway-bearer["'`]\s*[,)]/.test(src) || f.endsWith("loop.ts"), `${f} hard-codes a bearer path`);
    assert.ok(!/(sk-[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9]{20,})/.test(src), `${f} contains something that looks like a key`);
  }
});
