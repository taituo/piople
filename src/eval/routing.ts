import { Store } from "../core/index.ts";
import type { ContextKind } from "../core/index.ts";
import { Host, LocalCore } from "../hosts/host.ts";
import { RouterHarness } from "../harnesses/router.ts";
import type { Classifier } from "../harnesses/router.ts";

/**
 * Measuring routing before trusting it. Runs a classifier over labelled messages in shadow mode (nothing is
 * delivered), then tells you, per confidence threshold, how often it routes and how often it is right, so
 * `minConfidence` comes from measurement. Thresholds are never invented here: with too little data the report
 * says so.
 */
export type EvalCase = { id: string; sender: string; text: string; /** the destination a reasonable person would pick among what the sender may address, or null when it should stay unrouted */ expect: string | null; tags?: string[] };
export type EvalDataset = {
  name?: string;
  note?: string;
  contexts: Array<{ id: string; kind: Extract<ContextKind, "realm" | "channel" | "case">; title: string; realm?: string; parent?: string }>;
  members: Array<{ actor: string; contexts: string[] }>;
  cases: EvalCase[];
};
export type EvalRow = {
  id: string; sender: string; expect: string | null; tags: string[];
  predicted: string | null; confidence: number; needsHuman: number | null;
  /** classified, or why nothing was classified: no-targets, no-permitted-targets, error (classifier failed, message still pending) */
  outcome: "classified" | "no-targets" | "no-permitted-targets" | "error";
  latencyMs: number | null;
};
export type EvalRun = { dataset: string; classifier: { name: string; version: string }; rows: EvalRow[]; delivered: number };

const ORDER: Record<string, number> = { realm: 0, channel: 1, case: 2 };

export async function runRoutingEval(dataset: EvalDataset, classifier: Classifier): Promise<EvalRun> {
  const store = new Store(":memory:");
  const admin = "human:admin";
  const kind = new Map(dataset.contexts.map((c) => [c.id, c.kind]));
  [...dataset.contexts].sort((a, b) => ORDER[a.kind]! - ORDER[b.kind]!).forEach((c, i) =>
    store.createContext({ id: c.id, kind: c.kind, title: c.title, goal: "", createdAt: i + 1, realmId: c.realm ?? null, parentId: c.parent ?? null }, admin));
  for (const m of dataset.members) {
    for (const id of [...m.contexts].sort((a, b) => ORDER[kind.get(a)!]! - ORDER[kind.get(b)!]!)) {
      store.join({ contextId: id, actorId: m.actor, capabilities: ["read", "write"], joinedAt: 2 }, `eval-${m.actor}-${id}`, admin);
    }
  }
  for (const c of dataset.cases) {
    const addressable = new Set(store.targets(c.sender).map((t) => t.id));
    if (c.expect !== null && !addressable.has(c.expect)) throw new Error(`dataset-invalid: case ${c.id} expects ${c.expect}, which ${c.sender} cannot address`);
  }

  const timings = new Map<string, number>(); // summed per submission: a message may take two stages
  const timed: Classifier = {
    name: classifier.name, version: classifier.version, external: classifier.external,
    async classify(input) {
      const t0 = performance.now();
      try {
        return await classifier.classify(input);
      } finally {
        timings.set(input.submission!, (timings.get(input.submission!) ?? 0) + (performance.now() - t0));
      }
    },
  };
  store.addRouter("agent:router");
  const host = new Host(new LocalCore(store));
  // Running an evaluation is the operator's explicit decision to show the dataset to the classifier.
  const realms = dataset.contexts.filter((c) => c.kind === "realm").map((c) => c.id);
  await host.add({ actor: "agent:router", harness: new RouterHarness({ classifier: timed, mode: "shadow", minConfidence: 0, ruleVersion: "eval", external: { allowRealms: realms } }) });
  host.onError = () => {};
  for (const c of dataset.cases) store.submitMessage(c.sender, c.id, c.text);
  await host.settle(10).catch(() => {}); // a classifier that keeps failing leaves messages pending: they become "error" rows

  const rows: EvalRow[] = dataset.cases.map((c) => {
    const events = store.eventsSince(`ingress:${c.sender}`, 0, 1000).filter((e) => e.data.submittedKey === c.id);
    const classified = events.filter((e) => e.type === "route.classified").at(-1);
    const unresolved = events.find((e) => e.type === "route.unresolved");
    const ms = timings.get(`ingress:${c.sender}#${c.id}`);
    const latencyMs = ms === undefined ? null : Math.round(ms);
    const base = { id: c.id, sender: c.sender, expect: c.expect, tags: c.tags ?? [], latencyMs };
    if (classified) {
      const d = classified.data as { choice: string | null; confidence: number; extras?: { needsHuman?: number } | null };
      return { ...base, predicted: d.choice, confidence: d.confidence, needsHuman: d.extras?.needsHuman ?? null, outcome: "classified" as const };
    }
    const reason = unresolved?.data.reason;
    const outcome = reason === "no-targets" || reason === "no-permitted-targets" ? reason : "error";
    return { ...base, predicted: null, confidence: 0, needsHuman: null, outcome };
  });
  const delivered = store.db.prepare(`SELECT COUNT(*) n FROM events WHERE type='message.posted' AND json_extract(data,'$.via')='route'`).get() as { n: number };
  store.close();
  return { dataset: dataset.name ?? "dataset", classifier: { name: classifier.name, version: classifier.version }, rows, delivered: delivered.n };
}

// ---- analysis -----------------------------------------------------------------------------------------------

/** Lower bound of the Wilson score interval for k successes in n trials (default 95%). */
export function wilsonLower(k: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = k / n;
  const d = 1 + (z * z) / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
}

export type ThresholdRow = { threshold: number; routed: number; correct: number; wrong: number; precision: number | null; coverage: number; falseRouteRate: number; routableRecall: number };
export type Analysis = {
  cases: number; routable: number; offTopic: number; errors: number; withoutTargets: number;
  thresholds: ThresholdRow[];
  suggestion: null | { threshold: number; precision: number; routed: number; wilsonLower: number; confident: boolean };
  targetPrecision: number;
  latencyMs: { median: number; p95: number } | null;
};

/**
 * `suggestion` is the lowest threshold whose precision reaches the target (and routes at least minSupport
 * messages), together with how sure that is: `confident` only when even the Wilson lower bound reaches it.
 */
export function analyze(rows: EvalRow[], o: { targetPrecision?: number; minSupport?: number; step?: number } = {}): Analysis {
  const targetPrecision = o.targetPrecision ?? 0.95;
  const minSupport = o.minSupport ?? 10;
  const step = o.step ?? 0.05;
  const scored = rows.filter((r) => r.outcome === "classified");
  const routable = rows.filter((r) => r.expect !== null).length;
  const thresholds: ThresholdRow[] = [];
  for (let i = 0; i <= Math.round(1 / step); i++) {
    const t = Math.round(i * step * 100) / 100;
    const routed = scored.filter((r) => r.predicted !== null && r.confidence >= t);
    const correct = routed.filter((r) => r.predicted === r.expect).length;
    thresholds.push({
      threshold: t, routed: routed.length, correct, wrong: routed.length - correct,
      precision: routed.length ? correct / routed.length : null,
      coverage: rows.length ? routed.length / rows.length : 0,
      falseRouteRate: rows.length ? (routed.length - correct) / rows.length : 0,
      routableRecall: routable ? correct / routable : 0,
    });
  }
  const hit = thresholds.find((t) => t.routed >= minSupport && t.precision !== null && t.precision >= targetPrecision);
  const lat = rows.map((r) => r.latencyMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
  return {
    cases: rows.length, routable, offTopic: rows.length - routable,
    errors: rows.filter((r) => r.outcome === "error").length,
    withoutTargets: rows.filter((r) => r.outcome === "no-targets" || r.outcome === "no-permitted-targets").length,
    thresholds, targetPrecision,
    suggestion: hit ? { threshold: hit.threshold, precision: hit.precision!, routed: hit.routed, wilsonLower: wilsonLower(hit.correct, hit.routed), confident: wilsonLower(hit.correct, hit.routed) >= targetPrecision } : null,
    latencyMs: lat.length ? { median: lat[Math.floor(lat.length / 2)]!, p95: lat[Math.min(lat.length - 1, Math.ceil(lat.length * 0.95) - 1)]! } : null,
  };
}

const pct = (x: number | null) => (x === null ? "  n/a" : `${(x * 100).toFixed(0).padStart(3)}%`);

export function formatReport(run: EvalRun, a: Analysis, note?: string): string {
  const lines = [
    `# Routing evaluation: ${run.dataset}`,
    `Classifier ${run.classifier.name} ${run.classifier.version}. ${a.cases} messages (${a.routable} with a right destination, ${a.offTopic} that should stay unrouted); shadow mode, ${run.delivered} delivered.`,
    ...(a.errors ? [`**${a.errors} messages could not be classified (classifier errors)** and are left out of the table.`] : []),
    ...(a.withoutTargets ? [`${a.withoutTargets} messages had nothing to classify against (no addressable or permitted targets).`] : []),
    "",
    "| minConfidence | routed | correct | false routes | precision | coverage | share of right destinations found |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...a.thresholds.filter((_, i) => i % 2 === 0 || i === a.thresholds.length - 1).map((t) =>
      `| ${t.threshold.toFixed(2)} | ${t.routed} | ${t.correct} | ${t.wrong} | ${pct(t.precision)} | ${pct(t.coverage)} | ${pct(t.routableRecall)} |`),
    "",
    a.suggestion
      ? `Lowest threshold reaching ${(a.targetPrecision * 100).toFixed(0)}% precision: **${a.suggestion.threshold.toFixed(2)}** (precision ${pct(a.suggestion.precision).trim()} over ${a.suggestion.routed} routed messages; 95% lower bound ${pct(a.suggestion.wilsonLower).trim()}). ${a.suggestion.confident ? "The lower bound also reaches the target." : "**Not yet confident: the lower bound is below the target, so this dataset is too small to rely on it.**"}`
      : `**No threshold reaches ${(a.targetPrecision * 100).toFixed(0)}% precision with enough routed messages.** Do not enforce routing yet; improve the classifier or collect more data.`,
    ...(a.latencyMs ? [`Classifier latency: median ${a.latencyMs.median} ms, p95 ${a.latencyMs.p95} ms.`] : []),
    ...(note ? ["", `> ${note}`] : []),
  ];
  return lines.join("\n");
}
