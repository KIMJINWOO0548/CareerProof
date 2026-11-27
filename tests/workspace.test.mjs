import test from "node:test";
import assert from "node:assert/strict";
import {
  addFact, addQuestion, approveRevision, backupWorkspace, confirmFact, createWorkspace,
  importResume, restoreWorkspace, saveRevision,
} from "../frontend/workspace.js";

function project() {
  return createWorkspace({ company: "가상시스템즈", role: "제어 SW 개발자" });
}

function example(limit = 500) {
  const workspace = project();
  const fact = addFact(workspace, { text: "C++20 응답 지연을 120ms에서 85ms로 낮췄다.", source: "가상 측정 기록" });
  confirmFact(workspace, fact.id);
  const question = addQuestion(workspace, { title: "구현한 일을 설명하세요.", limit });
  const save = (text, factIds = [fact.id]) => saveRevision(workspace, question.id, {
    text, factIds, baseRevisionId: question.headRevisionId,
  });
  return { workspace, fact, question, save };
}

test("가져온 성과·기술은 출처가 있는 후보이며 중복 가져오기와 연락처를 처리한다", () => {
  const workspace = project();
  const resume = {
    basics: { name: "비공개", email: "private@example.test" },
    $schema: "https://example.test/external.json",
    work: [{ name: "가상시스템즈", position: "인턴", highlights: ["지연을 측정했다."] }],
    projects: [{ name: "가상 호스트", description: "프로세스 격리" }],
    skills: [{ name: "프로그래밍", keywords: ["C++"] }],
    education: [{ institution: "가상학교", area: "전산", courses: ["운영체제"] }],
  };
  const added = importResume(workspace, resume);
  assert.equal(added.length, 8);
  assert.ok(added.every(f => !f.verified));
  assert.equal(added.find(f => f.text === "지연을 측정했다.").source, "/work/0/highlights/0");
  assert.equal(importResume(workspace, resume).length, 0);
  assert.doesNotMatch(backupWorkspace(workspace), /private@example|external\.json|비공개/);
});

test("가져오기 도중 잘못된 항목을 만나면 기존 작업을 보존한다", () => {
  const workspace = project();
  assert.throws(() => importResume(workspace, { work: [{ name: "첫 항목" }, { highlights: 123 }] }));
  assert.deepEqual(workspace.facts, []);
  assert.throws(() => importResume(workspace, { format: "careerproof-prototype" }));
});

test("UTF-16 원래 이모지 길이 규칙을 백업하고 확정 분량 검사에도 적용한다", () => {
  const ws = project();
  const q = addQuestion(ws, { title: "짧은 문항", limit: 3, rule: { charUnit: "utf16", emojiPolicy: "native" } });
  const fact = addFact(ws, { text: "디자인", source: "기록" });
  confirmFact(ws, fact.id);
  const rev = saveRevision(ws, q.id, { text: "👍🏽", factIds: [fact.id], baseRevisionId: null });
  assert.throws(() => approveRevision(ws, q.id, rev.id), { code: "count_limit" });
  assert.equal(restoreWorkspace(backupWorkspace(ws)).questions[0].rule.emojiPolicy, "native");
});

test("수동 초안에는 미확인 사실을 연결할 수 없고 stale 편집은 기존 이력을 보존한다", () => {
  const { workspace, question, save } = example();
  const unverified = addFact(workspace, { text: "검토 전", source: "가상" });
  assert.throws(() => save("초안", [unverified.id]), { code: "unverified_fact" });
  const draft = save("근거 선택 전", []);
  assert.equal(save("근거 선택 전", []).id, draft.id);
  assert.throws(() => approveRevision(workspace, question.id, draft.id), { code: "missing_evidence" });
  assert.throws(() => saveRevision(workspace, question.id, {
    text: "다른 탭의 편집", factIds: [], baseRevisionId: null,
  }), { code: "stale_revision" });
  assert.deepEqual(question.revisions, [draft]);
});

test("확정본과 새 편집본은 독립적이며 작업 JSON 왕복 후에도 동일하다", () => {
  const { workspace, fact, question, save } = example();
  const refs = [fact.id];
  const first = save("C++20 응답 지연을 120 ms에서 85ms로 줄였습니다.", refs);
  refs.length = 0;
  assert.deepEqual(first.factIds, [fact.id]);
  approveRevision(workspace, question.id, first.id);
  const second = save("추가 편집 중");
  assert.equal(second.parentId, first.id);
  assert.equal(question.headRevisionId, second.id);
  assert.equal(question.approvedRevisionId, first.id);
  const restored = restoreWorkspace(backupWorkspace(workspace));
  assert.deepEqual(restored, workspace);
  restored.facts[0].text = "다른 문서";
  assert.notEqual(workspace.facts[0].text, restored.facts[0].text);
});

test("초안 저장은 허용하고 분량·수치·단위가 불일치하면 확정을 거절한다", () => {
  const { workspace, question, save } = example(30);
  for (const [text, code] of [
    ["가".repeat(31), "count_limit"], ["", "empty_answer"],
    ["35% 줄였습니다.", "unsupported_number"], ["85초 줄였습니다.", "unsupported_number"],
    ["C++23 환경", "unsupported_number"],
  ]) {
    const draft = save(text);
    assert.throws(() => approveRevision(workspace, question.id, draft.id), { code });
    assert.equal(question.approvedRevisionId, null);
  }
});

test("단위 없는 원장 수치에 배수나 화폐 단위를 붙이면 확정을 보류한다", () => {
  const { workspace, question, save } = example();
  const fact = addFact(workspace, { text: "배치 ID는 4, 담당한 작업은 4만 건", source: "작업 기록" });
  confirmFact(workspace, fact.id);
  const claims = ["4억 건", "4유로", "4만 달러", "4퍼센트포인트"];
  for (const claim of claims) {
    const draft = save(claim, [fact.id]);
    assert.throws(() => approveRevision(workspace, question.id, draft.id), { code: "unsupported_number" });
  }
  const valid = save("4만건을 처리했습니다.", [fact.id]);
  approveRevision(workspace, question.id, valid.id);
});

test("복원은 소속 문항의 포인터, 부모 사슬, 근거 참조, 확정 조건을 다시 확인한다", () => {
  const { workspace, question, save } = example();
  const first = save("지연 85ms");
  approveRevision(workspace, question.id, first.id);
  const other = addQuestion(workspace, { title: "추가 문항", limit: 100 });
  saveRevision(workspace, other.id, { text: "다른 내용", factIds: [], baseRevisionId: null });
  for (const tamper of [
    data => { data.format = "jsonresume"; },
    data => { data.version = 999; },
    data => { data.questions[0].headRevisionId = null; },
    data => { data.questions[0].revisions[0].parentId = "missing"; },
    data => { data.questions[0].approvedRevisionId = data.questions[1].headRevisionId; },
    data => { data.questions[0].rule.maxChars = 2; },
    data => { data.questions[0].rule.byteEncoding = "unknown"; },
    data => { data.questions[0].revisions[0].factIds = ["missing"]; },
    data => { data.questions[0].revisions[0].text = "지연 800ms"; },
    data => { data.facts[0].verified = false; },
    data => { data.facts.push(data.facts[0]); },
    data => { data.credentials = "unexpected"; },
  ]) {
    const copy = JSON.parse(backupWorkspace(workspace));
    tamper(copy);
    assert.throws(() => restoreWorkspace(copy));
  }
});
