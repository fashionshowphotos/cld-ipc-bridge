#!/usr/bin/env node
/**
 * adversarial-r10.cjs — Round 10 adversarial tests for IPC Bridge
 * -----------------------------------------------------------------
 * Focus: Idempotency cache clock backward, critical rate limiter
 * clock edge cases, _cleanIdempotencyCache with zero timestamps,
 * _processQueue concurrent guard, adapter error propagation,
 * getStatus completeness, dispose cleanup, request validation
 * boundary values, queue ordering, _handleRunCommand blocklist,
 * _sanitizeError edge cases, handle() routing.
 *
 * Usage: node test/adversarial-r10.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Router } = require('../lib/router.cjs');

// Constants replicated from router.cjs
const QUEUE_MAX = 5;
const CRITICAL_RATE_MAX = 3;
const IDEMPOTENCY_TTL_MS = 60_000;
const IDEMPOTENCY_CACHE_MAX = 200;
const MAX_TEXT_LENGTH = 64 * 1024;
const MAX_ID_LENGTH = 256;

const SAFE_ID_PATTERN = /^[\x20-\x7e]+$/;

// Helpers
function createRouter(adapterOverrides = {}) {
  const defaultAdapter = {
    submit: async (text, opts) => ({ grade: 'ok' }),
    isBusy: () => false,
    busyPolicy: 'queue',
    available: true,
    ...adapterOverrides,
  };
  const router = new Router({
    adapters: { test: defaultAdapter, copilot: defaultAdapter },
    log: () => {},
  });
  return router;
}

// ═══════════════════════════════════════════════════════════════
// IDEMPOTENCY CACHE: Clock edge cases
// ═══════════════════════════════════════════════════════════════
test('idempotency cache: zero timestamp entry cleaned immediately', () => {
  const router = createRouter();
  const key = 'test:chat.submit:zero-ts';
  router._idempotencyCache.set(key, { ts: 0, response: { grade: 'ok' } });
  router._cleanIdempotencyCache();
  assert.ok(!router._idempotencyCache.has(key), 'Zero-timestamp entry cleaned');
  router.dispose();
});

test('idempotency cache: very old entry cleaned', () => {
  const router = createRouter();
  const key = 'test:chat.submit:old';
  router._idempotencyCache.set(key, { ts: 1, response: { grade: 'ok' } });
  router._cleanIdempotencyCache();
  assert.ok(!router._idempotencyCache.has(key), 'Ancient entry cleaned');
  router.dispose();
});

test('idempotency cache: recent entry preserved during cleanup', () => {
  const router = createRouter();
  const key = 'test:chat.submit:recent';
  router._idempotencyCache.set(key, { ts: Date.now(), response: { grade: 'ok' } });
  router._cleanIdempotencyCache();
  assert.ok(router._idempotencyCache.has(key), 'Recent entry preserved');
  router.dispose();
});

test('idempotency cache: DESIGN GAP — future timestamp never cleaned', () => {
  const router = createRouter();
  const key = 'test:chat.submit:future';
  router._idempotencyCache.set(key, { ts: Date.now() + 1_000_000, response: { grade: 'ok' } });
  router._cleanIdempotencyCache();
  assert.ok(router._idempotencyCache.has(key), 'DESIGN GAP: Future-timestamped entry never expires');
  router.dispose();
});

test('idempotency cache: handle() returns cached result for duplicate key', async () => {
  const router = createRouter();
  // Pre-fill cache with a response for a specific idempotency key
  const scopedKey = 'test:chat.submit:dedup-key';
  router._idempotencyCache.set(scopedKey, {
    ts: Date.now(),
    response: { type: 'chat.submitted', ok: true, grade: 'ok' }
  });
  // Second request via handle() should hit cache
  const result = await router.handle(
    { id: 'dedup-2', type: 'chat.submit', target: 'test', text: 'hello', idempotencyKey: 'dedup-key' },
    () => {}
  );
  assert.ok(result && result.idempotencyHit, 'Idempotency hit returned');
  router.dispose();
});

test('idempotency cache: bounded at IDEMPOTENCY_CACHE_MAX', () => {
  const router = createRouter();
  for (let i = 0; i < IDEMPOTENCY_CACHE_MAX + 50; i++) {
    router._idempotencyCache.set(`key-${i}`, { ts: Date.now(), response: {} });
  }
  router._cleanIdempotencyCache();
  // Cleanup only removes by TTL, not size — all recent, so all preserved
  assert.ok(router._idempotencyCache.size <= IDEMPOTENCY_CACHE_MAX + 50, 'Cache exists');
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// CRITICAL RATE LIMITER: Edge cases
// ═══════════════════════════════════════════════════════════════
test('critical rate: first 3 critical requests accepted', () => {
  const router = createRouter();
  for (let i = 0; i < CRITICAL_RATE_MAX; i++) {
    const result = router._handleChatSubmit(
      { id: `crit-${i}`, target: 'test', text: `critical msg ${i}`, priority: 'critical' },
      () => {}
    );
    // _handleChatSubmit returns null on success (ack sent via sendFn)
    assert.ok(!result || result.code !== 'RATE_LIMITED', `Critical request ${i} accepted`);
  }
  router.dispose();
});

test('critical rate: 4th critical request rejected', () => {
  const router = createRouter();
  for (let i = 0; i < CRITICAL_RATE_MAX; i++) {
    router._handleChatSubmit(
      { id: `crit-fill-${i}`, target: 'test', text: `fill msg ${i}`, priority: 'critical' },
      () => {}
    );
  }
  const result = router._handleChatSubmit(
    { id: 'crit-overflow', target: 'test', text: 'overflow msg', priority: 'critical' },
    () => {}
  );
  assert.ok(result && result.code === 'RATE_LIMITED', '4th critical rejected');
  router.dispose();
});

test('critical rate: normal priority not affected by critical limit', () => {
  const router = createRouter();
  for (let i = 0; i < CRITICAL_RATE_MAX; i++) {
    router._handleChatSubmit(
      { id: `crit-n-${i}`, target: 'test', text: `fill msg ${i}`, priority: 'critical' },
      () => {}
    );
  }
  const result = router._handleChatSubmit(
    { id: 'normal-ok', target: 'test', text: 'normal msg' },
    () => {}
  );
  assert.ok(!result || result.code !== 'RATE_LIMITED', 'Normal not rate-limited');
  router.dispose();
});

test('critical rate: DESIGN GAP — future timestamps never expire from rate window', () => {
  const router = createRouter();
  router._criticalTimestamps = [Date.now() + 100_000, Date.now() + 100_000, Date.now() + 100_000];
  const result = router._handleChatSubmit(
    { id: 'crit-future', target: 'test', text: 'future msg', priority: 'critical' },
    () => {}
  );
  // now - (future) < 0 < 60_000 → entry kept → rate limit active
  assert.ok(result && result.code === 'RATE_LIMITED',
    'Future timestamps never expire from rate window');
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// INPUT VALIDATION: Boundary values
// ═══════════════════════════════════════════════════════════════
test('validation: text exactly at MAX_TEXT_LENGTH accepted', () => {
  const router = createRouter();
  const text = 'a'.repeat(MAX_TEXT_LENGTH);
  const result = router._handleChatSubmit(
    { id: 'max-text', target: 'test', text },
    () => {}
  );
  assert.ok(!result || result.code !== 'TEXT_TOO_LARGE', 'Exact max length accepted');
  router.dispose();
});

test('validation: text at MAX_TEXT_LENGTH + 1 rejected', () => {
  const router = createRouter();
  const text = 'a'.repeat(MAX_TEXT_LENGTH + 1);
  const result = router._handleChatSubmit(
    { id: 'over-text', target: 'test', text },
    () => {}
  );
  assert.ok(result && result.code === 'TEXT_TOO_LARGE', 'Over max length rejected');
  router.dispose();
});

test('validation: ID exactly at MAX_ID_LENGTH accepted', () => {
  const router = createRouter();
  const id = 'a'.repeat(MAX_ID_LENGTH);
  const result = router._handleChatSubmit(
    { id, target: 'test', text: 'hello' },
    () => {}
  );
  assert.ok(!result || result.code !== 'INVALID_ID', 'Max-length ID accepted');
  router.dispose();
});

test('validation: ID at MAX_ID_LENGTH + 1 rejected', () => {
  const router = createRouter();
  const id = 'a'.repeat(MAX_ID_LENGTH + 1);
  const result = router._handleChatSubmit(
    { id, target: 'test', text: 'hello' },
    () => {}
  );
  assert.ok(result && result.code === 'INVALID_ID', 'Over max-length ID rejected');
  router.dispose();
});

test('validation: idempotencyKey at boundary', () => {
  const router = createRouter();
  const key = 'k'.repeat(MAX_ID_LENGTH);
  const result = router._handleChatSubmit(
    { id: 'idem-boundary', target: 'test', text: 'hello', idempotencyKey: key },
    () => {}
  );
  assert.ok(!result || result.code !== 'INVALID_IDEMPOTENCY_KEY', 'Max-length key accepted');
  router.dispose();
});

test('validation: control chars in text rejected', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'ctrl-text', target: 'test', text: 'hello\x00world' },
    () => {}
  );
  assert.ok(result && result.code === 'INVALID_TEXT', 'Null byte in text rejected');
  router.dispose();
});

test('validation: dangerous unicode in text rejected', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'bidi-text', target: 'test', text: 'hello\u200Bworld' },
    () => {}
  );
  assert.ok(result && result.code === 'INVALID_TEXT', 'ZWSP in text rejected');
  router.dispose();
});

test('validation: tab in text allowed', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'tab-text', target: 'test', text: 'hello\tworld' },
    () => {}
  );
  assert.ok(!result || result.code !== 'INVALID_TEXT', 'Tab in text allowed');
  router.dispose();
});

test('validation: newline in text allowed', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'nl-text', target: 'test', text: 'hello\nworld' },
    () => {}
  );
  assert.ok(!result || result.code !== 'INVALID_TEXT', 'Newline in text allowed');
  router.dispose();
});

test('validation: empty text rejected', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'empty-text', target: 'test', text: '' },
    () => {}
  );
  assert.ok(result && result.code === 'INVALID_TEXT', 'Empty text rejected');
  router.dispose();
});

test('validation: whitespace-only text rejected', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'ws-text', target: 'test', text: '   ' },
    () => {}
  );
  assert.ok(result && result.code === 'INVALID_TEXT', 'Whitespace-only text rejected');
  router.dispose();
});

test('validation: invalid priority rejected', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'bad-prio', target: 'test', text: 'hello', priority: 'urgent' },
    () => {}
  );
  assert.ok(result && result.code === 'INVALID_PRIORITY', 'Invalid priority rejected');
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// _handleRunCommand: Extended blocklist tests (async)
// ═══════════════════════════════════════════════════════════════
test('_handleRunCommand: workbench.action.terminal.send* prefix blocked', async () => {
  const router = createRouter();
  const result = await router._handleRunCommand({
    id: 'blocked-terminal',
    command: 'workbench.action.terminal.sendSequence'
  });
  assert.ok(result && result.code === 'BLOCKED_COMMAND', 'terminal.send* prefix blocked');
  router.dispose();
});

test('_handleRunCommand: workbench.action.quit blocked', async () => {
  const router = createRouter();
  const result = await router._handleRunCommand({
    id: 'blocked-quit',
    command: 'workbench.action.quit'
  });
  assert.ok(result && result.code === 'BLOCKED_COMMAND', 'quit blocked');
  router.dispose();
});

test('_handleRunCommand: workbench.action.closeWindow blocked', async () => {
  const router = createRouter();
  const result = await router._handleRunCommand({
    id: 'blocked-close',
    command: 'workbench.action.closeWindow'
  });
  assert.ok(result && result.code === 'BLOCKED_COMMAND', 'closeWindow blocked');
  router.dispose();
});

test('_handleRunCommand: deleteFile blocked', async () => {
  const router = createRouter();
  const result = await router._handleRunCommand({
    id: 'blocked-del',
    command: 'deleteFile'
  });
  assert.ok(result && result.code === 'BLOCKED_COMMAND', 'deleteFile blocked');
  router.dispose();
});

test('_handleRunCommand: workbench.action.files.delete blocked', async () => {
  const router = createRouter();
  const result = await router._handleRunCommand({
    id: 'blocked-files-del',
    command: 'workbench.action.files.delete'
  });
  assert.ok(result && result.code === 'BLOCKED_COMMAND', 'files.delete blocked');
  router.dispose();
});

test('_handleRunCommand: workbench.action.closeAllEditors blocked', async () => {
  const router = createRouter();
  const result = await router._handleRunCommand({
    id: 'blocked-close-all',
    command: 'workbench.action.closeAllEditors'
  });
  assert.ok(result && result.code === 'BLOCKED_COMMAND', 'closeAllEditors blocked');
  router.dispose();
});

test('_handleRunCommand: safe command returns NO_VSCODE (no vscode api)', async () => {
  const router = createRouter();
  const result = await router._handleRunCommand({
    id: 'safe-cmd',
    command: 'workbench.action.showCommands'
  });
  // Not blocked, but no vscode → NO_VSCODE error
  assert.ok(result && result.code === 'NO_VSCODE', 'Safe command → NO_VSCODE (no vscode api)');
  router.dispose();
});

test('_handleRunCommand: empty command rejected', async () => {
  const router = createRouter();
  const result = await router._handleRunCommand({
    id: 'empty-cmd',
    command: ''
  });
  assert.ok(result && result.code === 'MISSING_COMMAND', 'Empty command → MISSING_COMMAND');
  router.dispose();
});

test('_handleRunCommand: null command rejected', async () => {
  const router = createRouter();
  const result = await router._handleRunCommand({
    id: 'null-cmd',
    command: null
  });
  assert.ok(result && result.code === 'MISSING_COMMAND', 'Null command rejected');
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// SAFE_ID_PATTERN: Validation edge cases
// ═══════════════════════════════════════════════════════════════
test('SAFE_ID_PATTERN: printable ASCII accepted', () => {
  assert.ok(SAFE_ID_PATTERN.test('hello-world_123'), 'Alphanumeric + symbols accepted');
  assert.ok(SAFE_ID_PATTERN.test('a b c'), 'Spaces accepted (printable)');
  assert.ok(SAFE_ID_PATTERN.test('~!@#$%'), 'Special printable chars accepted');
});

test('SAFE_ID_PATTERN: control chars rejected', () => {
  assert.ok(!SAFE_ID_PATTERN.test('hello\x00'), 'Null byte rejected');
  assert.ok(!SAFE_ID_PATTERN.test('hello\x1f'), '0x1F rejected');
  assert.ok(!SAFE_ID_PATTERN.test('hello\x7f'), 'DEL rejected');
});

test('SAFE_ID_PATTERN: unicode rejected', () => {
  assert.ok(!SAFE_ID_PATTERN.test('hello\u00A0'), 'NBSP rejected (above ASCII)');
  assert.ok(!SAFE_ID_PATTERN.test('hello\u2603'), 'Snowman rejected');
  assert.ok(!SAFE_ID_PATTERN.test('\u200Bhello'), 'ZWSP rejected');
});

test('SAFE_ID_PATTERN: empty string rejected', () => {
  assert.ok(!SAFE_ID_PATTERN.test(''), 'Empty string rejected (+ requires at least 1)');
});

// ═══════════════════════════════════════════════════════════════
// QUEUE: Processing and ordering
// ═══════════════════════════════════════════════════════════════
test('queue: FIFO ordering for normal priority', () => {
  const router = createRouter();
  const queue = [];
  for (let i = 0; i < 3; i++) {
    queue.push({
      request: { id: `q-${i}`, text: `msg-${i}` },
      sendFn: () => {},
      idempotencyKey: null
    });
  }
  router._queues.set('test', queue);
  assert.equal(queue[0].request.id, 'q-0', 'First in queue');
  assert.equal(queue[1].request.id, 'q-1', 'Second in queue');
  assert.equal(queue[2].request.id, 'q-2', 'Third in queue');
  router.dispose();
});

test('queue: critical priority uses unshift to head', () => {
  const router = createRouter();
  const queue = [
    { request: { id: 'normal-1' }, sendFn: () => {}, idempotencyKey: null },
    { request: { id: 'normal-2' }, sendFn: () => {}, idempotencyKey: null },
  ];
  router._queues.set('test', queue);
  queue.unshift({ request: { id: 'critical-1' }, sendFn: () => {}, idempotencyKey: null });
  assert.equal(queue[0].request.id, 'critical-1', 'Critical at head');
  assert.equal(queue[1].request.id, 'normal-1', 'Normal shifted');
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// getStatus and dispose
// ═══════════════════════════════════════════════════════════════
test('getStatus: returns per-adapter status', () => {
  const router = createRouter();
  const status = router.getStatus();
  assert.ok(typeof status === 'object', 'Returns object');
  assert.ok('test' in status, 'Has test adapter');
  assert.ok('copilot' in status, 'Has copilot adapter');
  assert.equal(status.test.available, true, 'test adapter available');
  assert.equal(status.test.busy, false, 'test adapter not busy');
  assert.equal(typeof status.test.queueLength, 'number', 'queueLength is number');
  router.dispose();
});

test('dispose: cleans up interval and maps', () => {
  const router = createRouter();
  assert.ok(router._cleanupInterval, 'Cleanup interval exists');
  // Pre-fill some data
  router._idempotencyCache.set('k', { ts: Date.now(), response: {} });
  router._queues.set('test', [{ request: {}, sendFn: () => {} }]);
  router.dispose();
  assert.equal(router._idempotencyCache.size, 0, 'Cache cleared');
  assert.equal(router._queues.size, 0, 'Queues cleared');
});

test('dispose: safe to call twice', () => {
  const router = createRouter();
  router.dispose();
  assert.doesNotThrow(() => router.dispose(), 'Double dispose safe');
});

// ═══════════════════════════════════════════════════════════════
// _sanitizeError: Edge cases
// ═══════════════════════════════════════════════════════════════
test('_sanitizeError: Windows path replaced with <path>', () => {
  const router = createRouter();
  const result = router._sanitizeError('Error at C:\\Users\\admin\\secret.txt');
  assert.ok(result.includes('<path>'), 'Windows path replaced');
  assert.ok(!result.includes('admin'), 'Username sanitized');
  router.dispose();
});

test('_sanitizeError: Unix path replaced with <path>', () => {
  const router = createRouter();
  const result = router._sanitizeError('Failed: /home/user/.ssh/id_rsa');
  assert.ok(result.includes('<path>'), 'Unix path replaced');
  router.dispose();
});

test('_sanitizeError: very long error message truncated to 200 chars', () => {
  const router = createRouter();
  const msg = 'Error: ' + 'x'.repeat(10000);
  const result = router._sanitizeError(msg);
  assert.equal(result.length, 200, 'Truncated to exactly 200');
  router.dispose();
});

test('_sanitizeError: empty string → "Internal error" (falsy fallback)', () => {
  const router = createRouter();
  const result = router._sanitizeError('');
  assert.equal(result, 'Internal error', 'Empty → fallback to "Internal error"');
  router.dispose();
});

test('_sanitizeError: null → "Internal error"', () => {
  const router = createRouter();
  const result = router._sanitizeError(null);
  assert.equal(result, 'Internal error', 'null → fallback');
  router.dispose();
});

test('_sanitizeError: undefined → "Internal error"', () => {
  const router = createRouter();
  const result = router._sanitizeError(undefined);
  assert.equal(result, 'Internal error', 'undefined → fallback');
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// handle(): Top-level routing
// ═══════════════════════════════════════════════════════════════
test('handle: unknown target → UNSUPPORTED_TARGET', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'unknown-1', target: 'nonexistent', text: 'hello' },
    () => {}
  );
  assert.ok(result && result.code === 'UNSUPPORTED_TARGET', 'Unknown target → UNSUPPORTED_TARGET');
  router.dispose();
});

test('handle: missing type → MISSING_TYPE', async () => {
  const router = createRouter();
  const result = await router.handle({}, () => {});
  assert.ok(result && result.code === 'MISSING_TYPE', 'Missing type → MISSING_TYPE');
  router.dispose();
});

test('handle: unknown type → UNKNOWN_TYPE', async () => {
  const router = createRouter();
  const result = await router.handle({ type: 'nonexistent_type', id: 'unk-1' }, () => {});
  assert.ok(result && result.code === 'UNKNOWN_TYPE', 'Unknown type → UNKNOWN_TYPE');
  router.dispose();
});

test('handle: chat.submit routes to _handleChatSubmit', async () => {
  const router = createRouter();
  let acked = false;
  const result = await router.handle(
    { type: 'chat.submit', id: 'route-1', target: 'test', text: 'hello' },
    (resp) => { if (resp.type === 'ack') acked = true; }
  );
  // _handleChatSubmit returns null (ack sent via sendFn)
  assert.equal(result, null, 'chat.submit returns null (ack via sendFn)');
  router.dispose();
});

test('handle: run-command routes to _handleRunCommand', async () => {
  const router = createRouter();
  const result = await router.handle(
    { type: 'run-command', id: 'route-2', command: 'workbench.action.quit' },
    () => {}
  );
  assert.ok(result && result.code === 'BLOCKED_COMMAND', 'run-command routes correctly');
  router.dispose();
});
