// Source offsets use Unicode code points, with an exclusive end offset.
export function sourceSpan(text, start, end, source = "jd", page = null) {
  return { source, page, start: [...text.slice(0, start)].length, end: [...text.slice(0, end)].length, quote: text.slice(start, end) };
}

const TECHNOLOGIES = [
  ["C++", /(?<![\w+#])(?:c\+\+|cpp|cplusplus|c\s+plus\s+plus|씨플러스플러스|씨플플)(?:\d+(?:\.\d+)*)?(?![\w+#])/giu],
  ["C#", /(?<![\w+#])(?:c#|csharp|c\s*sharp)(?:\d+(?:\.\d+)*)?(?![\w+#])/giu],
  ["WPF", /\bwpf\b|windows presentation foundation|윈도우\s*프레젠테이션\s*파운데이션/giu],
  ["드라이버", /\bdevice[- ]drivers?\b|\bdrivers?\b|디바이스\s*드라이버|장치\s*드라이버|드라이버/giu],
  [".NET", /(?<!\w)\.net\b|\bdotnet\b/giu],
  ["Python", /\bpython\b|파이썬/giu], ["JavaScript", /\bjavascript\b|\bjs\b/giu],
  ["TypeScript", /\btypescript\b|\bts\b/giu], ["React", /\breact\b|리액트/giu],
  ["SQL", /\bsql\b|데이터베이스|\bdatabase\b/giu], ["Git", /\bgit\b|버전\s*관리/giu],
  ["테스트", /테스트|\btests?\b|\btesting\b/giu], ["협업", /협업|커뮤니케이션|의사소통/giu],
  ["성능", /성능|최적화|\bperformance\b/giu], ["Linux", /\blinux\b|리눅스/giu],
];

export function termsIn(text) {
  return TECHNOLOGIES.filter(([, pattern]) => { pattern.lastIndex = 0; return pattern.test(text); }).map(([name]) => name);
}

function linesWithSpans(text, source = "jd", page = null) {
  const lines = [];
  let offset = 0;
  for (const [part] of text.matchAll(/[^\r\n]+|[\r\n]+/gu)) {
    const end = offset + [...part].length;
    if (part.trim()) lines.push({ text: part.trim(), span: { source, page, start: offset, end, quote: part } });
    offset = end;
  }
  return lines;
}

export function parseJobDescription(text, source = "jd") {
  const requirements = [], questions = [], known = new Set(), knownQuestions = new Set();
  let section = "";
  for (const row of linesWithSpans(text, source)) {
    const value = row.text.replace(/^\s*[-•·▪\d.)\]]+\s*/u, "");
    if (/^(?:자격\s*요건|지원\s*자격|필수(?:\s*사항)?|우대(?:\s*사항)?|주요\s*업무|담당\s*업무|지원\s*문항|자기소개서|복리후생|근무조건|전형절차)\s*[:：]?$/u.test(value)) { section = value; continue; }
    const maxChars = value.match(/([\d,]+)\s*(?:자|글자)(?:\s*(?:이내|이하|제한|최대))?/u);
    const maxBytes = value.match(/([\d,]+)\s*(?:bytes?|바이트)/iu);
    const maxLines = value.match(/([\d,]+)\s*줄/u);
    const questionLike = /(?:설명|기술|작성|서술|소개|말해|적어).*(?:세요|시오|주십시오)|지원\s*동기|입사\s*후\s*포부/u.test(value);
    if (questionLike || (/(?:문항|자기소개서)/u.test(section) && (maxChars || maxBytes || maxLines))) {
      if (!knownQuestions.has(value)) {
        const rule = {};
        for (const [key, match] of [["maxChars", maxChars], ["maxBytes", maxBytes], ["maxLines", maxLines]]) if (match) { const n = Number(match[1].replaceAll(",", "")); if (Number.isSafeInteger(n) && n > 0) rule[key] = n; }
        if (/공백\s*제외/u.test(value)) rule.includeSpaces = false;
        else if (/공백\s*포함/u.test(value)) rule.includeSpaces = true;
        const title = value.replace(/\s*[（(][^()（）]*(?:\d\s*(?:자|글자|bytes?|바이트|줄)|공백\s*(?:포함|제외))[^()（）]*[)）]\s*$/iu, "").trim();
        questions.push({ title: (title || value).slice(0, 1000), limit: rule.maxChars ?? 50000, rule, inferredCharLimit: !rule.maxChars, span: row.span });
        knownQuestions.add(value);
      }
      continue;
    }
    const relevantSection = /요건|자격|필수|우대|업무/u.test(section);
    if (/(?:복리후생|근무조건|전형절차)/u.test(section)) continue;
    if (!relevantSection && !/(?:필수|우대|경험|역량|능력|가능|숙련|이해|개발|구현)/u.test(value)) continue;
    const terms = termsIn(value);
    if (!terms.length && !relevantSection) continue;
    const identity = value.normalize("NFKC").toLowerCase().replace(/[\s.,·]/gu, "");
    if (known.has(identity) || value.length < 3) continue;
    known.add(identity);
    requirements.push({ id: `${source}-${requirements.length + 1}`, text: value, terms, priority: /우대/u.test(section + value) ? "preferred" : "required", span: row.span });
  }
  return { requirements, questions };
}

function substantive(text) { return text.length >= 12 && !/(?:경험|수행|개발|구현).{0,8}(?:없|않|못)|(?:미경험|미구현|미개발)/u.test(text) && /구현|개발|개선|설계|측정|검증|운영|해결|분석|배포|제작|담당|기여|수행|작성|자동화|\b(?:built|developed|implemented|tested|designed)\b/iu.test(text); }

// A skill mention and an action must belong to the same clause. This is a
// conservative text heuristic, not verification of authorship or proficiency.
function performedTerms(text) {
  return [...new Set(text.split(/[.!?](?:\s|$)|[\r\n;]|,\s*|(?:지만|했고|했으며|않았고|이고)\s*/u).flatMap(clause => {
    if (!substantive(clause) || /없|않|못|미경험|미구현|미개발|\b(?:not|never|without)\b/iu.test(clause)) return [];
    if (/팀원|팀에서|팀은|팀이|팀의|동료|타인|\b(?:teammate|colleague|team)\b/iu.test(clause)) return [];
    return termsIn(clause);
  }))];
}

function needsConditionReview(text) {
  // Term matching cannot establish duration, versions, leadership or a specific
  // deployment/domain scope. Keep these requirements pending human review.
  return /\d+\s*(?:년|개월)|(?:c\+\+|c#|python|react|\.net|typescript|javascript)\s*\d|상용|실무|프로덕션|production|리딩|리더|주도|총괄|대규모|커널|kernel/iu.test(text);
}

export function matchRequirements(workspace, requirements = parseJobDescription(workspace.research?.jdText ?? "").requirements) {
  const facts = workspace.facts.filter(f => f.verified && f.source.trim()).map(f => ({ text: f.text, source: f.source, factId: f.id, verified: true }));
  const evidence = [...facts];
  const mentions = workspace.facts.filter(f => !f.verified).map(f => ({ text: f.text, source: f.source, factId: f.id, verified: false }));
  for (const page of workspace.research?.portfolio?.pages ?? []) mentions.push({ text: page.text, source: workspace.research.portfolio.filename, page: page.page, verified: false });
  for (const question of workspace.questions) {
    const revision = question.revisions.find(r => r.id === question.approvedRevisionId);
    if (!revision) continue;
    const linked = facts.filter(f => revision.factIds.includes(f.factId));
    // An approved sentence does not establish a new skill absent from its linked facts.
    for (const fact of linked) evidence.push({ ...fact, text: revision.text, supportedTerms: termsIn(fact.text), performedTerms: performedTerms(fact.text), source: `확정본: ${question.title} · ${fact.source}`, revisionId: revision.id });
  }
  const indexed = [...evidence, ...mentions].map(item => ({ item, terms: termsIn(item.text).filter(t => !item.supportedTerms || item.supportedTerms.includes(t)) }));
  return requirements.map(requirement => {
    const terms = requirement.terms;
    const matches = indexed.flatMap(({ item, terms: observed }) => {
      const matched = terms.filter(term => observed.includes(term));
      if (!matched.length) return [];
      const supportedActions = performedTerms(item.text).filter(term => !item.performedTerms || item.performedTerms.includes(term));
      const strongTerms = item.verified ? matched.filter(term => supportedActions.includes(term)) : [];
      return [{ ...item, matchedTerms: matched, strongTerms, strong: strongTerms.length === matched.length, span: sourceSpan(item.text, 0, item.text.length, item.source, item.page ?? null) }];
    });
    const coveredTerms = terms.filter(term => matches.some(m => m.strongTerms.includes(term)));
    const missingTerms = terms.filter(term => !coveredTerms.includes(term));
    const conditionReview = needsConditionReview(requirement.text);
    const status = terms.length && !missingTerms.length && !conditionReview ? "covered" : matches.length ? "weak" : "missing";
    const reason = !terms.length ? "자동 비교할 기술어가 없습니다. 역할·경력 조건을 직접 확인하세요." : status === "covered" ? "모든 기술어에 출처와 같은 절의 수행 내용이 있는 확인된 사실이 연결됩니다. 숙련도·개인 기여는 원문을 확인하세요." : status === "weak" ? `${missingTerms.length ? `근거 보완 필요: ${missingTerms.join(", ")}. ` : ""}${conditionReview ? "경력·버전·역할·업무 범위 등 추가 조건은 직접 확인해야 합니다. " : ""}단순 언급과 미확인 원문은 충족 근거로 세지 않습니다.` : `확인된 수행 근거를 찾지 못했습니다: ${terms.join(", ")}.`;
    return { ...requirement, status, matches, missingTerms, conditionReview, reason };
  });
}

export function prioritizedActions(matches) {
  return matches.filter(row => row.status !== "covered").sort((a, b) => (a.priority === "required" ? 0 : 2) + (a.status === "missing" ? 0 : 1) - ((b.priority === "required" ? 0 : 2) + (b.status === "missing" ? 0 : 1))).map((row, index) => ({ priority: index + 1, requirementId: row.id, text: `${row.priority === "required" ? "필수" : "우대"} · ${row.text}`, action: row.status === "weak" ? "원문의 역할·행동·결과를 확인하여 사실 원장에 근거를 등록하세요." : "실제 경험의 출처를 찾아 등록하세요. 경험이 없다면 답변에 보유 역량으로 쓰지 마세요.", reason: row.reason, span: row.span }));
}

export function portfolioCandidates(portfolio) {
  const seen = new Set();
  return (portfolio?.pages ?? []).flatMap(page => linesWithSpans(page.text, portfolio.filename, page.page).filter(row => {
    if (row.text.length < 8 || row.text.length > 4000 || seen.has(row.text)) return false;
    seen.add(row.text); return true;
  }));
}

export function researchContext(workspace) {
  const research = workspace.research;
  const claims = parseJobDescription(research?.jdText ?? "").requirements.map(row => row.text);
  for (const source of research?.officialSources ?? []) claims.push(...linesWithSpans(source.text).map(row => `[사용자 등록 공식 자료: ${source.label} · ${source.url}] ${row.text}`));
  const facts = workspace.facts.filter(f => f.verified && f.source.trim());
  const observations = (research?.github?.checks ?? []).map(row => {
    const source = row.url ? `${row.url}${row.path ? ` (${row.path})` : ""}` : row.path ? `저장소 경로 ${row.path}` : research.github.url;
    return `[공개 저장소 관측 · 개인 기여 미확인] ${row.label}: ${row.status}${source ? ` · 출처: ${source}` : ""}`;
  });
  const brief = [
    `사용자 제공 회사·직무 브리프: 회사 ${workspace.company || "미입력"} · 직무 ${workspace.role || "미입력"}`,
    ...(research?.dart ? [`OpenDART 기업 자료 (${research.dart.source}, 고유번호 ${research.dart.corpCode}, 조회 ${research.dart.retrievedAt}, 자료 제공처 ${research.dart.url}):`, ...research.dart.fields.map(row => `${row.label}: ${row.text}`)] : []),
    ...(!research?.dart ? ["OpenDART 자료: 미등록"] : []),
  ].join("\n");
  const materials = [
    ...facts.map(f => `${f.text}\n출처: ${f.source}`),
    ...observations,
  ];
  return { requirements: [...new Set(claims)], portfolio: materials.join("\n\n"), brief };
}

export function emptyResearch() { return { jdText: "", officialSources: [], portfolio: null, github: null, dart: null }; }

export function validateResearch(value) {
  const error = () => { throw new Error("공고·포트폴리오 자료 형식 또는 크기를 확인해 주세요."); };
  const obj = (v, keys) => { if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) error(); };
  const str = (v, max = 50000) => { if (typeof v !== "string" || v.length > max) error(); };
  const list = (v, max) => { if (!Array.isArray(v) || v.length > max) error(); };
  const url = v => { str(v, 2000); try { if (!["https:", "http:"].includes(new URL(v).protocol)) error(); } catch { error(); } };
  obj(value, ["jdText", "officialSources", "portfolio", "github", "dart"]); str(value.jdText); list(value.officialSources, 30);
  for (const source of value.officialSources) { obj(source, ["label", "url", "text"]); str(source.label, 200); url(source.url); str(source.text); }
  if (value.portfolio !== null) {
    obj(value.portfolio, ["filename", "kind", "pages"]); str(value.portfolio.filename, 500); str(value.portfolio.kind, 30); list(value.portfolio.pages, 500);
    for (const page of value.portfolio.pages) { obj(page, ["page", "text"]); if (!Number.isSafeInteger(page.page) || page.page < 1) error(); str(page.text, 100000); }
  }
  if (value.github !== null) {
    const item = value.github; obj(item, ["url", "sha", "language", "pushedAt", "retrievedAt", "checks"]); url(item.url);
    for (const key of ["sha", "language", "pushedAt", "retrievedAt"]) { if (item[key] !== null) str(item[key], 200); }
    list(item.checks, 50); for (const check of item.checks) { obj(check, ["label", "status", "path", "url"]); str(check.label, 200); str(check.status, 100); if (check.path !== null) str(check.path, 500); if (check.url !== null) url(check.url); }
  }
  if (value.dart !== null) {
    const item = value.dart; obj(item, ["source", "url", "corpCode", "retrievedAt", "fields"]); str(item.source, 200); url(item.url); str(item.corpCode, 20); str(item.retrievedAt, 100); list(item.fields, 50);
    for (const field of item.fields) { obj(field, ["label", "text"]); str(field.label, 200); str(field.text); }
  }
  return JSON.parse(JSON.stringify(value));
}
