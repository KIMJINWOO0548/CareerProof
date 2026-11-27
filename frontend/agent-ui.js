async function exchange(action, body) {
  const response = await fetch("/api/agent/" + action, {
    method: "POST", cache: "no-store", headers: {"Content-Type": "application/json", "X-CareerProof-Request": "1"},
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(data.error || "연결 요청을 처리할 수 없습니다."), {status: response.status});
  }
  return data;
}

export function terminalCommand(client, port) {
  if (!["codex", "claude"].includes(client)) throw new Error("사용할 CLI를 선택하세요.");
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("로컬 서버 포트를 확인하세요.");
  return `python scripts/careerproof_cli.py ${client}` + (port === "8765" ? "" : " --port " + port);
}

export function openAgentDraft({openDialog, ensureSession, esc, input, onProposal}) {
  const port = window.location.port || "80";
  const previewText = task => [task.question, `최대 ${task.charLimit}자`, ...task.facts.map(fact => `${fact.text}\n근거 ID · ${fact.id}`)].join("\n\n");
  openDialog("내 Codex·Claude로 초안 작성", `<div class="form-flow" data-agent-view>
    <p>선택한 문항과 사실 ${input.facts.length}건으로 초안을 만듭니다. 모델 사용량은 실행하는 AI 계정에 적용됩니다.</p>
    <details><summary>선택한 문항과 사실 보기</summary><p class="plain-output">${esc(previewText(input))}</p></details>
    <label class="field"><span>추가로 가릴 이름·주소 (한 줄에 하나씩)</span><textarea data-redact rows="2"></textarea></label>
    <button type="button" class="btn primary" data-prepare>연결 코드 만들기</button>
    <section data-pair hidden class="form-flow">
      <details><summary>AI가 읽을 내용 확인</summary><p class="plain-output" data-preview></p></details>
      <label class="field"><span>터미널에서 실행할 CLI</span><select data-client><option value="codex">Codex CLI</option><option value="claude">Claude Code CLI</option></select></label>
      <p class="metadata">CareerProof 폴더에서 아래 명령을 실행하고, 코드를 묻는 곳에 붙여넣으세요.</p>
      <pre class="agent-command" data-command></pre>
      <label class="field"><span>이 문항의 연결 코드</span><input data-code readonly autocomplete="off" spellcheck="false"></label>
      <div class="cta-row"><button type="button" class="btn secondary" data-copy>코드 복사</button>
        <button type="button" class="btn primary" data-check>도착한 초안 확인</button></div>
      <details><summary>이미 열린 AI 대화에서 작성하기 (MCP)</summary>
        <p>CareerProof MCP를 등록한 대화에는 아래 요청을 붙여넣으세요. 함께 쓸 개인 작성 스킬이 있다면 요청에 이름을 덧붙이세요.</p>
        <textarea class="agent-message" rows="4" aria-label="MCP 대화 요청" readonly data-invocation></textarea>
      </details>
      <p class="metadata" data-expiry></p>
    </section>
    <p role="status" aria-live="polite" data-note></p>
  </div>`, modal => {
    const view = modal.querySelector("[data-agent-view]");
    const el = name => view.querySelector("[data-" + name + "]");
    const note = message => { el("note").textContent = message; };
    let code = "";
    let closed = false;
    let expiry, poll;
    const revoke = token => exchange("cancel", {code: token}).catch(() => {});
    function reset(message) {
      clearTimeout(expiry);
      clearTimeout(poll);
      code = "";
      el("code").value = el("invocation").value = el("preview").textContent = "";
      el("pair").hidden = true;
      el("prepare").hidden = el("redact").disabled = false;
      note(message);
    }
    function finish() {
      if (closed) return;
      closed = true;
      if (code) void revoke(code);
      reset("");
      view.remove();
      window.removeEventListener("pagehide", finish);
    }
    modal.addEventListener("close", finish, {once: true});
    window.addEventListener("pagehide", finish, {once: true});
    el("client").onchange = () => { el("command").textContent = terminalCommand(el("client").value, port); };
    el("prepare").onclick = async () => {
      el("prepare").disabled = true;
      try {
        await ensureSession();
        if (closed) return;
        const redactTerms = el("redact").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        const data = await exchange("start", {...input, redactTerms});
        if (closed || !modal.open) { await revoke(data.code); return; }
        code = data.code;
        el("preview").textContent = previewText(data.preview);
        el("code").value = code;
        el("invocation").value = `CareerProof의 read_writing_task 도구로 코드 ${code}의 자료와 작성 스킬을 읽고 초안을 작성해 줘. submit_draft로 초안과 사용한 사실 ID를 돌려줘.`;
        el("client").onchange();
        el("prepare").hidden = el("redact").disabled = true;
        el("pair").hidden = false;
        el("expiry").textContent = `이 코드는 ${Math.ceil(data.expiresInSeconds / 60)}분간 유효합니다. 창을 닫으면 연결을 취소합니다.`;
        expiry = setTimeout(() => reset("코드가 만료됐습니다. 새 코드를 만들어 주세요."), data.expiresInSeconds * 1000);
        poll = setTimeout(() => check(false), 2500);
        note("AI로 전달할 내용을 확인한 뒤 코드를 사용하세요.");
        el("client").focus();
      } catch (error) { if (!closed) note(error.message); }
      finally { el("prepare").disabled = false; }
    };
    el("copy").onclick = async () => {
      try { await navigator.clipboard.writeText(code); note("연결 코드를 복사했습니다."); }
      catch { el("code").focus(); el("code").select(); note("선택한 코드를 복사하세요."); }
    };
    async function check(manual) {
      if (closed || !code || el("check").disabled) return;
      clearTimeout(poll);
      const current = code;
      el("check").disabled = true;
      try {
        const result = await exchange("result", {code: current});
        if (closed || current !== code) return;
        if (result.status === "pending") {
          if (manual) note("아직 초안이 도착하지 않았습니다. 도착하면 비교 화면이 열립니다.");
          poll = setTimeout(() => check(false), 2500);
          return;
        }
        if (result.status !== "ready" || typeof result.text !== "string" || !Array.isArray(result.factIds)) {
          throw new Error("응답에서 초안과 근거를 확인할 수 없습니다.");
        }
        onProposal({text: result.text, factIds: result.factIds});
        modal.close();
      } catch (error) {
        if (!closed && current === code) {
          if (error.status === 404) reset("사용 가능한 코드가 없습니다. 새 코드를 만들어 주세요.");
          else note(error.message);
        }
      } finally { el("check").disabled = false; }
    }
    el("check").onclick = () => check(true);
  });
}
