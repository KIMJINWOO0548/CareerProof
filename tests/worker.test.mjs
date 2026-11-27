import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { addFact, addQuestion, confirmFact, createWorkspace, recordExternalReview, saveRevision } from '../frontend/workspace.js';

const workerFile = fileURLToPath(new URL('../backend/worker.mjs', import.meta.url));
const sample = '통신 오류를 재현하고 시험 12건을 작성했습니다.';

function setup() {
  const workspace = createWorkspace({ company: '가상 제어', role: '검증' });
  const q = addQuestion(workspace, { title: '시험 경험', limit: 800 });
  const fact = addFact(workspace, { text: sample, source: '가상 시험 원장' });
  confirmFact(workspace, fact.id);
  const initial = { text: '', factIds: [fact.id] };
  const start = { type: 'start', commandId: 'start', workspace, questionId: q.id, initial,
    provider: 'ollama', maxIterations: 2, target: null };
  return { workspace, q, fact, initial, start };
}

function run(t) {
  const proc = spawn(process.execPath, [workerFile], { windowsHide: true });
  const lines = createInterface({ input: proc.stdout });
  const received = [];
  let stderr = '';
  proc.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
  lines.on('line', line => received.push(JSON.parse(line)));
  const closed = once(proc, 'close');
  t.after(() => {
    if (proc.exitCode === null && !proc.killed) proc.kill();
    assert.equal(stderr, '');
  });
  async function get(predicate) {
    const signal = AbortSignal.timeout(6000);
    while (!received.some(predicate)) {
      assert.equal(proc.exitCode, null, 'worker exited before the expected frame');
      await once(lines, 'line', { signal });
    }
    return received.splice(received.findIndex(predicate), 1)[0];
  }
  return {
    send(frame) { proc.stdin.write(JSON.stringify(frame) + '\n'); },
    get,
    ack(id) { return get(frame => frame.type === 'ack' && frame.commandId === id); },
    state(phase) { return get(frame => frame.type === 'state' && frame.state.phase === phase); },
    generated() { return get(frame => frame.type === 'generate'); },
    close: closed,
  };
}

function checkpoint(frame) {
  const result = spawnSync(process.execPath, [workerFile, '--checkpoint'], {
    input: typeof frame === 'string' ? frame : JSON.stringify(frame),
    encoding: 'utf8', windowsHide: true, timeout: 6000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('server worker applies the same gate and accepts pause and an appended edit while preserving old snapshots', async t => {
  const { workspace, q, fact, initial, start } = setup();
  const worker = run(t);
  worker.send(start);
  assert.equal((await worker.ack('start')).ok, true);
  const first = await worker.generated();
  assert.equal(first.payload.previous, null);
  worker.send({ type: 'pause', commandId: 'pause' });
  assert.equal((await worker.ack('pause')).ok, true);
  await worker.state('pausing');
  worker.send({ type: 'resume', commandId: 'too-soon', workspace, initial, baseRevisionId: null });
  assert.equal((await worker.ack('too-soon')).code, 'invalid_transition');
  worker.send({ type: 'result', callId: first.callId, result: { text: sample, factIds: [fact.id], usage: null } });
  assert.equal((await worker.state('paused')).state.best.text, sample);

  const discarded = structuredClone(workspace);
  addFact(discarded, { text: '채택되지 않은 경험', source: '가상 원장' });
  worker.send({ type: 'resume', commandId: 'failed-edit', workspace: discarded,
    initial: { text: '', factIds: [discarded.facts.at(-1).id] }, baseRevisionId: null });
  assert.equal((await worker.ack('failed-edit')).code, 'unverified_fact');
  const edit = { text: '통신 오류를 확인했습니다.', factIds: [fact.id] };
  const saved = saveRevision(workspace, q.id, { ...edit, baseRevisionId: null });
  worker.send({ type: 'resume', commandId: 'stale', workspace, initial: edit, baseRevisionId: null });
  assert.equal((await worker.ack('stale')).code, 'stale_revision');
  worker.send({ type: 'resume', commandId: 'resume', workspace, initial: edit, baseRevisionId: saved.id });
  assert.equal((await worker.ack('resume')).ok, true);
  const second = await worker.generated();
  assert.equal(second.payload.previous.text, edit.text);
  assert.notEqual(first.callId, second.callId);
  worker.send({ type: 'result', callId: first.callId, result: { text: '이전 응답' } });
  worker.send({ type: 'result', callId: second.callId, result: {
    text: '통신 오류를 재현하고 시험 13건을 작성했습니다.', factIds: [fact.id], usage: null,
  } });
  const last = (await worker.state('completed')).state;
  assert.equal(last.reason, 'max_iter');
  assert.equal(last.best.text, sample);
  assert.ok(last.events.some(e => e.type === 'gate_rejected' && e.reason === 'evidence'));
  assert.deepEqual(await worker.close, [0, null]);
});

test('server worker can cancel an outstanding cloud call and still settle its late usage exactly once', async t => {
  const { start, fact } = setup();
  const worker = run(t);
  worker.send({ ...start, provider: 'anthropic', budgetUsd: '0.01' });
  assert.equal((await worker.ack('start')).ok, true);
  const call = await worker.generated();
  worker.send({ type: 'cancel', commandId: 'cancel' });
  assert.equal((await worker.ack('cancel')).ok, true);
  assert.equal((await worker.state('cancelled')).state.usagePending, true);
  worker.send({ type: 'result', callId: call.callId, result: { text: sample, factIds: [fact.id], usage: { costUsd: '0.002105' } } });
  const settled = (await worker.get(frame => frame.type === 'state' && frame.state.phase === 'cancelled' && !frame.state.usagePending)).state;
  assert.equal(settled.spentUsd, 0.002105);
  assert.equal(settled.best, null);
  assert.deepEqual(await worker.close, [0, null]);
});

test('a zero-call target closes the worker only after the completed snapshot and command acknowledgement', async t => {
  const { start, initial } = setup();
  const worker = run(t);
  worker.send({ ...start, target: 100, initial: { ...initial, text: sample + '가'.repeat(310) } });
  assert.equal((await worker.ack('start')).ok, true);
  const final = (await worker.state('completed')).state;
  assert.equal(final.reason, 'target_reached');
  assert.equal(final.iteration, 0);
  assert.deepEqual(await worker.close, [0, null]);
});

test('one-shot editing and approval use the immutable revision chain and the existing approval gates', () => {
  const { workspace, q, initial } = setup();
  const first = { kind: 'edit', previous: workspace, workspace, questionId: q.id, baseRevisionId: null,
    initial: { ...initial, text: sample } };
  const edit = checkpoint(first);
  assert.equal(edit.ok, true);
  const head = edit.workspace.questions[0].headRevisionId;
  const approve = { kind: 'approve', previous: edit.workspace, workspace: edit.workspace, questionId: q.id,
    baseRevisionId: head, revisionId: head };
  const approved = checkpoint(approve);
  assert.equal(approved.workspace.questions[0].approvedRevisionId, head);
  assert.equal(approved.workspace.questions[0].revisions.length, 1);
  assert.equal(checkpoint({ ...approve, baseRevisionId: null }).code, 'stale_revision');
  const bad = checkpoint({ ...first, initial: { ...initial, text: '시험 88건을 작성했습니다.' } }).workspace;
  const invalidHead = bad.questions[0].headRevisionId;
  const rejected = checkpoint({ ...approve, previous: bad, workspace: bad, revisionId: invalidHead, baseRevisionId: invalidHead });
  assert.equal(rejected.code, 'unsupported_number');
  assert.ok(!rejected.message.includes('88'));
});

test('a checkpoint refuses replacement of project history or the approval pointer and never echoes malformed JSON', () => {
  const { workspace, q, initial, fact } = setup();
  const rev = saveRevision(workspace, q.id, { text: sample, factIds: [fact.id], baseRevisionId: null });
  const frame = { kind: 'edit', previous: workspace, questionId: q.id, baseRevisionId: rev.id, initial };
  for (const change of [
    w => { w.company = '다른 회사'; },
    w => { w.facts[0].text = '교체한 사실'; },
    w => { w.questions[0].revisions[0].text = '교체한 이력'; },
    w => { w.questions = []; },
    w => { w.questions[0].approvedRevisionId = rev.id; },
  ]) {
    const changed = structuredClone(workspace);
    change(changed);
    assert.equal(checkpoint({ ...frame, workspace: changed }).ok, false);
  }
  const corrupt = checkpoint('{"private input');
  assert.ok(!JSON.stringify(corrupt).includes('private'));
  assert.equal(corrupt.ok, false);
});


test('checkpoint accepts workspace review notes while keeping the archived prefix immutable', () => {
  const { workspace, q, fact } = setup();
  const revision = saveRevision(workspace, q.id, { text: sample, factIds: [fact.id], baseRevisionId: null });
  const previous = structuredClone(workspace);
  const note = recordExternalReview(workspace, q.id, revision.id, { provider: '수동 평가', score: 82 });
  const command = { kind: 'edit', previous, workspace, questionId: q.id, baseRevisionId: revision.id,
    initial: { text: '통신 오류를 확인했습니다.', factIds: [fact.id] } };
  const result = checkpoint(command);
  assert.equal(result.ok, true);
  assert.deepEqual(result.workspace.questions[0].revisions[0], previous.questions[0].revisions[0]);
  assert.deepEqual(result.workspace.externalReviews, [note]);
  const tampered = structuredClone(workspace);
  tampered.questions[0].revisions[0].text = '바꾼 보관본';
  assert.equal(checkpoint({ ...command, workspace: tampered }).code, 'stale_workspace');
  const dangling = structuredClone(workspace);
  dangling.externalReviews[0].revisionId = 'missing';
  assert.equal(checkpoint({ ...command, workspace: dangling }).ok, false);
});
