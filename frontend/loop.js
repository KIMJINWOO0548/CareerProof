import { scoreText } from './analysis.js';
import { checkApproval } from './workspace.js';

const feedbackFor = {
  length: '문항의 문자·바이트·줄 제한을 확인하고 답변을 줄여 주세요.',
  evidence: '확인한 사실에 있는 수치·단위·이름·기술명만 사용해 주세요.',
  preservation: '선택한 사실마다 대조할 수 있는 구체 표현을 본문에 남기고 해당 ID를 반환하세요.',
  no_improvement: '근거에서 확인할 수 있는 행동·역할·제약·결과를 구체적으로 서술하세요.',
  invalid_candidate: '비어 있지 않은 답변과 연결한 사실 ID 목록을 반환하세요.',
};
const fallbackQuestions = [
  '실제로 맡은 역할이나 행동을 뒷받침할 수 있는 기록이 있나요?',
  '측정 조건과 결과를 확인할 수 있는 근거가 있나요?',
];
const providerReasons = new Set(['key_required', 'budget_limit', 'invalid_request', 'provider_error', 'cost_unknown']);
const blockedResume = new Set(['budget_limit', 'invalid_request', 'cost_unknown']);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

// The pinned price table is denominated in whole microdollars per token.
function microdollars(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) return null;
  const scaled = Number(value) * 1_000_000;
  const amount = Math.round(scaled);
  if (!Number.isSafeInteger(amount) || scaled < 0 || Math.abs(scaled - amount) > 0.000001) return null;
  return amount;
}

function selectedFacts(workspace, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 40 || new Set(ids).size !== ids.length)
    fail('missing_evidence', '확인한 사실을 1~40건 선택해 주세요.');
  return ids.map(id => {
    const fact = workspace.facts.find(item => item.id === id && item.verified);
    if (!fact) fail('unverified_fact', '선택한 근거가 확인된 상태인지 원장에서 확인해 주세요.');
    return { id, text: fact.text, verified: true };
  });
}

// Match conservative surface cues. Generic activities shared by many resumes give no evidence.
const genericCues = new Set((
  '제가 저는 직접 당시 위해 통해 해당 대해 관련 이러 그러 가장 새로 함께 스스로 우리 이후 이전 바탕 ' +
  '프로젝트 업무 경험 팀원 역할 담당 책임 수행 참여 진행 기여 활동 활용 사용 기록 작성 도입 확인 ' +
  '성공 성과 결과 성장 공유 완료 실행 개발 구현 적용 해결 개선 노력 기술 역량 지원 상황 과정 부분 목적 ' +
  '정리 관리 분석 검토 계획 비교 점검 준비 학습 진행 기획 설계 협업 방법 사례 내용 기간 시간 사용 방식 ' +
  'i we a an and or of the to for my our in on by as is was with from at project team work done ms s mb gb kb'
).split(/\s+/));
const cueAliases = new Map([['시험', '테스트'], ['에러', '오류'], ['버그', '결함'], ['문서화', '문서']]);
const latinTokens = /[A-Za-z][A-Za-z0-9]*(?:(?:[._/-][A-Za-z0-9]+)|(?:[+#]+[0-9]*))*/gu;
const lowerCaseTools = new Set(['react', 'vue', 'angular', 'svelte', 'python', 'java', 'kotlin', 'swift',
  'ruby', 'rust', 'git', 'github', 'gitlab', 'docker', 'kubernetes', 'redis', 'mysql', 'postgresql', 'linux']);
const particle = /(?:으로부터|에게서|에서도|에서는|으로는|에서|에게|부터|까지|처럼|으로|에는|과의|와의|은|는|이|가|을|를|에|로|와|과|도|만|의)$/u;
const actionEnding = /(?:하였습니다|했습니다|하겠습니다|하였으며|했으며|하였고|합니다|하였다|했다|했어요|하며|하여|해서|하고|했고|하는|하던|했던|하기|했을|한|해)$/u;

function words(text) {
  return text.normalize('NFKC').match(latinTokens) ?? [];
}

function contentCues(text) {
  const cues = new Set(words(text).map(w => w.toLowerCase()).filter(w => !genericCues.has(w)));
  for (const matched of text.normalize('NFKC').match(/[가-힣]+/gu) ?? []) {
    const stem = matched.replace(particle, '').replace(actionEnding, '');
    if (/^(?:배우|배웠|있습니|있었|했습니|합니|하였|했으며|됩니다|위하|이러한|그래서)/u.test(stem)) continue;
    if (stem.length >= 2 && !genericCues.has(stem)) cues.add(cueAliases.get(stem) ?? stem);
  }
  return cues;
}

function groundedSurface(text, facts) {
  const known = new Set(facts.flatMap(f => words(f.text)).map(w => w.toLowerCase()));
  for (const word of words(text)) {
    const named = /[A-Z].*[A-Z]|^[A-Z][a-z]{2,}|[a-z][A-Z]|[0-9._/+#-]/u.test(word)
      || lowerCaseTools.has(word.toLowerCase());
    if (named && !known.has(word.toLowerCase())) return 'evidence';
  }
  const written = contentCues(text);
  if (facts.some(f => ![...contentCues(f.text)].some(token => written.has(token)))) return 'preservation';
  return null;
}

function gate(candidate, question, facts, generated = false) {
  if (!candidate || typeof candidate.text !== 'string' || !candidate.text.trim()
      || !Array.isArray(candidate.factIds) || candidate.text.length > 50000)
    return { reason: 'invalid_candidate' };
  const ids = new Set(candidate.factIds);
  if (ids.size !== facts.length || ids.size !== candidate.factIds.length || facts.some(f => !ids.has(f.id)))
    return { reason: 'preservation' };
  try {
    checkApproval({ facts }, question, candidate);
  } catch (error) {
    return { reason: error.code === 'count_limit' ? 'length' : 'evidence' };
  }
  if (generated) {
    const reason = groundedSurface(candidate.text, facts);
    if (reason) return { reason };
  }
  const score = scoreText(candidate.text, { kind: question.kind, facts });
  return { candidate: { text: candidate.text, factIds: [...candidate.factIds], score } };
}

function improves(candidate, best) {
  if (!best) return true;
  const next = candidate.score, old = best.score;
  const moreSpecific = next.axes.specificity_deficit < old.axes.specificity_deficit;
  if (next.abstain || old.abstain) {
    // A short answer can gain evidence. Cosmetic edits alone cannot promote it.
    if (!moreSpecific && next.factIds.length <= old.factIds.length) return false;
  }
  return next.total < old.total || (next.total === old.total && moreSpecific);
}

function providerReason(error, cloud) {
  if (error?.code === 'provider_busy' || error?.code === 'receipt_capacity') return 'provider_error';
  if (error?.code === 'request_conflict') return 'invalid_request';
  if (error?.code === 'request_in_progress') return cloud ? 'cost_unknown' : 'provider_error';
  if (providerReasons.has(error?.code)) return error.code;
  if (error?.status === 401 || error?.status === 403) return 'key_required';
  if (error?.status === 429) return 'provider_error';
  return cloud ? 'cost_unknown' : 'provider_error';
}

function copyDraft(draft) {
  return draft ? { text: draft.text, factIds: [...draft.factIds] } : null;
}

/** One tab coordinates bounded requests. Proposals never change editor or approval pointers. */
export function createLoop({ workspace, question, initial, maxIterations, target = null,
  budgetUsd, provider, generate, onChange = () => {} }) {
  const cloud = provider === 'anthropic';
  const limit = cloud ? microdollars(budgetUsd) : 0;
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 10
      || (target !== null && (!Number.isInteger(target) || target < 0 || target > 100))
      || !['ollama', 'anthropic'].includes(provider) || (cloud && (!limit || limit > 1_000_000))
      || !['self_intro', 'career_desc'].includes(question.kind) || typeof initial?.text !== 'string')
    fail('invalid_request', '반복 횟수(1~10), 목표 점수, 문서 종류와 실행 예산을 확인해 주세요.');
  let facts = selectedFacts(workspace, initial.factIds);
  let editingBase = copyDraft(initial);
  let head = question.headRevisionId;
  const questionSnapshot = () => JSON.stringify([question.title, question.kind, question.rule]);
  let pinnedQuestion = questionSnapshot();
  let awaitingRebase = false;
  let working = null;
  let feedback = [];
  let spent = 0;
  let generation = 0;
  let pending = null;
  let stalled = 0;
  let evidenceFailures = 0;
  let state = { phase: 'idle', reason: null, iteration: 0, maxIterations, target,
    best: null, spentUsd: 0, budgetUsd: cloud ? limit / 1_000_000 : null,
    usageUnknown: false, usagePending: false, questions: [], events: [] };

  function emit(type, patch = {}, reason = null) {
    state = { ...state, ...patch };
    const event = { seq: state.events.length + 1, type, iteration: state.iteration };
    if (reason) event.reason = reason;
    if (type === 'run_state') event.phase = state.phase;
    state.events = [...state.events, event];
    onChange(state);
  }

  function move(phase, reason = null) {
    emit('run_state', { phase, reason }, reason);
  }

  function askForEvidence() {
    const questions = state.best?.score.questions.length ? state.best.score.questions : fallbackQuestions;
    emit('needs_user_input', { questions: questions.slice(0, 3) });
    if (state.phase === 'running') move('paused', 'needs_user_input');
  }

  function changedHeadOrFacts() {
    return question.headRevisionId !== head || questionSnapshot() !== pinnedQuestion || facts.some(fact =>
      !workspace.facts.some(live => live.verified && live.id === fact.id && live.text === fact.text));
  }

  function requireRebase() {
    awaitingRebase = true;
    if (state.phase === 'pausing') move('paused', 'user');
    else askForEvidence();
  }

  function atBoundary() {
    if (state.phase === 'pausing') move('paused', 'user');
    if (state.phase !== 'running') return true;
    const score = state.best?.score;
    if (target !== null && score && !score.abstain && score.total <= target) move('completed', 'target_reached');
    else if (state.iteration >= maxIterations) move('completed', 'max_iter');
    else if (cloud && spent >= limit) move('paused', 'budget_limit');
    else if (evidenceFailures >= 2) askForEvidence();
    else if (stalled >= 2) {
      const axes = score?.axes;
      if (!axes || (axes.specificity_deficit > 0 && axes.specificity_deficit >= Math.max(axes.cliche, axes.pattern)))
        askForEvidence();
      else move('completed', 'stagnated');
    }
    return state.phase !== 'running';
  }

  function consider(result) {
    const previous = state.best;
    const better = result.candidate && improves(result.candidate, previous);
    const reason = result.reason ?? 'no_improvement';
    evidenceFailures = ['evidence', 'preservation'].includes(reason) ? evidenceFailures + 1 : 0;
    if (better) {
      const score = result.candidate.score;
      const smallGain = previous && !score.abstain && previous.score.total - score.total < 2;
      stalled = smallGain ? stalled + 1 : 0;
      working = result.candidate;
      feedback = score.questions.slice(0, 3);
      emit('best_updated', { best: result.candidate });
    } else {
      stalled++;
      feedback = [feedbackFor[reason]];
      emit('gate_rejected', {}, reason);
    }
  }

  function settle(usage, errorReason = null) {
    if (!cloud) return errorReason;
    const cost = microdollars(usage?.costUsd);
    if (cost !== null && Number.isSafeInteger(spent + cost)) {
      spent += cost;
      emit('budget_update', { spentUsd: spent / 1_000_000, usagePending: false }, 'settled');
    } else if (!errorReason || errorReason === 'cost_unknown' || usage != null) {
      emit('budget_update', { usageUnknown: true, usagePending: false }, 'cost_unknown');
      return 'cost_unknown';
    } else {
      emit('budget_update', { usagePending: false }, 'settled');
    }
    return errorReason;
  }

  async function run(initialEvent = null) {
    const epoch = ++generation;
    move('running');
    if (initialEvent && epoch === generation) emit(initialEvent.type, {}, initialEvent.reason);
    while (epoch === generation) {
      if (atBoundary() || epoch !== generation) return;
      if (changedHeadOrFacts()) { requireRebase(); return; }
      const abort = new AbortController();
      pending = abort;
      emit('iteration_start', { iteration: state.iteration + 1, usagePending: cloud });
      // onChange may stop or pause before dispatch.
      if (epoch !== generation || state.phase !== 'running') {
        if (pending === abort) pending = null;
        if (cloud) settle(null, 'provider_error');
        atBoundary();
        return;
      }
      let response;
      let failure = null;
      try {
        response = await generate({
          previous: copyDraft(working), facts: facts.map(({ id, text }) => ({ id, text })),
          question: question.title, remainingUsd: (limit - spent) / 1_000_000,
          iteration: state.iteration, signal: abort.signal, feedback: [...feedback],
        });
      } catch (error) {
        failure = settle(error?.usage, providerReason(error, cloud));
      } finally {
        if (pending === abort) pending = null;
      }
      if (!failure) failure = settle(response?.usage);
      if (epoch !== generation) return;
      if (failure) { move('paused', failure); return; }
      if (changedHeadOrFacts()) { requireRebase(); return; }
      consider(gate(response, question, facts, true));
    }
  }

  return {
    get state() { return state; },
    async start() {
      if (state.phase !== 'idle') return;
      if (changedHeadOrFacts()) fail('stale_revision', '편집 기준이 바뀌었습니다. 최신 문항과 근거를 확인해 주세요.');
      const checked = gate(editingBase, question, facts);
      let event = null;
      if (checked.candidate) {
        working = checked.candidate;
        feedback = working.score.questions.slice(0, 3);
        state = { ...state, best: working };
        event = { type: 'best_updated' };
      } else if (editingBase.text.trim()) {
        feedback = [feedbackFor[checked.reason]];
        event = { type: 'gate_rejected', reason: checked.reason };
      }
      return run(event);
    },
    pause() {
      if (state.phase === 'running') move('pausing');
    },
    async resume(edit, baseRevisionId) {
      if (state.phase !== 'paused') fail('invalid_transition', '일시 정지한 실행에서 재개할 수 있습니다.');
      if (state.usageUnknown || blockedResume.has(state.reason))
        fail(state.reason, '사용 내역과 실행 설정을 확인하고 새 실행을 시작해 주세요.');
      if (question.headRevisionId !== baseRevisionId)
        fail('stale_revision', '편집 기준이 바뀌었습니다. 최신 답변을 확인해 주세요.');
      if (typeof edit?.text !== 'string') fail('invalid_request', '재개할 편집본을 확인해 주세요.');
      const nextFacts = selectedFacts(workspace, edit.factIds);
      const selectionChanged = nextFacts.length !== facts.length ||
        nextFacts.some(f => !facts.some(prev => prev.id === f.id && prev.text === f.text));
      const edited = edit.text !== editingBase.text || selectionChanged || questionSnapshot() !== pinnedQuestion;
      if (state.reason === 'needs_user_input' && !edited && !awaitingRebase)
        fail('needs_user_input', '보강 질문에 맞춰 원고를 수정하거나 새로 확인한 사실을 연결해 주세요.');
      const checked = gate(edit, question, nextFacts);
      if (edited && edit.text.trim() && checked.reason)
        fail(checked.reason, feedbackFor[checked.reason]);
      facts = nextFacts;
      head = baseRevisionId;
      pinnedQuestion = questionSnapshot();
      awaitingRebase = false;
      let event = null;
      if (edited) {
        const retained = state.best && gate(state.best, question, facts).candidate;
        const newlyBest = checked.candidate && improves(checked.candidate, retained);
        working = checked.candidate ?? retained ?? null;
        const best = newlyBest ? checked.candidate : retained ?? null;
        state = { ...state, best };
        if (newlyBest) event = { type: 'best_updated' };
        feedback = working?.score.questions.slice(0, 3) ?? [];
        editingBase = copyDraft(edit);
        stalled = 0;
        evidenceFailures = 0;
      }
      state = { ...state, questions: [] };
      return run(event);
    },
    stop() {
      if (!['running', 'pausing', 'paused'].includes(state.phase)) return;
      generation++;
      pending?.abort();
      move('completed', 'user_stop');
    },
    cancel() {
      if (!['running', 'pausing', 'paused'].includes(state.phase)) return;
      generation++;
      pending?.abort();
      move('cancelled', 'cancelled');
    },
  };
}
