import test from "node:test";
import assert from "node:assert/strict";
import { parseJobDescription, termsIn, matchRequirements, prioritizedActions, portfolioCandidates, researchContext, emptyResearch } from "../frontend/research.js";
import { createWorkspace, addFact, confirmFact, addQuestion, saveRevision, approveRevision, setResearch, backupWorkspace, restoreWorkspace } from "../frontend/workspace.js";

const project = () => createWorkspace({ company: "예시회사", role: "SW 개발" });
test("한국어 공고 조건, 문항 제한과 코드포인트 원문을 보존하고 중복을 제거한다", () => {
  const jd = "😀 채용 안내\n자격요건\n- C++20 개발 경험\n- C++20 개발 경험\n우대사항\n- WPF 및 C# 경험\n지원 문항\n1. 지원 동기를 설명하세요. (공백 제외 1,000자, 3000바이트, 5줄 이내)\n2. 역할을 기술하세요. (2000 bytes)";
  const parsed = parseJobDescription(jd);
  assert.equal(parsed.requirements.length, 2);
  assert.equal(parsed.requirements[1].priority, "preferred");
  assert.deepEqual(parsed.requirements[0].terms, ["C++"]);
  assert.equal(parsed.questions.length, 2);
  assert.equal(parsed.questions[0].limit, 1000);
  assert.equal(parsed.questions[0].rule.maxBytes, 3000);
  assert.equal(parsed.questions[0].rule.maxLines, 5);
  assert.equal(parsed.questions[0].rule.includeSpaces, false);
  assert.equal(parsed.questions[1].inferredCharLimit, true);
  for (const row of [...parsed.requirements, ...parsed.questions]) assert.equal([...jd].slice(row.span.start, row.span.end).join(""), row.span.quote);
});

test("기술어 동의어는 구분하되 유사 부분 문자열을 기술로 오인하지 않는다", () => {
  assert.deepEqual(termsIn("cpp C++20 csharp C# WPF Windows Presentation Foundation"), ["C++", "C#", "WPF"]);
  assert.deepEqual(termsIn("acpp compiler scsharp helpfulreact"), []);
});

test("단순 기술 언급과 미확인 포트폴리오는 충족으로 세지 않고 누락 우선순위를 설명한다", () => {
  const ws = project(); setResearch(ws, { ...emptyResearch(), jdText: "자격요건\nC++ 개발 경험\nWPF 개발 경험\n우대사항\nPython 개발 경험", portfolio: { filename: "경험.md", kind: "md", pages: [{ page: 1, text: "WPF를 사용하여 화면을 개발했습니다." }] } });
  const mention = addFact(ws, { text: "C++", source: "기술 목록" }); confirmFact(ws, mention.id);
  let rows = matchRequirements(ws);
  assert.deepEqual(rows.map(row => row.status), ["weak", "weak", "missing"]);
  const fact = addFact(ws, { text: "cpp를 사용해 제어 모듈을 구현하고 테스트했습니다.", source: "프로젝트 보고서 3쪽" }); confirmFact(ws, fact.id);
  rows = matchRequirements(ws);
  assert.equal(rows[0].status, "covered");
  assert.equal(rows[1].status, "weak");
  assert.equal(prioritizedActions(rows)[0].requirementId, rows[1].id);
  assert.match(prioritizedActions(rows)[0].reason, /WPF/);
  assert.ok(rows[0].matches.some(match => match.span.quote === fact.text));
});

test("확정본의 새로운 기술어와 부정된 경험은 수행 증거로 격상하지 않는다", () => {
  const ws = project();
  const f = addFact(ws, { text: "C++ 제어 모듈을 구현했습니다.", source: "프로젝트" }); confirmFact(ws, f.id);
  const denied = addFact(ws, { text: "WPF 개발 경험은 없습니다.", source: "기록" }); confirmFact(ws, denied.id);
  const q = addQuestion(ws, { title: "경험", limit: 500 });
  const r = saveRevision(ws, q.id, { text: "WPF 화면을 개발했습니다.", factIds: [f.id], baseRevisionId: null }); approveRevision(ws, q.id, r.id);
  const rows = matchRequirements(ws, parseJobDescription("필수\nWPF 개발 경험").requirements);
  assert.equal(rows[0].status, "weak");
  assert.ok(!rows[0].matches.some(m => m.revisionId));
});

test("선택용 포트폴리오 후보는 페이지·출처·범위가 있고 중복되지 않는다", () => {
  const data = { filename: "자료.pdf", kind: "pdf", pages: [{ page: 1, text: "😀 C++ 모듈을 구현했습니다.\n😀 C++ 모듈을 구현했습니다." }, { page: 3, text: "WPF 화면을 개발했습니다." }] };
  const rows = portfolioCandidates(data); assert.equal(rows.length, 2);
  assert.equal(rows[1].span.page, 3); assert.equal(rows[0].span.source, "자료.pdf");
  assert.equal([...data.pages[0].text].slice(rows[0].span.start, rows[0].span.end).join(""), rows[0].span.quote);
});

test("여러 확정본이 같은 기술 목록을 참조해도 중복 증거나 수행 근거가 생기지 않는다", () => {
  const ws = project();
  const fact = addFact(ws, { text: "C++", source: "기술 목록" }); confirmFact(ws, fact.id);
  for (let i = 0; i < 8; i++) {
    const q = addQuestion(ws, { title: `문항 ${i}`, limit: 100 });
    const r = saveRevision(ws, q.id, { text: "C++ 제어 모듈을 구현했습니다.", factIds: [fact.id], baseRevisionId: null });
    approveRevision(ws, q.id, r.id);
  }
  const [row] = matchRequirements(ws, parseJobDescription("필수\nC++ 개발 경험").requirements);
  assert.equal(row.status, "weak");
  assert.equal(row.matches.length, 9);
});

test("research 백업 왕복과 구버전 호환, 비밀·알 수 없는 필드 거절을 검증한다", () => {
  const ws = project(); assert.deepEqual(restoreWorkspace(backupWorkspace(ws)), ws);
  setResearch(ws, { ...emptyResearch(), jdText: "자격요건\nC++ 개발 경험", officialSources: [{ label: "공식 채용", url: "https://example.test/jobs", text: "제어 SW 개발" }] });
  assert.deepEqual(restoreWorkspace(backupWorkspace(ws)), ws);
  assert.throws(() => setResearch(ws, { ...ws.research, apiKey: "secret" }));
  assert.throws(() => setResearch(ws, { ...ws.research, portfolio: { filename: "a", kind: "txt", pages: [{ page: 1, text: "a", contentBase64: "secret" }] } }));
  assert.throws(() => setResearch(ws, { ...ws.research, officialSources: [{ label: "공식", url: "javascript:alert(1)", text: "원문" }] }));
  assert.throws(() => restoreWorkspace({ ...ws, extra: true }));
  assert.throws(() => setResearch(ws, { ...ws.research, jdText: "가".repeat(50001) }));
});

test("위원회 컨텍스트는 명시 공고·출처 및 확인된 사실만 포함한다", () => {
  const ws = project(); setResearch(ws, { ...emptyResearch(), jdText: "자격요건\nC# 개발 경험", portfolio: { filename: "미검토", kind: "txt", pages: [{ page: 1, text: "미검토 비밀 문장" }] } });
  const f = addFact(ws, { text: "C# 화면을 구현했습니다.", source: "자료 2쪽" }); confirmFact(ws, f.id);
  addFact(ws, { text: "미확인 사실", source: "미검토" });
  const context = researchContext(ws); assert.deepEqual(context.requirements, ["C# 개발 경험"]);
  assert.match(context.portfolio, /자료 2쪽/); assert.doesNotMatch(context.portfolio, /미검토|미확인/);
});
