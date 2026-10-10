import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { analyze, formatReport, runRoutingEval, wilsonLower } from "../src/eval/routing.ts";
import type { EvalDataset, EvalRow } from "../src/eval/routing.ts";
import { keywordClassifier } from "../src/harnesses/router.ts";
import type { Classifier } from "../src/harnesses/router.ts";
import { jevClassifier, NONE } from "../src/harnesses/jev.ts";
import { answerFor, fakeJev } from "./fake-jev.ts";

const dataset = () => JSON.parse(readFileSync("eval/routing-synthetic.json", "utf8")) as EvalDataset;
const row = (id: string, predicted: string | null, confidence: number, expect: string | null = "x"): EvalRow =>
  ({ id, sender: "human:a", expect, tags: [], predicted, confidence, needsHuman: null, outcome: "classified", latencyMs: 1 });

test("Wilson lower bound matches known values", () => {
  assert.ok(Math.abs(wilsonLower(10, 10) - 0.7225) < 0.002);
  assert.ok(Math.abs(wilsonLower(95, 100) - 0.8882) < 0.002);
  assert.equal(wilsonLower(0, 0), 0);
  assert.ok(wilsonLower(0, 10) < 0.001);
});

test("thresholds are measured, never invented: the lowest one that reaches the target, and how sure that is", () => {
  const rows = [...Array.from({ length: 10 }, (_, i) => row(`ok${i}`, "x", 0.9)), row("bad1", "y", 0.3), row("bad2", "y", 0.3)];
  const a = analyze(rows, { targetPrecision: 0.95 });
  const at = (t: number) => a.thresholds.find((x) => x.threshold === t)!;
  assert.deepEqual([at(0).routed, at(0).correct, at(0).wrong], [12, 10, 2]);
  assert.ok(Math.abs(at(0).precision! - 10 / 12) < 1e-9);
  assert.deepEqual([at(0.35).routed, at(0.35).precision], [10, 1]);
  assert.equal(a.suggestion!.threshold, 0.35);
  assert.equal(a.suggestion!.confident, false, "10 of 10 is too few to be sure of 95%");
  assert.equal(at(0.95).routed, 0);
  assert.equal(at(0.95).precision, null);

  const many = analyze([...Array.from({ length: 100 }, (_, i) => row(`ok${i}`, "x", 0.9)), ...Array.from({ length: 10 }, (_, i) => row(`bad${i}`, "y", 0.2))], { targetPrecision: 0.95 });
  assert.equal(many.thresholds[0]!.precision! < 0.95, true, "100 of 110 is not enough");
  assert.deepEqual([many.suggestion!.threshold, many.suggestion!.confident], [0.25, true], "100 of 100 above 0.25: enough data to be sure");
  const barely = analyze([...Array.from({ length: 100 }, (_, i) => row(`ok${i}`, "x", 0.9)), row("bad", "y", 0.2)], { targetPrecision: 0.95 });
  assert.deepEqual([barely.suggestion!.threshold, barely.suggestion!.confident], [0, false], "precision 99% already at 0, yet 100 messages cannot rule out below 95%");

  assert.equal(analyze(rows.slice(10), { targetPrecision: 0.95 }).suggestion, null, "too few routed messages: no suggestion");
  const err = analyze([{ ...row("e", null, 0), outcome: "error" }, { ...row("n", null, 0), outcome: "no-permitted-targets" }]);
  assert.deepEqual([err.errors, err.withoutTargets, err.suggestion], [1, 1, null]);
});

test("the synthetic dataset: shadow only, deterministic, and the baseline's known weaknesses show", async () => {
  const run = await runRoutingEval(dataset(), keywordClassifier());
  assert.equal(run.delivered, 0, "shadow mode delivers nothing");
  assert.equal(run.rows.length, 35);
  const by = Object.fromEntries(run.rows.map((r) => [r.id, r]));
  assert.equal(by.c01!.predicted, "ch-incidents");
  assert.equal(by.c17!.predicted, null, "no stemming and no Finnish: the keyword baseline abstains");
  assert.equal(by.c24!.predicted, null, "erin cannot address hr, so there is nothing to find");
  assert.equal(by.c31!.predicted, "ch-incidents", "off-topic text with overlapping words is a false route");
  assert.equal(by.c25!.predicted, "ch-deploys", "the destination she cannot reach was never offered");

  const a = analyze(run.rows);
  assert.deepEqual([a.cases, a.routable, a.offTopic], [35, 27, 8]);
  const t0 = a.thresholds[0]!;
  assert.deepEqual([t0.routed, t0.correct, t0.wrong], [24, 22, 2], "golden values: change the dataset or baseline on purpose");
  assert.equal(a.suggestion, null, "the baseline does not reach 95% precision on this data");
  assert.match(formatReport(run, a, "note"), /No threshold reaches 95% precision/);

  const again = await runRoutingEval(dataset(), keywordClassifier());
  const strip = (r: EvalRow) => ({ ...r, latencyMs: null });
  assert.deepEqual(again.rows.map(strip), run.rows.map(strip));
});

test("a bad dataset is refused; a failing classifier gives error rows, not an exception", async () => {
  const bad = dataset();
  bad.cases.push({ id: "z", sender: "human:bob", text: "invoice", expect: "ch-invoices" }); // bob cannot address finance
  await assert.rejects(runRoutingEval(bad, keywordClassifier()), /dataset-invalid: case z expects ch-invoices, which human:bob cannot address/);

  const down: Classifier = { name: "down", version: "1", async classify() { throw new Error("classifier down"); } };
  const run = await runRoutingEval(dataset(), down);
  assert.ok(run.rows.every((r) => r.outcome === "error"));
  const a = analyze(run.rows);
  assert.deepEqual([a.errors, a.suggestion], [35, null]);
  assert.match(formatReport(run, a), /35 messages could not be classified/);
});

test("an external classifier is evaluated through the same path: one request per message, only that sender's destinations", async () => {
  const jev = await fakeJev((b) => answerFor(b, Object.keys(b.questions.target.criteria).find((l) => l !== NONE && !l.startsWith("realm-"))!, { p: 0.8, noul: 0.2 }));
  const run = await runRoutingEval(dataset(), jevClassifier({ apiKey: "k", model: "pinned-1", endpoint: jev.url }));
  assert.equal(jev.requests.length, 35);
  assert.deepEqual(run.classifier, { name: "jev", version: "pinned-1" });
  assert.ok(run.rows.every((r) => r.outcome === "classified" && r.needsHuman === 0.2 && typeof r.latencyMs === "number"));
  const bob = jev.requests.find((r) => r.body.state.message === "production servers keep crashing")!;
  assert.deepEqual(Object.keys(bob.body.questions.target.criteria).sort(), [NONE, "ch-deploys", "ch-incidents", "ch-leave", "realm-hr", "realm-infra"].sort());
  await jev.close();
});

test("CLI: prints the report; --json parses; jev needs its key, a pinned model and explicit consent", () => {
  const out = execFileSync(process.execPath, ["--no-warnings", "src/eval/main.ts"], { encoding: "utf8" });
  assert.match(out, /# Routing evaluation: routing-synthetic/);
  assert.match(out, /Classifier keyword 1\. 35 messages/);
  const json = JSON.parse(execFileSync(process.execPath, ["--no-warnings", "src/eval/main.ts", "--json", "--target-precision", "0.9"], { encoding: "utf8" }));
  assert.equal(json.analysis.targetPrecision, 0.9);
  assert.equal(json.run.rows.length, 35);

  const env = { PATH: process.env.PATH! };
  const run = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", "src/eval/main.ts", ...args], { encoding: "utf8", env });
  assert.match(run("--classifier", "jev").stderr, /needs OPENROUTER_API_KEY/);
  assert.match(spawnSync(process.execPath, ["--no-warnings", "src/eval/main.ts", "--classifier", "jev"], { encoding: "utf8", env: { ...env, JEV_API_KEY: "k", JEV_MODEL: "m" } }).stderr, /--send-to-external/);
  assert.match(run("--classifier", "nope").stderr, /unknown classifier/);
});
