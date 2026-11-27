// Local NDJSON transport for the same decision rules that run in the browser.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createLoop } from '../frontend/loop.js';
import { approveRevision, restoreWorkspace, saveRevision } from '../frontend/workspace.js';

const MiB = 1024 * 1024;
const terminal = new Set(['completed', 'cancelled']);
const messages = {
  invalid_request: '명령과 입력 형식을 확인하세요.',
  invalid_transition: '현재 실행 상태에서 사용할 수 없는 명령입니다.',
  stale_revision: '작업 기준이 바뀌었습니다. 최신 작업을 다시 여세요.',
  stale_workspace: '기존 문항·근거·편집 이력과 일치하는 작업이 필요합니다.',
  not_found: '선택한 항목을 찾을 수 없습니다.',
  missing_evidence: '작성에 사용할 근거를 선택하세요.',
  unverified_fact: '확인한 사실만 근거로 사용할 수 있습니다.',
  unsupported_number: '연결된 사실에 있는 수치와 단위를 확인하세요.',
  empty_answer: '확정할 본문을 입력하세요.',
  count_limit: '문항의 분량 제한을 확인하세요.',
  length: '문항의 분량 제한을 확인하세요.',
  evidence: '수치와 연결된 사실을 확인하세요.',
  preservation: '선택한 근거의 참조를 확인하세요.',
  invalid_candidate: '편집본과 근거의 형식을 확인하세요.',
  cost_unknown: '확인되지 않은 과금이 있습니다.',
  budget_limit: '실행 예산을 확인하세요.',
  needs_user_input: '원고를 수정하거나 새로운 사실을 확인해 연결하세요.',
  too_large: '작업 크기 한도를 초과했습니다.',
};

function requireValue(condition, code = 'invalid_request') {
  if (!condition) throw Object.assign(new Error(messages[code]), { code });
}

function failure(error) {
  const code = Object.hasOwn(messages, error?.code) ? error.code : 'invalid_request';
  return { ok: false, code, message: messages[code] };
}

function questionOf(workspace, id) {
  const question = workspace.questions.find(q => q.id === id);
  requireValue(question, 'not_found');
  return question;
}

// A restored workspace can append facts, questions and revisions, and confirm a fact.
// Older revisions and their sources remain immutable even when approved pointers move.
function verifyExtension(previous, next) {
  requireValue(previous.company === next.company && previous.role === next.role, 'stale_workspace');
  const facts = new Map(next.facts.map(fact => [fact.id, fact]));
  for (const fact of previous.facts) {
    const update = facts.get(fact.id);
    requireValue(update && update.text === fact.text && update.source === fact.source &&
      (!fact.verified || update.verified), 'stale_workspace');
  }
  const questions = new Map(next.questions.map(q => [q.id, q]));
  for (const q of previous.questions) {
    const update = questions.get(q.id);
    requireValue(update && update.title === q.title && update.kind === q.kind && update.limit === q.limit &&
      isDeepStrictEqual(update.rule, q.rule) && update.revisions.length >= q.revisions.length &&
      q.revisions.every((r, i) => isDeepStrictEqual(r, update.revisions[i])), 'stale_workspace');
  }
}

function validDraft(draft) {
  requireValue(draft && typeof draft.text === 'string' && draft.text.length <= 50000 &&
    Array.isArray(draft.factIds) && draft.factIds.every(id => typeof id === 'string'));
  return { text: draft.text, factIds: draft.factIds };
}

function checkpoint(command) {
  requireValue(['edit', 'approve'].includes(command?.kind));
  const previous = restoreWorkspace(command.previous);
  const next = restoreWorkspace(command.workspace);
  verifyExtension(previous, next);
  const old = questionOf(previous, command.questionId);
  const q = questionOf(next, command.questionId);
  requireValue(old.headRevisionId === command.baseRevisionId && q.headRevisionId === command.baseRevisionId &&
    q.approvedRevisionId === old.approvedRevisionId, 'stale_revision');
  if (command.kind === 'edit') {
    saveRevision(next, q.id, { ...validDraft(command.initial), baseRevisionId: command.baseRevisionId });
  } else {
    approveRevision(next, q.id, command.revisionId);
  }
  return { ok: true, workspace: next };
}

// A single valid workspace can occupy 8 MiB. Bound the bytes while accumulating
// partial frames, before decoding JSON. The checkpoint has two workspace copies.
async function* frames(limit) {
  let parts = [], length = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  function complete() {
    const frame = decoder.decode(Buffer.concat(parts, length));
    parts = [];
    length = 0;
    return JSON.parse(frame);
  }
  for await (const chunk of process.stdin) {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      length += part.length;
      requireValue(length <= limit, 'too_large');
      parts.push(part);
      if (end < 0) break;
      yield complete();
      start = end + 1;
    }
  }
  if (length) yield complete();
}

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + '\n');
}

function host() {
  let workspace, question, loop;
  let outstanding = null, dispatch = null, finishing = false;

  function checkEnd() {
    // Let the command ack and the last usage event reach stdout before releasing stdin.
    if (!outstanding && terminal.has(loop?.state.phase) && !loop.state.usagePending) {
      finishing = true;
      process.stdin.destroy();
    }
  }

  function onChange(state) {
    send({ type: 'state', state });
    if (terminal.has(state.phase)) setImmediate(checkEnd);
  }

  function generate({ previous, facts, question, remainingUsd, iteration, feedback }) {
    requireValue(!outstanding);
    return new Promise((resolve, reject) => {
      const callId = randomUUID();
      outstanding = { callId, resolve, reject };
      const frame = { type: 'generate', callId, payload: { previous, facts, question, remainingUsd, iteration, feedback } };
      if (dispatch) dispatch.push(frame);
      else send(frame);
    });
  }

  // start/resume synchronously publish RUNNING after checking the edit and before
  // waiting for generation. A rejected command leaves the original state object intact.
  async function acceptExecution(before, execution) {
    if (before === loop.state) {
      await execution;
    } else {
      execution.catch(() => { process.exitCode = 1; process.stdin.destroy(); });
    }
  }

  async function command(frame) {
    if (frame.type === 'start') {
      requireValue(!loop, 'invalid_transition');
      workspace = restoreWorkspace(frame.workspace);
      question = questionOf(workspace, frame.questionId);
      loop = createLoop({
        workspace, question, initial: validDraft(frame.initial), maxIterations: frame.maxIterations,
        target: frame.target, provider: frame.provider, budgetUsd: frame.budgetUsd, generate, onChange,
      });
      const before = loop.state;
      try { await acceptExecution(before, loop.start()); }
      catch (error) { loop = null; throw error; }
      return;
    }
    requireValue(loop, 'invalid_transition');
    const before = loop.state;
    if (frame.type === 'resume') {
      requireValue(before.phase === 'paused', 'invalid_transition');
      const next = restoreWorkspace(frame.workspace);
      verifyExtension(workspace, next);
      const q = questionOf(next, question.id);
      requireValue(q.headRevisionId === frame.baseRevisionId, 'stale_revision');
      const draft = validDraft(frame.initial);
      const old = { ...workspace }, oldQuestion = { ...question };
      // The loop captures these two object identities. Stage changes for validation
      // and roll them back before accepting another line if resume rejects the edit.
      Object.assign(question, q);
      Object.assign(workspace, next, { questions: next.questions.map(item => item === q ? question : item) });
      try { await acceptExecution(before, loop.resume(draft, frame.baseRevisionId)); }
      catch (error) {
        Object.assign(question, oldQuestion);
        Object.assign(workspace, old);
        throw error;
      }
      return;
    }
    if (frame.type === 'pause') {
      requireValue(before.phase === 'running', 'invalid_transition');
      loop.pause();
      return;
    }
    requireValue(frame.type === 'stop' || frame.type === 'cancel');
    requireValue(['running', 'pausing', 'paused'].includes(before.phase), 'invalid_transition');
    loop[frame.type]();
  }

  async function handle(frame) {
    if (frame?.type === 'result' || frame?.type === 'error') {
      if (!outstanding || outstanding.callId !== frame.callId) return;
      const reply = outstanding;
      outstanding = null;
      if (frame.type === 'result') reply.resolve(frame.result);
      else {
        const error = frame.error ?? {};
        reply.reject(Object.assign(new Error('제공자 요청 결과를 확인하세요.'), {
          code: error.code, status: error.status, usage: error.usage,
        }));
      }
      setImmediate(checkEnd);
      return;
    }
    requireValue(typeof frame?.commandId === 'string' && /^[\w-]{1,100}$/.test(frame.commandId));
    dispatch = [];
    try {
      await command(frame);
      send({ type: 'ack', commandId: frame.commandId, ok: true });
      for (const item of dispatch) send(item);
    } catch (error) {
      send({ type: 'ack', commandId: frame.commandId, ...failure(error) });
    } finally {
      dispatch = null;
    }
  }
  return { handle, done: () => finishing };
}

async function main() {
  if (process.argv[2] === '--checkpoint') {
    try {
      for await (const value of frames(20 * MiB)) { send(checkpoint(value)); return; }
      requireValue(false);
    } catch (error) { send(failure(error)); }
    return;
  }
  const worker = host();
  try {
    for await (const frame of frames(10 * MiB)) await worker.handle(frame);
  } catch {
    if (!worker.done()) process.exitCode = 1;
  }
}

// A stopped parent owns the transport. Never print private frames or tracebacks.
process.stdout.on('error', () => process.stdin.destroy());
main().catch(() => { process.exitCode = 1; });
