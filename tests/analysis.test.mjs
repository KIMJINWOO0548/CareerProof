import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { countText, scoreText } from '../frontend/analysis.js';

test('character, byte and logical-line limits are independent', () => {
  for (const separator of ['\r', '\n', '\r\n']) {
    const source = '가 A' + separator + '나';
    const one = countText(source, { byteEncoding: 'cp949' });
    assert.deepEqual([one.chars, one.bytes, one.lines], [5, 7, 2]);
    const two = countText(source, { newline: 'count_2', maxLines: 1 });
    assert.deepEqual([two.chars, two.bytes, two.lines], [6, 10, 2]);
    assert.equal(two.status, 'over');
    assert.deepEqual(countText(source, { newline: 'strip', includeSpaces: false }).chars, 3);
  }
  assert.equal(countText('').lines, 0);
  assert.equal(countText('가\n', { newline: 'strip' }).lines, 2);
  assert.equal(countText('가\t 나', { includeSpaces: false }).chars, 3);
});

test('normalization, grapheme width, native UTF-16 width and emoji policy', () => {
  const family = '👩‍👩‍👦';
  assert.equal(countText(family).chars, 1);
  assert.equal(countText(family, { charUnit: 'utf16' }).chars, family.length);
  assert.equal(countText(family, { charUnit: 'utf16', emojiPolicy: 'count_2' }).chars, 2);
  assert.equal(countText('🇰🇷', { emojiPolicy: 'count_1' }).chars, 1);
  assert.equal(countText('1️⃣', { emojiPolicy: 'forbid' }).status, 'over');
  assert.equal(countText('1', { emojiPolicy: 'forbid' }).status, 'ok');
  const decomposed = '가'.normalize('NFD');
  assert.equal(countText(decomposed).chars, 1);
  assert.equal(countText(decomposed).bytes, 6);
  assert.equal(countText(decomposed, { normalize: 'NFC' }).bytes, 3);
  assert.equal(countText(decomposed, { normalize: 'NFC', byteEncoding: 'cp949' }).bytes, 2);
});

test('strict CP949 covers extended Hangul and rejects unmappable scalars', () => {
  assert.equal(countText('A갂힣漢€', { byteEncoding: 'cp949' }).bytes, 9);
  for (const scalar of ['😀', '\uE000', '₩', '\u0081']) {
    const optional = countText(scalar, { byteEncoding: 'cp949', maxChars: 5 });
    assert.equal(optional.bytes, null);
    assert.deepEqual(optional.violations, []);
    assert.equal(countText(scalar, { byteEncoding: 'cp949', maxBytes: 100 }).status, 'over');
  }
});

test('largest limit ratio drives exact 90%, 100%, overflow and unrounded thresholds', () => {
  assert.equal(countText('x'.repeat(449), { maxChars: 500 }).status, 'ok');
  assert.equal(countText('x'.repeat(450), { maxChars: 500 }).status, 'near');
  assert.equal(countText('가나', { maxChars: 9, maxBytes: 6 }).status, 'full');
  assert.equal(countText('가나', { maxChars: 9, maxBytes: 5 }).status, 'over');
});

const fixtureURL = new URL('./fixtures/style-smoke.json', import.meta.url);
const smoke = JSON.parse(await readFile(fixtureURL, 'utf8'));
for (const row of smoke) {
  test('synthetic style fixture: ' + row.id, () => {
    const facts = [
      { id: 'F-1', text: row.verified ?? '', verified: true },
      { id: 'F-2', text: row.unverified ?? '', verified: false },
    ];
    const options = { kind: row.kind, facts };
    const value = scoreText(row.text, options);
    assert.deepEqual(value, scoreText(row.text, options));
    assert.equal(value.abstain, true);
    assert.equal(value.calibrated, false);
    assert.equal(value.total, row.total);
    if (row.rule) assert.ok(value.highlights.some(h => h.rule === row.rule));
  });
}

test('highlights map to original Unicode code points and merge repeated-ending runs', () => {
  const text = '😀 이를 통해 분석했습니다.\r\n테스트를 작성했습니다. 문제를 수정했습니다. 결과를 확인했습니다.';
  const { highlights } = scoreText(text);
  const word = highlights.find(h => h.rule === 'cliche_phrase');
  assert.equal([...text].slice(word.start, word.end).join(''), '이를 통해');
  assert.equal(highlights.filter(h => h.rule === 'repeated_ending').length, 1);
});

test('300 normalized graphemes marks the reference threshold for supported prose only', () => {
  assert.equal(scoreText('가'.repeat(299) + ' ').abstain, true);
  assert.equal(scoreText('가'.normalize('NFD').repeat(300)).abstain, false);
  assert.equal(scoreText('가'.repeat(300), { kind: 'resume_form' }).abstain, true);
});
