/**
 * A scenario's world: a small virtual file tree plus reactive `effects`. Effects are the whole
 * "physics": whenever a file's content matches a pattern, other files take the given content.
 * That is enough to model "config says POOL_SIZE=0 → logs show crash loop; fix the config →
 * logs show healthy", without writing a simulator per domain. Agents see it only through tools;
 * the only way to change it is an approved action through the executor.
 */
export type Effect = { when: { path: string; matches: string }; set: Record<string, string> };
export type WorldSpec = { files: Record<string, string>; effects?: Effect[] };
export type WorldChange = { path: string; key: string; before: string; after: string };

export class World {
  readonly files = new Map<string, string>();
  readonly changes: WorldChange[] = [];
  private readonly effects: Effect[];

  constructor(spec: WorldSpec) {
    for (const [p, c] of Object.entries(spec.files)) this.files.set(p, c);
    this.effects = spec.effects ?? [];
    this.settle();
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.files.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  ls(prefix = ""): string[] {
    const pre = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
    return [...this.files.keys()].filter((p) => pre === "" || p === pre || p.startsWith(pre + "/")).sort();
  }

  read(path: string, maxLines = 200): string | undefined {
    const c = this.files.get(path);
    return c === undefined ? undefined : c.split("\n").slice(0, maxLines).join("\n");
  }

  grep(pattern: string, prefix = ""): string[] {
    const re = new RegExp(pattern, "i");
    const out: string[] = [];
    for (const p of this.ls(prefix)) {
      (this.files.get(p) ?? "").split("\n").forEach((line, i) => { if (re.test(line)) out.push(`${p}:${i + 1}:${line}`); });
    }
    return out.slice(0, 100);
  }

  /** Set `key` to `value` in a JSON document (any nesting, type preserved) or a KEY=VALUE / key: value file. */
  setKey(path: string, key: string, value: string): WorldChange {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`no such file: ${path}`);
    let before: string | undefined;
    let next = content;
    try {
      const doc = JSON.parse(content) as unknown;
      const hit = findKey(doc, key);
      if (hit) {
        before = String(hit.parent[hit.key]);
        hit.parent[hit.key] = typeof hit.parent[hit.key] === "number" && Number.isFinite(Number(value)) ? Number(value) : value;
        next = JSON.stringify(doc, null, 2) + (content.endsWith("\n") ? "\n" : "");
      }
    } catch {
      const re = new RegExp(`^(\\s*${escapeRe(key)}[ \\t]*[=:][ \\t]*)(.*?)[ \\t]*$`, "m");
      const m = re.exec(content);
      if (m) {
        before = m[2];
        next = content.replace(re, (_all, lead: string) => `${lead}${value}`);
      }
    }
    if (before === undefined) throw new Error(`key "${key}" not found in ${path}`);
    this.files.set(path, next);
    const change = { path, key, before, after: value };
    this.changes.push(change);
    this.settle();
    return change;
  }

  /** Re-evaluate effects in declaration order; later matching effects win. */
  private settle(): void {
    for (const e of this.effects) {
      const cur = this.files.get(e.when.path);
      if (cur !== undefined && new RegExp(e.when.matches, "m").test(cur)) {
        for (const [p, c] of Object.entries(e.set)) this.files.set(p, c);
      }
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findKey(node: unknown, key: string): { parent: Record<string, unknown>; key: string } | undefined {
  if (node === null || typeof node !== "object") return undefined;
  const rec = node as Record<string, unknown>;
  if (key in rec && (typeof rec[key] === "string" || typeof rec[key] === "number" || typeof rec[key] === "boolean")) return { parent: rec, key };
  for (const v of Object.values(rec)) {
    const hit = findKey(v, key);
    if (hit) return hit;
  }
  return undefined;
}
