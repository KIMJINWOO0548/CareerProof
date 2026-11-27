import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoop } from '../frontend/loop.js';
import { addFact, addQuestion, approveRevision, confirmFact, createWorkspace, saveRevision } from '../frontend/workspace.js';

const source = '제가 오류 재현을 담당하고 테스트 12건을 작성했습니다.';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function example() {
  const workspace = createWorkspace({ company: '가상 회사', role: '검증' });
  const question = addQuestion(workspace, { title: '시험 경험', limit: 1500 });
  const fact = addFact(workspace, { text: source, source: '가상 시험 기록' });
  confirmFact(workspace, fact.id);
  const base = { text: '', factIds: [fact.id] };
  function config(generate, overrides = {}) {
    return { workspace, question, initial: base, maxIterations: 3, provider: 'ollama', generate, ...overrides };
  }
  function answer(text = source, costUsd = null) {
    return { text, factIds: [fact.id], usage: costUsd == null ? null : { costUsd } };
  }
  return { workspace, question, fact, base, config, answer };
}

test('zero-call target uses an accepted baseline, and preserves both revision pointers', async () => {
  const { config, question, workspace, base } = example();
  const initial = { ...base, text: source + '가'.repeat(300) };
  const saved = saveRevision(workspace, question.id, { ...initial, baseRevisionId: null });
  approveRevision(workspace, question.id, saved.id);
  const loop = createLoop(config(assert.fail, { initial, target: 100 }));
  await loop.start();
  await loop.start();
  assert.equal(loop.state.reason, 'target_reached');
  assert.equal(loop.state.iteration, 0);
  assert.equal(loop.state.best.text, initial.text);
  assert.equal(question.approvedRevisionId, saved.id);
  assert.equal(question.headRevisionId, saved.id);
  assert.equal(question.revisions.length, 1);
  assert.deepEqual(loop.state.events.map(e => e.seq), [1, 2, 3]);
});

test('short text abstains, bounded calls reuse the best, and a worse result cannot overwrite it', async () => {
  const { config, base, answer } = example();
  const calls = [];
  const loop = createLoop(config(async input => {
    calls.push(input);
    return calls.length === 1 ? answer() : answer('재현을 하면서 이를 통해 배웠습니다.');
  }, { maxIterations: 2, target: 100, initial: { ...base, text: '사실과 다른 99건을 작성했습니다.' } }));
  await loop.start();
  assert.equal(calls[0].previous, null);
  assert.equal(calls[1].previous.text, source);
  assert.equal(loop.state.best.text, source);
  assert.ok(loop.state.best.score.abstain);
  assert.equal(loop.state.reason, 'max_iter');
  assert.equal(loop.state.events.at(-2).reason, 'no_improvement');
});

test('length, evidence and preservation gates reject model suggestions before promotion', async () => {
  const { config, fact, answer } = example();
  for (const [reason, candidate] of [
    ['length', answer(source + '가'.repeat(1600))],
    ['evidence', answer('시험 13건을 작성했습니다.')],
    ['preservation', { ...answer(), factIds: [fact.id, 'F-unknown'] }],
    ['preservation', { ...answer(), factIds: [] }],
    ['invalid_candidate', { ...answer(), text: '' }],
  ]) {
    const loop = createLoop(config(async () => candidate, { maxIterations: 1 }));
    await loop.start();
    assert.equal(loop.state.best, null);
    assert.equal(loop.state.events.find(e => e.type === 'gate_rejected').reason, reason);
  }
});

test('a cited fact must share a concrete cue and novel names or identifiers need a source', async () => {
  const { workspace, config, fact, base, answer } = example();
  const peer = addFact(workspace, { text: '데이터 이관 작업을 담당하고 보고서를 작성했습니다.', source: '가상 이관 기록' });
  confirmFact(workspace, peer.id);
  for (const candidate of [
    answer('NASA에서 오류를 재현했습니다.'),
    answer('오류를 재현하며 React를 적용했습니다.'),
    answer('오류를 재현하며 agentQueue를 수정했습니다.'),
  ]) {
    const loop = createLoop(config(async () => candidate, { maxIterations: 1, initial: { ...base, text: source } }));
    await loop.start();
    assert.equal(loop.state.best.text, source);
    assert.ok(loop.state.events.some(e => e.type === 'gate_rejected' && e.reason === 'evidence'));
  }
  const ids = [fact.id, peer.id];
  const run = createLoop(config(async () => ({ text: source, factIds: ids }),
    { initial: { text: '', factIds: ids }, maxIterations: 1 }));
  await run.start();
  assert.equal(run.state.best, null);
  assert.ok(run.state.events.some(e => e.type === 'gate_rejected' && e.reason === 'preservation'));
});

test('original words, Korean case-ending changes, synonym cues, and named tools from facts are accepted', async () => {
  const { workspace, config } = example();
  const fact = addFact(workspace, { text: 'React 화면의 결함을 검사했습니다.', source: '가상 장애 기록' });
  confirmFact(workspace, fact.id);
  const factIds = [fact.id];
  for (const text of ['React 화면의 결함을 검사했습니다.', '결함이 나타나는 상황을 살폈습니다.',
    '버그를 다시 일으켜 원인을 좁혔습니다.', 'React에 재현 절차를 적용했습니다.']) {
    const run = createLoop(config(async () => ({ text, factIds }), { initial: { text: '', factIds }, maxIterations: 1 }));
    await run.start();
    assert.equal(run.state.best?.text, text);
  }
});

test('two unsupported claims pause for input; an explicitly confirmed new fact can resume', async () => {
  const { config, base, answer, workspace, question } = example();
  const proposals = [];
  const loop = createLoop(config(async input => {
    proposals.push(input);
    return proposals.length <= 2 ? answer('시험 14건을 작성했습니다.')
      : { text: input.facts.map(f => f.text).join(' '), factIds: input.facts.map(f => f.id) };
  }));
  await loop.start();
  assert.equal(loop.state.phase, 'paused');
  assert.equal(loop.state.reason, 'needs_user_input');
  assert.equal(loop.state.best, null);
  assert.ok(loop.state.questions.length >= 1 && loop.state.questions.length <= 3);
  await assert.rejects(loop.resume(base, null), { code: 'needs_user_input' });
  const head = saveRevision(workspace, question.id, { ...base, baseRevisionId: null }).id;
  await assert.rejects(loop.resume(base, head), { code: 'needs_user_input' });
  const extra = addFact(workspace, { text: '시험 14건을 추가로 재현했습니다.', source: '추가 시험 기록' });
  const next = { text: '', factIds: [...base.factIds, extra.id] };
  await assert.rejects(loop.resume(next, head), { code: 'unverified_fact' });
  confirmFact(workspace, extra.id);
  await loop.resume(next, head);
  assert.equal(loop.state.reason, 'max_iter');
  assert.deepEqual(loop.state.best.factIds, next.factIds);
  assert.equal(proposals.length, 3);
  assert.equal(proposals[1].previous, null);
});

test('pause waits for in-flight response; stale resume fails and a saved user edit becomes the working input', async () => {
  const { config, base, workspace, question, answer } = example();
  const first = deferred();
  const calls = [];
  const loop = createLoop(config(async input => {
    calls.push(input);
    return calls.length === 1 ? first.promise : answer();
  }, { maxIterations: 2 }));
  const active = loop.start();
  loop.pause();
  assert.equal(loop.state.phase, 'pausing');
  assert.equal(calls[0].signal.aborted, false);
  first.resolve(answer());
  await active;
  assert.equal(loop.state.phase, 'paused');
  assert.equal(calls.length, 1);
  assert.equal(loop.state.best.text, source);
  const edit = { ...base, text: source + ' 동료와 기록을 읽었습니다.' };
  const revision = saveRevision(workspace, question.id, { ...edit, baseRevisionId: null });
  await assert.rejects(loop.resume(edit, null), { code: 'stale_revision' });
  assert.equal(calls.length, 1);
  await loop.resume(edit, revision.id);
  assert.equal(calls[1].previous.text, edit.text);
  assert.equal(question.headRevisionId, revision.id);
  assert.equal(question.approvedRevisionId, null);
  assert.equal(loop.state.reason, 'max_iter');
});

test('stop and cancel discard late outputs while settling actual paid usage exactly once', async () => {
  for (const action of ['stop', 'cancel']) {
    const { config, base, answer } = example();
    const first = deferred();
    let signal;
    const loop = createLoop(config(input => { signal = input.signal; return first.promise; },
      { provider: 'anthropic', budgetUsd: '0.03', initial: { ...base, text: '시험을 준비했습니다.' } }));
    const active = loop.start();
    const baseline = loop.state.best;
    loop[action]();
    assert.ok(signal.aborted);
    first.resolve(answer(source, '0.002517'));
    await active;
    assert.equal(loop.state.phase, action === 'stop' ? 'completed' : 'cancelled');
    assert.equal(loop.state.best, baseline);
    assert.equal(loop.state.spentUsd, 0.002517);
    assert.equal(loop.state.usagePending, false);
    assert.equal(loop.state.events.filter(e => e.type === 'budget_update').length, 1);
  }
});

test('cloud calls receive remaining budget in whole microdollars, then stop before another call', async () => {
  const { config, answer } = example();
  const budgets = [];
  const loop = createLoop(config(async input => {
    budgets.push(input.remainingUsd);
    return answer(source, budgets.length === 1 ? '0.002517' : '0.007483');
  }, { provider: 'anthropic', budgetUsd: 0.01, maxIterations: 5 }));
  await loop.start();
  assert.deepEqual(budgets, [0.01, 0.007483]);
  assert.equal(loop.state.reason, 'budget_limit');
  assert.equal(loop.state.spentUsd, 0.01);
  await assert.rejects(loop.resume({ text: source, factIds: [] }, null), { code: 'budget_limit' });
});

test('unknown paid outcome blocks resume, known-charge failure accounts before explicit retry', async () => {
  const { config, base, answer } = example();
  const cloud = { provider: 'anthropic', budgetUsd: '0.02' };
  for (const generate of [
    async () => { throw Error('connection lost'); },
    async () => answer(source),
    async () => answer(source, 'not known'),
  ]) {
    const loop = createLoop(config(generate, cloud));
    await loop.start();
    assert.equal(loop.state.reason, 'cost_unknown');
    assert.equal(loop.state.usageUnknown, true);
    await assert.rejects(loop.resume(base, null), { code: 'cost_unknown' });
    assert.equal(loop.state.iteration, 1);
  }
  const calls = [];
  const loop = createLoop(config(async input => {
    calls.push(input);
    if (calls.length === 1) throw Object.assign(Error('invalid candidate'), {
      code: 'provider_error', usage: { costUsd: '0.001001' },
    });
    return answer(source, '0.003333');
  }, { ...cloud, maxIterations: 2 }));
  await loop.start();
  assert.equal(loop.state.reason, 'provider_error');
  assert.equal(loop.state.spentUsd, 0.001001);
  assert.equal(calls.length, 1);
  await loop.resume(base, null);
  assert.equal(calls[1].remainingUsd, 0.018999);
  assert.equal(loop.state.spentUsd, 0.004334);
});

test('stagnation follows specificity deficit, score stagnation with detailed facts terminates', async () => {
  const { config, base, answer } = example();
  const vague = '재현을 하면서 이를 통해 배웠습니다.';
  const loop = createLoop(config(async () => answer(vague), { maxIterations: 5 }));
  await loop.start();
  assert.equal(loop.state.iteration, 3);
  assert.equal(loop.state.reason, 'needs_user_input');
  const complete = createLoop(config(async () => answer(), { initial: { ...base, text: source }, maxIterations: 5 }));
  await complete.start();
  assert.equal(complete.state.iteration, 2);
  assert.equal(complete.state.reason, 'stagnated');
});

test('local admission failures are uncharged; an in-progress paid attempt has unknown usage', async () => {
  const { config } = example();
  for (const [code, status, reason] of [
    ['provider_busy', 409, 'provider_error'], ['receipt_capacity', 503, 'provider_error'],
    ['request_conflict', 409, 'invalid_request'], ['request_in_progress', 409, 'cost_unknown'],
  ]) {
    const loop = createLoop(config(async () => { throw Object.assign(Error(), { code, status }); },
      { provider: 'anthropic', budgetUsd: 0.01 }));
    await loop.start();
    assert.equal(loop.state.reason, reason);
    assert.equal(loop.state.spentUsd, 0);
    assert.equal(loop.state.usageUnknown, code === 'request_in_progress');
  }
});

test('old head arriving during a call cannot promote a stale candidate', async () => {
  const { config, question, workspace, base, answer } = example();
  const first = deferred();
  const loop = createLoop(config(() => first.promise));
  const active = loop.start();
  saveRevision(workspace, question.id, { ...base, text: source, baseRevisionId: null });
  first.resolve(answer());
  await active;
  assert.equal(loop.state.best, null);
  assert.equal(loop.state.reason, 'needs_user_input');
  assert.equal(loop.state.iteration, 1);
});

test('a changed question rule pauses at the boundary and a revoked fact cannot satisfy an initial target', async () => {
  const { config, base, fact, question, answer } = example();
  const first = deferred();
  const run = createLoop(config(() => first.promise));
  const active = run.start();
  question.rule.maxChars = 5;
  first.resolve(answer());
  await active;
  assert.equal(run.state.reason, 'needs_user_input');
  assert.equal(run.state.best, null);
  const initial = { ...base, text: source + '가'.repeat(300) };
  const invalidated = createLoop(config(assert.fail, { initial, target: 100 }));
  fact.verified = false;
  await assert.rejects(invalidated.start(), { code: 'stale_revision' });
  assert.equal(invalidated.state.best, null);
});
