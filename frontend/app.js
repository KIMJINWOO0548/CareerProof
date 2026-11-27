import { countText, scoreText } from "./analysis.js";
import { mountCalibration } from "./calibration.js";
import { mountResearch } from "./research-ui.js";
import { exampleWorkspace } from "./demo.js";
import { mountCommittee } from "./committee-ui.js";
import { createLoop } from "./loop.js";
import { createRunJournal, ensureSession, flushRunJournals } from "./journal.js";
import { mountStyleTools } from "./style-tools.js";
import { openAgentDraft } from "./agent-ui.js";
import { RemoteRun, listRemoteRuns, openRemoteRun, startRemoteRun, deleteRemoteRun } from "./remote-runs.js";
import {
  createWorkspace, addFact, confirmFact, importResume, addQuestion,
  saveRevision, approveRevision, backupWorkspace, restoreWorkspace,
} from "./workspace.js";

const stage = document.querySelector("#stage");
const dialog = document.querySelector("#review");
const status = document.querySelector("#status");
const restoreFile = document.querySelector("#restore-file");
const drafts = new Map();
const loops = new Map();
const recentWriter = new WeakMap();
const titles = { writer: "문항 작성", facts: "사실 원장", research: "공고·포트폴리오", committee: "심사 위원회", export: "확정본 내보내기" };
let committeeView;
const kinds = { self_intro: "자기소개서", career_desc: "경력기술서", portfolio: "포트폴리오 설명", resume_form: "이력서 양식" };
const narrativeKind = kind => kind === "self_intro" || kind === "career_desc";
const cloudModels = {anthropic: "claude-haiku-4-5-20251001", openai: "gpt-4.1-mini-2025-04-14", gemini: "gemini-2.5-flash-lite"};
const isCloud = provider => Object.hasOwn(cloudModels, provider);
let workspace = null;
let currentPage = "writer";
let activeId = null;
let request = null;
let modelName = "";
let needsBackup = false;
let openingWorker = false;

function warnBeforeUnload(event) {
  event.preventDefault();
  event.returnValue = "";
}

function trackChanges(workspaceChanged = needsBackup) {
  needsBackup = workspaceChanged;
  if (needsBackup || workspace?.questions.some(modified) || request ||
      [...loops.values()].some(run => !run.remote && ["running","pausing"].includes(run.controller.state.phase))) {
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

function stopModelWork() {
  request?.controller.abort();
  request = null;
  for (const run of loops.values()) {
    if (run.remote) { run.controller.dispose(); continue; }
    run.key = "";
    if (["running", "pausing", "paused"].includes(run.controller.state.phase)) run.controller.cancel();
  }
}

window.addEventListener("pagehide", stopModelWork);
window.addEventListener("pageshow", event => {
  if (event.persisted) for (const run of loops.values()) {
    if (run.remote) { run.controller.disposed = false; run.controller.watch(); }
  }
});

function setWorkspace(next, needsFirstBackup = false) {
  stopModelWork();
  loops.clear();
  drafts.clear();
  workspace = next;
  trackChanges(needsFirstBackup);
  activeId = next.questions[0]?.id ?? null;
  goto(activeId ? "writer" : "facts");
}

function render() {
  committeeView?.dispose();
  committeeView = null;
  document.querySelector("#page-title").textContent = workspace ? titles[currentPage] : "새 지원 프로젝트";
  document.querySelector("#context").textContent = workspace ? `${workspace.company} / ${workspace.role}` : "내 작업 공간";
  document.querySelector("#subtitle").textContent = workspace
    ? ({ writer: "문항별 분량과 근거를 확인하고 제출할 버전을 확정하세요.", facts: "원문에서 맡은 역할과 성과를 확인해 작성 근거로 등록하세요.", research: "지원 요건과 내 경험을 대조하고 부족한 근거를 찾으세요.", committee: "다섯 관점의 평가와 감점 근거를 원문에서 확인하세요.", export: "제출할 답변과 다시 편집할 작업 파일을 받을 수 있습니다." })[currentPage]
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
      mountStyleTools(stage.querySelector(".primary-column"), workspace, activeQuestion(), () => trackChanges(true));
      stage.querySelector("#answer").value = draftOf(activeQuestion()).text;
      updateEditor();
    }
  } else if (currentPage === "facts") stage.innerHTML = factsPage();
  else if (currentPage === "research") mountResearch(stage, { workspace, onChanged: () => trackChanges(true), onQuestion: q => { activeId = q.id; } });
  else if (currentPage === "committee") committeeView = mountCommittee(stage, { workspace, writerModel: recentWriter.get(workspace) ?? "", onChanged: () => trackChanges(true) });
  else stage.innerHTML = exportPage();
}

function welcome() {
  return `<div class="grid-main">
    <section class="panel"><div class="section-line"><h2>지원 정보</h2></div>
      <form id="create-form" class="form-flow">
        ${field("회사명", "company", 'required maxlength="120" placeholder="지원할 회사 이름" autocomplete="off"')}
        ${field("지원 직무", "role", 'required maxlength="120" placeholder="예: 장비 제어 소프트웨어 개발" autocomplete="off"')}
        <div class="cta-row"><button class="btn primary" type="submit">프로젝트 만들기</button>${button("가상 지원서로 체험", "demo")}</div>
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
      ${Object.entries(kinds).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}
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

function locked(q) {
  const run = loops.get(q.id);
  return Boolean(run?.controller.busy || ["idle", "running", "pausing"].includes(run?.controller.state.phase));
}

function generating() {
  return openingWorker || Boolean(request) || [...loops.values()].some(run => run.controller.busy || ["idle","running","pausing"].includes(run.controller.state.phase));
}

const phaseLabel = { idle: "시작 전", running: "작성 중", pausing: "일시 정지 대기", paused: "일시 정지", completed: "완료", cancelled: "취소" };
const reasonLabel = {
  user: "편집할 수 있습니다.", user_stop: "사용자가 반복을 마쳤습니다.", cancelled: "사용자가 실행을 취소했습니다.",
  target_reached: "추천본이 설정한 문체 목표에 도달했습니다.", max_iter: "최대 작성 횟수에 도달했습니다.",
  stagnated: "연속된 제안에서 개선을 확인하지 못했습니다.", needs_user_input: "경험을 보강하거나 본문을 고친 뒤 재개하세요.",
  budget_limit: "남은 예산으로 추가 작성이 어렵습니다.", cost_unknown: "호출 비용을 확인할 수 없어 추가 작성을 멈췄습니다. 제공자 사용 내역을 확인하세요.",
  key_required: "모델 접근 권한과 API 키를 확인하세요.", provider_error: "모델에 연결하지 못했거나 유효한 응답을 받지 못했습니다.",
  invalid_request: "보낼 원문이나 모델 설정을 확인하고 새 실행을 시작하세요.",
  input_required: "워커가 중단되었습니다. 현재 원고를 보관하고 새 실행을 시작하세요.",
};
const gateLabel = {
  length: "문자·바이트·줄 제한을 초과했습니다.", evidence: "답변에 쓴 수치·단위 또는 영문 이름을 연결한 사실과 대조해 주세요.",
  preservation: "선택한 사실의 참조 또는 본문에서 확인할 수 있는 근거 표현이 빠졌습니다.", no_improvement: "현재 추천본보다 개선된 점을 찾지 못했습니다.",
  invalid_candidate: "답변 본문이나 근거의 형식을 확인할 수 없습니다.",
};

function loopPanel(q, draft) {
  const run = loops.get(q.id);
  if (!run) return "";
  const state = run.controller.state;
  const { phase, reason, best } = state;
  const running = ["idle", "running", "pausing"].includes(phase);
  const paused = phase === "paused";
  const resumable = paused && !["budget_limit", "cost_unknown", "invalid_request", "input_required"].includes(reason);
  const summary = reasonLabel[reason] || (phase === "pausing" ? "현재 요청이 끝나면 편집할 수 있습니다." : "");
  const decision = state.events.findLast(event => ["best_updated", "gate_rejected"].includes(event.type));
  const unavailable = run.remote && (run.controller.busy || run.controller.conflict || run.controller.missing);
  const canUse = best && !running && !unavailable;
  const cost = isCloud(run.provider)
    ? ` · 확인된 사용액 $${esc(state.spentUsd)} / $${esc(run.budgetUsd)}${state.usagePending || state.usageUnknown ? " · 미정산 호출 있음" : ""}` : "";
  return `<div class="loop-result" data-phase="${esc(phase)}" data-iteration="${state.iteration}">
    <div class="row-between"><h3>${run.remote ? "서버 반복 작성" : "반복 작성"}</h3><span class="badge" role="status" tabindex="-1">${phaseLabel[phase]} · ${state.iteration} / ${state.maxIterations}회</span></div>
    <p class="metadata">${esc(run.model)}${cost}${run.target !== null ? ` · 목표 ${run.target}점 이하` : ""}</p>
    ${decision?.type === "gate_rejected" ? `<p class="metadata">${decision.iteration ? decision.iteration + "회차" : "시작 본문"} 보류 · ${gateLabel[decision.reason] ?? "근거를 다시 검토하세요."}</p>` : ""}
    ${summary ? `<p class="description">${summary}</p>` : ""}
    ${run.remote && run.controller.missing ? `<p class="note">서버에서 작업 원본을 찾을 수 없습니다. 이 탭의 원고를 사본으로 보관할 수 있습니다.</p>${button("사본으로 계속 편집","remote-detach")}` :
      run.remote && run.controller.conflict ? `<p class="note" role="status">다른 탭에서 실행을 변경했습니다. 현재 편집 내용은 이 탭에 있습니다.</p><div class="cta-row">${button("서버 버전 확인","remote-reopen")}${button("사본으로 계속 편집","remote-detach","ghost")}</div>` :
      run.remote && run.controller.disconnected ? '<p class="note">서버 연결을 다시 확인하고 있습니다. 화면에는 마지막 확인 상태가 표시됩니다.</p>' : ""}
    ${paused && state.questions.length ? `<h4>보강할 근거</h4><ul>${state.questions.map(item => `<li>${esc(item)}</li>`).join("")}</ul>${button("사실 원장 열기","to-facts","ghost")}` : ""}
    <div class="cta-row">
      ${phase === "running" ? button("일시 정지","loop-pause","secondary",unavailable) : ""}
      ${resumable ? button("수정본으로 재개","loop-resume","primary",generating() || unavailable) : ""}
      ${running || paused ? button("여기서 마치기","loop-stop","secondary",unavailable) + button("실행 취소","loop-cancel","ghost",unavailable) : ""}
    </div>
    ${running && isCloud(run.provider) ? '<p class="metadata">종료·취소해도 이미 전송한 호출은 과금될 수 있습니다.</p>' : ""}
    ${canUse ? `<details class="action-details"><summary>추천본 비교 · ${best.score.total ?? "—"} / 100점${best.score.abstain ? " · 참고용" : ""}</summary>
      <div class="diff-grid"><div class="diff before"><strong>현재 편집본</strong><p>${esc(draft.text || "빈 답변")}</p></div>
      <div class="diff after"><strong>검증을 통과한 추천본</strong><p>${esc(best.text)}</p></div></div>
      <p class="metadata">연결한 근거 ${best.factIds.length}건 · 미보정 문체 진단이며 합격 예측이 아닙니다.</p>
      ${button("추천본을 편집기에 반영","loop-apply","primary")}</details>` : ""}
  </div>`;
}

function modelPanel(q, draft) {
  const offer = draft.proposal;
  const busy = request?.questionId === q.id;
  const live = ["running", "pausing", "paused"].includes(loops.get(q.id)?.controller.state.phase);
  const activeElsewhere = workspace.questions.find(item => item.id !== q.id && (locked(item) || request?.questionId === item.id));
  const repeatButton = narrativeKind(q.kind) ? button("반복 작성 설정", "loop-settings", "secondary", generating()) : "";
  const controls = busy ? button("응답 수신 중단", "cancel-request") : !live
    ? button("작성 설정", "model", "secondary", generating()) + repeatButton + button("내 Codex·Claude 연결", "personal-agent", "secondary", generating()) : "";
  return `<section class="panel model-offer"><div class="section-line"><h2>모델 초안 제안</h2>
    <div class="cta-row">${controls}</div></div>
    ${activeElsewhere ? `<p class="metadata">다른 문항에서 모델을 사용하고 있습니다.
      <button type="button" class="btn ghost" data-question="${esc(activeElsewhere.id)}">${esc(activeElsewhere.title)} 열기</button></p>` : ""}
    ${loopPanel(q, draft)}
    ${busy ? '<p role="status">모델의 응답을 기다리고 있습니다. 수신을 중단한 뒤에도 서버 처리가 계속되고 클라우드 호출 비용이 발생할 수 있습니다.</p>' : ''}
    ${offer && !live ? `<div class="diff-grid"><div class="diff before"><strong>현재 편집본</strong><p>${esc(draft.text || "빈 답변")}</p></div>
      <div class="diff after"><strong>도착한 제안</strong><p>${esc(offer.text)}</p></div></div>
      <p class="metadata">${esc(offer.context)} · 근거 ${offer.factIds.length}건</p>
      <div class="cta-row">${button("편집기에 반영", "apply-offer", "primary")}${button("제안 닫기", "dismiss-offer", "ghost")}</div>`
      : !loops.has(q.id) ? '<p class="description">이 문항에 연결한 사실로 초안을 받아 편집본과 비교하세요.</p>' : ""}
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
  setEditorLocks(q);
  if (!narrativeKind(q.kind)) {
    document.querySelector("#score").innerHTML = '<h2>문서 검토</h2><p class="muted-copy">항목별 사실과 출처, 본인의 기여 범위를 확인하세요. 문체 진단은 자기소개서와 경력기술서에 적용합니다.</p>';
    return;
  }
  const axes = [["형식 반복","pattern",30],["상투 표현","cliche",30],["구체성 결핍","specificity_deficit",40]];
  document.querySelector("#score").innerHTML = `<div class="section-line"><h2>문체 진단</h2><span class="badge">보정 전</span></div>
    <p class="score-total">${score.total === null ? "—" : score.total}<span> / 100</span></p>
    <div class="score-lines">${axes.map(([label,key,max]) => `<span>${label}<strong class="score-value">${score.axes[key] ?? "—"} / ${max}</strong></span>`).join("")}</div>
    ${score.abstain ? '<p class="muted-copy">짧은 글 또는 적용 제외 유형은 참고용입니다.</p>' : ''}
    ${reviewHighlights(visibleText, score.highlights)}
    ${score.questions.length ? `<details class="action-details"><summary>근거 보강 질문</summary><ul>${score.questions.slice(0,3).map(question => `<li>${esc(question)}</li>`).join("")}</ul></details>` : ""}
    <p class="muted-copy">점수는 진단이며 합격 예측이 아닙니다.</p>`;
}

function setEditorLocks(q) {
  const lock = locked(q);
  stage.querySelector("#answer").readOnly = lock;
  stage.querySelectorAll("[data-fact]").forEach(input => { input.disabled = lock; });
  const controller = loops.get(q.id)?.controller;
  const stale = controller?.conflict || controller?.missing;
  stage.querySelector('[data-action="approve"]').disabled = lock || stale || modified(q) || !q.headRevisionId;
  stage.querySelector('[data-action="save"]').disabled = lock || stale || !modified(q);
}

function exportPage() {
  const approved = workspace.questions.filter(q => q.approvedRevisionId);
  const dirty = workspace.questions.filter(modified).length;
    return `<div class="grid-main"><section class="panel printable"><div class="print-context">${esc(workspace.company)} · ${esc(workspace.role)}</div><div class="section-line"><h2>제출할 답변</h2>
    <span class="badge">${approved.length} / ${workspace.questions.length}문항 확정</span></div>
    ${approved.length ? `<ul class="list-reset">${approved.map(q => `<li><div class="row-between"><h3>${esc(q.title)}</h3>
      <span class="revision-tag">확정본 ${revisionLabel(q, q.approvedRevisionId)}</span></div>
      <p class="plain-output">${esc(revisionOf(q, q.approvedRevisionId).text)}</p>
      <button type="button" class="btn secondary" data-txt="${esc(q.id)}">답변 TXT 다운로드</button></li>`).join("")}</ul>`
      : `<p class="empty-message">확정한 답변이 없습니다. 문항에서 편집본을 저장한 뒤 확정해 주세요.</p>${button("문항 작성으로", "to-writer")}`}
      ${approved.length ? button("확정본 인쇄 · PDF 저장", "print") : ""}
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
    ${alreadyApproved ? '<p class="badge success">현재 확정본</p>' : locked(q) ? "" : '<button type="button" class="btn primary" id="confirm-revision">이 버전 확정</button>'}`,
    modal => modal.querySelector("#confirm-revision")?.addEventListener("click", async event => {
      try {
        const run = loops.get(q.id);
        if (run?.remote) {
          event.currentTarget.disabled = true;
          const snap = await run.controller.command("approve", {
            workspace, initial: draftInput(q), baseRevisionId: q.headRevisionId, revisionId: revision.id,
          });
          if (!acceptCheckpoint(q, run, snap)) return;
        } else approveRevision(workspace, q.id, revision.id);
        trackChanges(true);
        dialog.close();
        render();
        tell(`${revisionLabel(q, revision.id)}을 제출할 버전으로 확정했습니다.`);
        stage.querySelector('[data-action="approve"]')?.focus();
      } catch (error) { showError(error); }
    }));
}

async function modelSettings(q, mode = "single") {
  const facts = selectedFacts(q);
  if (!facts.length) throw new Error("문항에서 확인된 사실을 한 건 이상 선택해 주세요.");
  if (facts.length > 40 || q.title.length > 4000 || facts.some(f => f.text.length > 4000)
      || facts.reduce((total, f) => total + f.text.length, 0) > 30000)
    throw new Error("문항은 4,000자 이내, 근거는 각 4,000자 이내로 최대 40건·합계 30,000자까지 전송할 수 있습니다.");
  const repeat = mode !== "single";
  const run = mode === "resume" ? loops.get(q.id) : null;
  let server = Boolean(run?.remote);
  if (mode === "loop") {
    try { server = (await listRemoteRuns()).available; } catch { server = false; }
    if (q !== activeQuestion() || currentPage !== "writer" || dialog.open) return;
  }
  const title = mode === "resume" ? "반복 작성 재개" : repeat ? "반복 작성 설정" : "모델에 초안 요청";
  const draft = draftOf(q);
  openDialog(title, `<form id="model-form" class="form-flow" data-mode="${mode}" autocomplete="off">
    ${repeat ? `<label class="field"><span>실행 위치</span><select name="execution" ${run ? "disabled" : ""}>
      <option value="server" ${server ? "selected" : "disabled"}>로컬 서버 · 탭을 닫아도 계속</option>
      <option value="tab" ${server ? "" : "selected"}>이 탭에서 실행</option></select></label>
      <p class="metadata" data-execution-info></p>` : ""}
    <label class="field"><span>모델 제공자</span><select name="provider"><option value="ollama">Ollama · 로컬</option><option value="anthropic">Anthropic · 개인 키</option><option value="openai">OpenAI · 개인 키</option><option value="gemini">Gemini · 개인 키</option></select></label>
    <div data-local>${field("설치한 Ollama 모델","model",`required maxlength="100" ${run ? "readonly" : ""} value="${esc(run?.model || modelName || "qwen3:8b")}"`)}</div>
    <fieldset data-cloud hidden disabled class="form-flow"><legend>클라우드 호출 설정</legend>
      <span data-cloud-model></span>
      ${field("API 키","key",'required type="password" autocomplete="off" spellcheck="false"')}
      ${field(repeat ? "전체 반복 예산 (USD)" : "요청 한 번의 예산 (USD)","budget",`required type="number" min="0.000001" max="1" step="any" ${run ? "readonly" : ""} value="${esc(run?.budgetUsd ?? 0.03)}"`)}
      <label class="field"><span>추가로 가릴 이름·주소 (한 줄에 하나씩)</span><textarea name="redact" rows="2">${esc(run?.redactTerms?.join("\n") ?? "")}</textarea></label>
      <p class="muted-copy">서버가 이메일, 전화번호, 주민번호 형태와 입력한 이름·주소를 가린 후 선택한 제공자에 전송합니다. 원문에 남은 식별 정보를 확인하세요. 최대 출력은 1,200토큰입니다. 표시 비용은 표준 요율을 마이크로달러 단위로 올림한 상한 추정치입니다. Gemini 무료 등급은 입력이 제품 개선에 사용될 수 있으므로 계정 정책을 확인하세요.</p>
    </fieldset>
    ${repeat ? `<fieldset class="form-flow"><legend>반복 조건</legend><div class="field-grid">
      ${field("최대 작성 횟수","iterations",`type="number" min="1" max="10" step="1" required ${run ? "readonly" : ""} value="${run?.maxIterations ?? 3}"`)}
      ${field("목표 문체 지수 (선택)","target",`type="number" min="0" max="100" step="1" ${run ? "readonly" : ""} value="${run?.target ?? ""}"`)}
      </div><p class="metadata">모델은 각 회차에 문항, 연결한 사실, 글자 한도(${q.limit}자), 작성 기준 본문과 직전 점검 의견을 받습니다. 300자 미만은 목표 판정을 보류합니다.</p>
      </fieldset>` : ""}
    <section><h3>보낼 문항과 근거 · 로컬 원문</h3><p class="plain-output">${esc(q.title)}</p>${evidenceList(facts)}</section>
    ${repeat ? `<section><h3>현재 편집본</h3><p class="review-body">${esc(draft.text || "빈 답변")}</p>
      ${run?.controller.state.best && run.controller.state.best.text !== draft.text ? `<h3>이전 추천본</h3><p class="review-body">${esc(run.controller.state.best.text)}</p>` : ""}
      <p class="metadata">검증을 통과한 본문으로 다음 회차를 작성합니다. 추천본을 보관하려면 편집기에 반영해 저장하고 작업 JSON을 내려받으세요.</p></section>` : ""}
    ${run?.remote && isCloud(run.provider) ? '<label class="check-row"><input type="checkbox" required>이번 전송에서 가릴 이름·주소를 확인했습니다.</label>' : ""}
    ${mode === "resume" && modified(q) ? '<p class="metadata">수정한 본문과 근거를 새 편집본으로 저장한 뒤 재개합니다.</p>' : ""}
    <button class="btn primary" type="submit">${mode === "resume" ? "이 내용으로 재개" : repeat ? "이 설정으로 반복 시작" : "이 문항과 근거로 초안 요청"}</button>
    </form>`, modal => {
    const form = modal.querySelector("form");
    if (repeat) {
      const explain = () => {
        form.querySelector("[data-execution-info]").textContent = form.elements.execution.value === "server"
          ? "전체 작업 JSON과 현재 문항의 편집본을 이 기기의 서버 메모리에 보관합니다. 탭을 닫아도 반복은 계속되고 같은 브라우저에서 다시 열 수 있습니다. 서버를 종료하면 원본이 사라집니다. 모델에는 아래 문항과 선택한 근거, 기준 본문, 점검 의견을 보냅니다."
          : (server || run ? "" : "서버 워커에 연결할 수 없습니다. ") + "이 탭에서 반복합니다. 탭을 닫으면 실행과 미반영 추천본이 사라집니다.";
      };
      explain();
      form.elements.execution.onchange = explain;
    }
    function updateProvider() {
      const cloud = isCloud(form.elements.provider.value);
      form.querySelector("[data-local]").hidden = cloud;
      form.elements.model.disabled = cloud;
      form.querySelector("[data-cloud]").hidden = !cloud;
      form.querySelector("[data-cloud]").disabled = !cloud;
      form.elements.key.value = "";
      form.querySelector("[data-cloud-model]").textContent = cloud ? `모델 · ${cloudModels[form.elements.provider.value]}` : "";
    }
    if (run) {
      form.elements.provider.value = run.provider;
      form.elements.provider.disabled = true;
    }
    updateProvider();
    form.elements.provider.addEventListener("change", updateProvider);
  });
}

function refreshModelPanel() {
  const q = activeQuestion();
  const panel = stage.querySelector(".model-offer");
  if (q && currentPage === "writer" && panel) {
    const wasFocused = panel.contains(document.activeElement);
    const focus = wasFocused ? document.activeElement.dataset.action : null;
    const compared = panel.querySelector(".loop-result details")?.open;
    panel.outerHTML = modelPanel(q, draftOf(q));
    const comparison = stage.querySelector(".loop-result details");
    if (comparison && compared) comparison.open = true;
    if (wasFocused) {
      const replacement = focus && stage.querySelector(`[data-action="${CSS.escape(focus)}"]:not([disabled])`);
      (replacement || stage.querySelector('.loop-result [role="status"]'))?.focus({preventScroll: true});
    }
    setEditorLocks(q);
  }
}

function readModelSettings(form) {
  const provider = form.elements.provider.value;
  const cloud = isCloud(provider);
  const model = cloud ? cloudModels[provider] : form.elements.model.value.trim();
  const key = cloud ? form.elements.key.value.trim() : "";
  form.elements.key.value = "";
  if (!cloud) modelName = model;
  const redactTerms = cloud ? form.elements.redact.value.split(/\r?\n/).map(t => t.trim()).filter(Boolean) : [];
  return {provider, model, key, redactTerms, budgetUsd: cloud ? Number(form.elements.budget.value) : 0};
}

async function requestDraft(settings, payload, signal, budgetUsd) {
  const cloud = isCloud(settings.provider);
  const body = {...payload, provider: settings.provider, model: settings.model};
  const headers = {
    "Content-Type":"application/json", "X-CareerProof-Request":"1", "X-CareerProof-Command":crypto.randomUUID(),
  };
  if (cloud) {
    headers["X-LLM-API-Key"] = settings.key;
    Object.assign(body, {budgetUsd: String(budgetUsd), redactTerms: settings.redactTerms, confirmed: true});
  }
  let response;
  let result;
  try {
    response = await fetch("/api/draft", {method: "POST", headers, body: JSON.stringify(body), signal});
    result = await response.json();
  } catch (error) {
    if (signal.aborted) throw error;
    throw Object.assign(new Error("모델 응답을 받지 못했습니다."), {code: cloud ? "cost_unknown" : "provider_error"});
  } finally {
    delete headers["X-LLM-API-Key"];
  }
  if (!response.ok) throw Object.assign(new Error(result?.error || "모델 요청이 중단됐습니다."), {
    status: response.status, code: result?.code || (cloud ? "cost_unknown" : "provider_error"), usage: result?.usage,
  });
  if (typeof result?.text !== "string" || !result.text.trim() || !Array.isArray(result.factIds)
      || !result.factIds.length || !result.factIds.every(id => payload.facts.some(f => f.id === id))) {
    throw Object.assign(new Error("모델이 반환한 초안이나 근거를 확인할 수 없습니다."), {
      code: cloud && !result?.usage ? "cost_unknown" : "provider_error", usage: result?.usage,
    });
  }
  return result;
}

function draftInput(q) {
  const draft = draftOf(q);
  return {text: draft.text, factIds: [...draft.factIds]};
}

function attachRemote(q, snapshot) {
  const previous = loops.get(q.id);
  if (previous?.remote) previous.controller.dispose();
  const {provider, model, maxIterations, budgetUsd, target, redactTerms = []} = snapshot;
  recentWriter.set(workspace, model);
  const run = {remote: true, provider, model, maxIterations, budgetUsd, target, redactTerms};
  run.controller = new RemoteRun(snapshot, () => {
    if (loops.get(q.id) !== run) return;
    refreshModelPanel();
    trackChanges();
  });
  loops.set(q.id, run);
  run.controller.watch();
  return run;
}

function acceptCheckpoint(q, run, snapshot) {
  if (loops.get(q.id) !== run) return false;
  const accepted = snapshot.workspace.questions.find(item => item.id === q.id);
  if (!accepted) throw new Error("서버에서 저장한 문항을 찾을 수 없습니다.");
  // Other questions can still be edited while this command is in flight.
  q.revisions = accepted.revisions;
  q.approvedRevisionId = accepted.approvedRevisionId;
  q.headRevisionId = accepted.headRevisionId;
  draftOf(q).baseRevisionId = q.headRevisionId;
  return true;
}

async function submitServerLoop(form, q, settings) {
  const current = workspace;
  const input = draftInput(q);
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    if (form.dataset.mode === "resume") {
      const run = loops.get(q.id);
      const staged = restoreWorkspace(backupWorkspace(workspace));
      let baseRevisionId = draftOf(q).baseRevisionId;
      if (modified(q)) baseRevisionId = saveRevision(staged, q.id, {...input, baseRevisionId}).id;
      const snap = await run.controller.command("resume", {
        workspace: staged, initial: input, baseRevisionId, confirmed: true, redactTerms: settings.redactTerms,
      }, settings.key);
      if (!acceptCheckpoint(q, run, snap)) return;
      run.redactTerms = snap.redactTerms ?? settings.redactTerms;
      trackChanges(true);
    } else {
      openingWorker = true;
      const snap = await startRemoteRun({
        workspace, initial: input, questionId: q.id, provider: settings.provider, model: settings.model,
        maxIterations: Number(form.elements.iterations.value), budgetUsd: settings.budgetUsd,
        target: form.elements.target.value === "" ? null : Number(form.elements.target.value),
        redactTerms: settings.redactTerms,
      }, settings.key);
      if (current !== workspace) return;
      attachRemote(q, snap);
    }
    if (form.isConnected && dialog.open) dialog.close();
    if (current === workspace) {
      render();
      tell("서버 실행에 연결했습니다. 서버 작성 목록에서 이 작업을 다시 열 수 있습니다.");
    }
  } finally {
    settings.key = "";
    openingWorker = false;
    submit.disabled = false;
  }
}

async function reviewRemote(id) {
  const original = workspace;
  const snapshot = await openRemoteRun(id);
  if (original !== workspace || dialog.open) return;
  const next = restoreWorkspace(snapshot.workspace);
  const q = next.questions.find(item => item.id === snapshot.questionId);
  if (!q) throw new Error("서버의 문항 원본을 복원할 수 없습니다.");
  function open() {
    setWorkspace(next);
    activeId = q.id;
    const draft = draftOf(q);
    draft.text = snapshot.initial.text;
    draft.factIds = [...snapshot.initial.factIds];
    attachRemote(q, snapshot);
    goto("writer");
    trackChanges();
    tell("서버의 편집본과 추천본을 열었습니다.");
  }
  if (!workspace) { open(); return; }
  const local = workspace.questions.find(item => item.id === q.id);
  const compare = local ? `<div class="diff-grid"><div class="diff before"><strong>이 탭의 편집본</strong><p>${esc(draftOf(local).text || "빈 답변")}</p></div>
    <div class="diff after"><strong>서버 편집본</strong><p>${esc(snapshot.initial.text || "빈 답변")}</p></div></div>` : "";
  openDialog("서버 작업 열기", `<h3>${esc(next.company)} · ${esc(q.title)}</h3>${compare}
    <p class="note">이 탭의 전체 작업을 서버에 있는 버전으로 교체합니다. 현재 편집을 보관하려면 먼저 편집본을 저장하고 작업 JSON을 내려받으세요.</p>
    <div class="cta-row"><button type="button" class="btn primary" id="worker-confirm-open">서버 버전 열기</button>
    <button type="button" class="btn secondary" id="worker-keep">이 탭의 작업 유지</button></div>`, modal => {
    modal.querySelector("#worker-confirm-open").onclick = () => { dialog.close(); open(); };
    modal.querySelector("#worker-keep").onclick = () => dialog.close();
  });
}

async function submitLoop(form, q, settings) {
  const mode = form.dataset.mode;
  if (form.elements.execution?.value === "server") {
    await submitServerLoop(form, q, settings);
    return;
  }
  let run = loops.get(q.id);
  if (mode === "resume") {
    if (!run || run.controller.state.phase !== "paused") throw new Error("재개할 실행을 찾을 수 없습니다.");
  } else {
    const maxIterations = Number(form.elements.iterations.value);
    const target = form.elements.target.value === "" ? null : Number(form.elements.target.value);
    const snapshot = draftInput(q);
    run = {...settings, maxIterations, target};
    const journal = createRunJournal();
    run.controller = createLoop({
      workspace, question: q, initial: snapshot, maxIterations, target, provider: run.provider, budgetUsd: run.budgetUsd,
      generate: ({previous, facts, question, remainingUsd, signal, feedback}) => {
        const payload = {facts, question, charLimit: q.limit, documentKind: q.kind, feedback};
        if (previous) payload.previousText = previous.text;
        return requestDraft(run, payload, signal, remainingUsd);
      },
      onChange: state => {
        journal.record(state);
        if (["paused", "completed", "cancelled"].includes(state.phase)) run.key = "";
        if (["completed", "cancelled"].includes(state.phase)) run.redactTerms = [];
        if (loops.get(q.id) === run) {
          refreshModelPanel();
          trackChanges();
        }
      },
    });
    const previous = loops.get(q.id);
    if (previous?.remote) previous.controller.dispose();
    loops.set(q.id, run);
  }
  const input = draftInput(q);
  try {
    if (mode === "resume") {
      if (modified(q)) {
        const revision = saveRevision(workspace, q.id, {...input, baseRevisionId: draftOf(q).baseRevisionId});
        draftOf(q).baseRevisionId = revision.id;
        trackChanges(true);
        render();
      }
      run.key = settings.key;
      run.redactTerms = settings.redactTerms;
    }
    settings.key = "";
    dialog.close();
    if (mode === "resume") await run.controller.resume(input, draftOf(q).baseRevisionId);
    else await run.controller.start();
  } finally {
    settings.key = "";
    if (!["running", "pausing"].includes(run.controller.state.phase)) run.key = "";
  }
}

async function fetchDraft(form) {
  if (generating()) throw new Error("진행 중인 모델 요청이 있습니다.");
  const q = activeQuestion();
  const settings = readModelSettings(form);
  recentWriter.set(workspace, settings.model);
  if (form.dataset.mode !== "single") return submitLoop(form, q, settings);
  const facts = selectedFacts(q).map(({id,text}) => ({id,text}));
  const {model, provider} = settings;
  const pending = {questionId: q.id, controller: new AbortController()};
  request = pending;
  dialog.close();
  refreshModelPanel();
  tell(`${model}에 초안을 요청했습니다.`);
  try {
    const result = await requestDraft(settings, {question:q.title, facts, charLimit:q.limit, documentKind:q.kind}, pending.controller.signal, settings.budgetUsd);
    if (pending !== request) return;
    const cost = result.usage?.costUsd;
    const usage = isCloud(provider) && cost != null && Number.isFinite(Number(cost)) ? ` · 사용액 $${cost}` : "";
    draftOf(q).proposal = {text: result.text, factIds: [...new Set(result.factIds)], context: `${model}${usage}`};
    tell(`‘${q.title}’의 초안이 도착했습니다. 편집본과 비교해 주세요.`);
  } catch (error) {
    if (request === pending) {
      if (error.name === "AbortError") tell("응답 수신을 중단했습니다. 서버의 호출은 계속될 수 있습니다.");
      else report(error);
    }
  } finally {
    settings.key = "";
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

async function handleAction(action) {
  const q = activeQuestion();
  const run = q && loops.get(q.id);
  switch (action) {
      case "demo": setWorkspace(exampleWorkspace()); tell("가상 자료를 열었습니다. 공고·포트폴리오에서 직무 요건과 연결된 근거를 확인할 수 있습니다."); break;
      case "print": window.print(); break;
    case "restore": restoreFile.click(); break;
    case "to-facts": goto("facts"); break;
    case "to-writer": goto("writer"); break;
    case "add-question": openDialog("새 문항", questionForm()); break;
    case "save": {
      const draft = draftOf(q);
      let revision;
      if (run?.remote) {
        const snap = await run.controller.command("edit", {workspace, initial: draftInput(q), baseRevisionId: draft.baseRevisionId});
        if (!acceptCheckpoint(q, run, snap)) return;
        revision = revisionOf(q);
      } else revision = saveRevision(workspace, q.id, {text: draft.text, factIds: draft.factIds, baseRevisionId: draft.baseRevisionId});
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
    case "model": await modelSettings(q); break;
    case "personal-agent": {
      if (!q || generating() || locked(q)) break;
      const project = workspace;
      const originalDraft = draftOf(q);
      const facts = selectedFacts(q).map(({id, text}) => ({id, text}));
      if (!facts.length) throw new Error("문항에서 확인된 사실을 한 건 이상 선택해 주세요.");
      openAgentDraft({
        openDialog, ensureSession, esc,
        input: {question: q.title, facts, documentKind: q.kind, charLimit: q.limit},
        onProposal(proposal) {
          if (workspace !== project || activeQuestion() !== q || originalDraft !== draftOf(q) || locked(q) ||
              !proposal.factIds.every(id => facts.some(original => original.id === id &&
                selectedFacts(q).some(live => live.id === id && live.text === original.text)))) {
            throw new Error("문항이나 연결 근거가 바뀌었습니다. 현재 편집본에서 새 요청을 만드세요.");
          }
          originalDraft.proposal = {...proposal, context: "내 AI 대화에서 받은 초안"};
          refreshModelPanel();
          tell("개인 AI의 제안이 도착했습니다. 현재 편집본과 비교해 주세요.");
        },
      });
      break;
    }
    case "loop-settings": await modelSettings(q, "loop"); break;
    case "loop-resume": await modelSettings(q, "resume"); break;
    case "loop-pause":
    case "loop-stop":
    case "loop-cancel": {
      const kind = action.slice(5);
      if (run.remote) await run.controller.command(kind);
      else run.controller[kind]();
      break;
    }
    case "remote-reopen": await reviewRemote(run.controller.id); break;
    case "remote-detach":
      run.controller.dispose(); loops.delete(q.id);
      render(); tell("이 탭의 편집 내용을 로컬 사본으로 유지했습니다. 서버 실행은 서버 작성 목록에서 열 수 있습니다.");
      break;
    case "loop-apply": {
      const best = run.controller.state.best;
      if (!best || locked(q)) break;
      const draft = draftOf(q);
      draft.text = best.text;
      draft.factIds = [...best.factIds];
      trackChanges();
      render();
      tell("추천본을 편집기에 반영했습니다. 내용을 확인한 뒤 저장하고 확정하세요.");
      stage.querySelector("#answer").focus();
      break;
    }
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
    if (target.dataset.action) handleAction(target.dataset.action).catch(showError);
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
      const name = `${workspace.company}-${q.title}`.replace(/[\\/:*?"<>|]/g, "-").slice(0, 160).replace(/[.\s]+$/, "");
      download(`${name}.txt`, revisionOf(q,q.approvedRevisionId).text, "text/plain;charset=utf-8");
      tell("확정본 TXT 다운로드를 요청했습니다.");
    }
  } catch (error) { showError(error); }
});

stage.addEventListener("input", event => {
  if (event.target.id !== "answer") return;
  draftOf(activeQuestion()).text = event.target.value;
  trackChanges();
  stage.querySelectorAll(".diff.before p").forEach(item => { item.textContent = event.target.value || "빈 답변"; });
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

function mountRecovery() {
  const panel = document.querySelector("#server-runs");
  const choice = panel.querySelector("#worker-choice");
  const status = panel.querySelector("#worker-status");
  const open = panel.querySelector("#worker-open");
  const remove = panel.querySelector("#worker-delete");
  let rows = [], query = 0;
  function select() {
    const item = rows.find(row => row.id === choice.value);
    choice.disabled = !rows.length;
    open.disabled = !item;
    remove.disabled = !item || !(item.canDelete ?? (["completed","cancelled","failed"].includes(item.phase) || item.reason === "input_required"));
  }
  async function list() {
    const version = ++query;
    const last = choice.value;
    rows = []; select();
    status.textContent = "서버 작업을 확인하고 있습니다.";
    try {
      const response = await listRemoteRuns();
      if (version !== query) return;
      rows = response.runs;
      choice.replaceChildren(...rows.map(row => new Option(
        row.company + " · " + row.title + " · " + (phaseLabel[row.phase] || "상태 확인 필요"), row.id)));
      if (rows.some(row => row.id === last)) choice.value = last;
      select();
      status.textContent = rows.length ? "" : response.available ? "다시 열 서버 작업이 없습니다." : "서버 워커를 사용할 수 없습니다. 이 탭에서 반복 작성할 수 있습니다.";
    } catch {
      if (version !== query) return;
      choice.replaceChildren();
      status.textContent = "서버 작성 목록에 연결하지 못했습니다. 로컬 서버를 확인하세요.";
    }
  }
  panel.ontoggle = () => { if (panel.open) void list(); else query++; };
  panel.querySelector("#worker-refresh").onclick = list;
  choice.onchange = select;
  open.onclick = () => reviewRemote(choice.value).catch(error => { status.textContent = error.message; });
  remove.onclick = async () => {
    const item = rows.find(row => row.id === choice.value);
    if (!item || !window.confirm("선택한 실행의 문항 원본과 추천본을 서버에서 삭제할까요?")) return;
    remove.disabled = true;
    try {
      await deleteRemoteRun(item.id, item.version);
      const attached = loops.get(item.questionId);
      if (attached?.controller.id === item.id) {
        attached.controller.dispose(); loops.delete(item.questionId); render();
      }
      await list();
    } catch (error) {
      status.textContent = error.status === 409 ? "다른 탭이 실행을 변경했습니다. 목록을 새로고침한 뒤 다시 선택하세요." : error.message;
    }
  };
}
document.querySelector("#privacy-erase").onclick = () => {
  openDialog("이 브라우저의 작업과 기록 삭제", `
    <p>이 탭에 열린 프로젝트·편집 내용과 이 브라우저 소유자의 서버 작업 원본·추천본·전체 실행 기록(목록에 보이지 않는 기록 포함)을 삭제합니다. 복구할 수 없습니다.</p>
    <p>다른 탭의 편집 내용과 내려받은 JSON·TXT 파일은 삭제되지 않습니다. 다른 탭을 닫아야 그 탭의 메모리가 비워지며, 열어 둔 탭은 기록을 다시 만들 수 있습니다. 브라우저 소유자 쿠키는 유지합니다.</p>
    <p>초안·위원회 재시도 응답은 소유자별 삭제가 불가능하여 서버 RAM에서 완료 후 최대 10분간 남습니다. 삭제는 제공자 과금·요청을 취소하지 않습니다. 미확인 비용 기록도 삭제되므로 제공자 사용 내역을 별도로 확인하세요.</p>
    <label class="field"><span><input type="checkbox" id="privacy-consent"> 삭제 범위와 미확인 비용 기록의 삭제를 이해했으며 전체 삭제에 동의합니다.</span></label>
    <p id="privacy-error" role="status"></p>
    <button type="button" class="btn primary" id="privacy-confirm" disabled>작업과 전체 기록 영구 삭제</button>`, modal => {
    const consent = modal.querySelector("#privacy-consent");
    const confirm = modal.querySelector("#privacy-confirm");
    const error = modal.querySelector("#privacy-error");
    consent.onchange = () => { confirm.disabled = !consent.checked; };
    confirm.onclick = async () => {
      if (!consent.checked) return;
      confirm.disabled = consent.disabled = true;
      const close = modal.querySelector("[data-close]");
      close.disabled = true;
      const preventClose = event => event.preventDefault();
      dialog.addEventListener("cancel", preventClose);
      try {
        if (request || openingWorker || committeeView?.isBusy() || [...loops.values()].some(run =>
          !run.remote && ["running", "pausing", "paused"].includes(run.controller.state.phase))) {
          throw new Error("진행 중인 요청과 반복 작성을 종료하거나 취소하고 응답 및 사용량 정산이 끝난 뒤 삭제하세요.");
        }
        await ensureSession();
        await flushRunJournals();
        const response = await fetch("/api/history/erase", {method:"POST", cache:"no-store",
          headers:{"Content-Type":"application/json", "X-CareerProof-Request":"1"},
          body:JSON.stringify({confirm:"erase-browser-workspace"})});
        const result = await response.json();
        if (!response.ok || result.deleted !== true) throw new Error(result.error || "삭제를 완료하지 못했습니다.");
        window.removeEventListener("beforeunload", warnBeforeUnload);
        // A fresh document clears every module's editor, report and retry cache.
        window.location.replace(window.location.pathname);
      } catch (failure) {
        error.textContent = failure.message;
        confirm.disabled = !consent.checked;
        consent.disabled = false;
        close.disabled = false;
        dialog.removeEventListener("cancel", preventClose);
      }
    };
  });
};
mountRecovery();
render();
