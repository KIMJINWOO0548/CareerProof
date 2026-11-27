import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrationProbes, matchCalibration } from '../frontend/calibration.js';
import { countText } from '../frontend/analysis.js';

test('세 예문으로 지원하는 문자 계산 조합을 구분한다', () => {
  for (const includeSpaces of [false, true]) {
    for (const newline of ['count_1', 'count_2', 'strip']) {
      for (const emojiPolicy of ['count_1', 'count_2', 'forbid', 'native']) {
        for (const charUnit of ['grapheme', 'utf16']) {
          const rule = { includeSpaces, newline, emojiPolicy, charUnit };
          const observations = Object.fromEntries(Object.entries(calibrationProbes)
            .map(([key, sample]) => [key, String(countText(sample, rule).chars)]));
          if (emojiPolicy === 'forbid') observations.emoji = 'forbid';
          const representative = emojiPolicy === 'native' && charUnit === 'grapheme'
            ? { ...rule, emojiPolicy: 'count_1' } : rule;
          assert.deepEqual(matchCalibration(observations), { status: 'matched', candidates: [representative] });
        }
      }
    }
  }
});

test('결합 문자 예문 미측정 시 동치성을 가정하지 않고 선택 가능한 두 규칙을 반환한다', () => {
  const result = matchCalibration({ spacing: '9', emoji: '4' });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(new Set(result.candidates.map(rule => rule.charUnit)), new Set(['utf16', 'grapheme']));
  assert.ok(result.candidates.every(rule => rule.includeSpaces && rule.newline === 'count_1' && rule.emojiPolicy === 'count_2'));
  for (const rule of result.candidates) {
    assert.equal(Object.hasOwn(rule, 'byteEncoding'), false);
    assert.equal(Object.hasOwn(rule, 'maxBytes'), false);
  }
});

test('이모지 입력 거부는 명시적 관찰이며 누락·0 사용 글자 수·지원하지 않는 글자 수는 각각 처리한다', () => {
  for (const observations of [{}, { spacing: '9' }, { emoji: 'forbid' }, { spacing: null, emoji: '' }]) {
    assert.deepEqual(matchCalibration(observations), { status: 'incomplete', candidates: [] });
  }
  assert.equal(matchCalibration({ spacing: '9', emoji: 'forbid', unit: '3' }).candidates[0].emojiPolicy, 'forbid');
  for (const count of ['0', '5', '100']) {
    assert.deepEqual(matchCalibration({ spacing: '9', emoji: count }), { status: 'none', candidates: [] });
  }
});

test('textarea.value.length를 사용하는 사이트의 이모지 복합문자는 UTF-16 원래 길이로 보정된다', () => {
  const readings = Object.fromEntries(Object.entries(calibrationProbes).map(([key, text]) => [key, text.length]));
  assert.deepEqual(readings, { spacing: 9, emoji: 6, unit: 4 });
  assert.deepEqual(matchCalibration(readings), {
    status: 'matched', candidates: [{ includeSpaces: true, newline: 'count_1', charUnit: 'utf16', emojiPolicy: 'native' }],
  });
});

test('소수, 음수, 부울, 지수 표기 및 안전 범위 밖의 숫자를 거절한다', () => {
  for (const value of ['2.5', -1, true, '1e1', 'Infinity', '9007199254740992']) {
    assert.deepEqual(matchCalibration({ spacing: value, emoji: '3' }), { status: 'invalid', candidates: [] });
  }
});
