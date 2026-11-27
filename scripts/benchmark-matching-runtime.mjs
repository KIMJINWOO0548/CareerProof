import { deepStrictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus, platform, release } from "node:os";
import { fileURLToPath } from "node:url";
import { matchRequirements, parseJobDescription } from "../frontend/research.js";

// Compare the same evidence semantics immediately before and after indexing.
const baselineCommit = "17e4c8c3a2c604704cf62fddf28bcb4ef21ea5bd";
const root = fileURLToPath(new URL("..", import.meta.url));
const baselineSource = execFileSync("git", ["show", baselineCommit + ":frontend/research.js"], { cwd: root });
const baseline = await import("data:text/javascript;base64," + baselineSource.toString("base64"));
const fixture = JSON.parse(await readFile(new URL("../tests/fixtures/matching-benchmark.json", import.meta.url)));
const samples = 40;

function workload(requirementCount, factCount) {
  const rows = fixture.cases;
  const jdText = "자격요건\n" + rows.slice(0, requirementCount).map((row, i) => `공고 항목 ${i + 1} · ${row.jd}`).join("\n");
  const facts = Array.from({ length: factCount }, (_, i) => {
    const example = rows[i % rows.length];
    return { id: "f" + i, text: example.facts.join(" "), source: "가상 기록 " + i, verified: example.verified !== false };
  });
  return { workspace: { facts, questions: [], research: { jdText } }, requirements: parseJobDescription(jdText).requirements };
}

function percentiles(times) {
  const sorted = times.toSorted((a, b) => a - b);
  const at = p => Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(3));
  return { p50_ms: at(0.5), p95_ms: at(0.95) };
}

function measure(requirementCount, factCount) {
  const { workspace, requirements } = workload(requirementCount, factCount);
  const runs = {
    baseline: () => baseline.matchRequirements(workspace, requirements),
    current: () => matchRequirements(workspace, requirements),
  };
  deepStrictEqual(runs.current(), runs.baseline());
  const times = { baseline: [], current: [] };
  for (let i = 0; i < samples + 8; i++) {
    for (const name of (i % 2 ? ["current", "baseline"] : ["baseline", "current"])) {
      const start = performance.now();
      runs[name]();
      const elapsed = performance.now() - start;
      if (i >= 8) times[name].push(elapsed);
    }
  }
  return { requirements: requirements.length, facts: factCount, outputsEqual: true, baseline: percentiles(times.baseline), current: percentiles(times.current) };
}

console.log(JSON.stringify({
  baselineCommit, node: process.version, system: platform() + " " + release(), cpu: cpus()[0].model,
  samplePairs: samples, warmupPairs: 8, tests: [measure(4, 12), measure(25, 120)],
}, null, 2));
