import { countText, scoreText } from "./analysis.js";
import { mountCalibration } from "./calibration.js";
import {
  createWorkspace, addFact, confirmFact, importResume, addQuestion,
  saveRevision, approveRevision, backupWorkspace, restoreWorkspace,
} from "./workspace.js";

const stage = document.querySelector("#stage");
const dialog = document.querySelector("#review");
const status = document.querySelector("#status");
const restoreFile = document.querySelector("#restore-file");
const drafts = new Map();
const titles = { writer: "문항 작성", facts: "사실 원장", export: "확정본 내보내기" };
const kinds = { self_intro: "자기소개서", career_desc: "경력기술서" };
const cloudModel = "claude-haiku-4-5-20251001";
let workspace = null;
let currentPage = "writer";
let activeId = null;
let request = null;
let modelName = "";
let needsBackup = false;

function warnBeforeUnload(event) {
  event.preventDefault();
  event.returnValue = "";
}

function trackChanges(workspaceChanged = needsBackup) {
  needsBackup = workspaceChanged;
  if (needsBackup || workspace?.questions.some(modified)) {
    window.addEventListener("beforeunload", warnBeforeUnload);
  } else {
    window.removeEventListener("beforeunload", warnBeforeUnload);
  }
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function tell(message = "", level = "info") {
  status.dataset.level = level;
  status.textContent = message;
}

function report(error) {
  tell(error instanceof Error ? error.message : "요청을 처리하지 못했습니다.", "error");
  status.scrollIntoView({ block: "nearest" });
}

function button(label, action, variant = "secondary", disabled = false) {
  return `<button type="button" class="btn ${variant}" data-action="${action}" ${disabled ? "disabled" : ""}>${esc(label)}</button>`;
}

function field(label, name, attributes = "") {
  return `<label class="field"><span>${esc(label)}</span><input name="${name}" ${attributes}></label>`;
}

function activeQuestion() {
  return workspace?.questions.find(question => question.id === activeId);
}

function revisionOf(question, id = question.headRevisionId) {
  return question.revisions.find(revision => revision.id === id);
}

function revisionLabel(question, id) {
  const index = question.revisions.findIndex(revision => revision.id === id);
  return index < 0 ? "없음" : `v${index + 1}`;
}

function draftOf(question) {
  if (!drafts.has(question.id)) {
    const revision = revisionOf(question);
    drafts.set(question.id, {
      text: revision?.text ?? "", factIds: [...(revision?.factIds ?? [])],
      baseRevisionId: question.headRevisionId, proposal: null,
    });
  }
  return drafts.get(question.id);
}

function modified(question) {
  const draft = draftOf(question);
  const revision = revisionOf(question);
  const savedIds = revision?.factIds ?? [];
  return draft.text !== (revision?.text ?? "") || draft.factIds.length !== savedIds.length
    || draft.factIds.some(id => !savedIds.includes(id));
}

function openDialog(title, html, bind) {
  dialog.innerHTML = `
    <div class="dialog-head"><h2 id="review-title">${esc(title)}</h2>
      <button type="button" class="icon-btn" data-close aria-label="닫기">×</button></div>
    ${html}`;
  dialog.querySelector("[data-close]").onclick = () => dialog.close();
  bind?.(dialog);
  mountCalibration(dialog.querySelector("#question-form"));
  dialog.showModal();
}

function goto(page, moveFocus = true) {
  currentPage = page;
  tell();
  render();
  if (moveFocus) document.querySelector("#page-title").focus();
}

function setWorkspace(next, needsFirstBackup = false) {
  request?.controller.abort();
  request = null;
  drafts.clear();
  workspace = next;
  trackChanges(needsFirstBackup);
  activeId = next.questions[0]?.id ?? null;
  goto(activeId ? "writer" : "facts");
}

function render() {
  document.querySelector("#page-title").textContent = workspace ? titles[currentPage] : "새 지원 프로젝트";
  document.querySelector("#context").textContent = workspace ? `${workspace.company} / ${workspace.role}` : "내 작업 공간";
  document.querySelector("#subtitle").textContent = workspace
    ? ({ writer: "문항별 분량과 근거를 확인하고 제출할 버전을 확정하세요.", facts: "원문에서 맡은 역할과 성과를 확인해 작성 근거로 등록하세요.", export: "제출할 답변과 다시 편집할 작업 파일을 받을 수 있습니다." })[currentPage]
    : "지원할 회사와 직무를 입력해 작업을 시작하세요.";
  document.querySelectorAll("[data-nav]").forEach(link => {
    link.disabled = !workspace;
    if (workspace && link.dataset.nav === currentPage) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (!workspace) stage.innerHTML = welcome();
  else if (currentPage === "writer") {
    stage.innerHTML = writerPage();
    mountCalibration(stage.querySelector("#question-form"));
    if (activeQuestion()) {
      stage.querySelector("#answer").value = draftOf(activeQuestion()).text;
      updateEditor();
    }
  } else if (currentPage === "facts") stage.innerHTML = factsPage();
  else stage.innerHTML = exportPage();
}

function welcome() {
  return `<div class="grid-main">
    <section class="panel"><div class="section-line"><h2>지원 정보</h2></div>
      <form id="create-form" class="form-flow">
        ${field("회사명", "company", 'required maxlength="120" placeholder="지원할 회사 이름" autocomplete="off"')}
        ${field("지원 직무", "role", 'required maxlength="120" placeholder="예: 장비 제어 소프트웨어 개발" autocomplete="off"')}
        <div class="cta-row"><button class="btn primary" type="submit">프로젝트 만들기</button></div>
      </form>
    </section>
    <aside class="rail">
      <section class="project-summary"><h2>이어서 작성</h2>
        <p class="muted">이전에 내려받은 CareerProof 작업 JSON에서 문항과 작성 이력을 복원합니다.</p>
        <div class="actions">${button("작업 JSON 복원", "restore")}</div>
      </section>
      <p class="metadata">작업은 이 탭의 메모리에 보관됩니다. 창을 닫거나 새로고침하기 전에 작업 JSON을 내보내세요.</p>
    </aside></div>`;
}

function factsPage() {
  const verifiedCount = workspace.facts.filter(fact => fact.verified).length;
  const list = workspace.facts.map(fact => `<li class="fact-item">
    <div class="row-between"><span class="badge ${fact.verified ? "success" : "warning"}">${fact.verified ? "확인됨" : "검토 필요"}</span>
      ${fact.verified ? "" : `<button type="button" class="btn secondary" data-confirm="${esc(fact.id)}">사실 확인</button>`}</div>
    <p class="fact-body">${esc(fact.text)}</p><small class="muted">출처 · ${esc(fact.source)}</small>
  </li>`).join("");
  return `<div class="grid-main"><div class="primary-column">
    <section class="panel"><div class="section-line"><h2>경험과 성과</h2><span class="badge">${verifiedCount} / ${workspace.facts.length}건 확인</span></div>
      ${list ? `<ul class="list-reset">${list}</ul>` : '<p class="empty-message">아직 등록된 사실이 없습니다. 직접 입력하거나 JSON Resume에서 가져오세요.</p>'}
    </section>
    <section class="panel"><h2>사실 직접 입력</h2>
      <form id="fact-form" class="form-flow">
        <label class="field"><span>경험 또는 성과</span><textarea name="text" rows="3" required maxlength="3000" placeholder="맡은 일, 측정 조건, 결과를 적으세요."></textarea></label>
        ${field("출처", "source", 'required maxlength="300" placeholder="예: 프로젝트 회고 문서 2쪽"')}
        <div><button class="btn primary">검토 목록에 추가</button></div>
      </form>
    </section></div>
    <aside class="rail"><section class="panel"><h2>JSON Resume 가져오기</h2>
      <p class="description">경력·프로젝트·기술·학력에서 읽은 항목을 검토한 뒤 원장에 추가합니다.</p>
      <label class="field"><span>프로필 파일 선택</span><input type="file" id="resume-file" accept=".json,application/json"></label>
    </section><section class="panel"><h2>문항에 연결</h2><p class="description">확인한 사실을 문항별로 선택해 본문의 주장과 연결하세요.</p>
      ${button("문항 작성으로", "to-writer")}</section></aside></div>`;
}

function questionForm() {
  return `<form id="question-form" class="form-flow">
    ${field("문항 제목", "title", 'required maxlength="250" placeholder="공고의 문항을 입력하세요."')}
    <div class="field-grid"><label class="field"><span>문서 종류</span><select name="kind">
      <option value="self_intro">자기소개서</option><option value="career_desc">경력기술서</option>
    </select></label>${field("최대 글자 수", "limit", 'required type="number" min="1" max="100000" value="1000"')}</div>
    <details class="action-details"><summary>바이트·줄·문자 계산 규칙</summary><div class="form-flow">
      <div class="field-grid">${field("최대 바이트 (선택)", "maxBytes", 'type="number" min="1" max="1000000"')}${field("최대 줄 수 (선택)", "maxLines", 'type="number" min="1" max="100000"')}</div>
      <div class="field-grid">
        <label class="field"><span>바이트 인코딩</span><select name="encoding"><option value="utf-8">UTF-8</option><option value="cp949">CP949</option></select></label>
        <label class="field"><span>문자 단위</span><select name="unit"><option value="grapheme">표시 문자</option><option value="utf16">UTF-16</option></select></label>
        <label class="field"><span>줄바꿈</span><select name="newline"><option value="count_1">1자</option><option value="count_2">2자</option><option value="strip">문자 수에서 제외</option></select></label>
        <label class="field"><span>이모지</span><select name="emoji"><option value="count_1">1자</option><option value="count_2">2자</option><option value="native">선택한 문자 단위로 계산</option><option value="forbid">금지</option></select></label>
      </div>
      <label class="check-row"><input type="checkbox" name="spaces" checked>공백 포함</label>
    </div></details><div class="cta-row"><button class="btn primary" type="submit">문항 추가</button></div>
  </form>`;
}

function writerPage() {
  const q = activeQuestion();
  if (!q) return `<div class="grid-main"><section class="panel"><h2>첫 문항 추가</h2>${questionForm()}</section>
    <aside class="project-summary"><h2>${esc(workspace.company)}</h2><p class="muted">${esc(workspace.role)}</p>
      <p class="project-count"><strong>${workspace.facts.filter(f => f.verified).length}</strong>건의 확인된 사실</p>
      ${button("사실 원장 열기", "to-facts")}</aside></div>`;
  const draft = draftOf(q);
  const tabs = workspace.questions.map((question, index) => `
    <button type="button" class="tab ${q.id === question.id ? "active" : ""}" aria-pressed="${q.id === question.id}"
      data-question="${esc(question.id)}" title="${esc(question.title)}">${index + 1}. ${esc(question.title)}</button>`).join("");
  const choices = workspace.facts.filter(fact => fact.verified).map(fact => `<li><label class="fact-choice">
    <input type="checkbox" data-fact="${esc(fact.id)}" ${draft.factIds.includes(fact.id) ? "checked" : ""}>
    <span><strong>${esc(fact.text)}</strong><small>${esc(fact.source)}</small></span>
    </label></li>`).join("");
  return `<div class="question-nav"><div class="tabs" role="group" aria-label="문항 선택">${tabs}</div>${button("+ 문항 추가", "add-question")}</div>
    <div class="grid-main"><div class="primary-column">
      <section class="panel"><p class="eyebrow">${esc(kinds[q.kind] ?? q.kind)}</p><div class="section-line"><h2>${esc(q.title)}</h2></div>
        <label class="field"><span>내 답변</span><textarea id="answer" aria-describedby="counter" maxlength="50000" rows="9" placeholder="확인한 사실을 바탕으로 답변을 작성하세요."></textarea></label>
        <div id="counter" class="counter-box"></div>
        <div class="editor-footer"><span class="metadata" id="version-state"></span><div class="cta-row">
          ${button("편집본 저장", "save", "primary")}${button("확정 검토", "approve")}
        </div></div>
      </section>
      ${modelPanel(q, draft)}
      ${historyPanel(q)}
    </div><aside class="rail">
      <section class="panel"><div class="section-line"><h2>연결할 사실</h2></div>
        ${choices ? `<ul class="list-reset">${choices}</ul>` : '<p class="empty-message">원장에서 사실을 확인하면 선택할 수 있습니다.</p>'}
        <div class="actions">${button("사실 원장 열기", "to-facts", "ghost")}</div>
      </section><section class="panel" id="score"></section>
    </aside></div>`;
}

function historyPanel(q) {
  if (!q.revisions.length) return "";
  return `<details class="panel action-details"><summary>편집 이력 · ${q.revisions.length}개 버전</summary>
    <ul class="list-reset">${q.revisions.slice().reverse().map(revision => `<li>
      <div class="row-between"><span class="revision-tag">${revisionLabel(q, revision.id)}</span>
        <button type="button" class="btn ghost" data-history="${esc(revision.id)}">내용 보기</button></div>
      <p class="metadata">${esc(new Date(revision.createdAt).toLocaleString("ko-KR"))} · 근거 ${revision.factIds.length}건
      ${revision.id === q.approvedRevisionId ? ' · 확정본' : ''}</p></li>`).join("")}</ul></details>`;
}

function modelPanel(q, draft) {
  const offer = draft.proposal;
  const busy = request?.questionId === q.id;
  return `<section class="panel model-offer"><div class="section-line"><h2>모델 초안 제안</h2>
    ${busy ? button("응답 수신 중단", "cancel-request") : button("작성 설정", "model", "secondary", Boolean(request))}</div>
    ${busy ? '<p role="status">모델의 응답을 기다리고 있습니다. 수신을 중단한 뒤에도 서버 처리가 계속되고 클라우드 호출 비용이 발생할 수 있습니다.</p>' : ''}
    ${offer ? `<div class="diff-grid"><div class="diff before"><strong>현재 편집본</strong><p>${esc(draft.text || "빈 답변")}</p></div>
      <div class="diff after"><strong>도착한 제안</strong><p>${esc(offer.text)}</p></div></div>
      <p class="metadata">${esc(offer.context)} · 근거 ${offer.factIds.length}건</p>
      <div class="cta-row">${button("편집기에 반영", "apply-offer", "primary")}${button("제안 닫기", "dismiss-offer", "ghost")}</div>`
      : '<p class="description">선택한 근거로 Ollama 또는 개인 API 키를 사용하는 클라우드 모델에 초안을 요청할 수 있습니다.</p>'}
  </section>`;
}

function reviewHighlights(text, highlights) {
  if (!highlights.length) return "";
  const offsets = [0];
  for (const point of text) offsets.push(offsets.at(-1) + point.length);
  const shown = highlights.slice(0, 10);
  const list = shown.map(item => {
    const start = offsets[item.start];
    const end = offsets[item.end];
    const quote = text.slice(start, end);
    const excerpt = [...quote].slice(0, 100).join("");
    return `<li><button type="button" class="quote-button" data-start="${start}" data-end="${end}"
      aria-label="${esc(`본문에서 선택: ${excerpt}`)}">“${esc(excerpt)}${excerpt.length < quote.length ? "…" : ""}”</button>
      <p class="metadata">${esc(item.reason)}</p></li>`;
  }).join("");
  const limitNote = shown.length < highlights.length ? " · 처음 10건 표시" : "";
  return `<details class="action-details"><summary>표현 점검 ${highlights.length}건${limitNote}</summary><ul>${list}</ul></details>`;
}

function updateEditor() {
  const q = activeQuestion();
  const draft = draftOf(q);
  const counts = countText(draft.text, q.rule);
  const visibleText = stage.querySelector("#answer").value;
  const score = scoreText(visibleText, {kind: q.kind, facts: workspace.facts.filter(f => draft.factIds.includes(f.id))});
  const statusLabel = { ok: "제한 이내", near: "제한 임박", full: "한도에 맞음", over: "제한 초과" };
  const bytes = counts.bytes === null ? "인코딩 불가" : counts.bytes.toLocaleString("ko-KR");
  document.querySelector("#counter").innerHTML = `
    <div class="row-between"><span class="count-line" data-level="${esc(counts.status)}"><strong>${counts.chars} / ${q.limit}자</strong>
      · ${statusLabel[counts.status] ?? ""}</span>
      <span class="rule-summary">${q.rule.includeSpaces === false ? "공백 제외" : "공백 포함"}</span></div>
    <progress max="1" value="${Math.min(1, counts.ratio)}" data-level="${esc(counts.status)}" aria-label="분량 한도 사용률"></progress>
    <p class="count-line">${bytes}${q.rule.maxBytes ? ` / ${q.rule.maxBytes}` : ''} 바이트 (${esc(q.rule.byteEncoding || "utf-8")}) ·
      ${counts.lines}${q.rule.maxLines ? ` / ${q.rule.maxLines}` : ''}줄</p>
    ${counts.violations.map(message => `<p class="count-line" data-level="over">${esc(message)}</p>`).join("")}`;
  const version = q.headRevisionId ? revisionLabel(q, q.headRevisionId) : "첫 편집";
  document.querySelector("#version-state").textContent = `편집본 ${version}${modified(q) ? " · 저장 전" : ""} / 확정본 ${revisionLabel(q, q.approvedRevisionId)}`;
  stage.querySelector('[data-action="approve"]').disabled = modified(q) || !q.headRevisionId;
  stage.querySelector('[data-action="save"]').disabled = !modified(q);
  const axes = [["형식 반복","pattern",30],["상투 표현","cliche",30],["구체성 결핍","specificity_deficit",40]];
  document.querySelector("#score").innerHTML = `<div class="section-line"><h2>문체 진단</h2><span class="badge">보정 전</span></div>
    <p class="score-total">${score.total === null ? "—" : score.total}<span> / 100</span></p>
    <div class="score-lines">${axes.map(([label,key,max]) => `<span>${label}<strong class="score-value">${score.axes[key] ?? "—"} / ${max}</strong></span>`).join("")}</div>
    ${score.abstain ? '<p class="muted-copy">짧은 글 또는 적용 제외 유형은 참고용입니다.</p>' : ''}
    ${reviewHighlights(visibleText, score.highlights)}
    ${score.questions.length ? `<details class="action-details"><summary>근거 보강 질문</summary><ul>${score.questions.slice(0,3).map(question => `<li>${esc(question)}</li>`).join("")}</ul></details>` : ""}
    <p class="muted-copy">점수는 진단이며 합격 예측이 아닙니다.</p>`;
}

function exportPage() {
  const approved = workspace.questions.filter(q => q.approvedRevisionId);
  const dirty = workspace.questions.filter(modified).length;
  return `<div class="grid-main"><section class="panel"><div class="section-line"><h2>제출할 답변</h2>
    <span class="badge">${approved.length} / ${workspace.questions.length}문항 확정</span></div>
    ${approved.length ? `<ul class="list-reset">${approved.map(q => `<li><div class="row-between"><h3>${esc(q.title)}</h3>
      <span class="revision-tag">확정본 ${revisionLabel(q, q.approvedRevisionId)}</span></div>
      <p class="plain-output">${esc(revisionOf(q, q.approvedRevisionId).text)}</p>
      <button type="button" class="btn secondary" data-txt="${esc(q.id)}">답변 TXT 다운로드</button></li>`).join("")}</ul>`
      : `<p class="empty-message">확정한 답변이 없습니다. 문항에서 편집본을 저장한 뒤 확정해 주세요.</p>${button("문항 작성으로", "to-writer")}`}
    </section>
    <aside class="rail"><section class="panel"><h2>전체 작업 JSON</h2>
      <p class="description">이 탭을 닫으면 작업 내용이 사라집니다. 사실 원장, 문항, 저장한 편집 이력과 확정본이 파일에 포함됩니다.</p>
      ${dirty ? `<p class="note">저장 전인 문항 ${dirty}개가 있습니다. 편집본을 저장하면 작업 파일을 받을 수 있습니다.</p>` : ""}
      <div class="cta-row">${button("작업 JSON 다운로드","backup","primary",Boolean(dirty))}${button("작업 JSON 복원","restore")}</div>
    </section></aside></div>`;
}

function download(file, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showError(error) {
  if (!dialog.open) return report(error);
  let note = dialog.querySelector("[data-dialog-error]");
  if (!note) {
    note = document.createElement("p");
    note.className = "status-message";
    note.dataset.level = "error";
    note.dataset.dialogError = "";
    note.setAttribute("role", "alert");
    dialog.append(note);
  }
  note.textContent = error.message;
  note.scrollIntoView({block: "nearest"});
}

function selectedFacts(q) {
  return workspace.facts.filter(f => f.verified && draftOf(q).factIds.includes(f.id));
}

function evidenceList(facts) {
  if (!facts.length) return '<p class="muted">연결된 사실이 없습니다.</p>';
  return `<dl class="evidence-preview">${facts.map(f => `<dt>${esc(f.id)}</dt><dd>${esc(f.text)}</dd>`).join("")}</dl>`;
}

function previewRevision(q, revision) {
  if (!revision) return;
  const alreadyApproved = q.approvedRevisionId === revision.id;
  const facts = workspace.facts.filter(f => revision.factIds.includes(f.id));
  openDialog(`${revisionLabel(q, revision.id)} ${alreadyApproved ? "확정본" : "편집본"} 검토`,
    `<h3>${esc(q.title)}</h3><p class="review-body">${esc(revision.text)}</p>
    <h3>연결한 근거</h3>${evidenceList(facts)}
    <p class="description">수치와 이름, 역할이 실제 경험과 일치하는지 확인하세요. 확정한 버전이 TXT 파일에 담깁니다.</p>
    ${alreadyApproved ? '<p class="badge success">현재 확정본</p>' : '<button type="button" class="btn primary" id="confirm-revision">이 버전 확정</button>'}`,
    modal => modal.querySelector("#confirm-revision")?.addEventListener("click", () => {
      try {
        approveRevision(workspace, q.id, revision.id);
        trackChanges(true);
        dialog.close();
        render();
        tell(`${revisionLabel(q, revision.id)}을 제출할 버전으로 확정했습니다.`);
        stage.querySelector('[data-action="approve"]')?.focus();
      } catch (error) { showError(error); }
    }));
}

function modelSettings(q) {
  const facts = selectedFacts(q);
  if (!facts.length) throw new Error("문항에서 확인된 사실을 한 건 이상 선택해 주세요.");
  if (facts.length > 40 || q.title.length > 4000 || facts.some(f => f.text.length > 4000)
      || facts.reduce((total, f) => total + f.text.length, 0) > 30000)
    throw new Error("문항은 4,000자 이내, 근거는 각 4,000자 이내로 최대 40건·합계 30,000자까지 전송할 수 있습니다.");
  openDialog("모델에 초안 요청", `<form id="model-form" class="form-flow" autocomplete="off">
    <label class="field"><span>모델 제공자</span><select name="provider"><option value="ollama">Ollama · 로컬</option><option value="anthropic">Anthropic · 개인 키</option></select></label>
    <div data-local>${field("설치한 Ollama 모델","model",`required maxlength="100" value="${esc(modelName || "qwen3:8b")}"`)}</div>
    <fieldset data-cloud hidden disabled class="form-flow"><legend>Anthropic 호출 설정</legend>
      <span>모델 · ${cloudModel}</span>
      ${field("API 키","key",'required type="password" autocomplete="off" spellcheck="false"')}
      ${field("요청 한 번의 예산 (USD)","budget",'required type="number" min="0.000001" max="1" step="any" value="0.03"')}
      <label class="field"><span>추가로 가릴 이름·주소 (한 줄에 하나씩)</span><textarea name="redact" rows="2"></textarea></label>
      <p class="muted-copy">서버가 이메일, 전화번호, 주민번호 형태와 입력한 이름·주소를 가린 후 Anthropic에 전송합니다. 원문에 남은 식별 정보를 확인하세요. 최대 출력은 1,200토큰입니다.</p>
    </fieldset>
    <section><h3>보낼 문항과 근거 · 로컬 원문</h3><p class="plain-output">${esc(q.title)}</p>${evidenceList(facts)}</section>
    <button class="btn primary" type="submit">이 문항과 근거로 초안 요청</button>
    </form>`, modal => {
    const form = modal.querySelector("form");
    form.elements.provider.addEventListener("change", () => {
      const cloud = form.elements.provider.value === "anthropic";
      form.querySelector("[data-local]").hidden = cloud;
      form.elements.model.disabled = cloud;
      form.querySelector("[data-cloud]").hidden = !cloud;
      form.querySelector("[data-cloud]").disabled = !cloud;
      form.elements.key.value = "";
    });
  });
}

function refreshModelPanel() {
  const q = activeQuestion();
  const panel = stage.querySelector(".model-offer");
  if (q && currentPage === "writer" && panel) panel.outerHTML = modelPanel(q, draftOf(q));
}

async function fetchDraft(form) {
  if (request) throw new Error("진행 중인 요청이 있습니다.");
  const q = activeQuestion();
  const facts = selectedFacts(q).map(({id,text}) => ({id,text}));
  const provider = form.elements.provider.value;
  const cloud = provider === "anthropic";
  const model = cloud ? cloudModel : form.elements.model.value.trim();
  const payload = {provider, model, question: q.title, facts};
  const headers = {"Content-Type":"application/json", "X-CareerProof-Request":"1"};
  if (cloud) {
    headers["X-LLM-API-Key"] = form.elements.key.value.trim();
    form.elements.key.value = "";
    payload.budgetUsd = form.elements.budget.value;
    payload.redactTerms = form.elements.redact.value.split(/\r?\n/).map(t => t.trim()).filter(Boolean);
    payload.confirmed = true;
  } else modelName = model;
  const pending = {questionId: q.id, controller: new AbortController()};
  request = pending;
  dialog.close();
  refreshModelPanel();
  tell(`${model}에 초안을 요청했습니다.`);
  try {
    const response = await fetch("/api/draft", {
      method: "POST", headers, body: JSON.stringify(payload), signal: pending.controller.signal,
    });
    const result = await response.json();
    if (pending !== request) return;
    if (!response.ok) throw new Error(result.error || "모델의 응답을 받지 못했습니다.");
    if (typeof result.text !== "string" || !result.text.trim() || !Array.isArray(result.factIds)
        || !result.factIds.every(id => facts.some(f => f.id === id))) throw new Error("모델이 반환한 초안이나 근거를 확인할 수 없습니다.");
    const cost = result.usage?.costUsd;
    const usage = cloud && cost != null && Number.isFinite(Number(cost)) ? ` · 사용액 $${cost}` : "";
    draftOf(q).proposal = {text: result.text, factIds: [...new Set(result.factIds)], context: `${model}${usage}`};
    tell(`‘${q.title}’의 초안이 도착했습니다. 편집본과 비교해 주세요.`);
  } catch (error) {
    if (request === pending) {
      if (error.name === "AbortError") tell("응답 수신을 중단했습니다. 서버의 호출은 계속될 수 있습니다.");
      else report(error);
    }
  } finally {
    delete headers["X-LLM-API-Key"];
    if (request === pending) { request = null; refreshModelPanel(); }
  }
}

function handleSubmit(form) {
  const data = new FormData(form);
  switch (form.id) {
    case "create-form":
      setWorkspace(createWorkspace({company: data.get("company"), role: data.get("role")}), true);
      tell("프로젝트를 만들었습니다. 작성에 사용할 경험을 추가하세요.");
      break;
    case "fact-form":
      addFact(workspace, {text: data.get("text"), source: data.get("source")});
      trackChanges(true);
      render();
      tell("원장에 추가했습니다. 내용을 검토하고 사실 확인을 눌러 주세요.");
      stage.querySelector(".fact-item:last-child [data-confirm]")?.focus();
      break;
    case "question-form": {
      const limit = Number(data.get("limit"));
      const rule = {maxChars: limit, maxBytes: Number(data.get("maxBytes")) || null, maxLines: Number(data.get("maxLines")) || null,
        byteEncoding: data.get("encoding"), charUnit: data.get("unit"), includeSpaces: data.has("spaces"),
        newline: data.get("newline"), emojiPolicy: data.get("emoji"), normalize: "none"};
      const question = addQuestion(workspace, {title: data.get("title"), kind: data.get("kind"), limit, rule});
      trackChanges(true);
      activeId = question.id;
      if (dialog.open) dialog.close();
      goto("writer", false);
      tell("문항을 추가했습니다.");
      stage.querySelector("#answer").focus();
      break;
    }
  }
}

document.addEventListener("submit", event => {
  event.preventDefault();
  try {
    if (event.target.id === "model-form") fetchDraft(event.target).catch(showError);
    else handleSubmit(event.target);
  } catch (error) { showError(error); }
});

function handleAction(action) {
  const q = activeQuestion();
  switch (action) {
    case "restore": restoreFile.click(); break;
    case "to-facts": goto("facts"); break;
    case "to-writer": goto("writer"); break;
    case "add-question": openDialog("새 문항", questionForm()); break;
    case "save": {
      const draft = draftOf(q);
      const revision = saveRevision(workspace, q.id, {text: draft.text, factIds: draft.factIds, baseRevisionId: draft.baseRevisionId});
      trackChanges(true);
      draft.baseRevisionId = revision.id;
      draft.text = revision.text;
      draft.factIds = [...revision.factIds];
      render();
      tell(`${revisionLabel(q, revision.id)} 편집본을 저장했습니다.`);
      stage.querySelector('[data-action="approve"]').focus();
      break;
    }
    case "approve": previewRevision(q, revisionOf(q)); break;
    case "model": modelSettings(q); break;
    case "cancel-request":
      request?.controller.abort();
      break;
    case "apply-offer": {
      const draft = draftOf(q);
      draft.text = draft.proposal.text;
      draft.factIds = [...draft.proposal.factIds];
      draft.proposal = null;
      trackChanges();
      render();
      tell("제안을 편집기에 반영했습니다. 경험과 표현을 검토한 뒤 저장하세요.");
      stage.querySelector("#answer").focus();
      break;
    }
    case "dismiss-offer":
      draftOf(q).proposal = null;
      refreshModelPanel();
      stage.querySelector('[data-action="model"]').focus();
      break;
    case "backup":
      download(`${workspace.company}-CareerProof.json`, backupWorkspace(workspace), "application/json;charset=utf-8");
      trackChanges(false);
      tell("작업 JSON 다운로드를 요청했습니다.");
      break;
  }
}

document.querySelector("#navigation").addEventListener("click", e => {
  const nav = e.target.closest("[data-nav]");
  if (nav && workspace) goto(nav.dataset.nav);
});

stage.addEventListener("click", event => {
  const target = event.target.closest("button");
  if (!target || target.disabled) return;
  try {
    if (target.dataset.action) handleAction(target.dataset.action);
    else if (target.hasAttribute("data-start")) {
      const editor = stage.querySelector("#answer");
      editor.focus();
      editor.setSelectionRange(Number(target.dataset.start), Number(target.dataset.end));
    }
    else if (target.dataset.confirm) {
      confirmFact(workspace, target.dataset.confirm);
      trackChanges(true);
      render();
      tell("확인한 사실을 문항에 연결할 수 있습니다.");
      (stage.querySelector("[data-confirm]") || stage.querySelector('[data-action="to-writer"]')).focus();
    } else if (target.dataset.question) {
      activeId = target.dataset.question;
      goto("writer", false);
      stage.querySelector('.tab[aria-pressed="true"]').focus();
    } else if (target.dataset.history) previewRevision(activeQuestion(), revisionOf(activeQuestion(), target.dataset.history));
    else if (target.dataset.txt) {
      const q = workspace.questions.find(item => item.id === target.dataset.txt);
      download(`${workspace.company}-${q.title}.txt`, revisionOf(q,q.approvedRevisionId).text, "text/plain;charset=utf-8");
      tell("확정본 TXT 다운로드를 요청했습니다.");
    }
  } catch (error) { showError(error); }
});

stage.addEventListener("input", event => {
  if (event.target.id !== "answer") return;
  draftOf(activeQuestion()).text = event.target.value;
  trackChanges();
  const comparison = stage.querySelector(".diff.before p");
  if (comparison) comparison.textContent = event.target.value || "빈 답변";
  updateEditor();
});
stage.addEventListener("change", event => {
  if (!event.target.dataset.fact) return;
  const draft = draftOf(activeQuestion());
  draft.factIds = [...stage.querySelectorAll("[data-fact]:checked")].map(input => input.dataset.fact);
  trackChanges();
  updateEditor();
});

async function readFile(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = "";
  const original = workspace;
  if (file.size > 12 * 1024 * 1024) throw new Error("12MB 이내의 JSON 파일을 선택해 주세요.");
  let inputJson;
  try { inputJson = JSON.parse((await file.text()).replace(/^\uFEFF/, "")); }
  catch { throw new Error("파일의 JSON 형식을 읽을 수 없습니다."); }
  if (workspace !== original || dialog.open) return;
  if (input === restoreFile) {
    const next = restoreWorkspace(inputJson);
    const replace = workspace ? "<p class='note'>복원하면 이 탭의 기존 작업이 선택한 파일의 내용으로 교체됩니다.</p>" : "";
    openDialog("작업 JSON 복원", `<h3>${esc(next.company)} · ${esc(next.role)}</h3>
      <p>문항 ${next.questions.length}개 · 사실 ${next.facts.length}건</p>${replace}
      <button type="button" class="btn primary" id="restore-confirm">이 작업 복원</button>`,
      modal => modal.querySelector("#restore-confirm").onclick = () => {
        dialog.close(); setWorkspace(next); tell("작업을 복원했습니다.");
      });
  } else {
    const preview = restoreWorkspace(backupWorkspace(workspace));
    const candidates = importResume(preview, inputJson);
    if (!candidates.length) throw new Error("새로 가져올 경력·프로젝트·기술·학력 항목이 없습니다.");
    openDialog("가져올 원장 항목", `<p>${candidates.length}건의 근거를 검토 목록에 추가합니다.</p>
      <ul class="review-body">${candidates.map(f => `<li>${esc(f.text)} · ${esc(f.source)}</li>`).join("")}</ul>
      <button type="button" class="btn primary" id="import-confirm">검토 목록에 추가</button>`,
      modal => modal.querySelector("#import-confirm").onclick = () => {
        try {
          const added = importResume(workspace, inputJson);
          trackChanges(true);
          dialog.close(); goto("facts");
          tell(`${added.length}건을 가져왔습니다. 원문과 대조한 뒤 사실 확인을 눌러 주세요.`);
        } catch (error) { showError(error); }
      });
  }
}

document.addEventListener("change", event => {
  if (event.target === restoreFile || event.target.id === "resume-file") readFile(event.target).catch(showError);
});
dialog.addEventListener("close", () => {
  const password = dialog.querySelector('input[type="password"]');
  if (password) password.value = "";
});
render();
