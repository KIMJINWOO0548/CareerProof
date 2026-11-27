'use strict';

(() => {
  const help = document.querySelector('#help-dialog');
  const calibration = document.querySelector('#cal-dialog');
  const result = document.querySelector('#cal-result');
  const form = document.querySelector('#cal-form');
  const inputs = Array.from(form.querySelectorAll('input'));
  const helpOpen = document.querySelector('#help-open');

  helpOpen.addEventListener('click', () => help.showModal());
  document.querySelector('#help-close').addEventListener('click', () => help.close());
  help.querySelectorAll('[data-help-jump]').forEach(button => {
    button.addEventListener('click', () => {
      help.close();
      document.querySelector('.nav-link[data-page="' + button.dataset.helpJump + '"]').click();
      document.querySelector('#page-title').focus();
    });
  });

  document.addEventListener('click', event => {
    if (event.target.closest('[data-calibrate]')) {
      form.reset();
      result.textContent = '';
      calibration.showModal();
    }
  });
  document.querySelector('#cal-close').addEventListener('click', () => calibration.close());
  document.querySelector('#cal-sample').addEventListener('click', () => {
    [3, 4, 3].forEach((value, i) => { inputs[i].value = value; });
    form.requestSubmit();
  });
  form.addEventListener('input', () => { result.textContent = ''; });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const counts = inputs.map(input => input.value === '' ? null : input.valueAsNumber);
    if (counts.every(count => count === null)) {
      result.textContent = '한 가지 이상의 표시값을 입력하세요.';
      inputs[0].focus();
      return;
    }
    const candidates = [];
    for (const space of [0, 1]) {
      for (const newline of [0, 1, 2]) {
        for (const emoji of [1, 2]) {
          const predicted = [2 + space, 2 + newline, 1 + emoji];
          if (counts.every((count, i) => count === null || count === predicted[i])) {
            candidates.push([space, newline, emoji]);
          }
        }
      }
    }
    if (candidates.length === 1) {
      const [space, newline, emoji] = candidates[0];
      result.textContent = '일치 후보 1개 · 공백 ' + (space ? '포함' : '제외') + ' · 줄바꿈 ' + newline + '자 · 이모지 ' + emoji + '자';
    } else if (candidates.length) {
      result.textContent = '일치 후보 ' + candidates.length + '개 · 남은 예문의 표시값을 입력해 주세요.';
    } else {
      result.textContent = '일치하는 후보가 없습니다. 붙여넣은 예문과 사이트의 단위(자 또는 바이트)를 확인하세요.';
    }
  });
})();
