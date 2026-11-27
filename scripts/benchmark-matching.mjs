import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { module: { type: "string" }, dataset: { type: "string", default: "development" } } });
const datasets = { development: "matching-benchmark.json", challenge: "matching-challenge.json" };
if (!Object.hasOwn(datasets, values.dataset)) throw new Error("--dataset must be development or challenge");
const modulePath = values.module ? pathToFileURL(resolve(values.module)) : new URL("../frontend/research.js", import.meta.url);
const { matchRequirements, parseJobDescription } = await import(modulePath.href);
const fixture = JSON.parse(await readFile(new URL("../tests/fixtures/" + datasets[values.dataset], import.meta.url), "utf8"));
const classes = ["covered", "weak", "missing"];
const matrix = Object.fromEntries(classes.map(label => [label, Object.fromEntries(classes.map(prediction => [prediction, 0]))]));
const failures = [];
for (const example of fixture.cases) {
  const workspace = {
    facts: example.facts.map((text, i) => ({ id: `f${i}`, text, source: "synthetic fixture", verified: example.verified !== false })),
    questions: [], research: { jdText: `자격요건\n${example.jd}` },
  };
  const [result] = matchRequirements(workspace, parseJobDescription(workspace.research.jdText).requirements);
  if (!result || !classes.includes(result.status)) throw new Error(`Invalid result: ${example.id}`);
  matrix[example.expected][result.status]++;
  if (result.status !== example.expected) failures.push({ id: example.id, expected: example.expected, actual: result.status });
}
const perClass = Object.fromEntries(classes.map(label => {
  const tp = matrix[label][label];
  const predicted = classes.reduce((sum, actual) => sum + matrix[actual][label], 0);
  const support = classes.reduce((sum, predictedLabel) => sum + matrix[label][predictedLabel], 0);
  const precision = predicted ? tp / predicted : 0;
  const recall = support ? tp / support : 0;
  return [label, { precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0, support }];
}));
const unsupported = fixture.cases.filter(row => row.expected !== "covered").length;
console.log(JSON.stringify({
  dataset: fixture.description, module: modulePath.href, cases: fixture.cases.length,
  confusionMatrix: { rows: "expected", columns: "predicted", values: matrix }, perClass,
  macroF1: classes.reduce((sum, label) => sum + perClass[label].f1, 0) / classes.length,
  unsupportedFalselyCovered: { numerator: matrix.weak.covered + matrix.missing.covered, denominator: unsupported }, failures,
}, null, 2));
