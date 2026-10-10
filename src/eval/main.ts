import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { jevClassifier } from "../harnesses/jev.ts";
import { keywordClassifier } from "../harnesses/router.ts";
import { consensusClassifier } from "../harnesses/consensus.ts";
import { analyze, formatReport, runRoutingEval } from "./routing.ts";
import type { EvalDataset } from "./routing.ts";

/**
 * node src/eval/main.ts [--dataset eval/routing-synthetic.json] [--classifier keyword|jev]
 *                       [--target-precision 0.95] [--json] [--send-to-external] [--consensus]
 * --consensus asks jev twice with the destinations in opposite order and routes only when both agree.
 * jev needs OPENROUTER_API_KEY (or JEV_API_KEY), JEV_MODEL (exact id), optionally JEV_ENDPOINT, and
 * --send-to-external: evaluating shows the dataset's message texts and destination names to an outside service.
 */
const { values } = parseArgs({
  options: { dataset: { type: "string" }, classifier: { type: "string" }, "target-precision": { type: "string" }, json: { type: "boolean" }, "send-to-external": { type: "boolean" }, consensus: { type: "boolean" } },
  strict: true,
});
const dataset = JSON.parse(readFileSync(values.dataset ?? "eval/routing-synthetic.json", "utf8")) as EvalDataset;
const which = values.classifier ?? "keyword";
let classifier;
if (which === "keyword") classifier = keywordClassifier();
else if (which === "jev") {
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.JEV_API_KEY;
  if (!apiKey || !process.env.JEV_MODEL) die("jev needs OPENROUTER_API_KEY (or JEV_API_KEY) and JEV_MODEL");
  if (!values["send-to-external"]) die("jev is an external service: pass --send-to-external to confirm the dataset may be shown to it");
  classifier = jevClassifier({ apiKey: apiKey!, model: process.env.JEV_MODEL!, endpoint: process.env.JEV_ENDPOINT });
  if (values.consensus) classifier = consensusClassifier(classifier);
} else die(`unknown classifier ${which} (keyword or jev)`);

const run = await runRoutingEval(dataset, classifier!);
const analysis = analyze(run.rows, { targetPrecision: values["target-precision"] === undefined ? undefined : Number(values["target-precision"]) });
if (values.json) process.stdout.write(JSON.stringify({ run, analysis }, null, 2) + "\n");
else process.stdout.write(formatReport(run, analysis, dataset.note) + "\n");

function die(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}
