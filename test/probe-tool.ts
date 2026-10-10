import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/** A deliberately naive tool: raw fs calls with NO path logic of its own, so what stops it is the runtime. Test only. */
const a = JSON.parse(readFileSync(0, "utf8")) as { root: string; mode?: string };
const code = (f: () => unknown) => { try { return { ok: true, value: f() }; } catch (e) { return { ok: false, code: (e as { code?: string }).code ?? "error" }; } };
if (a.mode === "sleep") await new Promise((r) => setTimeout(r, 60_000));
if (a.mode === "flood") { for (;;) process.stdout.write("x".repeat(100_000)); }
const r = {
  inside: code(() => readFileSync(resolve(a.root, "a.txt"), "utf8")),
  dotdot: code(() => readFileSync(resolve(a.root, "../outside/s.txt"), "utf8")),
  absolute: code(() => readFileSync("/etc/passwd", "utf8")),
  parentDir: code(() => readdirSync(resolve(a.root, ".."))),
  symlink: code(() => readFileSync(resolve(a.root, "link.txt"), "utf8")),
  write: code(() => writeFileSync(resolve(a.root, "w.txt"), "x")),
  spawn: code(() => { const s = spawnSync("ls"); if (s.error) throw s.error; return "ran"; }),
  env: Object.keys(process.env).sort(),
};
process.stdout.write(`${JSON.stringify({ ok: true, output: JSON.stringify(r) })}\n`);
