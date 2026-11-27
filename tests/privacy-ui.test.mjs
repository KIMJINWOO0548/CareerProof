import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('document.querySelector("#privacy-erase").onclick'), source.lastIndexOf('mountRecovery();'));

function harness(response = {ok: true, deleted: true}, busy = false) {
  const nodes = Object.fromEntries(['#privacy-erase', '#privacy-consent', '#privacy-confirm', '#privacy-error', '[data-close]'].map(id => [id, {disabled: id === '#privacy-confirm', checked: false}]));
  const observed = {requests: [], reloads: [], dialog: ''};
  const context = {
    document: {querySelector: id => nodes[id]},
    openDialog(_title, html, bind) {observed.dialog = html; bind({querySelector: id => nodes[id]});},
    dialog: {addEventListener() {}, removeEventListener() {}},
    request: busy ? {} : null, openingWorker: false, committeeView: null, loops: new Map(),
    ensureSession: async () => {}, flushRunJournals: async () => {}, warnBeforeUnload() {},
    fetch: async (url, options) => {observed.requests.push({url, options}); return {ok: response.ok, json: async () => response};},
    window: {removeEventListener() {}, location: {pathname: '/', replace: path => observed.reloads.push(path)}},
  };
  vm.runInNewContext(handler, context);
  nodes['#privacy-erase'].onclick();
  return {nodes, observed};
}

test('erase requires explicit checked confirmation and resets only after server success', async () => {
  const {nodes, observed} = harness();
  await nodes['#privacy-confirm'].onclick();
  assert.equal(observed.requests.length, 0);
  nodes['#privacy-consent'].checked = true;
  nodes['#privacy-consent'].onchange();
  assert.equal(nodes['#privacy-confirm'].disabled, false);
  await nodes['#privacy-confirm'].onclick();
  assert.equal(observed.requests[0].url, '/api/history/erase');
  assert.deepEqual(JSON.parse(observed.requests[0].options.body), {confirm: 'erase-browser-workspace'});
  assert.deepEqual(observed.reloads, ['/']);
  assert.match(observed.dialog, /10분/);
  assert.match(observed.dialog, /다른 탭/);
  assert.match(observed.dialog, /미확인 비용/);
});

test('server refusal preserves document and allows retry; active local requests never erase', async () => {
  for (const busy of [false, true]) {
    const {nodes, observed} = harness({ok: false, error: 'synthetic refusal'}, busy);
    nodes['#privacy-consent'].checked = true;
    await nodes['#privacy-confirm'].onclick();
    assert.deepEqual(observed.reloads, []);
    assert.ok(nodes['#privacy-error'].textContent);
    assert.equal(nodes['#privacy-confirm'].disabled, false);
    assert.equal(nodes['#privacy-consent'].disabled, false);
    assert.equal(observed.requests.length, busy ? 0 : 1);
  }
});
