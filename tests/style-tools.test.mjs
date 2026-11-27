import test from "node:test";
import assert from "node:assert/strict";
import { compareNgrams } from "../frontend/style-tools.js";
import { addFact, addQuestion, backupWorkspace, confirmFact, createWorkspace, recordExternalReview, restoreWorkspace, saveRevision } from "../frontend/workspace.js";

test("4-token comparison reports only exact shared spans and an explicit denominator", () => {
  const result = compareNgrams("저는 고객 응답 시간을 크게 줄였습니다", "고객 응답 시간을 크게 줄인 결과", 4, 0.2);
  assert.equal(result.denominator, 3);
  assert.equal(result.matched, 1);
  assert.equal(result.thresholdExceeded, true);
  assert.deepEqual(result.draftSpans, [{ start: 3, end: 15 }]);
  assert.deepEqual(result.sourceSpans, [{ start: 0, end: 12 }]);
});

test("punctuation and overlapping matching windows retain the reference offsets", () => {
  const reference = "첫째 둘째 셋째 넷째 다섯째";
  const result = compareNgrams("첫째, 둘째 셋째 넷째 다섯째", reference);
  assert.equal(result.ratio, 1);
  assert.deepEqual(result.sourceSpans.map(s => reference.slice(s.start, s.end)), ["첫째 둘째 셋째 넷째", "둘째 셋째 넷째 다섯째"]);
});

test("external scores attach to a saved revision and survive backup restore", () => {
  const workspace = createWorkspace({ company: "회사", role: "직무" });
  const fact = addFact(workspace, { text: "프로젝트 성과를 개선했다.", source: "기록" });
  confirmFact(workspace, fact.id);
  const question = addQuestion(workspace, { title: "성과", limit: 200 });
  const revision = saveRevision(workspace, question.id, { text: "프로젝트 성과를 개선했다.", factIds: [fact.id], baseRevisionId: null });
  const review = recordExternalReview(workspace, question.id, revision.id, { provider: "수동 평가", score: 82, paragraphScores: [79, 85] });
  assert.equal(workspace.externalReviews[0], review);
  assert.equal(revision.externalReviews, undefined);
  assert.deepEqual(restoreWorkspace(backupWorkspace(workspace)).externalReviews[0], review);
  assert.throws(() => recordExternalReview(workspace, question.id, revision.id, { provider: "평가", score: 101 }));
});

function reviewedWorkspace() {
  const workspace = createWorkspace({ company: "회사", role: "직무" });
  const question = addQuestion(workspace, { title: "성과", limit: 200 });
  const revision = saveRevision(workspace, question.id, { text: "작성한 답변", factIds: [], baseRevisionId: null });
  recordExternalReview(workspace, question.id, revision.id, { provider: "평가", score: 82 });
  return { workspace, question, revision };
}

test("external review validation rejects dangling, cross-question and unknown fields", () => {
  const { workspace, question, revision } = reviewedWorkspace();
  const other = addQuestion(workspace, { title: "다른 문항", limit: 200 });
  for (const change of [
    w => { w.externalReviews[0].questionId = other.id; },
    w => { w.externalReviews[0].revisionId = "missing"; },
    w => { w.externalReviews[0].unknown = true; },
    w => { w.externalReviews[0].score = NaN; },
    w => { w.externalReviews[0].paragraphScores = [101]; },
    w => { w.externalReviews[0].createdAt = "yesterday"; },
    w => { w.externalReviews = Array(101).fill(w.externalReviews[0]); },
  ]) {
    const invalid = structuredClone(workspace);
    change(invalid);
    assert.throws(() => restoreWorkspace(invalid));
    assert.throws(() => backupWorkspace(invalid));
  }
  const before = backupWorkspace(workspace);
  assert.throws(() => recordExternalReview(workspace, question.id, revision.id, { provider: "평가", score: 80, unknown: true }));
  assert.throws(() => recordExternalReview(workspace, other.id, revision.id, { provider: "평가", score: 80 }));
  assert.equal(backupWorkspace(workspace), before);
});

test("remote revision replacement preserves local notes and original revision bytes", () => {
  const { workspace, question } = reviewedWorkspace();
  const original = structuredClone(question.revisions);
  const remote = restoreWorkspace(backupWorkspace(workspace));
  delete remote.externalReviews;
  const note = recordExternalReview(workspace, question.id, question.headRevisionId, { provider: "추가 평가", score: 90 });
  question.revisions = remote.questions[0].revisions;
  assert.deepEqual(question.revisions, original);
  assert.deepEqual(restoreWorkspace(backupWorkspace(workspace)).externalReviews.at(-1), note);
});

test("official v1 backups stay compatible and experimental revision notes migrate", () => {
  const { workspace, revision } = reviewedWorkspace();
  const [{ questionId, revisionId, ...entry }] = workspace.externalReviews;
  delete workspace.externalReviews;
  const official = backupWorkspace(workspace);
  assert.equal(backupWorkspace(restoreWorkspace(official)), official);
  revision.externalReviews = [entry];
  const migrated = restoreWorkspace(workspace);
  assert.equal(migrated.questions[0].revisions[0].externalReviews, undefined);
  assert.deepEqual(migrated.externalReviews, [{ ...entry, questionId, revisionId }]);
});
