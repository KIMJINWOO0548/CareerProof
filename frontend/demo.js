import { createWorkspace, addFact, confirmFact, addQuestion, saveRevision, setResearch } from "./workspace.js";
import { emptyResearch } from "./research.js";

export function exampleWorkspace() {
  const project = createWorkspace({ company: "가상정밀", role: "장비 제어 소프트웨어 개발" });
  const source = "가상 시험일지.md";
  const notes = [
    "C++ 장비 제어 모듈에서 연결이 끊긴 뒤 명령이 중복 전송되는 조건을 재현했습니다.",
    "로그에 명령 식별자를 남기고 재접속 시 이미 처리한 명령을 건너뛰도록 수정했습니다.",
    "수정 후 동일한 조건에서 회귀 테스트 12건을 수행해 중복 전송 여부를 확인했습니다.",
  ];
  const factIds = notes.map((text, i) => {
    const fact = addFact(project, { text, source: `${source} · 기록 ${i + 1}` });
    return confirmFact(project, fact.id).id;
  });
  const title = "장비 제어 과정에서 해결한 문제와 검증 방법을 기술하세요.";
  const question = addQuestion(project, { title, limit: 800 });
  saveRevision(project, question.id, { text: notes.join(" "), factIds, baseRevisionId: null });
  setResearch(project, {
    ...emptyResearch(),
    jdText: `자격요건\n- C++ 장비 제어 개발\n- 회귀 테스트 경험\n우대사항\n- Linux 개발 경험\n지원 문항\n${title} (800자 이내, 공백 포함)`,
    portfolio: { filename: source, kind: "md", pages: [{ page: 1, text: notes.join("\n") }] },
  });
  return project;
}
