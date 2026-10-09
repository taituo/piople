import fs from "node:fs";
import path from "node:path";
import { loadScenario } from "../src/sim/scenario.ts";
import { runScenario, type RunOptions } from "../src/sim/runner.ts";
import { renderMarkdown } from "../src/sim/report.ts";
import { readBearer } from "../src/agents/loop.ts";
import { gatewayUrl } from "../src/agents/pi-provider.ts";

/**
 * Run scenarios (plain JSON, see scenarios/) against the protocol.
 *
 *   node scripts/simulate.ts scenarios/checkout-incident.json            # scripted, deterministic, offline
 *   node scripts/simulate.ts scenarios --live --model deepseek-v4-flash   # every scenario with a real model
 *
 * Options: --live  --model <id>  --rounds <n>  --out <dir>  --keep-db
 * Live needs a gateway: PIO_GATEWAY (default http://10.91.1.1:8788/v1) and a bearer
 * (PIO_GATEWAY_BEARER / OPENCODE_API_KEY / PIO_BEARER_FILE). Exit code 1 if any scenario fails.
 */
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const VALUE_FLAGS = new Set(["--model", "--rounds", "--out"]);
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !VALUE_FLAGS.has(all[i - 1] ?? ""));
const target = positional[0] ?? "scenarios";
const files = fs.statSync(target).isDirectory()
  ? fs.readdirSync(target).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(target, f))
  : [target];
const live = flag("live");
const out = arg("out") ?? "data/sim";
fs.mkdirSync(out, { recursive: true });

function need<T>(f: () => T): T {
  try { return f(); } catch (e) { console.error(`simulate: ${(e as Error).message}`); process.exit(2); }
}

const base: Omit<RunOptions, "dbPath"> = {
  mode: live ? "live" : "scripted",
  ...(arg("model") ? { model: arg("model")! } : {}),
  ...(arg("rounds") ? { rounds: Number(arg("rounds")) } : {}),
  ...(live ? { baseUrl: gatewayUrl(), bearer: need(readBearer) } : {}),
  log: (l) => console.log(l),
};

let failed = 0;
for (const file of files) {
  const scn = need(() => loadScenario(file));
  console.log(`\n== ${scn.id} (${base.mode}) ==`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dbPath = flag("keep-db") ? path.join(out, `${scn.id}-${stamp}.sqlite`) : undefined;
  const report = await runScenario(scn, { ...base, ...(dbPath ? { dbPath } : {}) });
  fs.writeFileSync(path.join(out, `${scn.id}-${base.mode}-${stamp}.json`), JSON.stringify(report, null, 2));
  const md = renderMarkdown(report);
  fs.writeFileSync(path.join(out, `${scn.id}-${base.mode}-${stamp}.md`), md);
  console.log(md);
  if (report.verdict !== "pass") failed++;
}
console.log(`\n${files.length - failed}/${files.length} scenarios passed`);
process.exit(failed ? 1 : 0);
