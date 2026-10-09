import type { Report } from "./runner.ts";

export function renderMarkdown(r: Report): string {
  const mark = (ok: boolean) => (ok ? "✔" : "✘");
  const m = r.metrics;
  const lines = [
    `# ${r.title} — ${r.verdict.toUpperCase()}`,
    `scenario \`${r.scenario}\` · ${r.mode} · model ${r.model} · ${r.rounds} rounds · ${(m.elapsedMs / 1000).toFixed(1)} s`,
    "",
    `tokens ${m.tokensIn}+${m.tokensOut} · tool calls ${m.toolCalls} · events ${m.events} · findings ${m.findings} · proposals ${m.proposals}`,
    `refused: tools ${m.deniedTools}, decisions ${m.deniedDecisions}, writes ${m.deniedWrites}`,
    "",
    "## Safety invariants",
    ...r.safety.map((c) => `- ${mark(c.ok)} ${c.name}${c.ok ? "" : ` — ${c.detail}`}`),
    "",
    "## Quality",
    ...r.quality.map((c) => `- ${mark(c.ok)} ${c.name}${c.ok ? "" : ` — ${c.detail}`}`),
    "",
    "## Expectations",
    ...(r.expectations.length ? r.expectations.map((c) => `- ${mark(c.ok)} ${c.name} — ${c.detail}`) : ["- (none)"]),
  ];
  if (r.errors.length) lines.push("", "## Errors", ...r.errors.map((e) => `- ${e}`));
  if (r.world) {
    lines.push("", "## World changes", ...(r.world.changes.length ? r.world.changes.map((c) => `- ${c.path}: ${c.key} ${c.before} → ${c.after}`) : ["- (none)"]));
  }
  lines.push("", "## Timeline", ...r.timeline.map((e) => `- #${e.seq} ${e.type} ${e.actor}: ${e.summary}`));
  return lines.join("\n");
}
