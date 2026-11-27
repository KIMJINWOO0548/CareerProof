// All public offsets are half-open Unicode code-point offsets in the original text.
const graphemes = new Intl.Segmenter('ko', { granularity: 'grapheme' });
const sentences = new Intl.Segmenter('ko', { granularity: 'sentence' });
const utf8 = new TextEncoder();
const emoji = /[\p{Emoji_Presentation}\p{Regional_Indicator}\uFE0F\u20E3]/u;

let cp949Membership;

function cp949Bytes(characters) {
  if (!cp949Membership) {
    cp949Membership = Uint8Array.from(atob(CP949_BITMAP), byte => byte.charCodeAt(0));
  }
  let bytes = 0;
  for (const character of characters) {
    const point = character.codePointAt(0);
    if (point < 128) {
      bytes++;
    } else if ((cp949Membership[point >>> 3] & (1 << (point & 7))) !== 0) {
      bytes += 2;
    } else {
      return { bytes: null, unsupported: character };
    }
  }
  return { bytes, unsupported: null };
}

/** Counts against all configured limits. Only an enabled byte limit blocks on an unencodable scalar. */
export function countText(text, rule = {}) {
  let logical = text.replace(/\r\n?/g, '\n');
  const lines = logical ? logical.split('\n').length : 0;
  if (rule.normalize === 'NFC') logical = logical.normalize('NFC');
  if (rule.includeSpaces === false) logical = logical.replaceAll(' ', '');
  const newline = { count_1: '\n', count_2: '\r\n', strip: '' }[rule.newline ?? 'count_1'];
  let chars = 0;
  let forbiddenEmoji = null;
  for (const { segment } of graphemes.segment(logical)) {
    if (segment === '\n') {
      chars += newline.length;
      continue;
    }
    let width = rule.charUnit === 'utf16' ? segment.length : 1;
    if (emoji.test(segment)) {
      if (rule.emojiPolicy === 'count_1') width = 1;
      if (rule.emojiPolicy === 'count_2') width = 2;
      if (rule.emojiPolicy === 'forbid') forbiddenEmoji ??= segment;
    }
    chars += width;
  }
  const encodedText = logical.replaceAll('\n', newline);
  const { bytes, unsupported } = rule.byteEncoding === 'cp949'
    ? cp949Bytes(encodedText)
    : { bytes: utf8.encode(encodedText).length, unsupported: null };
  const violations = [];
  if (forbiddenEmoji) violations.push(`규칙에서 허용하지 않는 이모지(${forbiddenEmoji})가 있습니다.`);
  if (unsupported && rule.maxBytes != null) {
    violations.push(`CP949로 표현할 수 없는 문자(${unsupported})가 있습니다.`);
  }
  let ratio = 0;
  for (const [value, limit, unit] of [
    [chars, rule.maxChars, '자'], [bytes, rule.maxBytes, '바이트'], [lines, rule.maxLines, '줄'],
  ]) {
    if (limit == null || value == null) continue;
    ratio = Math.max(ratio, value / limit);
    if (value > limit) violations.push(`${value - limit}${unit} 초과했습니다.`);
  }
  let status = 'ok';
  if (violations.length) status = 'over';
  else if (ratio === 1) status = 'full';
  else if (ratio >= 0.9) status = 'near';
  return { chars, bytes, lines, violations, status, ratio, unsupported };
}

const stockPhrases = /이를 통해|이러한 경험을 (?:통해|바탕으로)|이를 바탕으로|끊임없(?:이|는)|최선을 다하|귀사의 발전에 기여/gu;
const endForm = /(했습니다|하였습니다|하겠습니다|합니다|됩니다|입니다|있습니다|습니다)(?:[.!?。！？]+)?$/u;
const formatSymbols = /[·→•]|^\s*[-*]\s/gu;
const specificity = [
  { key: 'action', match: /구현|설계|분석|연동|수정|재현|측정|정리|작성|개선|조정|개발/u, question: '직접 수행한 행동은 무엇인가요?' },
  { key: 'role', match: /제가|저는|담당|맡[아았은]|역할|기여 범위|팀원으로/u, question: '본인이 맡은 범위를 확인할 수 있나요?' },
  { key: 'constraint', match: /제약|오류|실패|충돌|타임아웃|병목|문제|한계|원인/u, question: '어떤 제약이나 시행착오가 있었나요?' },
  { key: 'result', match: /검증|단축|감소|증가|통과|확인|측정|테스트|줄였|늘렸/u, question: '결과나 검증 방법을 뒷받침할 근거가 있나요?' },
];

function splitSentences(text) {
  const parts = [];
  for (const line of text.matchAll(/[^\r\n]+/gu)) {
    for (const { segment, index } of sentences.segment(line[0])) {
      const body = segment.trim();
      if (!body) continue;
      const start = line.index + index + segment.length - segment.trimStart().length;
      parts.push({ text: body, start, end: start + body.length });
    }
  }
  return parts;
}

function pointOffsets(text) {
  const offsets = new Uint32Array(text.length + 1);
  let unit = 0;
  let point = 0;
  for (const char of text) {
    offsets[unit] = point++;
    unit += char.length;
  }
  offsets[unit] = point;
  return offsets;
}

function canonical(text) {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** Local, uncalibrated writing feedback. A fact contributes only when confirmed and present in the draft. */
export function scoreText(text, { kind = 'self_intro', facts = [] } = {}) {
  const parts = splitSentences(text);
  const emptyAxes = { pattern: null, cliche: null, specificity_deficit: null };
  const result = {
    total: null, axes: emptyAxes, highlights: [], questions: [], factIds: [],
    abstain: true, calibrated: false, confidence: 'low', version: 'ko-rules-1',
  };
  if (!parts.length || !['self_intro', 'career_desc'].includes(kind)) return result;

  const offsets = pointOffsets(text);
  const add = (start, end, rule, reason) => result.highlights.push({
    start: offsets[start], end: offsets[end], rule, reason,
  });
  const patternHits = new Set();
  let clicheHits = 0;
  for (const [index, part] of parts.entries()) {
    let found = false;
    for (const match of part.text.matchAll(stockPhrases)) {
      add(part.start + match.index, part.start + match.index + match[0].length,
        'cliche_phrase', '자주 쓰이는 표현입니다. 연결되는 행동이나 근거를 확인하세요.');
      found = true;
    }
    if (found) clicheHits++;
    if (kind === 'self_intro' && [...part.text.matchAll(formatSymbols)].length >= 3) {
      patternHits.add(index);
      add(part.start, part.end, 'symbol_density', '한 문장에 열거 기호가 여러 번 나타납니다.');
    }
  }
  for (let start = 0; start < parts.length;) {
    const ending = parts[start].text.match(endForm)?.[1];
    let end = start + 1;
    while (ending && end < parts.length && parts[end].text.match(endForm)?.[1] === ending) end++;
    if (end - start >= 3) {
      for (let i = start; i < end; i++) patternHits.add(i);
      add(parts[start].start, parts[end - 1].end, 'repeated_ending', '세 문장 이상이 같은 종결 표현으로 끝납니다.');
    }
    start = end;
  }

  const body = canonical(text);
  const evidence = facts.filter(fact => {
    const candidate = fact.verified === true && typeof fact.text === 'string' && canonical(fact.text);
    return candidate && body.includes(candidate);
  });
  result.factIds = evidence.map(fact => fact.id);
  const missing = specificity.filter(({ match }) => !evidence.some(fact => match.test(fact.text)));
  result.questions = missing.map(({ question }) => question);
  const pattern = 30 * patternHits.size / parts.length;
  const cliche = 30 * clicheHits / parts.length;
  const deficit = 40 * missing.length / specificity.length;
  result.axes = {
    pattern: Math.round(pattern * 10) / 10, cliche: Math.round(cliche * 10) / 10, specificity_deficit: deficit,
  };
  result.total = Math.round(pattern + cliche + deficit);
  result.highlights.sort((a, b) => a.start - b.start || a.end - b.end);
  result.abstain = countText(text.trim(), { normalize: 'NFC' }).chars < 300;
  result.confidence = result.abstain ? 'low' : 'unassessed';
  return result;
}

// Each set bit marks a BMP scalar that encodes to two bytes in strict CP949.
// Generated from Python 3.12's cp949 encoder for U+0080..U+FFFF. ASCII uses one byte.
// ICU builds differ in whether TextDecoder('euc-kr') supports the CP949 extensions.
const CP949_BITMAP =
  'AAAAAAAAAAAAAAAAAAAAAAAAAACSZd/3QACBwUAAgUEAAAIAwAAOgQcODADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAIAAAS8AAAAAAAAAAAAAAAAAAAAAAAAAAAAA/v/7A/7/+wMAAAAAAAACAP//////////AgAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAIDNjAA0IAAAAAAAAEIAeAAAAABAAAAAAAAAAAAAACAJIAEYIAAAAABh4/wP/AwAA/wMAAAAA' +
  'AAAUAAAAAACNiQJkoV8wMAAABAAzDAAAzAAAAiAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAA/3/w/wcAAPD//z8AAAD///8DAAAP8P////////8PAAAAAAAAAAAEAPsDzDDDyQMAAAAAAGDAAFAAAAAA' +
  'BQAAALs3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/87AAAAAAD+////////////DwD+////////////fwAAAAAAAAD+////////////' +
  '/38AAAAAAAAAAAAAAAAAAP///x8AAAAAAAAAAP///48AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB//////////' +
  '/4dJOQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAiy9yQwAgBAss6EDjACjIQERZN0l2eUAE' +
  'kyzwozgAxQgC7gMAAIBQNcjhIx4AgknEWq1CKQDAYIAcRpqkA8AqBUQqRtbaPQAIiIMgFCAAcAEhIAIDADCsQCCGYkSgIACK' +
  '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' +
  'DQEAFQAAAAAAQKCAQAFQAQQgAIAEAAgEEAAAAAGQBEogAACADABCCEEwjCoOCYXABinEQAAIEAAGgDCyAgE4IYAADQMgBEAJ' +
  'EgAAgBAEBIDKiEgAAgYEJAEABAAIABABDVXIqSgkUgwAADFITWIvAqAwKEF7BQXSlKhEGMJswkUXQNEuARkIAgLCABVAkJEg' +
  'AQRNBAAAAAAAAAAAAAAAAAAAAAAAAICAQhUgBAIMAAYEFABgh5/ZuZ8FClRdJBA4sCVIAAAAAAAAAAAAUAiZACAEAAIIAQhE' +
  'QJgAKAqBCAAAhAFAAAQhAJQHAIIBAFAAgiQAAAAcAAABPASAAAgASSgCPPjAhgjLMGIAoAQAAAAAAAAYSKEHACRAEgBALIUi' +
  'b6mz5g9AJlGGbDtyC+KktZ+FIgJMhSMBAgQAQAIhICAEACQCgCAEAAB+BAAEFqABgCoEEADYMgCB+oMxiAQgAAAgh0AAABCE' +
  'IQKASHQAAAApAEoRAADIAgCQBAAQBAAREAABxVfJAAAALRAIAEAgUAAQUASIMAEACAACQBIAQAAQAAABIAggARAABggAAACg' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAJih4BOCECGIAEcBAGAAAAAAAAEAJEBIgVOAH4HATpIWBsMBuIBYII' +
  '83pgGgyHxQrBAEpSgAAFIhQBQlAGIpAEAKgAAAEpAABACAgQAABIiG8VjwEAIAELQHAQRaCIAAAAAAAAAIECAJAAAJgG4BBw' +
  'CBYJQQEBAAAgOpYAAAAAAAAAQCIgcRoCAgAnogAgAoACwQACAAjBACkgoIwkBgAAAAAAAAABAAEAABgBIEAAAAAAAASABAIQ' +
  'PoAQBACAAAAAQAKAAEgAAAACQAAQAQAAACAlACAABAiAAoAAAAAAAAAAAAAAAAAAAAAAAKACWAAAAgAIQAEACAAAAiADEAQA' +
  'AAAAAACCEAAQAIAAAAAEBwAAAEQAAAAAAAAAAAAAIKIAAIygIAAwSAhgElkAARAAgEEIAAEAAAgATASAghSAAAAgIRAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////DwAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////////////////////////////////' +
  '////////////DwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/v////////////9/AAAAAAAAAAAAAAAAAAAAAG8AAAA=';
