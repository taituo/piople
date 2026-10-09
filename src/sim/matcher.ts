/**
 * Tiny declarative matcher shared by scenario files: human decision rules and expectations.
 * A match is an object of `dot.path -> condition`; a condition is a literal (equality) or an
 * operator object: { eq, ne, gt, gte, lt, lte, matches, includes, in, exists }.
 * Data, not code, so scenarios stay plain JSON.
 */
export type Condition = string | number | boolean | null | {
  eq?: unknown; ne?: unknown; gt?: number; gte?: number; lt?: number; lte?: number;
  matches?: string; includes?: string; in?: unknown[]; exists?: boolean;
};
export type Match = Record<string, Condition>;

const OPS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "matches", "includes", "in", "exists"]);

export function pathGet(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function test(value: unknown, cond: Condition): boolean {
  if (cond === null || typeof cond !== "object") return value === cond || (value !== undefined && cond !== null && String(value) === String(cond));
  for (const [op, arg] of Object.entries(cond)) {
    const n = num(value);
    switch (op) {
      case "eq": if (String(value) !== String(arg)) return false; break;
      case "ne": if (String(value) === String(arg)) return false; break;
      case "gt": if (n === undefined || !(n > (arg as number))) return false; break;
      case "gte": if (n === undefined || !(n >= (arg as number))) return false; break;
      case "lt": if (n === undefined || !(n < (arg as number))) return false; break;
      case "lte": if (n === undefined || !(n <= (arg as number))) return false; break;
      case "matches": if (typeof value !== "string" || !new RegExp(arg as string, "i").test(value)) return false; break;
      case "includes": if (typeof value !== "string" || !value.toLowerCase().includes(String(arg).toLowerCase())) return false; break;
      case "in": if (!(arg as unknown[]).some((a) => String(a) === String(value))) return false; break;
      case "exists": if ((value !== undefined && value !== null) !== (arg as boolean)) return false; break;
      default: return false;
    }
  }
  return true;
}

export function matches(obj: unknown, match: Match): boolean {
  return Object.entries(match).every(([path, cond]) => test(pathGet(obj, path), cond));
}

/** Returns an error message for a malformed match, or null. */
export function validateMatch(m: unknown, where: string): string | null {
  if (m === null || typeof m !== "object" || Array.isArray(m)) return `${where}: match must be an object`;
  for (const [path, cond] of Object.entries(m as Record<string, unknown>)) {
    if (cond !== null && typeof cond === "object") {
      for (const [op, arg] of Object.entries(cond as Record<string, unknown>)) {
        if (!OPS.has(op)) return `${where}.${path}: unknown operator "${op}"`;
        if (["gt", "gte", "lt", "lte"].includes(op) && typeof arg !== "number") return `${where}.${path}.${op}: must be a number`;
        if (op === "in" && !Array.isArray(arg)) return `${where}.${path}.in: must be an array`;
        if (op === "matches") {
          try { new RegExp(String(arg)); } catch { return `${where}.${path}.matches: invalid regular expression`; }
        }
      }
    } else if (!["string", "number", "boolean"].includes(typeof cond) && cond !== null) {
      return `${where}.${path}: condition must be a literal or operator object`;
    }
  }
  return null;
}
