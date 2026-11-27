import { countText } from './analysis.js';

export const calibrationProbes = Object.freeze({
  spacing: '가 나 다 라\n마',
  emoji: '가👍🏽나',
  unit: 'Ax\u0301B',
});

function measurement(input) {
  if (input == null || input === '') return null;
  if (typeof input !== 'number' && !(typeof input === 'string' && /^\d+$/.test(input))) return NaN;
  const value = Number(input);
  return Number.isSafeInteger(value) && value >= 0 ? value : NaN;
}

/** Match only observed character counts. An explicit rejection is distinct from a displayed zero. */
export function matchCalibration({ spacing, emoji, unit } = {}) {
  const spacingValue = measurement(spacing);
  const unitValue = measurement(unit);
  const rejectedEmoji = emoji === 'forbid';
  const emojiValue = rejectedEmoji ? null : measurement(emoji);
  if ([spacingValue, emojiValue, unitValue].some(Number.isNaN)) return { status: 'invalid', candidates: [] };
  if (spacingValue === null || (!rejectedEmoji && emojiValue === null)) {
    return { status: 'incomplete', candidates: [] };
  }

  const candidates = [];
  for (const includeSpaces of [true, false]) {
    for (const newline of ['strip', 'count_1', 'count_2']) {
      for (const charUnit of ['grapheme', 'utf16']) {
        const emojiOptions = rejectedEmoji ? ['forbid'] : ['count_1', 'count_2'];
        // A native grapheme always has width one, so count_1 already represents it.
        if (!rejectedEmoji && charUnit === 'utf16') emojiOptions.push('native');
        for (const emojiPolicy of emojiOptions) {
          const rule = { includeSpaces, newline, charUnit, emojiPolicy };
          if (countText(calibrationProbes.spacing, rule).chars !== spacingValue) continue;
          if (!rejectedEmoji && countText(calibrationProbes.emoji, rule).chars !== emojiValue) continue;
          if (unitValue !== null && countText(calibrationProbes.unit, rule).chars !== unitValue) continue;
          candidates.push(rule);
        }
      }
    }
  }
  const status = candidates.length === 0 ? 'none' : candidates.length === 1 ? 'matched' : 'ambiguous';
  return { status, candidates };
}

function describe(rule) {
  const newline = { count_1: '줄바꿈 1자', count_2: '줄바꿈 2자', strip: '줄바꿈 제외' };
  const emoji = { count_1: '이모지 1자', count_2: '이모지 2자', forbid: '이모지 금지', native: '이모지 원래 길이' };
  return [rule.includeSpaces ? '공백 포함' : '공백 제외', newline[rule.newline], emoji[rule.emojiPolicy],
    rule.charUnit === 'utf16' ? 'UTF-16' : '표시 문자'].join(' · ');
}

/** Mount on a question form after render, including forms inside dialogs. */
export function mountCalibration(form) {
  if (!form || form.querySelector('[data-calibration]')) return;
  const settings = form.querySelector('details');
  if (!settings) return;
  const section = document.createElement('details');
  section.className = 'action-details';
  section.dataset.calibration = '';
  section.innerHTML = `<summary>사이트 표시값으로 글자 수 보정</summary>
    <div class="form-flow">
      <p class="description">예문을 하나씩 복사해 비어 있는 지원 사이트 입력창에 붙여 넣고, 화면에 표시된 사용 글자 수를 입력하세요. 세 번째 예문으로 문자 단위를 구분할 수 있습니다.</p>
      <div class="form-flow" data-probes></div>
      <p class="description" role="status" aria-live="polite" data-result></p>
      <label class="field" data-picker hidden><span>적용할 계산 규칙</span><select></select></label>
      <div class="cta-row"><button type="button" class="btn" data-apply disabled>문항 설정에 적용</button></div>
    </div>`;
  settings.after(section);
  const probes = section.querySelector('[data-probes]');
  const observed = {};
  const labels = { spacing: '공백과 줄바꿈', emoji: '이모지', unit: '결합 문자 (선택)' };
  for (const [key, sample] of Object.entries(calibrationProbes)) {
    const row = document.createElement('div');
    row.className = 'form-flow';
    row.innerHTML = `<label class="field"><span></span><textarea readonly rows="${key === 'spacing' ? 2 : 1}"></textarea></label>
      <div class="field-grid"><button type="button" class="btn">예문 복사</button>
      <label class="field"><span>사이트 사용 글자 수</span><input type="text" inputmode="numeric" autocomplete="off"></label></div>`;
    row.querySelector('.field span').textContent = labels[key] + ' 예문';
    const example = row.querySelector('textarea');
    example.value = sample;
    observed[key] = row.querySelector('input');
    observed[key].setAttribute('aria-label', labels[key] + ' 예문의 사이트 사용 글자 수');
    row.querySelector('button').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(sample);
        result.textContent = labels[key] + ' 예문을 복사했습니다.';
      } catch {
        example.focus();
        example.select();
        result.textContent = '선택된 예문을 복사해 주세요.';
      }
    });
    probes.append(row);
    if (key === 'emoji') {
      const label = document.createElement('label');
      label.className = 'check-row';
      label.innerHTML = '<input type="checkbox" data-emoji-rejected>사이트가 이모지 입력을 거부함';
      row.append(label);
    }
  }
  const rejected = probes.querySelector('[data-emoji-rejected]');
  const result = section.querySelector('[data-result]');
  const picker = section.querySelector('[data-picker]');
  const select = picker.querySelector('select');
  const apply = section.querySelector('[data-apply]');
  let candidates = [];
  function refresh() {
    observed.emoji.disabled = rejected.checked;
    const match = matchCalibration({
      spacing: observed.spacing.value.trim(),
      emoji: rejected.checked ? 'forbid' : observed.emoji.value.trim(),
      unit: observed.unit.value.trim(),
    });
    candidates = match.candidates;
    picker.hidden = match.status !== 'ambiguous';
    select.replaceChildren(new Option('규칙을 선택하세요', ''));
    candidates.forEach((rule, i) => select.add(new Option(describe(rule), String(i))));
    apply.disabled = match.status !== 'matched';
    const descriptions = {
      invalid: '글자 수는 0 이상의 정수로 입력하세요.',
      incomplete: '공백·줄바꿈 예문과 이모지 예문의 결과를 입력하세요.',
      none: '일치하는 규칙이 없습니다. 남은 글자 수를 입력했는지, 예문 전체가 붙여 넣어졌는지 확인하세요.',
      ambiguous: `${candidates.length}개 규칙이 일치합니다. 결합 문자 예문을 측정하거나 적용할 규칙을 선택하세요.`,
      matched: candidates.length ? '일치한 규칙 · ' + describe(candidates[0]) : '',
    };
    result.textContent = descriptions[match.status];
  }
  probes.addEventListener('input', refresh);
  select.addEventListener('change', () => { apply.disabled = select.value === ''; });
  apply.addEventListener('click', () => {
    const rule = candidates.length === 1 ? candidates[0] : candidates.find((_, i) => String(i) === select.value);
    if (!rule) return;
    form.elements.spaces.checked = rule.includeSpaces;
    form.elements.newline.value = rule.newline;
    form.elements.unit.value = rule.charUnit;
    form.elements.emoji.value = rule.emojiPolicy;
    result.textContent = '문항 설정에 적용했습니다. ' + describe(rule);
  });
  refresh();
}
