import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Tool: list one directory under the allowed directory (names; directories end in "/"). See read-file.ts for the sandbox. */
const out = (o: { ok: boolean; output?: string; error?: string }) => process.stdout.write(`${JSON.stringify(o)}\n`);
try {
  const a = JSON.parse(readFileSync(0, "utf8")) as { root: string; path?: unknown };
  const rel = a.path === undefined || a.path === "" ? "." : a.path;
  if (typeof rel !== "string") throw Object.assign(new Error("path must be a string"), { code: "BAD_ARGS" });
  const target = realpathSync(resolve(a.root, rel));
  if (target !== a.root && !target.startsWith(a.root + sep)) throw Object.assign(new Error("resolves outside the allowed directory"), { code: "ERR_ACCESS_DENIED" });
  const names = readdirSync(target).sort().slice(0, 500).map((n) => {
    try { return statSync(resolve(target, n)).isDirectory() ? `${n}/` : n; } catch { return n; }
  });
  out({ ok: true, output: names.join("\n") });
} catch (e) {
  const code = (e as { code?: string }).code;
  out({ ok: false, error: code === "ERR_ACCESS_DENIED" ? "denied: outside the allowed directory" : code === "ENOENT" ? "not found" : code === "ENOTDIR" ? "not a directory" : code === "BAD_ARGS" ? (e as Error).message : `failed (${code ?? "error"})` });
}
