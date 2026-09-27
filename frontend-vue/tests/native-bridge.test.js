/*
 * Unit tests for the host binding layer: how a binding is resolved (direct
 * global vs. the WebView bridge) and how a native outcome is normalized for
 * callers that only branch on `result.error`.
 */

import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { getNativeBinding, runNativeCall } from '../src/native-bridge.js';

const originalWindow = globalThis.window;

after(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

test('a direct global binding wins over the WebView bridge', () => {
  const calls = [];
  globalThis.window = {
    openPdf: () => {
      calls.push('direct');
      return 'direct-result';
    },
    __webview__: {
      call: (name) => calls.push(`bridge:${name}`),
    },
  };

  const binding = getNativeBinding('openPdf');
  assert.equal(typeof binding, 'function');
  assert.equal(binding(), 'direct-result');
  assert.deepEqual(calls, ['direct']);
});

test('the bridge is used when the global is missing or not callable', () => {
  globalThis.window = {
    extractPdfToc: 'not-a-function',
    __webview__: { call: (name) => `bridge:${name}` },
  };
  assert.equal(getNativeBinding('extractPdfToc')(), 'bridge:extractPdfToc');

  globalThis.window = { __webview__: { call: (name) => `bridge:${name}` } };
  assert.equal(
    getNativeBinding('openImageDirectory')(),
    'bridge:openImageDirectory',
  );
});

test('a missing binding returns null outside the host', () => {
  globalThis.window = {};
  assert.equal(getNativeBinding('openPdf'), null);

  globalThis.window = { __webview__: { call: 'nope' } };
  assert.equal(getNativeBinding('openPdf'), null);

  globalThis.window = undefined;
  assert.throws(() => getNativeBinding('openPdf'), TypeError);
});

test('runNativeCall passes object payloads through untouched', async () => {
  const payload = {
    images: [{ name: 'a.png' }],
    name: 'Photos',
    cached: false,
  };
  assert.deepEqual(await runNativeCall(async () => payload), payload);
  assert.deepEqual(await runNativeCall(() => ({})), {});
  assert.deepEqual(await runNativeCall(() => []), []);
});

test('runNativeCall turns a non-object answer into an empty object', async () => {
  assert.deepEqual(await runNativeCall(() => undefined), {});
  assert.deepEqual(await runNativeCall(() => null), {});
  assert.deepEqual(await runNativeCall(() => 'ok'), {});
  assert.deepEqual(await runNativeCall(() => 42), {});
});

test('runNativeCall reports thrown errors as { error: { message } }', async () => {
  assert.deepEqual(
    await runNativeCall(() => {
      throw new Error('boom');
    }),
    { error: { message: 'boom' } },
  );

  assert.deepEqual(
    await runNativeCall(() => {
      throw 'plain string';
    }),
    { error: { message: 'plain string' } },
  );

  const rejected = await runNativeCall(async () => {
    throw new TypeError('async failure');
  });
  assert.equal(rejected.error.message, 'async failure');
});

test('runNativeCall keeps a host rejection shape so reports keep their code', async () => {
  const hostError = { error: { code: 'INVALID_CONTENT', message: 'damaged' } };
  const result = await runNativeCall(async () => {
    throw hostError;
  });
  assert.deepEqual(result, hostError);

  const resolvedError = await runNativeCall(async () => hostError);
  assert.deepEqual(resolvedError, hostError);
});

test('binding arguments are forwarded on both paths', () => {
  const directArgs = [];
  globalThis.window = {
    saveTextFile: (...args) => {
      directArgs.push(args);
      return 'direct-saved';
    },
  };
  const direct = getNativeBinding('saveTextFile');
  assert.equal(direct('outline.json', '{"a":1}'), 'direct-saved');
  assert.deepEqual(directArgs, [['outline.json', '{"a":1}']]);

  const bridgeArgs = [];
  globalThis.window = {
    __webview__: {
      call: (...args) => {
        bridgeArgs.push(args);
        return 'bridge-saved';
      },
    },
  };
  const bridged = getNativeBinding('saveTextFile');
  assert.equal(bridged('outline.json', '{"a":1}'), 'bridge-saved');
  assert.deepEqual(bridgeArgs, [['saveTextFile', 'outline.json', '{"a":1}']]);

  // Zero-argument calls keep working after the forwarding change.
  globalThis.window = { openPdf: () => 'opened' };
  assert.equal(getNativeBinding('openPdf')(), 'opened');
});
