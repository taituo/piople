import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
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
  // At most 100,000 bytes: the answer travels as one JSON line, and a control character becomes six characters
  // (\u0001), so more than that can exceed the harness's output cap and the whole call fails with "too much output".
  const max = Math.min(Math.max(Number(a.maxBytes) || 65_536, 1), 100_000);
  // Read only what is returned (plus one byte to know whether there is more), never the whole file into memory.
  const size = statSync(target).size;
  const fd = openSync(target, "r");
  let buf: Buffer;
  try {
    buf = Buffer.alloc(Math.min(size, max));
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    buf = buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
  out({ ok: true, output: buf.toString("utf8") + (size > max ? `\n…(cut at ${max} of ${size} bytes)` : "") });
} catch (e) {
  const code = (e as { code?: string }).code;
  out({ ok: false, error: code === "ERR_ACCESS_DENIED" ? "denied: outside the allowed directory" : code === "ENOENT" ? "not found" : code === "BAD_ARGS" ? (e as Error).message : `failed (${code ?? "error"})` });
}
