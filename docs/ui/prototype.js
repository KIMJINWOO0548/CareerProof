(() => {
  "use strict";

  const stage = document.querySelector("#stage");
  if (!stage) return;

  const company = "가상시스템즈";
  const role = "장비 제어 소프트웨어 개발";
  const disclaimer = "점수는 진단이며 합격 예측이 아닙니다.";
  const pages = {
    workbench: ["지원서 작성", "문항별 답변을 다듬고 사실 근거를 확인하세요."],
    profile: ["프로필과 사실 원장", "경험의 출처를 남기고 초안에 사용할 사실을 확인하세요."],
    brief: ["공고 브리프", "공고에 명시된 직무 요건과 준비할 증거를 확인하세요."],
    committee: ["위원회 심사", "다섯 가지 역할이 같은 답변에서 살펴보는 기준을 비교하세요."],
    export: ["확정본 내보내기", "확정한 답변을 복사하거나 파일로 받으세요."],
  };

  const facts = [
    { id: "F-001", label: "구현", text: "C++ DLL과 C# WPF 간 P/Invoke 연동", source: "프로필 · 인턴 업무", verified: true },
    { id: "F-002", label: "수치", text: "배치 처리 지연을 120ms에서 85ms로 단축", source: "프로필 · 프로젝트 기록", verified: true },
    { id: "F-003", label: "검증", text: "장비 응답 타임아웃을 재현하는 테스트 6건 작성", source: "포트폴리오 · 테스트 기록", verified: true },
  ];

  const firstText = "가상시스템즈의 장비 제어 소프트웨어 개발 직무에 지원합니다. 인턴 기간 C++ DLL과 C# WPF 간 P/Invoke 연동을 맡아 제어 계층과 화면이 데이터를 주고받을 수 있도록 연결했습니다. 이를 통해 장비와 응용 프로그램 사이의 경계가 안정성에 어떤 영향을 미치는지 배웠습니다.\n\n배치 처리 지연을 120ms에서 85ms로 단축했습니다. 또한 장비 응답 타임아웃을 재현하는 테스트 6건 작성 경험을 바탕으로, 오류를 반복해서 재현할 수 있는 조건을 남기려고 했습니다. 입사 후에는 운영 중 이상 동작을 발견했을 때 재현 조건과 확인 결과를 동료가 다시 사용할 수 있도록 정리하겠습니다.";
  const questions = [
    {
      id: "q1", label: "지원 동기", title: "지원 동기와 직무 강점을 작성해 주세요.", limit: 500,
      text: firstText, required: ["F-001"], links: ["F-001", "F-002", "F-003"],
      change: [
        "이를 통해 장비와 응용 프로그램 사이의 경계가 안정성에 어떤 영향을 미치는지 배웠습니다.\n\n배치 처리 지연을 120ms에서 85ms로 단축했습니다.",
        "장비 상태를 화면에서 확인할 수 있도록 C++ 제어 계층에서 전달하는 값을 연결했습니다.\n\n배치 처리 지연을 120ms에서 85ms로 단축했습니다.",
      ],
    },
    {
      id: "q2", label: "직무 역량", title: "직무 역량을 보여 주는 구현 경험을 적어 주세요.", limit: 700,
      text: "인턴으로 장비 제어 화면과 C++ 모듈을 연결하는 개발을 맡았습니다. C++ DLL과 C# WPF 간 P/Invoke 연동을 구현하고, 화면에서 장비 상태를 확인할 수 있도록 했습니다.\n\n장비 응답 타임아웃을 재현하는 테스트 6건 작성 과정에서는 오류의 발생 조건을 구분해 기록했습니다.",
      required: ["F-001"], links: ["F-001", "F-003"],
      change: ["인턴으로 장비 제어 화면과 C++ 모듈을 연결하는 개발을 맡았습니다. ", ""],
    },
    {
      id: "q3", label: "입사 후 계획", title: "입사 후 기여하고 싶은 일을 작성해 주세요.", limit: 500,
      text: "입사 후 장비 응답 오류를 발견하면 재현 조건과 관찰 결과부터 정리하겠습니다. 인턴 기간 장비 응답 타임아웃을 재현하는 테스트 6건 작성 경험을 적용해, 제어 계층과 화면 중 어느 구간에서 증상이 시작되는지 확인하겠습니다.",
      required: ["F-003"], links: ["F-003"],
      change: ["입사 후 장비 응답 오류를 발견하면 재현 조건과 관찰 결과부터 정리하겠습니다.", "입사 후 장비 응답 오류의 재현 조건과 장비 상태를 먼저 기록하겠습니다."],
    },
  ];
  let revisionNumber = 1;

  function createRevision(question, text, source, parent = question.head) {
    const revision = { id: "R-" + String(revisionNumber++).padStart(2, "0"), parentId: parent?.id ?? null, text, source };
    question.revisions.push(revision);
    return revision;
  }

  for (const question of questions) {
    question.revisions = [];
    question.head = createRevision(question, question.text, "초기 초안", null);
    question.best = question.head;
    question.approved = null;
    question.run = "paused";
    question.iteration = 1;
    question.step = 2;
    question.proposal = null;
    question.note = "";
  }

  let currentPage = "workbench";
  let questionIndex = 0;
  let notice = "";
  let briefText = "가상시스템즈의 장비 제어 소프트웨어 개발 직무입니다.\n\n[주요 업무]\nC++ 및 C# WPF 장비 제어 소프트웨어 개발\n장비 응답 오류 재현 및 테스트 작성\n\n[우대 요건]\n장비 통신 프로토콜 연동 경험";
  const sampleBrief = briefText;
  let briefSaved = briefText;
  let committeeQuestion = 0;
  let committeeScope = "question";
  let committeeResult = null;
  let committeePersona = 0;
  let exportQuestion = 0;
  let importPreview = [];
  let importMessage = "";
  const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("ko", { granularity: "grapheme" }) : null;

  const personas = [
    ["실무 팀장", "직무 요건과 설계 깊이", [8, 8, 4]],
    ["실무 팀원", "구현과 검증 근거", [8, 7, 5]],
    ["인사 팀장", "지원 동기와 회사 적합성", [8, 6, 4]],
    ["인사 담당자", "문항 의도와 분량", [7, 6, 4]],
    ["임원", "기여 가능성과 임팩트", [10, 8, 7]],
  ];

  function escape(text) {
    return String(text ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  }

  function count(text) {
    return {
      chars: segmenter ? Array.from(segmenter.segment(text)).length : Array.from(text).length,
      bytes: new TextEncoder().encode(text).length,
      lines: text ? text.split("\n").length : 0,
    };
  }

  function button(label, action, style = "secondary", disabled = false, extra = "") {
    return '<button type="button" class="btn ' + style + '" data-action="' + action + '"' + (disabled ? " disabled" : "") + (extra ? " " + extra : "") + ">" + escape(label) + "</button>";
  }

  function badge(text, kind = "neutral") {
    return '<span class="badge ' + kind + '">' + escape(text) + "</span>";
  }

  function notify(message) {
    notice = message;
    const region = document.querySelector("#prototype-notice");
    if (region) region.textContent = message;
  }

  function verifiedFact(id) {
    return facts.find((fact) => fact.id === id && fact.verified);
  }

  function proposalFor(question) {
    const [before, after] = question.change;
    const text = question.head.text;
    if (text.includes(before) && !text.includes(after || "\0")) {
      return { base: question.head.id, before, after, text: text.replace(before, after), factIds: question.links.slice(0, 2).filter(verifiedFact) };
    }
    const fact = question.links.map(verifiedFact).find((entry) => entry && !text.includes(entry.text));
    return fact ? {
      base: question.head.id, before: "", after: fact.text + ".", text: (text ? text.trimEnd() + "\n\n" : "") + fact.text + ".", factIds: [fact.id],
    } : null;
  }

  questions[0].proposal = proposalFor(questions[0]);

  function saveEdit(question) {
    if (question.text !== question.head.text) question.head = createRevision(question, question.text, "편집");
  }

  function numberTokens(text) {
    return Array.from(text.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?(?:[ \t]*(?:시간|ms|초|분|일|건|개|명|회|%|배))?/giu),
      ([token]) => token.toLowerCase().replace(/[, \t]/g, ""));
  }

  function approvalProblem(question, text) {
    if (!text.trim()) return "답변을 입력하면 확정할 수 있습니다.";
    if (count(text).chars > question.limit) return "답변이 " + question.limit + "자 제한을 넘었습니다.";
    const normalized = text.normalize("NFC").replace(/\s+/g, " ");
    const missing = question.required.some((id) => {
      const fact = verifiedFact(id);
      return !fact || !normalized.includes(fact.text.normalize("NFC").replace(/\s+/g, " "));
    });
    if (missing) return "문항에 연결한 필수 사실을 답변에서 확인해 주세요.";
    const verifiedNumbers = new Set(question.links.map(verifiedFact).filter(Boolean).flatMap((fact) => numberTokens(fact.text)));
    if (numberTokens(text).some((token) => !verifiedNumbers.has(token))) {
      return "이 시연에서 확인할 수 있는 수치는 연결된 사실 원장에 있습니다. 새 수치를 추가했다면 출처를 확인해 주세요.";
    }
    return "";
  }

  function approvalState(question) {
    if (!question.approved) return ["초안 작업 중", "neutral"];
    if (question.text !== question.approved.text) return ["확정 후 편집", "warning"];
    return ["확정됨", "success"];
  }

  function styleScore(text) {
    const words = text.match(/이를 통해|바탕으로|기여하겠습니다|최선을 다하겠습니다/g)?.length ?? 0;
    const details = text.match(/C\+\+|C#|WPF|P\/Invoke|\d+ms|\d+건|타임아웃|재현/g)?.length ?? 0;
    const endings = text.match(/했습니다\./g)?.length ?? 0;
    const pattern = Math.min(30, 8 + endings * 2);
    const cliche = Math.min(30, words * 6);
    const specificity = Math.max(0, 32 - details * 2);
    return { pattern, cliche, specificity, total: pattern + cliche + specificity, pending: count(text).chars < 300 };
  }

  function counterMarkup(question) {
    const { chars, bytes, lines } = count(question.text);
    const status = chars > question.limit ? "over-limit" : chars / question.limit >= 0.9 ? "near-limit" : "";
    return `
      <div class="counter-row ${status}">
        <span><strong>${chars}</strong> / ${question.limit}자</span><span>공백 포함</span>
        <span class="counter-extra">${bytes}바이트 · ${lines}줄</span>
        <button type="button" class="btn ghost calibration-trigger" data-calibrate>글자 수 보정</button>
      </div>
      <progress class="progress ${status}" max="${question.limit}" value="${Math.min(chars, question.limit)}" aria-label="글자 수 제한 사용량"></progress>`;
  }

  function diffMarkup(question) {
    const proposal = question.proposal;
    if (!proposal) {
      return `
        <section class="panel diff-panel">
          <div class="panel-head">
            <div><h2>수정 제안</h2><p class="muted">근거를 연결한 제안을 여기에서 검토할 수 있습니다.</p></div>
            ${badge("대기")}
          </div>
          <p class="empty-state muted">편집 후 루프를 재개하면 가상 예시로 제안을 만듭니다.</p>
        </section>`;
    }
    const changed = proposal.base !== question.head.id || question.text !== question.head.text;
    const links = proposal.factIds.map((id) => `
      <button class="fact-link" type="button" data-action="show-fact" data-id="${escape(id)}">${escape(id)}</button>`).join("");
    return `
      <section class="panel diff-panel">
        <div class="panel-head">
          <div><h2>수정 제안</h2><p class="muted">원장의 사실을 바탕으로 구현 경험을 구체화합니다.</p></div>
          ${badge(changed ? "편집 전 제안" : "검토 대기", "warning")}
        </div>
        <div class="diff-grid">
          <div class="diff before"><div class="diff-label">수정 전</div><p>${escape(proposal.before || "추가할 문장")}</p></div>
          <div class="diff after"><div class="diff-label">수정 후</div><p>${escape(proposal.after || "중복 문장 삭제")}</p></div>
        </div>
        <div class="diff-footer row">
          <div class="fact-links"><span class="muted">연결 근거</span>${links}</div>
          <div class="actions">
            ${button("거절", "reject", "ghost", question.run === "running")}
            ${button("제안 반영", "accept", "secondary", changed || question.run === "running")}
          </div>
        </div>
      </section>`;
  }

  function runMarkup(question) {
    const labels = ["초안 준비", "분량·근거 확인", "수정 제안 검토"];
    const [status, kind, actionLabel, action] = {
      paused: ["일시 정지", "warning", "이어서 진행", "resume"],
      running: ["진행 중", "info", "일시 정지", "pause"],
      completed: ["검토 가능", "success", "다시 점검", "resume"],
    }[question.run];
    const steps = labels.map((label, index) => {
      const css = index < question.step ? "done" : index === question.step ? "current" : "";
      return `
        <li class="${css}">
          <span class="step-dot" aria-hidden="true">${index < question.step ? "✓" : index + 1}</span>
          <span>${label}</span>${css === "current" ? '<span class="step-current">현재</span>' : ""}
        </li>`;
    }).join("");
    return `
      <section class="panel run-panel">
        <div class="panel-head"><div><h2>작성 루프</h2><p class="muted">로컬 시연 · 가상 실행</p></div>${badge(status, kind)}</div>
        <ol class="step-list">${steps}</ol>
        <div class="panel-actions row"><span class="muted">반복 ${question.iteration}</span>${button(actionLabel, action, "secondary")}</div>
        ${question.note ? `<p class="run-note muted">${escape(question.note)}</p>` : ""}
      </section>`;
  }

  function factCard(fact, controls = false) {
    const id = escape(fact.id);
    return `
      <article class="fact" id="fact-${id}" tabindex="-1">
        <div class="row fact-heading">
          <span class="fact-id">${id}</span>${badge(fact.label)}
          ${controls ? badge(fact.verified ? "확인됨" : "검토 필요", fact.verified ? "success" : "warning") : ""}
        </div>
        <p>${escape(fact.text)}</p>
        <div class="row fact-footer">
          <small class="muted">${escape(fact.source)}</small>
          ${controls && !fact.verified ? button("사실 확인", "verify-fact", "secondary", false, `data-id="${id}"`) : ""}
        </div>
      </article>`;
  }

  function scoreMarkup(text) {
    const score = styleScore(text);
    const axes = [["형식 패턴", score.pattern, 30], ["상투성", score.cliche, 30], ["구체성 결핍", score.specificity, 40]];
    const metrics = axes.map(([label, value, max]) => `
      <div class="metric">
        <span>${label}</span><progress max="${max}" value="${value}" aria-label="${label}"></progress><strong>${value}</strong>
      </div>`).join("");
    return `
      <section class="panel score-panel">
        <div class="panel-head"><h2>문체 진단</h2>${badge(score.pending ? "짧은 글 · 참고" : "미보정")}</div>
        <div class="score-total"><strong>${score.total}</strong><span> / 100</span></div>
        <div class="score-metrics">${metrics}</div>
        <p class="score-disclaimer muted">${disclaimer}</p>
      </section>`;
  }

  function renderWorkbench() {
    const question = questions[questionIndex];
    const locked = question.run === "running";
    const [approval, approvalKind] = approvalState(question);
    const visibleFacts = facts.filter((fact) => question.links.includes(fact.id) && fact.verified);
    const tabs = questions.map((item, index) => {
      const active = index === questionIndex;
      return `
        <button class="tab${active ? " active" : ""}" type="button" role="tab" id="question-tab-${index}"
          aria-controls="question-panel" aria-selected="${active}" tabindex="${active ? 0 : -1}"
          data-action="question" data-index="${index}">
          <span class="tab-number" aria-hidden="true">0${index + 1}</span>${escape(item.label)}
          ${item.approved ? '<span class="tab-check" aria-label="확정됨">✓</span>' : ""}
        </button>`;
    }).join("");

    return `
      <div class="workspace-top row">
        <div class="company-context">
          <span class="company-mark" aria-hidden="true">가</span>
          <div><strong>${company}</strong><span class="muted">${role}</span></div>
        </div>
        <div class="actions">
          <span class="badge ${approvalKind}" id="approval-state">${approval}</span>
          ${button("확정 검토", "review-approval", "primary", locked)}
        </div>
      </div>
      <div class="tabs" role="tablist" aria-label="지원서 문항">${tabs}</div>
      <div class="grid-workbench" id="question-panel" role="tabpanel" aria-labelledby="question-tab-${questionIndex}">
        <div class="workspace-main stack">
          <section class="panel editor-panel">
            <div class="panel-head">
              <div><div class="eyebrow">문항 0${questionIndex + 1}</div><h2>${escape(question.title)}</h2></div>
              ${badge("공백 포함 " + question.limit + "자")}
            </div>
            <div class="editor-shell">
              <div class="toolbar row">
                <label for="answer">내 답변</label>
                <span class="muted">${escape(question.head.id)}${locked ? " · 점검 진행 중" : ""}</span>
              </div>
              <textarea id="answer" class="editor" aria-describedby="counter" spellcheck="false"${locked ? " readonly" : ""}>${escape(question.text)}</textarea>
            </div>
            <div id="counter">${counterMarkup(question)}</div>
            <div class="editor-meta row">
              <span class="muted">추천본 <strong>${question.best?.id ?? "없음"}</strong></span>
              <span class="muted">확정본 <strong>${question.approved?.id ?? "미확정"}</strong></span>
            </div>
          </section>
          ${diffMarkup(question)}
        </div>
        <aside class="workspace-rail stack" aria-label="작성 상태와 근거">
          ${runMarkup(question)}
          <section class="panel facts-panel">
            <div class="panel-head">
              <div><h2>연결된 사실</h2><p class="muted">사용자 확인을 마친 근거</p></div>
              ${badge(visibleFacts.length + "건", "success")}
            </div>
            <div class="fact-list">${visibleFacts.map((fact) => factCard(fact)).join("")}</div>
            <div class="panel-actions">${button("사실 원장 열기", "go-profile", "ghost")}</div>
          </section>
          ${scoreMarkup(question.text)}
        </aside>
      </div>`;
  }

  function renderProfile() {
    const importList = importPreview.map((fact) => `
      <li><strong>${escape(fact.text)}</strong><br><small class="muted">${escape(fact.source)}</small></li>`).join("");
    return `
      <div class="grid-workbench">
        <div class="stack">
          <section class="panel">
            <div class="panel-head">
              <div><h2>사실 원장</h2><p class="muted">작성과 평가에 쓸 근거를 확인합니다.</p></div>
              ${badge(facts.filter((fact) => fact.verified).length + "건 확인", "success")}
            </div>
            <div class="fact-list profile-facts">${facts.map((fact) => factCard(fact, true)).join("")}</div>
          </section>
          <section class="panel">
            <div class="panel-head">
              <div><h2>새 사실 추가</h2><p class="muted">직접 맡은 일, 측정 조건 또는 확인 가능한 결과를 적어 주세요.</p></div>
            </div>
            <form id="fact-form" class="stack">
              <label class="field">
                <span>사실 내용</span>
                <textarea name="fact" rows="3" required maxlength="300" placeholder="예시. 처리 지연을 재현하는 테스트 케이스를 작성했습니다."></textarea>
              </label>
              <label class="field">
                <span>출처</span><input name="source" required maxlength="80" placeholder="프로젝트 제목 또는 확인 경로">
              </label>
              <div class="actions"><button class="btn primary" type="submit">검토 목록에 추가</button></div>
            </form>
          </section>
        </div>
        <aside class="stack">
          <section class="panel">
            <div class="panel-head"><div><h2>지원 프로필</h2><p class="muted">가상 인턴 경험 · 시연 자료</p></div></div>
            <div class="profile-identity">
              <span class="company-mark" aria-hidden="true">가</span><div><strong>가상 지원자</strong><p class="muted">${role}</p></div>
            </div>
          </section>
          <section class="panel">
            <div class="panel-head">
              <div><h2>JSON Resume 가져오기</h2><p class="muted">경력·프로젝트의 요약을 브라우저에서 읽습니다.</p></div>
            </div>
            <label class="field"><span>로컬 JSON 파일</span><input type="file" id="resume-file" accept=".json,application/json"></label>
            <div class="actions">${button("가상 파일 불러오기", "sample-import", "secondary")}</div>
            ${importMessage ? `<p class="muted">${escape(importMessage)}</p>` : ""}
            ${importList ? `<ul class="list">${importList}</ul>${button("미확인 사실로 추가", "apply-import", "primary")}` : ""}
          </section>
        </aside>
      </div>`;
  }

  function renderBrief() {
    const requirements = briefSaved.split("\n").map((line) => line.trim())
      .filter((line) => line && !line.startsWith("[") && !line.endsWith("직무입니다."));
    const matches = requirements.map((line) => {
      let evidence = "";
      if (/테스트|타임아웃|오류/.test(line)) evidence = "F-003 · 재현 테스트";
      else if (/WPF|C\+\+/i.test(line)) evidence = "F-001 · 제어 계층 연동";
      return `
        <article class="fact">
          <div class="row"><strong>${escape(line)}</strong>${evidence ? badge("근거 연결", "success") : badge("근거 확인", "warning")}</div>
          <p class="muted">${evidence || "지원 프로필에서 관련 경험을 더 확인하세요."}</p>
        </article>`;
    }).join("");
    return `
      <div class="grid-workbench">
        <div class="stack">
          <section class="panel">
            <div class="panel-head">
              <div><h2>공고 원문</h2><p class="muted">붙여넣은 문장에서 명시 요건을 표시합니다.</p></div>
              ${badge(briefSaved === sampleBrief ? "가상 공고" : "사용자 입력")}
            </div>
            <form id="brief-form" class="stack">
              <label class="field">
                <span>채용 공고 텍스트</span>
                <textarea id="brief-input" name="brief" class="editor" rows="9" required maxlength="6000">${escape(briefText)}</textarea>
              </label>
              <div class="actions">
                <button type="submit" class="btn primary">브리프 반영</button>
                ${button("가상 공고 불러오기", "sample-brief", "ghost")}
              </div>
            </form>
          </section>
          <section class="panel">
            <div class="panel-head">
              <div><h2>명시 요건</h2><p class="muted">근거 출처는 입력한 공고 원문입니다.</p></div>
              ${badge(requirements.length + "건")}
            </div>
            <div class="fact-list">${matches || '<p class="muted">표시할 요건을 한 줄씩 적어 주세요.</p>'}</div>
          </section>
        </div>
        <aside class="stack">
          <section class="panel">
            <div class="panel-head"><div><h2>출처</h2><p class="muted">사용자 붙여넣기 · S0</p></div>${badge("명시", "success")}</div>
            <p>이 시연은 원문을 줄 단위로 표시하고 예시 기술 키워드에 연결된 사실을 보여 줍니다.</p>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>지원 전 확인</h2></div>
            <p class="muted">채용 공고의 AI 활용 안내와 답변 분량을 제출 화면에서 확인하세요.</p>
            ${button("문항으로 이동", "go-workbench", "secondary")}
          </section>
        </aside>
      </div>`;
  }

  function renderCommittee() {
    const questionOptions = questions.map((item, index) => `
      <option value="${index}"${index === committeeQuestion ? " selected" : ""}>${escape(item.label)}</option>`).join("");
    const result = committeeResult;
    const persona = result?.reviews[committeePersona];
    const quote = persona && result.text.includes(persona.quote) && persona.quote;
    const scopeLabel = result?.scope === "application" ? "지원서 단위" : "문항 단위";
    const personaButtons = result ? result.reviews.map((review, index) => `
      <button type="button" class="tab${index === committeePersona ? " active" : ""}" aria-pressed="${index === committeePersona}"
        data-action="persona" data-index="${index}">${escape(review.name)}</button>`).join("") : "";

    return `
      <div class="grid-workbench">
        <div class="stack">
          <section class="panel">
            <div class="panel-head">
              <div><h2>심사 설정</h2><p class="muted">가상 루브릭으로 현재 편집본을 검토합니다.</p></div>
              ${badge("시연 결과", "warning")}
            </div>
            <div class="fields-row">
              <label class="field">
                <span>심사 범위</span>
                <select id="committee-scope">
                  <option value="question"${committeeScope === "question" ? " selected" : ""}>문항 단위</option>
                  <option value="application"${committeeScope === "application" ? " selected" : ""}>지원서 단위</option>
                </select>
              </label>
              ${committeeScope === "question" ? `
                <label class="field"><span>대상 문항</span><select id="committee-question">${questionOptions}</select></label>` : ""}
            </div>
            <div class="actions">${button("시연 심사 실행", "run-committee", "primary")}</div>
          </section>
          <section class="panel">
            <div class="panel-head">
              <div><h2>심사 의견</h2>
                <p class="muted">${result ? scopeLabel + " · " + escape(result.label) : "심사를 실행하면 의견과 답변 인용을 표시합니다."}</p>
              </div>
            </div>
            ${persona ? `
              <div class="tabs committee-tabs" aria-label="심사자">${personaButtons}</div>
              <div class="panel-body">
                <div class="row"><h3>${escape(persona.criterion)}</h3>${badge(persona.score + " / " + persona.max + "점")}</div>
                <p>${escape(persona.reason)}</p>
                ${quote ? `<blockquote class="quote">${escape(quote)}</blockquote><small class="muted">검토한 답변에서 인용문을 확인했습니다.</small>`
                  : '<p class="muted">인용할 답변이 없습니다.</p>'}
              </div>` : '<div class="empty-state muted">아직 실행한 심사가 없습니다.</div>'}
          </section>
        </div>
        <aside class="stack">
          <section class="panel">
            <div class="panel-head">
              <div><h2>평가 요약</h2><p class="muted">${result ? scopeLabel + " · 가상 규칙 1회" : "심사 결과 대기"}</p></div>
            </div>
            ${result && result.text.trim() ? `
              <div class="score-total"><strong>${result.total}</strong><span> / 100</span></div>
              <p class="muted">${result.scope === "question" ? "시연 점수를 100점 기준으로 표시합니다." : "5개 역할의 예시 점수를 합산했습니다."}</p>` : ""}
            <p class="score-disclaimer muted">${disclaimer}</p>
          </section>
        </aside>
      </div>`;
  }

  function renderExport() {
    const approved = questions.filter((question) => question.approved);
    const selected = approved[exportQuestion] || approved[0];
    const options = approved.map((question, index) => `
      <option value="${index}"${selected === question ? " selected" : ""}>${escape(question.label)}</option>`).join("");

    return `
      <div class="grid-workbench">
        <div class="stack">
          <section class="panel">
            <div class="panel-head">
              <div><h2>확정한 답변</h2><p class="muted">최종 확인을 마친 버전을 문항별로 제공합니다.</p></div>
              ${badge(approved.length + " / " + questions.length + "건")}
            </div>
            ${selected ? `
              <label class="field"><span>문항</span><select id="export-question">${options}</select></label>
              ${selected.text !== selected.approved.text ? '<p class="note">확정 후 편집이 있습니다. 이 화면에는 마지막 확정본을 표시합니다.</p>' : ""}
              <label class="field">
                <span>확정본 ${escape(selected.approved.id)}</span>
                <textarea id="approved-text" class="editor" rows="8" readonly>${escape(selected.approved.text)}</textarea>
              </label>
              <div class="actions">${button("답변 복사", "copy", "secondary")}${button("TXT 다운로드", "export-txt", "primary")}</div>` : `
              <p class="empty-state muted">확정한 답변이 없습니다. 작성 화면의 확정 검토에서 최종 답변을 선택하세요.</p>
              ${button("작성 화면 열기", "go-workbench", "secondary")}`}
          </section>
        </div>
        <aside class="stack">
          <section class="panel">
            <div class="panel-head"><div><h2>작업 JSON</h2><p class="muted">CareerProof v0.3 시연용 형식</p></div></div>
            <p>이 브라우저 탭의 사실 원장, 글자 수 규칙, 편집 이력, 확정본을 내려받습니다.</p>
            <div class="actions">${button("JSON 다운로드", "export-json", "secondary")}</div>
          </section>
        </aside>
      </div>`;
  }

  function render(focusSelector) {
    const templates = {
      workbench: renderWorkbench,
      profile: renderProfile,
      brief: renderBrief,
      committee: renderCommittee,
      export: renderExport,
    };
    const [title, subtitle] = pages[currentPage];
    for (const [id, content] of [["page-title", title], ["page-subtitle", subtitle], ["breadcrumb", title]]) {
      const target = document.getElementById(id);
      if (target) target.textContent = content;
    }
    document.querySelectorAll("[data-page]").forEach((control) => {
      const active = control.dataset.page === currentPage;
      control.classList.toggle("active", active);
      if (active) control.setAttribute("aria-current", "page");
      else control.removeAttribute("aria-current");
    });
    stage.innerHTML = templates[currentPage]() + '<p id="prototype-notice" class="prototype-notice" role="status">' + escape(notice) + "</p>";
    if (focusSelector) document.querySelector(focusSelector)?.focus();
  }

  function navigate(page) {
    if (!pages[page]) return;
    const question = questions[questionIndex];
    if (currentPage === "workbench" && question.run !== "running") saveEdit(question);
    currentPage = page;
    notice = "";
    window.scrollTo(0, 0);
    const heading = document.querySelector("#page-title");
    if (heading) heading.tabIndex = -1;
    render("#page-title");
  }

  function refreshQuestion(question, action) {
    if (currentPage === "workbench" && question === questions[questionIndex]) {
      const focus = action ? "[data-action=" + action + "]" : null;
      render(focus);
    }
  }

  function resume(question) {
    if (question.run === "running") return;
    if (questions.some((other) => other.run === "running")) {
      notify("다른 문항의 작성 루프가 진행 중입니다.");
      return;
    }
    saveEdit(question);
    question.run = "running";
    question.note = "";
    question.step = 0;
    question.iteration += 1;
    question.pauseRequested = false;
    notice = "";
    refreshQuestion(question, "pause");

    function advance() {
      if (question.pauseRequested) {
        question.run = "paused";
        question.note = "단계가 끝나는 지점에서 멈췄습니다. 답변을 편집할 수 있습니다.";
        refreshQuestion(question, "resume");
        return;
      }

      question.step += 1;
      if (question.step < 2) {
        refreshQuestion(question);
        window.setTimeout(advance, 650);
        return;
      }

      question.proposal = proposalFor(question);
      question.run = "completed";
      question.note = question.proposal
        ? "제안의 변경 내용과 연결 사실을 확인하세요."
        : "예시에서 제안할 변경 사항이 없습니다.";
      refreshQuestion(question, question.proposal ? "accept" : "resume");
    }

    window.setTimeout(advance, 650);
  }

  function pause(question) {
    if (question.run !== "running") return;
    question.pauseRequested = true;
    notify("일시 정지를 요청했습니다. 현재 단계가 끝나면 편집할 수 있습니다.");
  }

  function updateAnswer(question) {
    const counter = document.querySelector("#counter");
    if (counter) counter.innerHTML = counterMarkup(question);
    const score = document.querySelector(".score-panel");
    if (score) score.outerHTML = scoreMarkup(question.text);
    const apply = document.querySelector('[data-action="accept"]');
    if (apply && question.proposal) {
      const stale = question.proposal.base !== question.head.id || question.text !== question.head.text;
      apply.disabled = stale;
      const status = document.querySelector(".diff-panel .badge");
      if (status) status.textContent = stale ? "편집 전 제안" : "검토 대기";
    }
    const [approval, kind] = approvalState(question);
    const status = document.querySelector("#approval-state");
    if (status) {
      status.className = "badge " + kind;
      status.textContent = approval;
    }
  }

  function approveDialog(question) {
    if (question.run === "running") return;
    saveEdit(question);
    const candidate = question.head;
    const problem = approvalProblem(question, candidate.text);
    const allowed = !problem;
    const chars = count(candidate.text).chars;
    const required = question.required.map(verifiedFact).filter(Boolean);
    const explanation = problem || "이 버전을 확정하면 내보내기 화면에서 사용할 수 있습니다.";
    let dialog = document.querySelector("#approval-dialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "approval-dialog";
      dialog.className = "prototype-dialog";
      dialog.setAttribute("aria-labelledby", "approval-title");
      document.body.append(dialog);
    }
    dialog.innerHTML = `
      <form method="dialog">
        <div class="panel-head">
          <div><h2 id="approval-title">최종 답변 확인</h2>
            <p class="muted">${escape(question.label)} · ${escape(candidate.id)} · ${chars}자</p>
          </div>
        </div>
        <p>${escape(explanation)}</p>
        <label class="field"><span>확정할 텍스트</span><textarea id="approval-text" rows="6" readonly>${escape(candidate.text)}</textarea></label>
        ${required.length ? `<p class="muted">필수 근거 ${required.map((fact) => escape(fact.id)).join(", ")}</p>` : ""}
        <div class="actions">
          <button class="btn ghost" type="submit" value="cancel" autofocus>돌아가기</button>
          <button class="btn primary" type="submit" value="approve"${allowed ? "" : " disabled"}>이 답변 확정</button>
        </div>
      </form>`;
    dialog.returnValue = "";
    dialog.addEventListener("close", () => {
      if (dialog.returnValue === "approve" && allowed) {
        question.approved = candidate;
        notice = candidate.id + " 답변을 확정했습니다.";
      }
      refreshQuestion(question, "review-approval");
    }, { once: true });
    dialog.showModal();
  }

  function addFact(entry) {
    const id = "F-" + String(facts.length + 1).padStart(3, "0");
    facts.push({ ...entry, id, verified: false });
  }

  function readImported(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("JSON Resume 객체가 필요합니다.");
    }
    const result = [];
    for (const [key, label] of [["work", "경력"], ["projects", "프로젝트"]]) {
      const entries = data[key];
      if (!Array.isArray(entries)) continue;
      entries.forEach((entry, index) => {
        const candidates = [entry?.summary, ...(Array.isArray(entry?.highlights) ? entry.highlights : [])];
        candidates.forEach((text, fragment) => {
          if (typeof text === "string" && text.trim() && result.length < 12) {
            const field = fragment ? "/highlights/" + (fragment - 1) : "/summary";
            result.push({ label, text: text.trim().slice(0, 300), source: "JSON Resume · /" + key + "/" + index + field });
          }
        });
      });
    }
    return result;
  }

  function importData(data) {
    importPreview = readImported(data);
    importMessage = importPreview.length
      ? importPreview.length + "개 후보를 찾았습니다. 승인 전에는 미확인 상태로 가져옵니다."
      : "가져올 경력 또는 프로젝트의 요약·주요 내용이 없습니다.";
    render();
  }

  function runCommittee() {
    const targets = committeeScope === "application" ? questions : [questions[committeeQuestion]];
    const text = targets.map((question) => question.text).join("\n\n");
    const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((entry) => entry.trim()).filter(Boolean);
    const links = facts.filter((fact) => fact.verified && text.includes(fact.text));
    const reasons = [
      "제어 계층을 연동한 경험과 담당 범위를 확인합니다.",
      "구현 과정에 재현 조건이나 테스트 방법을 덧붙이면 확인할 근거가 늘어납니다.",
      "공고에서 확인한 업무를 지원 동기에 연결해 보세요.",
      targets.every((question) => count(question.text).chars <= question.limit) ? "편집본이 예시 글자 수 범위에 있습니다." : "허용 글자 수를 넘긴 문항이 있습니다.",
      "입사 후 활용할 경험을 실행 단계와 연결해 보세요.",
    ];
    const reviews = personas.map(([name, criterion, weights], index) => {
      const max = weights.reduce((sum, points) => sum + points, 0);
      const preferred = links[index % Math.max(links.length, 1)]?.text;
      const quote = (preferred && sentences.find((sentence) => sentence.includes(preferred))) || sentences[index % sentences.length] || "";
      const levels = text.trim() ? [quote ? 0.7 : 0.4, links.length ? 0.7 : 0.4, index === 3 && targets.every((question) => count(question.text).chars <= question.limit) ? 1 : 0.4] : [0, 0, 0];
      const score = Math.round(weights.reduce((sum, points, criterionIndex) => sum + points * levels[criterionIndex], 0));
      return { name, criterion, max, quote, score, reason: text.trim() ? reasons[index] : "평가할 답변을 입력해 주세요." };
    });
    committeePersona = 0;
    committeeResult = {
      scope: committeeScope,
      label: committeeScope === "application" ? "전체 가상 답변" : targets[0].label,
      text,
      reviews,
      total: reviews.reduce((sum, persona) => sum + persona.score, 0),
    };
    notice = "시연 심사를 마쳤습니다.";
    render('[data-action="run-committee"]');
  }

  function download(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function selectedApproved() {
    const approved = questions.filter((question) => question.approved);
    return approved[exportQuestion] || approved[0];
  }

  async function copyApproved() {
    const question = selectedApproved();
    if (!question) return;
    try {
      await navigator.clipboard.writeText(question.approved.text);
      notify("확정 답변을 복사했습니다.");
    } catch {
      const field = document.querySelector("#approved-text");
      field?.focus();
      field?.select();
      let copied = false;
      try {
        copied = document.execCommand("copy");
      } catch {
        // The selected text is available for a manual copy.
      }
      notify(copied ? "확정 답변을 복사했습니다." : "답변을 선택했습니다. 키보드의 복사 단축키를 사용하세요.");
    }
  }

  function exportData() {
    questions.forEach((question) => {
      if (question.run !== "running") saveEdit(question);
    });
    const payload = {
      format: "careerproof-prototype",
      version: "0.3",
      application: { company, role },
      facts,
      questions: questions.map(({ id, label, title, limit, required, head, best, approved, revisions }) => ({
        id, label, title, countingRule: { unit: "grapheme", includeSpaces: true, maxChars: limit },
        mustKeepFactIds: required, headRevisionId: head.id, bestRevisionId: best?.id ?? null,
        approvedRevisionId: approved?.id ?? null, revisions,
      })),
    };
    download("careerproof-workbench.json", JSON.stringify(payload, null, 2), "application/json");
    notify("작업 JSON을 내려받았습니다.");
  }

  function loadQuestion(index, focus = true) {
    const previous = questions[questionIndex];
    if (!questions[index] || index === questionIndex) return;
    if (previous.run !== "running") saveEdit(previous);
    questionIndex = index;
    notice = "";
    render(focus ? "#question-tab-" + index : null);
  }

  document.addEventListener("click", (event) => {
    const navigation = event.target.closest("button[data-page]");
    if (navigation) navigate(navigation.dataset.page);

    const control = event.target.closest("#stage [data-action]");
    if (!control) return;
    const { action, id, index } = control.dataset;
    const question = questions[questionIndex];

    switch (action) {
      case "question": loadQuestion(Number(index)); break;
      case "resume": resume(question); break;
      case "pause": pause(question); break;
      case "review-approval": approveDialog(question); break;
      case "accept": {
        const proposal = question.proposal;
        if (!proposal || proposal.base !== question.head.id || question.text !== question.head.text || question.run === "running") break;
        const problem = approvalProblem(question, proposal.text);
        if (problem) {
          notify(problem);
          break;
        }
        const revision = createRevision(question, proposal.text, "제안 반영");
        question.head = revision;
        question.text = revision.text;
        const prior = question.best && styleScore(question.best.text);
        const next = styleScore(revision.text);
        if (!prior || next.pending || prior.pending || next.total <= prior.total) question.best = revision;
        question.proposal = null;
        question.run = "completed";
        question.step = 3;
        question.note = "선택한 제안을 현재 편집본에 반영했습니다.";
        notice = "제안을 반영했습니다. 확정 검토에서 최종 답변을 선택할 수 있습니다.";
        render('[data-action="review-approval"]');
        break;
      }
      case "reject":
        question.proposal = null;
        question.run = "paused";
        notice = "제안을 거절했습니다.";
        render('[data-action="resume"]');
        break;
      case "show-fact": document.getElementById("fact-" + id)?.focus(); break;
      case "go-profile": navigate("profile"); break;
      case "go-workbench": navigate("workbench"); break;
      case "verify-fact": {
        const fact = facts.find((entry) => entry.id === id);
        if (fact) {
          fact.verified = true;
          if (!question.links.includes(fact.id)) question.links.push(fact.id);
          notice = fact.id + " 사실을 확인하고 선택한 문항에 연결했습니다.";
          render("#fact-" + fact.id);
        }
        break;
      }
      case "sample-import":
        importData({ projects: [{ summary: "시연 장비의 테스트 재현 절차를 문서에 정리했습니다." }] });
        break;
      case "apply-import":
        importPreview.forEach(addFact);
        notice = importPreview.length + "개 후보를 원장에 추가했습니다.";
        importPreview = [];
        importMessage = "";
        render("#fact-" + facts.at(-1).id);
        break;
      case "sample-brief":
        briefText = sampleBrief;
        briefSaved = sampleBrief;
        notice = "가상 공고를 불러왔습니다.";
        render("#brief-input");
        break;
      case "run-committee": runCommittee(); break;
      case "persona":
        committeePersona = Number(index);
        render('[data-action="persona"][data-index="' + index + '"]');
        break;
      case "copy": void copyApproved(); break;
      case "export-txt": {
        const selected = selectedApproved();
        if (selected) {
          download("careerproof-" + selected.id + ".txt", selected.approved.text, "text/plain;charset=utf-8");
          notify("확정 답변을 내려받았습니다.");
        }
        break;
      }
      case "export-json": exportData(); break;
    }
  });

  stage.addEventListener("keydown", (event) => {
    if (!event.target.matches('[role="tab"][data-action="question"]')) return;
    const offsets = { ArrowLeft: -1, ArrowRight: 1 };
    const next = event.key === "Home" ? 0 : event.key === "End" ? questions.length - 1
      : offsets[event.key] ? (questionIndex + offsets[event.key] + questions.length) % questions.length : null;
    if (next !== null) {
      event.preventDefault();
      loadQuestion(next);
    }
  });

  stage.addEventListener("input", (event) => {
    if (event.target.id === "answer") {
      const question = questions[questionIndex];
      if (question.run !== "running") {
        question.text = event.target.value;
        updateAnswer(question);
      }
    }
    if (event.target.id === "brief-input") briefText = event.target.value;
  });

  stage.addEventListener("change", async (event) => {
    switch (event.target.id) {
      case "committee-scope":
        committeeScope = event.target.value;
        render("#committee-scope");
        break;
      case "committee-question":
        committeeQuestion = Number(event.target.value);
        break;
      case "export-question":
        exportQuestion = Number(event.target.value);
        render("#export-question");
        break;
      case "resume-file": {
        const file = event.target.files[0];
        if (!file) return;
        try {
          if (file.size > 1024 * 1024) throw new Error("1MB 이하의 JSON 파일을 선택하세요.");
          const data = JSON.parse((await file.text()).replace(/^\uFEFF/, ""));
          if (currentPage === "profile") importData(data);
        } catch (error) {
          if (currentPage === "profile") {
            importPreview = [];
            importMessage = error instanceof SyntaxError ? "JSON 구문을 확인해 주세요." : error.message;
            render("#resume-file");
          }
        }
        break;
      }
    }
  });

  stage.addEventListener("submit", (event) => {
    const form = event.target;
    if (form.id === "fact-form") {
      event.preventDefault();
      const fields = new FormData(form);
      const fact = fields.get("fact").trim();
      const source = fields.get("source").trim();
      if (!fact || !source) {
        notify("사실 내용과 출처를 모두 입력해 주세요.");
        return;
      }
      addFact({ text: fact, source, label: "직접 입력" });
      notice = "새 사실을 검토 목록에 추가했습니다.";
      render("#fact-" + facts.at(-1).id);
    }
    if (form.id === "brief-form") {
      event.preventDefault();
      const brief = new FormData(form).get("brief").trim();
      if (!brief) {
        notify("공고 텍스트를 입력해 주세요.");
        return;
      }
      briefText = brief;
      briefSaved = brief;
      notice = "공고 원문과 명시 요건을 업데이트했습니다.";
      render("#brief-input");
    }
  });

  render();
})();
