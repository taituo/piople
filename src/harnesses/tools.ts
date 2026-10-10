import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Environments at process level (plan item 7). An agent's real abilities are fixed by the *operator's* profile for
 * it, never by what the agent declares or Core stores. A tool runs in its own child process:
 *  - started with the Node permission model: read access only to the profile's directory (and the tool's own code),
 *    no writes, no child processes, no workers, no addons; the runtime enforces it (ERR_ACCESS_DENIED);
 *  - with an EMPTY environment plus the profile's explicit `env`: the harness's token and keys never reach it;
 *  - with a time limit and an output cap, killed when exceeded; results come back over stdio as one JSON line.
 * What this does NOT cover (Node 22): the network is not restricted by the permission model, and a symlink inside the
 * directory that points outside is followed by the runtime (the bundled tools close that with a realpath check).
 * A network profile waits for containers (plan item 9). A harness that uses tools should run in its own process: the
 * child is isolated from the harness, the harness is not isolated from its siblings.
 */
export type EnvironmentProfile = {
  name: string;
  /** Tools this agent may call, by name (a name not in the registry is ignored at startup). */
  tools: string[];
  /** The one directory tools may read. Required by every bundled tool. */
  files?: { root: string };
  /** The only environment variables a tool gets. Default none. */
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type ToolDef = { description: string; script: string; needsFiles: boolean };

const here = dirname(fileURLToPath(import.meta.url));
const toolsDir = resolve(here, "../tools");
export const TOOLS: Record<string, ToolDef> = {
  read_file: { description: 'read one text file under your directory: {"path": "<relative path>"}', script: resolve(toolsDir, "read-file.ts"), needsFiles: true },
  list_dir: { description: 'list a directory under your directory: {"path": "<relative path, default .>"}', script: resolve(toolsDir, "list-dir.ts"), needsFiles: true },
};

export type ToolResult = { ok: true; output: string } | { ok: false; error: string };

/** The tools of a profile that exist, as protocol lines for the agent. */
export function describeTools(p: EnvironmentProfile, registry: Record<string, ToolDef> = TOOLS): string[] {
  return p.tools.filter((t) => registry[t]).map((t) => `${t} ${registry[t]!.description}`);
}

/** Run one tool call. Never throws: every failure is a result the agent is told about. */
export async function runTool(p: EnvironmentProfile, name: string, args: unknown, registry: Record<string, ToolDef> = TOOLS): Promise<ToolResult> {
  const def = registry[name];
  if (!p.tools.includes(name) || !def) return { ok: false, error: `tool ${name} is not available to this agent` };
  let root: string | undefined;
  if (p.files) {
    try { root = realpathSync(p.files.root); } catch { return { ok: false, error: "the agent's directory is not available" }; }
  } else if (def.needsFiles) return { ok: false, error: `tool ${name} needs a directory and this profile has none` };
  const allowRead = [dirname(def.script), ...(root ? [root] : [])];
  const flags = ["--no-warnings", "--permission", ...allowRead.map((d) => `--allow-fs-read=${d}`)];
  const max = p.maxOutputBytes ?? 1_000_000;
  return new Promise<ToolResult>((done) => {
    let stdout = "", stderr = "", settled = false, timedOut = false, tooBig = false;
    const finish = (r: ToolResult) => { if (!settled) { settled = true; clearTimeout(timer); done(r); } };
    const child = spawn(process.execPath, [...flags, def.script], { env: { ...(p.env ?? {}) }, cwd: root ?? toolsDir, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, p.timeoutMs ?? 10_000);
    child.stdout.on("data", (d: Buffer) => { stdout += d; if (stdout.length > max) { tooBig = true; child.kill("SIGKILL"); } });
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < 2000) stderr += d; });
    child.on("error", () => finish({ ok: false, error: "the tool could not be started" }));
    child.on("close", (code) => {
      if (timedOut) return finish({ ok: false, error: `the tool took longer than ${p.timeoutMs ?? 10_000} ms and was stopped` });
      if (tooBig) return finish({ ok: false, error: "the tool produced too much output and was stopped" });
      try {
        const r = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as { ok?: boolean; output?: unknown; error?: unknown };
        if (r.ok === true && typeof r.output === "string") return finish({ ok: true, output: r.output });
        if (r.ok === false && typeof r.error === "string") return finish({ ok: false, error: r.error });
      } catch { /* fall through */ }
      finish({ ok: false, error: `the tool failed (exit ${code}${/ERR_ACCESS_DENIED/.test(stderr) ? ", denied by the runtime" : ""})` });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ ...(args && typeof args === "object" && !Array.isArray(args) ? args : {}), ...(root ? { root } : {}) }));
  });
}
