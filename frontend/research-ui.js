import { addFact, addQuestion, setResearch } from "./workspace.js";
import { emptyResearch, parseJobDescription, matchRequirements, prioritizedActions, portfolioCandidates } from "./research.js";

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function field(parent, label, value = "", type = "text") {
  const wrapper = node("label", null, "field");
  wrapper.append(node("span", label));
  const input = node(type === "textarea" ? "textarea" : "input");
  if (type !== "textarea") input.type = type;
  input.value = value; wrapper.append(input); parent.append(wrapper); return input;
}
function button(parent, label, handler, primary = false) {
  const element = node("button", label, `btn ${primary ? "primary" : "secondary"}`); element.type = "button";
  element.addEventListener("click", handler); parent.append(element); return element;
}
function panel(parent, title, description) {
  const section = node("section", null, "panel form-flow"); section.append(node("h2", title));
  if (description) section.append(node("p", description, "description")); parent.append(section); return section;
}
function reference(parent, span) {
  const details = node("details", null, "action-details"); details.append(node("summary", `원문 근거 · ${span.source === "jd" ? "공고 원문" : span.source}${span.page ? ` ${span.page}쪽` : ""} · 문자 ${span.start}–${span.end} (끝 제외)`));
  details.append(node("blockquote", span.quote, "plain-output")); parent.append(details);
}
function check(parent, text) { const label = node("label", null, "check-row"); const input = node("input"); input.type = "checkbox"; label.append(input, node("span", text)); parent.append(label); return input; }
function safeLink(parent, title, url) {
  try { if (!["https:", "http:"].includes(new URL(url).protocol)) return; } catch { return; }
  const link = node("a", title); link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer"; parent.append(link);
}
async function post(path, body, headers = {}) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-CareerProof-Request": "1", ...headers }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error?.message ?? data.message ?? (typeof data.error === "string" ? data.error : "요청을 처리하지 못했습니다.")); error.code = data.code ?? data.error?.code; throw error; }
  return data;
}
function base64File(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("파일을 읽지 못했습니다.")); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.readAsDataURL(file); }); }

export function mountResearch(stage, { workspace, onChanged = () => {}, onFact, onQuestion }) {
  stage.replaceChildren();
  const layout = node("div", null, "research-workbench"); stage.append(layout);
  const status = node("p", "", "status-message"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); layout.append(status);
  function tell(text, error = false) { status.textContent = text; status.dataset.level = error ? "error" : "info"; }
  function save(patch) { setResearch(workspace, { ...(workspace.research ?? emptyResearch()), ...patch }); onChanged(); }
  function guard(action) { return async () => { try { await action(); } catch (error) { tell(error.message, true); } }; }

  const research = workspace.research ?? emptyResearch();
  const tabs = node("div", null, "research-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "리서치 작업 영역");
  const viewHost = node("div", null, "research-view"); layout.append(tabs, viewHost);
  const views = [];
  function addTab(label, id, render) {
    const tab = node("button", label, "research-tab"); tab.type = "button"; tab.id = `${id}-tab`; tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", `${id}-view`); tab.setAttribute("aria-selected", "false"); tab.tabIndex = -1;
    const view = node("section", null, "research-tabpanel"); view.id = `${id}-view`; view.setAttribute("role", "tabpanel"); view.setAttribute("aria-labelledby", tab.id); view.hidden = true;
    tabs.append(tab); viewHost.append(view); views.push({ tab, view });
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const index = views.findIndex(row => row.tab === tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : (index + (event.key === "ArrowRight" ? 1 : views.length - 1)) % views.length;
      activate(views[next].tab); views[next].tab.focus();
    });
    render(view);
    return view;
  }
  function activate(active) { for (const row of views) { const selected = row.tab === active; row.tab.setAttribute("aria-selected", String(selected)); row.tab.tabIndex = selected ? 0 : -1; row.view.hidden = !selected; } }

  const jdView = addTab("공고 분석", "research-jd", view => {
    const jd = panel(view, "공고 분석", "저장한 공고의 요구사항을 확인된 사실과 대조합니다. 커버리지는 참고 요약이며 채용 결과나 적합도 점수가 아닙니다.");
    const parsed = parseJobDescription(research.jdText ?? "");
    const initialMatches = matchRequirements(workspace, parsed.requirements);
    const summary = node("section", null, "coverage-summary"); summary.setAttribute("aria-label", "요구사항 근거 요약");
    const summaryHead = node("div", null, "coverage-heading"); summaryHead.append(node("p", "근거 커버리지", "eyebrow"), node("strong", ""));
    const summaryStats = node("div", null, "coverage-stats"); summary.append(summaryHead, summaryStats); jd.append(summary);

    const sourceDetails = node("details", null, "jd-source"); sourceDetails.open = !research.jdText;
    sourceDetails.append(node("summary", research.jdText ? "공고 원문 보기 · 수정" : "공고 원문 입력"));
    const jdInput = field(sourceDetails, "채용 공고 원문", research.jdText ?? "", "textarea"); jdInput.rows = 8; jdInput.maxLength = 50000; jdInput.setAttribute("aria-describedby", "jd-source-help");
    const sourceHelp = node("p", "원문은 이 작업 파일에 저장됩니다. 명시된 요건과 작성 문항을 줄 단위로 검토합니다.", "metadata"); sourceHelp.id = "jd-source-help"; sourceDetails.append(sourceHelp);
    button(sourceDetails, "공고 저장 · 요구사항 갱신", guard(() => { save({ jdText: jdInput.value }); renderRequirements(); tell("공고를 저장하고 요구사항을 갱신했습니다."); }), true);
    const requirements = panel(view, "요구사항과 내 근거", "확인된 사실과 원문 위치가 연결된 경우에만 근거 있음으로 표시합니다.");
    const actionsHost = node("div", null, "research-actions");
    const questionsHost = node("div", null, "research-questions");
    jd.append(requirements, sourceDetails, actionsHost, questionsHost);

    function renderRequirements() {
      const currentParsed = parseJobDescription(workspace.research?.jdText ?? "");
      const matches = matchRequirements(workspace, currentParsed.requirements);
      const covered = matches.filter(row => row.status === "covered").length;
      const weak = matches.filter(row => row.status === "weak").length;
      const missing = matches.length - covered - weak;
      summaryHead.querySelector("strong").textContent = matches.length ? `${covered} / ${matches.length}개 요구사항에 확인된 근거` : "요구사항을 분석할 공고가 없습니다";
      summaryStats.replaceChildren();
      for (const [label, count, cls] of [["근거 있음", covered, "is-covered"], ["부분·언급", weak, "is-weak"], ["근거 없음", missing, "is-missing"]]) {
        const stat = node("div", null, `coverage-stat ${cls}`); stat.append(node("strong", String(count)), node("span", label)); summaryStats.append(stat);
      }
      requirements.replaceChildren(node("h2", "요구사항과 내 근거"), node("p", "확인된 사실과 원문 위치가 연결된 경우에만 근거 있음으로 표시합니다.", "description"));
      if (!matches.length) requirements.append(node("p", "공고 원문을 저장하면 요건이 이곳에 표시됩니다.", "empty-message"));
      for (const row of matches) {
        const item = node("article", null, "requirement-card");
        const label = row.status === "covered" ? "근거 있음" : row.status === "weak" ? "부분 근거" : "근거 없음";
        item.append(node("div", null, "requirement-meta")); item.firstChild.append(node("span", row.priority === "required" ? "필수·업무" : "우대", "requirement-priority"), node("span", label, `requirement-status ${row.status}`));
        item.append(node("h3", row.text), node("p", row.reason, "metadata")); reference(item, row.span);
        for (const match of row.matches.slice(0, 10)) { const evidence = node("div", null, "matched-evidence"); evidence.append(node("p", `${match.strong ? "확인된 수행" : "언급·미확인"} · ${match.source}`, "metadata")); reference(evidence, match.span); item.append(evidence); }
        requirements.append(item);
      }
      actionsHost.replaceChildren();
      const actions = prioritizedActions(matches);
      if (actions.length) { const area = panel(actionsHost, "먼저 보완할 일"); for (const action of actions) { const row = node("article", null, "action-card"); row.append(node("h3", `${action.priority}. ${action.text}`), node("p", action.action), node("p", action.reason, "metadata")); reference(row, action.span); area.append(row); } }

      questionsHost.replaceChildren();
      const questions = panel(questionsHost, "공고 문항 가져오기", "가져온 문항과 분량은 추가 전에 원문에서 확인하세요.");
      if (!currentParsed.questions.length) questions.append(node("p", "추출된 작성 문항이 없습니다.", "empty-message"));
      for (const candidate of currentParsed.questions) {
        const row = node("article", null, "evidence-preview"); row.append(node("h3", candidate.title));
        row.append(node("p", `${candidate.inferredCharLimit ? "문자 제한 미명시 (임시 50,000자)" : `${candidate.limit}자`}${candidate.rule.maxBytes ? ` · ${candidate.rule.maxBytes}바이트` : ""}${candidate.rule.maxLines ? ` · ${candidate.rule.maxLines}줄` : ""}${candidate.rule.includeSpaces === false ? " · 공백 제외" : candidate.rule.includeSpaces ? " · 공백 포함" : ""}`, "metadata")); reference(row, candidate.span);
        const exists = workspace.questions.some(q => q.title === candidate.title);
        const add = button(row, exists ? "이미 추가한 문항" : "이 문항 추가", guard(() => {
          const question = addQuestion(workspace, { title: candidate.title, limit: candidate.limit, rule: candidate.rule }); onChanged(); add.disabled = true; add.textContent = "추가 완료"; onQuestion?.(question); tell("문항을 추가했습니다.");
        })); add.disabled = exists; questions.append(row);
      }
    }
    renderRequirements();
    return { renderRequirements };
  });

  addTab("포트폴리오", "research-portfolio", view => {
    const portfolio = panel(view, "포트폴리오 자료", "파일과 붙여넣은 글에서 사실 후보를 찾습니다. 가져온 문장은 미확인 상태이며 사실 원장에서 역할과 출처를 검토하세요.");
    const filename = field(portfolio, "출처 이름 또는 파일 경로", research.portfolio?.filename ?? "붙여넣은 포트폴리오"); filename.maxLength = 500;
    const portfolioText = field(portfolio, "포트폴리오 텍스트 붙여넣기", research.portfolio?.kind === "text" ? research.portfolio.pages.map(p => p.text).join("\n") : "", "textarea"); portfolioText.maxLength = 100000;
    const candidatesArea = node("div", null, "form-flow");
    function showPortfolio() {
      candidatesArea.replaceChildren(); const data = workspace.research?.portfolio; if (!data) { candidatesArea.append(node("p", "아직 가져온 포트폴리오 자료가 없습니다.", "empty-message")); return; }
      const candidates = portfolioCandidates(data); const choices = [];
      candidatesArea.append(node("h3", `${data.filename} · ${data.pages.length}쪽 · 후보 ${candidates.length}개`));
      for (const candidate of candidates) { const item = node("div", null, "evidence-preview"); const input = check(item, candidate.text); choices.push({ input, candidate }); reference(item, candidate.span); candidatesArea.append(item); }
      if (candidates.length) button(candidatesArea, "선택한 후보를 사실 원장에 추가", guard(() => {
        const selected = choices.filter(row => row.input.checked); if (!selected.length) throw new Error("가져올 후보를 선택하세요."); let count = 0;
        for (const { input, candidate } of selected) { const source = `${data.filename} · ${candidate.span.page}쪽 · 문자 ${candidate.span.start}–${candidate.span.end}`.slice(0, 500); if (!workspace.facts.some(f => f.text === candidate.text && f.source === source)) { const fact = addFact(workspace, { text: candidate.text, source }); count++; onFact?.(fact); } input.checked = false; }
        onChanged(); jdView.renderRequirements(); tell(`${count}개 후보를 미확인 사실로 추가했습니다. 사실 원장에서 검토하세요.`);
      }), true);
    }
    button(portfolio, "붙여넣은 텍스트 미리보기", guard(() => { if (!portfolioText.value.trim()) throw new Error("포트폴리오 텍스트를 입력하세요."); save({ portfolio: { filename: filename.value.trim() || "붙여넣은 포트폴리오", kind: "text", pages: [{ page: 1, text: portfolioText.value }] } }); showPortfolio(); jdView.renderRequirements(); tell("텍스트를 저장했습니다. 후보의 출처 범위를 확인하세요."); }));
    const file = field(portfolio, "파일 선택 (PDF, MD, TXT, DOCX, HWPX)", "", "file"); file.accept = ".pdf,.md,.txt,.docx,.hwpx";
    const fallback = node("div", null, "temporary-file-notice"); fallback.hidden = true;
    fallback.append(node("p", "이 PDF는 Windows Xpdf 추출을 위해 로컬 임시 파일이 필요합니다. 동의하면 서버가 임시 파일을 생성하고 처리 후 삭제를 시도합니다."));
    const consent = check(fallback, "이 PDF의 로컬 임시 파일 생성을 허용합니다"); let pendingFile = null;
    async function extract(allowTemporaryFile = false) {
      const chosen = allowTemporaryFile ? pendingFile : file.files?.[0]; if (!chosen) throw new Error("파일을 선택하세요.");
      if (chosen.size > 5 * 1024 * 1024) throw new Error("파일 크기는 최대 5MiB입니다.");
      tell("파일을 추출하고 있습니다.");
      try {
        const result = await post("/api/extract", { filename: chosen.name, contentBase64: await base64File(chosen), ...(allowTemporaryFile ? { allowTemporaryFile: true } : {}) });
        save({ portfolio: { filename: chosen.name, kind: result.kind, pages: result.pages } }); pendingFile = null; fallback.hidden = true; consent.checked = false; showPortfolio(); jdView.renderRequirements(); tell(result.warning || "추출했습니다. 후보와 원문 범위를 확인하세요.");
      } catch (error) { if (error.code === "temporary_file_required" && !allowTemporaryFile) { pendingFile = chosen; fallback.hidden = false; consent.checked = false; tell("아래 임시 파일 안내를 확인한 뒤 다시 추출할 수 있습니다."); } else throw error; }
    }
    button(portfolio, "선택 파일 추출 · 미리보기", guard(() => { fallback.hidden = true; consent.checked = false; return extract(); }));
    button(fallback, "동의한 임시 파일 방식으로 다시 추출", guard(() => { if (!consent.checked) throw new Error("임시 파일 생성 안내에 동의해야 합니다."); return extract(true); }));
    portfolio.append(fallback, candidatesArea); showPortfolio();
  });

  addTab("회사 자료", "research-company", view => {
    const official = panel(view, "회사 공식 자료", "회사 또는 채용처가 공개한 원문을 직접 등록합니다. URL과 발췌의 진위는 자동 검증되지 않습니다.");
    const officialLabel = field(official, "자료 이름 (예: 공식 채용 페이지)"); officialLabel.maxLength = 200;
    const officialUrl = field(official, "공식 원문 URL", "", "url");
    const officialText = field(official, "직접 확인한 원문 발췌", "", "textarea"); officialText.maxLength = 50000;
    const sources = node("div", null, "form-flow");
    function renderSources() { sources.replaceChildren(); for (const [index, source] of (workspace.research?.officialSources ?? []).entries()) { const item = node("article", null, "evidence-preview"); item.append(node("h3", source.label)); safeLink(item, source.url, source.url); item.append(node("p", source.text, "plain-output")); button(item, "이 자료 삭제", guard(() => { save({ officialSources: workspace.research.officialSources.filter((_, i) => i !== index) }); renderSources(); })); sources.append(item); } if (!sources.childNodes.length) sources.append(node("p", "등록된 회사 자료가 없습니다.", "empty-message")); }
    button(official, "공식 자료 등록", guard(() => { if (!officialLabel.value.trim() || !officialText.value.trim()) throw new Error("자료 이름과 원문을 입력하세요."); if (!officialUrl.value.trim()) throw new Error("원문 URL을 입력하세요."); save({ officialSources: [...(workspace.research?.officialSources ?? []), { label: officialLabel.value.trim(), url: officialUrl.value.trim(), text: officialText.value }] }); officialLabel.value = officialUrl.value = officialText.value = ""; renderSources(); tell("출처와 발췌문을 저장했습니다."); })); official.append(sources); renderSources();

    const github = panel(view, "GitHub 공개 저장소", "공개 저장소에서 관측한 파일·언어 신호를 확인합니다. 이는 저장소의 관측값이며 개인의 기여나 능력을 증명하지 않습니다.");
    const githubUrl = field(github, "GitHub 공개 저장소 URL", research.github?.url ?? "", "url");
    const githubResult = node("div", null, "form-flow");
    function showGithub() {
      githubResult.replaceChildren(); const value = workspace.research?.github; if (!value) { githubResult.append(node("p", "조회한 저장소 자료가 없습니다.", "empty-message")); return; }
      githubResult.append(node("p", `조회 ${value.retrievedAt} · 커밋 ${value.sha?.slice(0, 12) ?? "미확인"} · 주 언어 ${value.language ?? "미확인"} · 최근 push ${value.pushedAt ?? "미확인"}`, "metadata")); safeLink(githubResult, "저장소 열기", value.url);
      for (const row of value.checks) { const item = node("article", null, "source-observation"); const statusText = ({ present: "확인됨", missing: "찾지 못함", unknown: "미확인" })[row.status] ?? "미확인"; item.append(node("span", statusText, `source-state ${row.status}`), node("strong", row.label)); if (row.path && row.url) safeLink(item, `경로 보기 · ${row.path}`, row.url); else if (row.path) item.append(node("p", `경로 · ${row.path}`, "metadata")); githubResult.append(item); }
    }
    button(github, "공개 저장소 신호 조회", guard(async () => { const value = await post("/api/github", { url: githubUrl.value.trim() }); save({ github: { url: value.url, sha: value.sha ?? null, language: value.language ?? null, pushedAt: value.pushedAt ?? null, retrievedAt: value.retrievedAt, checks: value.checks.map(row => ({ label: row.label, status: row.status, path: row.path ?? null, url: row.url ?? null })) } }); showGithub(); tell("공개 저장소 관측값을 저장했습니다."); })); github.append(githubResult); showGithub();

    const dart = panel(view, "DART 기업 공시", "OpenDART 기업개황은 회사 정보입니다. 지원자의 경험·성과에 대한 근거로 사용하지 않습니다. API 키는 요청에만 쓰고 저장하지 않습니다.");
    const corpCode = field(dart, "DART 고유번호 (8자리)", research.dart?.corpCode ?? ""); corpCode.inputMode = "numeric"; corpCode.maxLength = 8;
    const dartKey = field(dart, "DART API 키", "", "password"); dartKey.autocomplete = "off";
    safeLink(dart, "OpenDART 공식 사이트", "https://opendart.fss.or.kr/");
    const dartResult = node("div", null, "form-flow");
    function showDart() {
      dartResult.replaceChildren();
      const value = workspace.research?.dart;
      if (!value) { dartResult.append(node("p", "조회한 DART 자료가 없습니다.", "empty-message")); return; }
      safeLink(dartResult, `${value.source} · 자료 제공처`, value.url);
      dartResult.append(node("p", `고유번호 ${value.corpCode} · 조회 시각 ${value.retrievedAt}`, "metadata"));
      for (const row of value.fields) dartResult.append(node("p", `${row.label} · ${row.text}`, "plain-output"));
    }
    button(dart, "DART 공시 조회", guard(async () => { const key = dartKey.value.trim(); dartKey.value = ""; if (!key) throw new Error("DART API 키를 입력하세요."); const value = await post("/api/dart", { corpCode: corpCode.value.trim() }, { "X-DART-API-Key": key }); save({ dart: { source: value.source, url: value.url, corpCode: value.corpCode, retrievedAt: value.retrievedAt, fields: value.fields.map(row => ({ label: row.label, text: row.text })) } }); showDart(); tell("DART 기업 자료를 저장했습니다. API 키 입력값은 비웠습니다."); })); dart.append(dartResult); showDart();
  });

  activate(views[0].tab);
}
