// No network or dependency installation. Input text is never printed.
import { readFile } from "node:fs/promises";
import { scoreText } from "../frontend/analysis.js";

function diagnostic(row) {
  return scoreText(row.text, { kind: row.kind ?? "self_intro", facts: [
    { id: "F-1", text: row.verified ?? "", verified: true },
    { id: "F-2", text: row.unverified ?? "", verified: false },
  ] });
}

function metrics(rows) {
  const eligible = rows.filter(r => !r.abstain && Number.isFinite(r.score));
  const humans = eligible.filter(r => r.label === "human").length;
  const ai = eligible.length - humans;
  const summary = { count: rows.length, abstained: rows.length - eligible.length, humans, ai };
  if (!humans || !ai) return { ...summary, auroc: null, tprAtFpr05: null };
  const groups = new Map();
  for (const row of eligible) {
    const group = groups.get(row.score) ?? { ai: 0, human: 0 };
    group[row.label]++;
    groups.set(row.score, group);
  }
  let seenAI = 0, seenHuman = 0, area = 0, bestTPR = 0;
  for (const [, g] of [...groups].sort((a, b) => b[0] - a[0])) {
    area += (seenAI + g.ai / 2) * g.human;
    seenAI += g.ai;
    seenHuman += g.human;
    if (seenHuman / humans <= 0.05) bestTPR = seenAI / ai;
  }
  return { ...summary, auroc: area / (ai * humans), tprAtFpr05: bestTPR };
}

const path = process.argv[2];
if (!path) {
  const fixtures = JSON.parse(await readFile(new URL("../tests/fixtures/style-smoke.json", import.meta.url), "utf8"));
  const failures = fixtures.filter(row => {
    const result = diagnostic(row);
    return result.total !== row.total || !result.abstain || result.calibrated ||
      (row.rule && !result.highlights.some(h => h.rule === row.rule));
  }).map(row => row.id);
  console.log(JSON.stringify({ dataset: "synthetic-style-smoke", cases: fixtures.length, passed: fixtures.length - failures.length, failures, modelCalls: 0, calibrated: false }, null, 2));
  if (failures.length) process.exitCode = 1;
} else {
  const segmenter = new Intl.Segmenter("ko", { granularity: "grapheme" });
  const rows = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).map((line, index) => {
    const row = JSON.parse(line);
    if (!["human", "ai"].includes(row.label) || typeof row.text !== "string" || !row.text.trim() || !row.source || !row.permission) {
      throw Error(`Invalid label, text, source or permission at row ${index + 1}`);
    }
    const result = diagnostic(row);
    return { label: row.label, score: result.total, abstain: result.abstain, length: [...segmenter.segment(row.text.normalize("NFC").trim())].length };
  });
  const bands = [[0, 300], [300, 600], [600, 1000], [1000, Infinity]];
  console.log(JSON.stringify({ date: new Date().toISOString().slice(0, 10), calibrated: false,
    overall: metrics(rows), lengthBands: bands.map(([from, until]) => ({ from, until: Number.isFinite(until) ? until : null, ...metrics(rows.filter(r => r.length >= from && r.length < until)) })) }, null, 2));
}
