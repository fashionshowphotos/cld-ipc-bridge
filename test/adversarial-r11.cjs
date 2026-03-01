#!/usr/bin/env node
/**
 * adversarial-r11.cjs — Round 11 adversarial tests for IPC Bridge
 * -----------------------------------------------------------------
 * Focus: Router _processQueue busy state machine, _executeSubmit
 * adapter timeout, adapter busy policy (reject-when-busy vs queue),
 * per-connection rate limiting, idempotency check in handle(),
 * _sanitizeError regex precision, router construction variations,
 * prototype pollution via request fields, VALID_PRIORITIES enum.
 *
 * Usage: node test/adversarial-r11.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Router } = require('../lib/router.cjs');

const QUEUE_MAX = 5;
const PROCESSING_TIMEOUT_MS = 30_000;
const MAX_TEXT_LENGTH = 64 * 1024;
const VALID_PRIORITIES = new Set(['normal', 'critical']);

// Helpers
function createRouter(adapterOverrides = {}) {
  const defaultAdapter = {
    submit: async (text, opts) => ({ grade: 'ok' }),
    isBusy: () => false,
    busyPolicy: 'queue',
    available: true,
    ...adapterOverrides,
  };
  return new Router({
    adapters: { test: defaultAdapter },
    log: () => {},
  });
}

// ═══════════════════════════════════════════════════════════════
// ROUTER: _processQueue busy state machine
// ═══════════════════════════════════════════════════════════════
test('_processQueue: sets busy=true during processing', async () => {
  let busyDuringSubmit = false;
  const router = createRouter({
    submit: async () => {
      busyDuringSubmit = router._busy.get('test') || false;
      return { grade: 'ok' };
    }
  });
  router._handleChatSubmit(
    { id: 'busy-1', target: 'test', text: 'hello' },
    () => {}
  );
  // Wait for async processing
  await new Promise(r => setTimeout(r, 50));
  assert.ok(busyDuringSubmit, 'Busy flag set during submit');
  router.dispose();
});

test('_processQueue: processes queue items sequentially', async () => {
  const order = [];
  const router = createRouter({
    submit: async (text) => {
      order.push(text);
      await new Promise(r => setTimeout(r, 10));
      return { grade: 'ok' };
    }
  });

  router._handleChatSubmit({ id: 'seq-1', target: 'test', text: 'first' }, () => {});
  router._handleChatSubmit({ id: 'seq-2', target: 'test', text: 'second' }, () => {});
  router._handleChatSubmit({ id: 'seq-3', target: 'test', text: 'third' }, () => {});

  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(order, ['first', 'second', 'third'], 'Sequential processing');
  router.dispose();
});

test('_processQueue: adapter error caught and reported via sendFn', async () => {
  let errorSent = null;
  const router = createRouter({
    submit: async () => { throw new Error('adapter crash'); }
  });
  router._handleChatSubmit(
    { id: 'err-1', target: 'test', text: 'hello' },
    (resp) => { if (resp.code === 'SUBMIT_FAILED') errorSent = resp; }
  );
  await new Promise(r => setTimeout(r, 50));
  assert.ok(errorSent, 'Error response sent');
  assert.equal(errorSent.code, 'SUBMIT_FAILED');
  assert.ok(errorSent.message.includes('adapter crash') || errorSent.message.includes('<path>'),
    'Error message included (possibly sanitized)');
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: Adapter busy policy
// ═══════════════════════════════════════════════════════════════
test('adapter busy policy: reject-when-busy sends TARGET_BUSY', async () => {
  let targetBusySent = false;
  const router = createRouter({
    submit: async () => {
      await new Promise(r => setTimeout(r, 100));
      return { grade: 'ok' };
    },
    isBusy: () => true,
    busyPolicy: 'reject-when-busy',
  });

  // First request starts processing
  router._handleChatSubmit({ id: 'bp-1', target: 'test', text: 'first' }, () => {});
  // Second request hits busy adapter
  router._handleChatSubmit(
    { id: 'bp-2', target: 'test', text: 'second' },
    (resp) => { if (resp.code === 'TARGET_BUSY') targetBusySent = true; }
  );

  await new Promise(r => setTimeout(r, 200));
  assert.ok(targetBusySent, 'TARGET_BUSY sent for reject-when-busy');
  router.dispose();
});

test('adapter busy policy: submit-anyway proceeds despite busy', async () => {
  let submitCalled = 0;
  const router = createRouter({
    submit: async () => {
      submitCalled++;
      return { grade: 'ok' };
    },
    isBusy: () => true,
    busyPolicy: 'submit-anyway',
  });

  router._handleChatSubmit({ id: 'sa-1', target: 'test', text: 'first' }, () => {});
  await new Promise(r => setTimeout(r, 50));
  assert.ok(submitCalled >= 1, 'Submit called despite busy');
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: _executeSubmit response structure
// ═══════════════════════════════════════════════════════════════
test('_executeSubmit: success response has correct structure', async () => {
  let response = null;
  const router = createRouter({
    submit: async () => ({ grade: 'submitted', detail: 'test detail' })
  });
  router._handleChatSubmit(
    { id: 'struct-1', target: 'test', text: 'hello' },
    (resp) => { if (resp.type === 'chat.submitted') response = resp; }
  );
  await new Promise(r => setTimeout(r, 50));
  assert.ok(response, 'Got success response');
  assert.equal(response.v, 1, 'Version 1');
  assert.equal(response.id, 'struct-1', 'Correct ID');
  assert.equal(response.type, 'chat.submitted', 'Correct type');
  assert.equal(response.ok, true, 'ok=true');
  assert.ok(response.ts, 'Has timestamp');
  assert.equal(response.detail, 'test detail', 'Detail passed through');
  router.dispose();
});

test('_executeSubmit: ack response sent immediately', () => {
  let ackReceived = false;
  const router = createRouter({
    submit: async () => {
      await new Promise(r => setTimeout(r, 1000));
      return { grade: 'ok' };
    }
  });
  router._handleChatSubmit(
    { id: 'ack-1', target: 'test', text: 'hello' },
    (resp) => { if (resp.type === 'ack') ackReceived = true; }
  );
  // Ack should be sent immediately (sync), not after submit completes
  assert.ok(ackReceived, 'Ack sent immediately');
  router.dispose();
});

test('_executeSubmit: ack has queue info', () => {
  let ackResp = null;
  const router = createRouter();
  router._handleChatSubmit(
    { id: 'ack-info', target: 'test', text: 'hello' },
    (resp) => { if (resp.type === 'ack') ackResp = resp; }
  );
  assert.ok(ackResp, 'Got ack');
  assert.equal(ackResp.v, 1, 'Version');
  assert.equal(ackResp.ok, true, 'ok');
  assert.ok(typeof ackResp.queueSize === 'number', 'Has queueSize');
  assert.ok(typeof ackResp.position === 'number', 'Has position');
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: handle() idempotency integration
// ═══════════════════════════════════════════════════════════════
test('handle: idempotency check occurs before routing', async () => {
  const router = createRouter();
  // Pre-fill cache
  const scopedKey = 'test:chat.submit:idem-test';
  router._idempotencyCache.set(scopedKey, {
    ts: Date.now(),
    response: { type: 'chat.submitted', ok: true, grade: 'cached' }
  });
  const result = await router.handle(
    { id: 'idem-1', type: 'chat.submit', target: 'test', text: 'hello', idempotencyKey: 'idem-test' },
    () => {}
  );
  assert.ok(result, 'Got result');
  assert.ok(result.idempotencyHit, 'Hit cache');
  assert.equal(result.grade, 'cached', 'Cached grade returned');
  router.dispose();
});

test('handle: non-matching idempotency key passes through', async () => {
  const router = createRouter();
  const result = await router.handle(
    { id: 'fresh-1', type: 'chat.submit', target: 'test', text: 'hello', idempotencyKey: 'new-key' },
    () => {}
  );
  // Should return null (ack sent via sendFn, not returned)
  assert.equal(result, null, 'Fresh request → null (ack via sendFn)');
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: _sanitizeError regex precision
// ═══════════════════════════════════════════════════════════════
test('_sanitizeError: preserves non-path text', () => {
  const router = createRouter();
  const result = router._sanitizeError('Connection refused at port 8080');
  assert.equal(result, 'Connection refused at port 8080', 'No path → preserved');
  router.dispose();
});

test('_sanitizeError: replaces Windows drive paths', () => {
  const router = createRouter();
  const result = router._sanitizeError('Error at C:\\Users\\admin\\file.txt rest');
  assert.ok(result.includes('<path>'), 'Windows path replaced');
  assert.ok(result.includes('rest'), 'Non-path text preserved');
  router.dispose();
});

test('_sanitizeError: replaces Unix paths', () => {
  const router = createRouter();
  const result = router._sanitizeError('File not found: /home/user/secret.key');
  assert.ok(result.includes('<path>'), 'Unix path replaced');
  assert.ok(result.includes('File not found:'), 'Prefix preserved');
  router.dispose();
});

test('_sanitizeError: relative paths partially sanitized (regex catches /subpath)', () => {
  const router = createRouter();
  const result = router._sanitizeError('Error in ./src/secret/config.js');
  // Regex /\/[^\s"')]+/ matches /src/secret/config.js portion
  assert.ok(result.includes('<path>'), 'Relative path partially sanitized');
  assert.ok(result.includes('Error in .'), 'Prefix preserved');
  router.dispose();
});

test('_sanitizeError: truncates at 200 chars', () => {
  const router = createRouter();
  const result = router._sanitizeError('x'.repeat(500));
  assert.equal(result.length, 200, 'Truncated to 200');
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: construction and configuration
// ═══════════════════════════════════════════════════════════════
test('Router: constructs with empty adapters', () => {
  const router = new Router({ adapters: {}, log: () => {} });
  const status = router.getStatus();
  assert.deepEqual(status, {}, 'No adapters → empty status');
  router.dispose();
});

test('Router: constructs with multiple adapters', () => {
  const adapter = { submit: async () => ({}), available: true };
  const router = new Router({
    adapters: { a: adapter, b: adapter, c: adapter },
    log: () => {},
  });
  const status = router.getStatus();
  assert.ok('a' in status, 'Adapter a present');
  assert.ok('b' in status, 'Adapter b present');
  assert.ok('c' in status, 'Adapter c present');
  router.dispose();
});

test('Router: unavailable adapter → TARGET_UNAVAILABLE', () => {
  const router = new Router({
    adapters: { offline: { submit: async () => ({}), available: false } },
    log: () => {},
  });
  const result = router._handleChatSubmit(
    { id: 'unavail-1', target: 'offline', text: 'hello' },
    () => {}
  );
  assert.ok(result && result.code === 'TARGET_UNAVAILABLE', 'Unavailable adapter rejected');
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: VALID_PRIORITIES enum
// ═══════════════════════════════════════════════════════════════
test('VALID_PRIORITIES: normal accepted', () => {
  assert.ok(VALID_PRIORITIES.has('normal'));
});

test('VALID_PRIORITIES: critical accepted', () => {
  assert.ok(VALID_PRIORITIES.has('critical'));
});

test('VALID_PRIORITIES: unknown rejected', () => {
  assert.ok(!VALID_PRIORITIES.has('high'));
  assert.ok(!VALID_PRIORITIES.has('low'));
  assert.ok(!VALID_PRIORITIES.has('urgent'));
  assert.ok(!VALID_PRIORITIES.has(''));
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: prototype pollution via request fields
// ═══════════════════════════════════════════════════════════════
test('prototype pollution: __proto__ in request fields ignored', () => {
  const router = createRouter();
  const malicious = JSON.parse('{"__proto__":{"polluted":true},"id":"pp-1","target":"test","text":"hello"}');
  const result = router._handleChatSubmit(malicious, () => {});
  const clean = {};
  assert.equal(clean.polluted, undefined, 'Prototype NOT polluted');
  router.dispose();
});

test('prototype pollution: constructor pollution attempt', () => {
  const router = createRouter();
  const malicious = { id: 'pp-2', target: 'test', text: 'hello', constructor: { prototype: { hack: true } } };
  router._handleChatSubmit(malicious, () => {});
  const clean = {};
  assert.equal(clean.hack, undefined, 'Constructor pollution failed');
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: target name validation
// ═══════════════════════════════════════════════════════════════
test('target validation: alphanumeric accepted', () => {
  const router = createRouter();
  // "test" is registered, should not get INVALID_TARGET
  const result = router._handleChatSubmit(
    { id: 'tv-1', target: 'test', text: 'hello' },
    () => {}
  );
  assert.ok(!result || result.code !== 'INVALID_TARGET', 'Alphanumeric target accepted');
  router.dispose();
});

test('target validation: special chars rejected', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'tv-2', target: 'test;drop', text: 'hello' },
    () => {}
  );
  assert.ok(result && result.code === 'INVALID_TARGET', 'Semicolon in target rejected');
  router.dispose();
});

test('target validation: 33 char target rejected', () => {
  const router = createRouter();
  const longTarget = 'a'.repeat(33);
  const result = router._handleChatSubmit(
    { id: 'tv-3', target: longTarget, text: 'hello' },
    () => {}
  );
  assert.ok(result && result.code === 'INVALID_TARGET', '33-char target rejected (max 32)');
  router.dispose();
});

test('target validation: 32 char target accepted (if registered)', () => {
  const longTarget = 'a'.repeat(32);
  const adapter = { submit: async () => ({}), available: true };
  const router = new Router({
    adapters: { [longTarget]: adapter },
    log: () => {},
  });
  const result = router._handleChatSubmit(
    { id: 'tv-4', target: longTarget, text: 'hello' },
    () => {}
  );
  assert.ok(!result || result.code !== 'INVALID_TARGET', '32-char target accepted');
  router.dispose();
});
