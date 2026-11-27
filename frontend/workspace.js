import { countText } from "./analysis.js";

const FORMAT = "careerproof-workspace";
const VERSION = 1;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FACTS = 500;
const MAX_QUESTIONS = 100;
const MAX_REVISIONS = 500;
const MAX_TEXT = 50000;
const KINDS = new Set(["resume_form", "self_intro", "career_desc", "portfolio"]);
const RULE_VALUES = {
  byteEncoding: ["utf-8", "cp949"],
  charUnit: ["grapheme", "utf16"],
  newline: ["count_1", "count_2", "strip"],
  emojiPolicy: ["count_1", "count_2", "forbid", "native"],
  normalize: ["none", "NFC"],
};
const encoder = new TextEncoder();

function fail(message, code = "invalid_input") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function object(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("항목의 형식을 확인해 주세요.");
  }
  if (fields && Object.keys(value).some(key => !fields.includes(key))) {
    fail("현재 버전에서 읽을 수 없는 필드가 있습니다.");
  }
}

function string(value, max, label, allowBlank = false) {
  if (typeof value !== "string" || value.length > max || (!allowBlank && !value.trim())) {
    fail(`${label} 입력값을 확인해 주세요. 최대 ${max}자입니다.`);
  }
  return value;
}

function array(value, max) {
  if (!Array.isArray(value) || value.length > max) fail("항목 수 또는 목록 형식을 확인해 주세요.");
  return value;
}

function id(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][\w-]{0,79}$/.test(value)) {
    fail("항목 식별자 형식이 잘못되었습니다.");
  }
  return value;
}

function find(items, itemId) {
  const item = items.find(row => row.id === itemId);
  if (!item) fail("선택한 항목을 찾을 수 없습니다.", "not_found");
  return item;
}

function uniqueIds(items) {
  const ids = items.map(item => id(item?.id));
  if (ids.length !== new Set(ids).size) fail("중복된 식별자가 있습니다.");
}

function serialize(workspace) {
  const json = JSON.stringify(workspace, null, 2);
  if (encoder.encode(json).length > MAX_BYTES) fail("작업 파일은 최대 8MiB까지 지원합니다.", "too_large");
  return json;
}

function checkedRule(limit, rule) {
  if (!Number.isSafeInteger(limit) || limit <= 0) fail("문자 제한은 양의 정수여야 합니다.");
  object(rule, ["maxChars", "maxBytes", "maxLines", "includeSpaces", ...Object.keys(RULE_VALUES)]);
  if (Object.hasOwn(rule, "maxChars") && rule.maxChars !== limit) fail("문항과 규칙의 문자 제한이 다릅니다.");
  for (const key of ["maxBytes", "maxLines"]) {
    if (rule[key] != null && (!Number.isSafeInteger(rule[key]) || rule[key] <= 0)) {
      fail("바이트와 줄 제한은 양의 정수여야 합니다.");
    }
  }
  if (Object.hasOwn(rule, "includeSpaces") && typeof rule.includeSpaces !== "boolean") fail("공백 포함 규칙을 확인해 주세요.");
  for (const [key, values] of Object.entries(RULE_VALUES)) {
    if (Object.hasOwn(rule, key) && !values.includes(rule[key])) fail("지원하지 않는 글자 수 규칙입니다.");
  }
  return { ...rule, maxChars: limit };
}

export function createWorkspace({ company, role }) {
  return {
    format: FORMAT, version: VERSION,
    company: string(company, 200, "회사명").trim(),
    role: string(role, 200, "직무").trim(),
    facts: [], questions: [],
  };
}

function makeFact({ text, source }) {
  return {
    id: crypto.randomUUID(),
    text: string(text, 4000, "사실").trim(),
    source: string(source, 500, "출처").trim(),
    verified: false,
  };
}

function appendFacts(workspace, added) {
  if (workspace.facts.length + added.length > MAX_FACTS) fail("사실은 프로젝트당 최대 500개입니다.");
  serialize({ ...workspace, facts: [...workspace.facts, ...added] });
  workspace.facts.push(...added);
}

export function addFact(workspace, input) {
  const fact = makeFact(input);
  appendFacts(workspace, [fact]);
  return fact;
}

export function confirmFact(workspace, factId) {
  const fact = find(workspace.facts, factId);
  fact.verified = true;
  return fact;
}

// JSON Pointers refer to the selected file. URLs and contact fields are never resolved.
const RESUME_FIELDS = {
  work: { labels: ["name", "position", "startDate", "endDate"], fields: ["summary"], lists: ["highlights"] },
  projects: { labels: ["name", "startDate", "endDate"], fields: ["summary", "description"], lists: ["highlights", "keywords"] },
  skills: { labels: ["name", "level"], fields: [], lists: ["keywords"] },
  education: { labels: ["institution", "area", "studyType", "startDate", "endDate"], fields: ["score"], lists: ["courses"] },
  certificates: { labels: ["name", "issuer", "date"], fields: [], lists: [] },
};

export function importResume(workspace, resume) {
  object(resume);
  if (Object.hasOwn(resume, "format")) fail("이 파일은 JSON Resume 형식이 아닙니다.");
  const known = new Set(workspace.facts.map(fact => JSON.stringify([fact.text, fact.source])));
  const added = [];
  let seen = 0;
  function collect(value, source) {
    if (value == null || value === "") return;
    const text = string(value, 4000, "가져올 사실", true).trim();
    if (!text) return;
    seen++;
    const identity = JSON.stringify([text, source]);
    if (!known.has(identity)) {
      if (workspace.facts.length + added.length === MAX_FACTS) fail("사실은 프로젝트당 최대 500개입니다.");
      known.add(identity);
      added.push(makeFact({ text, source }));
    }
  }
  for (const [section, mapping] of Object.entries(RESUME_FIELDS)) {
    if (!Object.hasOwn(resume, section)) continue;
    for (const [i, row] of array(resume[section], MAX_FACTS).entries()) {
      object(row);
      const pointer = `/${section}/${i}`;
      const labels = mapping.labels.filter(key => row[key] != null)
        .map(key => string(row[key], 4000, key, true).trim()).filter(Boolean);
      collect(labels.join(" · "), pointer);
      for (const key of mapping.fields) collect(row[key], `${pointer}/${key}`);
      for (const key of mapping.lists) {
        if (!Object.hasOwn(row, key)) continue;
        array(row[key], MAX_FACTS).forEach((value, j) => collect(value, `${pointer}/${key}/${j}`));
      }
    }
  }
  if (!seen) fail("가져올 경력·프로젝트·기술·학력·자격 항목이 없습니다.");
  appendFacts(workspace, added);
  return added;
}

export function addQuestion(workspace, { title, limit, kind = "self_intro", rule = {} }) {
  if (!KINDS.has(kind)) fail("문서 유형을 확인해 주세요.");
  if (workspace.questions.length >= MAX_QUESTIONS) fail("문항은 프로젝트당 최대 100개입니다.");
  const question = {
    id: crypto.randomUUID(), title: string(title, 1000, "문항").trim(), kind, limit,
    rule: checkedRule(limit, rule), revisions: [], headRevisionId: null, approvedRevisionId: null,
  };
  serialize({ ...workspace, questions: [...workspace.questions, question] });
  workspace.questions.push(question);
  return question;
}

function linkedFacts(workspace, factIds) {
  array(factIds, MAX_FACTS);
  if (new Set(factIds).size !== factIds.length) fail("같은 사실을 두 번 연결할 수 없습니다.");
  return factIds.map(factId => {
    const fact = find(workspace.facts, id(factId));
    if (!fact.verified) fail("확인한 사실만 본문에 연결할 수 있습니다.", "unverified_fact");
    return fact;
  });
}

export function saveRevision(workspace, questionId, { text, factIds, baseRevisionId }) {
  const question = find(workspace.questions, questionId);
  if (question.headRevisionId !== baseRevisionId) fail("편집 기준이 변경되었습니다. 최신 답변을 확인해 주세요.", "stale_revision");
  string(text, MAX_TEXT, "본문", true);
  linkedFacts(workspace, factIds);
  const previous = question.revisions.at(-1);
  if (previous && previous.text === text && JSON.stringify(previous.factIds) === JSON.stringify(factIds)) return previous;
  if (question.revisions.length >= MAX_REVISIONS) fail("문항당 리비전은 최대 500개입니다.");
  const revision = { id: crypto.randomUUID(), parentId: baseRevisionId, text, factIds: [...factIds], createdAt: new Date().toISOString() };
  const next = { ...question, headRevisionId: revision.id, revisions: [...question.revisions, revision] };
  serialize({ ...workspace, questions: workspace.questions.map(item => item === question ? next : item) });
  question.revisions.push(revision);
  question.headRevisionId = revision.id;
  return revision;
}

// Numeric claims are compared with their units. Human review covers authorship,
// causality, and free-form claims that cannot be inferred from number matching.
function numericClaims(text) {
  const pattern = /(?:C\+\+|C#|\.NET|Python|React|Java|CUDA|Windows)\s*v?\d+(?:\.\d+)*|[−+-]?\d+(?:,\d{3})*(?:\.\d+)?(?:[ \t]*(?:%p|%|퍼센트포인트|퍼센트|시간|개월|분기|주일|밀리초|(?:천|만|억|조)(?:[ \t]*(?:개사|달러|유로|원|명|개|건|회|배))?|개사|달러|유로|회|건|명|배|개|대|초|분|일|주|달|월|년|원|점|[a-zA-Zµμ]+))?/gu;
  return (text.normalize("NFKC").match(pattern) ?? []).map(token => token.replace(/[\s,]/gu, "").replace("−", "-"));
}

export function checkApproval(workspace, question, revision) {
  if (!revision.text.trim()) fail("답변을 입력한 후 확정해 주세요.", "empty_answer");
  const { violations } = countText(revision.text, question.rule);
  if (violations.length) fail(violations.join(" "), "count_limit");
  const facts = linkedFacts(workspace, revision.factIds);
  if (!facts.length) fail("본문을 뒷받침하는 확인된 사실을 연결해 주세요.", "missing_evidence");
  const supported = new Set(facts.flatMap(fact => numericClaims(fact.text)));
  const unsupported = numericClaims(revision.text).find(claim => !supported.has(claim));
  if (unsupported) fail(`연결한 사실에서 수치·단위 ‘${unsupported}’를 확인할 수 없습니다.`, "unsupported_number");
}

export function approveRevision(workspace, questionId, revisionId) {
  const question = find(workspace.questions, questionId);
  const revision = find(question.revisions, revisionId);
  checkApproval(workspace, question, revision);
  // A change from null to a UUID also counts towards the backup size limit.
  const next = { ...question, approvedRevisionId: revision.id };
  serialize({ ...workspace, questions: workspace.questions.map(item => item === question ? next : item) });
  question.approvedRevisionId = revision.id;
  return revision;
}

export function backupWorkspace(workspace) {
  return serialize(workspace);
}

export function restoreWorkspace(input) {
  const raw = typeof input === "string" ? input : serialize(input);
  if (encoder.encode(raw).length > MAX_BYTES) fail("작업 파일은 최대 8MiB까지 지원합니다.", "too_large");
  let workspace;
  try {
    workspace = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    fail("작업 파일의 JSON 형식을 확인해 주세요.");
  }
  object(workspace, ["format", "version", "company", "role", "facts", "questions"]);
  if (workspace.format !== FORMAT || workspace.version !== VERSION) fail("지원하는 CareerProof 작업 파일 버전이 아닙니다.");
  string(workspace.company, 200, "회사명");
  string(workspace.role, 200, "직무");
  uniqueIds(array(workspace.facts, MAX_FACTS));
  for (const fact of workspace.facts) {
    object(fact, ["id", "text", "source", "verified"]);
    string(fact.text, 4000, "사실");
    string(fact.source, 500, "출처");
    if (typeof fact.verified !== "boolean") fail("사실의 확인 상태가 잘못되었습니다.");
  }
  uniqueIds(array(workspace.questions, MAX_QUESTIONS));
  const revisionIds = new Set();
  for (const question of workspace.questions) {
    object(question, ["id", "title", "kind", "limit", "rule", "revisions", "headRevisionId", "approvedRevisionId"]);
    string(question.title, 1000, "문항");
    if (!KINDS.has(question.kind)) fail("문서 유형이 잘못되었습니다.");
    question.rule = checkedRule(question.limit, question.rule);
    let parentId = null;
    for (const revision of array(question.revisions, MAX_REVISIONS)) {
      object(revision, ["id", "parentId", "text", "factIds", "createdAt"]);
      id(revision.id);
      if (parentId !== revision.parentId || revisionIds.has(revision.id)) fail("리비전 이력 연결을 확인해 주세요.");
      revisionIds.add(revision.id);
      parentId = revision.id;
      string(revision.text, MAX_TEXT, "본문", true);
      linkedFacts(workspace, revision.factIds);
      const timestamp = new Date(revision.createdAt);
      if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== revision.createdAt) fail("리비전 생성 시각을 확인해 주세요.");
    }
    if (question.headRevisionId !== parentId) fail("현재 편집본의 연결이 잘못되었습니다.");
    if (question.approvedRevisionId !== null) {
      checkApproval(workspace, question, find(question.revisions, question.approvedRevisionId));
    }
  }
  serialize(workspace);
  return workspace;
}
