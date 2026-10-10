import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * Tool: read one text file under the allowed directory. Runs in a child process started with the Node permission
 * model (--permission --allow-fs-read=<root>): reads outside the directory are stopped by the *runtime*
 * (ERR_ACCESS_DENIED), not by this code. The one gap the runtime leaves is a symlink inside the directory that
 * points outside, which it follows; the realpath check below closes that, and is the only path logic here.
 * stdin: {"root": "<real path>", "path": "<relative>", "maxBytes"?: n}   stdout: one JSON line.
 */
const out = (o: { ok: boolean; output?: string; error?: string }) => process.stdout.write(`${JSON.stringify(o)}\n`);
try {
  const a = JSON.parse(readFileSync(0, "utf8")) as { root: string; path: unknown; maxBytes?: number };
  if (typeof a.path !== "string" || !a.path) throw Object.assign(new Error("path must be a non-empty string"), { code: "BAD_ARGS" });
  const target = realpathSync(resolve(a.root, a.path));
  if (target !== a.root && !target.startsWith(a.root + sep)) throw Object.assign(new Error("resolves outside the allowed directory"), { code: "ERR_ACCESS_DENIED" });
  if (!statSync(target).isFile()) throw Object.assign(new Error("not a regular file"), { code: "BAD_ARGS" });
  const max = Math.min(Math.max(Number(a.maxBytes) || 65_536, 1), 1_000_000);
  const buf = readFileSync(target);
  out({ ok: true, output: buf.subarray(0, max).toString("utf8") + (buf.length > max ? `\n…(cut at ${max} of ${buf.length} bytes)` : "") });
} catch (e) {
  const code = (e as { code?: string }).code;
  out({ ok: false, error: code === "ERR_ACCESS_DENIED" ? "denied: outside the allowed directory" : code === "ENOENT" ? "not found" : code === "BAD_ARGS" ? (e as Error).message : `failed (${code ?? "error"})` });
}
