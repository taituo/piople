import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** The architecture, enforced: Core knows nothing of hosts, harnesses or model libraries. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const imports = (file: string) => [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);

test("src/core imports only itself and node:*", () => {
  for (const f of files("src/core")) {
    for (const i of imports(f)) assert.ok(i.startsWith("node:") || i.startsWith("./"), `${relative(".", f)} imports ${i}`);
  }
});

test("ops, hosts and the synthetic harness use no model or agent library", () => {
  const targets = ["src/ops.ts", ...files("src/hosts"), ...files("src/cli"), ...files("src/mcp"), "src/harnesses/synthetic.ts"];
  for (const f of targets) {
    for (const i of imports(f)) assert.ok(!i.startsWith("@") && !i.includes("harnesses/pi"), `${relative(".", f)} imports ${i}`);
  }
});

test("model libraries are confined to src/harnesses/pi.ts", () => {
  for (const f of files("src")) {
    if (f.endsWith("harnesses/pi.ts")) continue;
    for (const i of imports(f)) assert.ok(!i.startsWith("@earendil-works"), `${relative(".", f)} imports ${i}`);
  }
});

test("nothing outside src/hosts and src/harnesses knows about harnesses", () => {
  for (const f of [...files("src/core"), "src/ops.ts", ...files("src/cli"), ...files("src/mcp")]) {
    for (const i of imports(f)) assert.ok(!/hosts|harnesses/.test(i), `${relative(".", f)} imports ${i}`);
  }
});
