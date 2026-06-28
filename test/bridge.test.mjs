import test from 'node:test';
import assert from 'node:assert/strict';

import { loadBridge } from '../bridge_harness.mjs';

// These run the REAL da_browser_core_bridge.js against a stubbed callHandler, so
// they catch bridge-contract drift the Dart tests can't — e.g. the host-call
// payload keys a plugin author actually depends on.

test('da.host.language.getTermReadingPairs forwards the script option', async () => {
  const { da, hostCalls } = loadBridge();
  const pairs = [{ term: '日', reading: 'ひ' }];

  await da.scope('p').host.language.getTermReadingPairs(pairs, { script: 'katakana' });

  const call = hostCalls()[0];
  assert.equal(call.plugin, 'p');
  assert.equal(call.capability, 'language');
  assert.equal(call.op, 'getTermReadingPairs');
  assert.deepEqual(call.args, { pairs, script: 'katakana' });
});

test('da.host.ocr.full forwards image, languages, level, and engine', async () => {
  const { da, hostCalls } = loadBridge();

  await da.scope('p').host.ocr.full('BASE64', {
    languages: ['jpn'],
    level: 'accurate',
    engine: 'system',
  });

  const call = hostCalls()[0];
  assert.equal(call.capability, 'ocr');
  assert.equal(call.op, 'full');
  assert.deepEqual(call.args, { image: 'BASE64', languages: ['jpn'], level: 'accurate' });
  assert.equal(call.engine, 'system');
});

test('each scope binds its own plugin id into host calls', async () => {
  const { da, hostCalls } = loadBridge();

  await da.scope('alpha').host.tts('hi');
  await da.scope('beta').host.tts('yo');

  assert.deepEqual(hostCalls().map((c) => c.plugin), ['alpha', 'beta']);
});

test('da.emit posts {plugin, event, data} to the bridge channel', () => {
  const { da, bridgeCalls } = loadBridge();

  da.scope('p').emit('selection', { text: 'x' });

  assert.deepEqual(bridgeCalls()[0], { plugin: 'p', event: 'selection', data: { text: 'x' } });
});

test('__da.matches mirrors the Dart matchesUrl rules', () => {
  const { da } = loadBridge();

  assert.equal(da.matches('https://x.test/a', ['<all_urls>']), true);
  assert.equal(da.matches('https://x.test', []), false);
  assert.equal(da.matches('https://www.youtube.com/watch', ['*://*.youtube.com/*']), true);
  assert.equal(da.matches('https://vimeo.com/1', ['*://*.youtube.com/*']), false);
  assert.equal(da.matches('https://x.test/abc', ['https://x.test/a']), false); // anchored
});

test('__da.invoke calls a registered handler and returns its result', async () => {
  const { da } = loadBridge();
  const scope = da.scope('p');
  scope.register('greet', (args) => `hi ${args.name}`);

  assert.equal(await da.invoke('p', 'greet', { name: 'x' }), 'hi x');
});
