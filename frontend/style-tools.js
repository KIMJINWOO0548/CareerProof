import { recordExternalReview } from "./workspace.js";

const esc = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function tokens(text) {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map(match => ({ value: match[0].normalize("NFKC").toLocaleLowerCase("ko-KR"), start: match.index, end: match.index + match[0].length }));
}

export function compareNgrams(draft, reference, size = 4, threshold = 0.2) {
  function windows(text) {
    const words = tokens(text), result = [];
    for (let i = 0; i + size <= words.length; i++) {
      const key = words.slice(i, i + size).map(word => word.value).join(" ");
      result.push({ key, span: { start: words[i].start, end: words[i + size - 1].end } });
    }
    return result;
  }
  const current = windows(draft), source = windows(reference);
  const sourceKeys = new Set(source.map(w => w.key));
  const matches = current.filter(w => sourceKeys.has(w.key));
  const shared = new Set(matches.map(w => w.key));
  const draftSpans = matches.map(w => w.span);
  const sourceSpans = source.filter(w => shared.has(w.key)).map(w => w.span);
  const denominator = current.length, matched = matches.length;
  const ratio = denominator ? matched / denominator : 0;
  return { draftSpans, sourceSpans, denominator, matched, ratio, threshold, thresholdExceeded: denominator > 0 && ratio >= threshold };
}

function marked(text, spans) {
  let cursor = 0;
  const merged = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && last.end >= span.start) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged.reduce((html, span) => {
    html += `${esc(text.slice(cursor, span.start))}<mark>${esc(text.slice(span.start, span.end))}</mark>`;
    cursor = span.end;
    return html;
  }, "") + esc(text.slice(cursor));
}

export function mountStyleTools(container, workspace, question, onChanged) {
  const revisions = question.revisions;
  const selected = revisions.at(-1);
  const panel = document.createElement("details");
  panel.className = "panel action-details";
  panel.innerHTML = `<summary>외부 평가·문장 비교 (선택)</summary>
    <p class="metadata">저장한 편집본만 선택할 수 있습니다. 입력한 점수는 참고 기록이며 내부 점수·추천본·확정 상태에 영향을 주지 않습니다. 비교는 이 브라우저에서만 실행됩니다.</p>
    ${revisions.length ? `<label class="field"><span>저장 리비전</span><select data-revision>${revisions.map((revision, i) => `<option value="${esc(revision.id)}" ${revision === selected ? "selected" : ""}>편집본 ${i + 1} · ${esc(new Date(revision.createdAt).toLocaleDateString("ko-KR"))}</option>`).join("")}</select></label>
      <form data-review-form><label class="field"><span>외부 평가 도구 이름</span><input name="provider" required maxlength="80" placeholder="예: 직접 평가"></label>
      <label class="field"><span>전체 점수 (0–100)</span><input name="score" type="number" min="0" max="100" step="1" required></label>
      <label class="field"><span>문단별 점수 (선택, 쉼표로 구분)</span><input name="paragraphs" inputmode="numeric" placeholder="예: 78, 84"></label>
      <button class="btn secondary" type="submit">선택한 리비전에 기록</button><p data-note-status role="status"></p></form>
      <ul data-reviews class="list-reset"></ul>
      <label class="field"><span>비교할 참고 문장</span><textarea data-reference rows="3" maxlength="12000" placeholder="비교할 문장을 붙여 넣으세요. 저장하거나 전송하지 않습니다."></textarea></label>
      <button class="btn secondary" type="button" data-compare>4단어 연속 일치 비교</button><div data-result aria-live="polite"></div>`
      : `<p class="empty-message">먼저 답변을 저장하면 해당 리비전을 선택해 비교할 수 있습니다.</p>`}`;
  container.append(panel);
  const getRevision = () => revisions.find(item => item.id === panel.querySelector("[data-revision]")?.value);
  const showReviews = () => {
    const list = panel.querySelector("[data-reviews]");
    if (!list) return;
    const revisionId = getRevision()?.id;
    const entries = (workspace.externalReviews ?? []).filter(entry => entry.questionId === question.id && entry.revisionId === revisionId);
    list.innerHTML = entries.length ? entries.map(entry => `<li><span class="badge">${esc(entry.score)} / 100</span> ${esc(entry.provider)} · 문단 ${esc((entry.paragraphScores ?? []).join(", ") || "미입력")} · ${esc(new Date(entry.createdAt).toLocaleString("ko-KR"))}</li>`).join("") : '<li class="metadata">아직 외부 평가 기록이 없습니다.</li>';
  };
  panel.querySelector("[data-revision]")?.addEventListener("change", showReviews);
  const paragraphField = panel.querySelector('[name="paragraphs"]');
  paragraphField?.addEventListener("input", () => paragraphField.setCustomValidity(""));
  panel.querySelector("[data-review-form]")?.addEventListener("submit", event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const raw = String(form.get("paragraphs") || "").trim();
    const paragraphScores = raw ? raw.split(",").map(part => part.trim() ? Number(part.trim()) : NaN) : [];
    if (raw && paragraphScores.some(value => !Number.isInteger(value) || value < 0 || value > 100)) {
      event.currentTarget.querySelector('[name="paragraphs"]').setCustomValidity("0에서 100 사이의 정수를 쉼표로 구분해 입력하세요.");
      event.currentTarget.querySelector('[name="paragraphs"]').reportValidity(); return;
    }
    const revision = getRevision();
    const feedback = event.currentTarget.querySelector("[data-note-status]");
    try {
      recordExternalReview(workspace, question.id, revision.id, { provider: form.get("provider"), score: Number(form.get("score")), paragraphScores });
      event.currentTarget.reset(); showReviews(); onChanged();
      feedback.textContent = "선택한 편집본의 외부 점수를 기록했습니다.";
    } catch (error) { feedback.textContent = error.message; }
  });
  panel.querySelector("[data-compare]")?.addEventListener("click", () => {
    const revision = getRevision();
    const reference = panel.querySelector("[data-reference]").value;
    const result = panel.querySelector("[data-result]");
    if (!reference.trim()) { result.textContent = "비교할 참고 문장을 입력해 주세요."; return; }
    const comparison = compareNgrams(revision.text, reference);
    result.innerHTML = `<p class="metadata">4단어 연속 구간 ${comparison.matched} / ${comparison.denominator}개 일치 (${(comparison.ratio * 100).toFixed(1)}%) · 참고 기준 ${comparison.threshold * 100}% ${comparison.thresholdExceeded ? "도달" : "미도달"}. 단순 텍스트 비교이며 출처·표절 판정이나 문서 전체 범위 점검이 아닙니다.</p>
      <h3>답변에서 겹친 구간</h3><p class="review-body">${marked(revision.text, comparison.draftSpans)}</p>
      <h3>참고 문장에서 겹친 구간</h3><p class="review-body">${marked(reference, comparison.sourceSpans)}</p>`;
  });
  showReviews();
}
