import { readFileSync } from "node:fs";
import { parseOrExit } from "../cli/args.ts";
import { jevClassifier } from "../harnesses/jev.ts";
import { keywordClassifier } from "../harnesses/router.ts";
import { consensusClassifier } from "../harnesses/consensus.ts";
import { analyze, formatReport, runRoutingEval } from "./routing.ts";
import type { EvalDataset } from "./routing.ts";

/**
 * node src/eval/main.ts [--dataset eval/routing-synthetic.json] [--classifier keyword|jev]
 *                       [--target-precision 0.95] [--json] [--send-to-external] [--consensus]
 * --context K shows the classifier the K messages before each one (a reply needs them); they are sent to jev too.
 * --needs-human-above P leaves a message unrouted when jev says a person is needed with probability >= P.
 * --consensus asks jev twice with the destinations in opposite order and routes only when both agree.
 * jev needs OPENROUTER_API_KEY (or JEV_API_KEY), JEV_MODEL (exact id), optionally JEV_ENDPOINT, and
 * --send-to-external: evaluating shows the dataset's message texts and destination names to an outside service.
 */
const { values } = parseOrExit({
  options: { dataset: { type: "string" }, classifier: { type: "string" }, "target-precision": { type: "string" }, json: { type: "boolean" }, "send-to-external": { type: "boolean" }, consensus: { type: "boolean" }, context: { type: "string" }, "needs-human-above": { type: "string" } },
  strict: true,
});
const datasetPath = values.dataset ?? "eval/routing-synthetic.json";
const dataset = loadDataset(datasetPath);
for (const [flag, v, ok, want] of [
  ["target-precision", values["target-precision"], (n: number) => n > 0 && n <= 1, "a number above 0 and at most 1"],
  ["needs-human-above", values["needs-human-above"], (n: number) => n >= 0 && n <= 1, "a number from 0 to 1"],
  ["context", values.context, (n: number) => Number.isInteger(n) && n >= 0, "a whole number, 0 or more"],
] as const) if (v !== undefined && !(v.trim() !== "" && ok(Number(v)))) die(`--${flag} must be ${want} (got ${JSON.stringify(v)})`);
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

const run = await runRoutingEval(dataset, classifier!, { context: values.context === undefined ? undefined : Number(values.context), needsHumanAbove: values["needs-human-above"] === undefined ? undefined : Number(values["needs-human-above"]) });
const analysis = analyze(run.rows, { targetPrecision: values["target-precision"] === undefined ? undefined : Number(values["target-precision"]) });
if (values.json) process.stdout.write(JSON.stringify({ run, analysis }, null, 2) + "\n");
else process.stdout.write(formatReport(run, analysis, dataset.note) + "\n");

/** Read and check a dataset file; a person who points at the wrong file gets a sentence, not a stack trace. */
function loadDataset(path: string): EvalDataset {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch (e) { return die(`cannot read the dataset ${path}: ${e instanceof Error ? e.message.replace(/^[A-Z]+: /, "") : String(e)}`); }
  let d: unknown;
  try { d = JSON.parse(raw); } catch (e) { return die(`${path} is not valid JSON (${e instanceof Error ? e.message : String(e)})`); }
  const o = d as Partial<EvalDataset> | null;
  if (!o || typeof o !== "object" || Array.isArray(o) || !Array.isArray(o.contexts) || !Array.isArray(o.members) || !Array.isArray(o.cases)) {
    return die(`${path} is not a routing dataset: it needs "contexts", "members" and "cases" lists (see eval/routing-synthetic.json)`);
  }
  if (!o.cases.length) return die(`${path} has no cases to evaluate`);
  const bad = o.cases.findIndex((c) => !c || typeof c.id !== "string" || typeof c.sender !== "string" || typeof c.text !== "string");
  if (bad >= 0) return die(`${path}: case number ${bad + 1} needs a string "id", "sender" and "text"`);
  return o as EvalDataset;
}

function die(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}
