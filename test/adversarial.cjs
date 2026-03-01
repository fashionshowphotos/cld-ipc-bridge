#!/usr/bin/env node
/**
 * adversarial.cjs — Adversarial tests for IPC Bridge
 * ---------------------------------------------------
 * Tests designed to BREAK things: injection, overflow, race conditions,
 * malformed input, boundary conditions.
 *
 * Usage: node test/adversarial.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { generateToken, safeCompare, tokenHint, writeTokenFile, readTokenFile, deleteTokenFile } = require('../lib/auth.cjs');
const { Router } = require('../lib/router.cjs');

// ============================================================================
// Test infrastructure
// ============================================================================

let passCount = 0;
let failCount = 0;

function makeAdapter(overrides = {}) {
  return {
    available: true,
    method: 'query',
    busyPolicy: 'reject-when-busy',
    _busyFlag: false,
    isBusy() { return this._busyFlag; },
    async submit(text) {
      await new Promise(r => setTimeout(r, 5));
      return { grade: 'submitted', detail: 'mock' };
    },
    async probe() { return {}; },
    _setAbortToken() {},
    ...overrides
  };
}

function makeRouter(adapterOverrides = {}) {
  const adapters = {
    copilot: makeAdapter(adapterOverrides),
    codex: makeAdapter(adapterOverrides),
    generic: makeAdapter(adapterOverrides),
  };
  const log = () => {};
  return new Router({ adapters, log });
}

function collectSend() {
  const msgs = [];
  return { msgs, fn: (m) => msgs.push(m) };
}

// ============================================================================
// AUTH MODULE — adversarial
// ============================================================================

test('auth: path traversal in instanceId is rejected', () => {
  assert.throws(() => writeTokenFile(os.tmpdir(), '../../../etc', 'token123'), /Invalid instanceId/);
  assert.throws(() => writeTokenFile(os.tmpdir(), '..\\..\\..', 'token123'), /Invalid instanceId/);
  assert.throws(() => writeTokenFile(os.tmpdir(), 'AABBCCDD', 'token123'), /Invalid instanceId/); // uppercase
  assert.throws(() => writeTokenFile(os.tmpdir(), 'aabbccd', 'token123'), /Invalid instanceId/); // 7 chars
  assert.throws(() => writeTokenFile(os.tmpdir(), 'aabbccdde', 'token123'), /Invalid instanceId/); // 9 chars
  assert.throws(() => writeTokenFile(os.tmpdir(), '00000000/../x', 'token123'), /Invalid instanceId/);
});

test('auth: readTokenFile rejects path traversal', () => {
  assert.equal(readTokenFile(os.tmpdir(), '../../../etc'), null);
  assert.equal(readTokenFile(os.tmpdir(), 'ZZZZZZZZ'), null); // non-hex
  assert.equal(readTokenFile(os.tmpdir(), ''), null);
});

test('auth: writeTokenFile round-trip works', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-test-'));
  const token = generateToken();
  const id = crypto.randomBytes(4).toString('hex');
  try {
    writeTokenFile(dir, id, token);
    const read = readTokenFile(dir, id);
    assert.equal(read, token);
    deleteTokenFile(dir, id);
    const after = readTokenFile(dir, id);
    assert.equal(after, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auth: safeCompare rejects non-strings', () => {
  assert.equal(safeCompare(null, 'abc'), false);
  assert.equal(safeCompare('abc', undefined), false);
  assert.equal(safeCompare(123, 'abc'), false);
  assert.equal(safeCompare('abc', 123), false);
  assert.equal(safeCompare({}, {}), false);
});

test('auth: safeCompare rejects different lengths', () => {
  assert.equal(safeCompare('abc', 'abcd'), false);
  assert.equal(safeCompare('', 'a'), false);
});

test('auth: safeCompare matches equal strings', () => {
  const token = generateToken();
  assert.equal(safeCompare(token, token), true);
  assert.equal(safeCompare('hello', 'hello'), true);
});

test('auth: safeCompare catches subtle differences', () => {
  const a = 'a'.repeat(64);
  const b = 'a'.repeat(63) + 'b';
  assert.equal(safeCompare(a, b), false);
});

test('auth: tokenHint handles edge cases', () => {
  assert.equal(tokenHint(''), '');
  assert.equal(tokenHint(null), '');
  assert.equal(tokenHint(undefined), '');
  assert.equal(tokenHint('abcdefgh12345678'), 'abcdefgh');
  assert.equal(tokenHint('short'), 'short');
});

test('auth: generateToken produces unique tokens', () => {
  const tokens = new Set();
  for (let i = 0; i < 100; i++) {
    tokens.add(generateToken());
  }
  assert.equal(tokens.size, 100, 'All 100 tokens should be unique');
});

test('auth: generateToken format is 64-char hex', () => {
  const token = generateToken();
  assert.equal(token.length, 64);
  assert.match(token, /^[0-9a-f]{64}$/);
});

// ============================================================================
// ROUTER — input validation adversarial
// ============================================================================

test('router: missing type returns error', async () => {
  const router = makeRouter();
  const { fn } = collectSend();
  const result = await router.handle({ id: 'test1' }, fn);
  assert.equal(result.code, 'MISSING_TYPE');
  router.dispose();
});

test('router: chat.submit with empty text is rejected', async () => {
  const router = makeRouter();
  const { fn } = collectSend();
  const result = await router.handle({ id: 'test2', type: 'chat.submit', text: '', target: 'copilot' }, fn);
  assert.equal(result.code, 'INVALID_TEXT');
  router.dispose();
});

test('router: chat.submit with whitespace-only text is rejected', async () => {
  const router = makeRouter();
  const { fn } = collectSend();
  const result = await router.handle({ id: 'test3', type: 'chat.submit', text: '   \t\n  ', target: 'copilot' }, fn);
  assert.equal(result.code, 'INVALID_TEXT');
  router.dispose();
});

test('router: chat.submit with control chars is rejected', async () => {
  const router = makeRouter();
  const { fn } = collectSend();
  // Null byte
  const result1 = await router.handle({ id: 't4a', type: 'chat.submit', text: 'hello\x00world', target: 'copilot' }, fn);
  assert.equal(result1.code, 'INVALID_TEXT');
  // Bell char
  const result2 = await router.handle({ id: 't4b', type: 'chat.submit', text: 'hello\x07world', target: 'copilot' }, fn);
  assert.equal(result2.code, 'INVALID_TEXT');
  // Escape
  const result3 = await router.handle({ id: 't4c', type: 'chat.submit', text: 'hello\x1bworld', target: 'copilot' }, fn);
  assert.equal(result3.code, 'INVALID_TEXT');
  router.dispose();
});

test('router: chat.submit with bidi override chars is rejected', async () => {
  const router = makeRouter();
  const { fn } = collectSend();
  // Right-to-left override
  const result = await router.handle({ id: 't5', type: 'chat.submit', text: 'hello\u202Eworld', target: 'copilot' }, fn);
  assert.equal(result.code, 'INVALID_TEXT');
  // Zero-width space
  const result2 = await router.handle({ id: 't5b', type: 'chat.submit', text: 'hello\u200Bworld', target: 'copilot' }, fn);
  assert.equal(result2.code, 'INVALID_TEXT');
  router.dispose();
});

test('router: chat.submit text over 64KB is rejected', async () => {
  const router = makeRouter();
  const { fn } = collectSend();
  const bigText = 'x'.repeat(65 * 1024);
  const result = await router.handle({ id: 't6', type: 'chat.submit', text: bigText, target: 'copilot' }, fn);
  assert.equal(result.code, 'TEXT_TOO_LARGE');
  router.dispose();
});

test('router: chat.submit with exactly 64KB text is accepted', async () => {
  const router = makeRouter();
  const { msgs, fn } = collectSend();
  const exactText = 'x'.repeat(64 * 1024);
  const result = await router.handle({ id: 't6b', type: 'chat.submit', text: exactText, target: 'copilot' }, fn);
  // Should be null (ack sent via sendFn) not an error
  assert.equal(result, null);
  router.dispose();
});

test('router: non-ASCII request ID is rejected', async () => {
  const router = makeRouter();
  const { fn } = collectSend();
  const result = await router.handle({
    id: 'test\u{1F4A9}emoji', type: 'chat.submit', text: 'hello', target: 'copilot'
  }, fn);
  assert.equal(result.code, 'INVALID_ID');
  router.dispose();
});

test('router: overlong request ID is rejected', async () => {
  const router = makeRouter();
  const { fn } = collectSend();
  const result = await router.handle({
    id: 'x'.repeat(257), type: 'chat.submit', text: 'hello', target: 'copilot'
  }, fn);
  assert.equal(result.code, 'INVALID_ID');
  router.dispose();
});

test('router: invalid target name with special chars is rejected', async () => {
  const router = makeRouter();
  const { fn } = collectSend();
  const result = await router.handle({
    id: 't8', type: 'chat.submit', text: 'hello', target: 'co;pilot && rm -rf /'
  }, fn);
  assert.equal(result.code, 'INVALID_TARGET');
  router.dispose();
});

test('router: unknown target returns UNSUPPORTED_TARGET', async () => {
  const router = makeRouter();
  const { fn } = collectSend();
  const result = await router.handle({
    id: 't9', type: 'chat.submit', text: 'hello', target: 'nonexistent'
  }, fn);
  assert.equal(result.code, 'UNSUPPORTED_TARGET');
  router.dispose();
});

test('router: invalid priority is rejected', async () => {
  const router = makeRouter();
  const { fn } = collectSend();
  const result = await router.handle({
    id: 't10', type: 'chat.submit', text: 'hello', target: 'copilot', priority: 'urgent'
  }, fn);
  assert.equal(result.code, 'INVALID_PRIORITY');
  router.dispose();
});

test('router: queue overflow returns QUEUE_FULL', async () => {
  // Adapter that never resolves — keeps queue full
  const router = makeRouter({
    async submit() {
      await new Promise(() => {}); // hang forever
    }
  });
  const { fn } = collectSend();

  // Effective capacity = QUEUE_MAX + 1 (1 processing + QUEUE_MAX queued)
  // First request dequeues immediately into processing, so queue stays short.
  // With QUEUE_MAX=5: 1 processing + 5 queued = 6 total before overflow
  for (let i = 0; i < 6; i++) {
    const r = await router.handle({
      id: `q${i}`, type: 'chat.submit', text: `msg ${i}`, target: 'copilot'
    }, fn);
    assert.equal(r, null, `Request ${i} should be accepted`);
  }

  // 7th should overflow
  const overflow = await router.handle({
    id: 'q6', type: 'chat.submit', text: 'overflow', target: 'copilot'
  }, fn);
  assert.equal(overflow.code, 'QUEUE_FULL');
  router.dispose();
});

test('router: critical priority rate limiting kicks in at 4th request', async () => {
  const router = makeRouter();
  const { fn } = collectSend();

  for (let i = 0; i < 3; i++) {
    const r = await router.handle({
      id: `c${i}`, type: 'chat.submit', text: `critical ${i}`, target: 'copilot', priority: 'critical'
    }, fn);
    assert.equal(r, null, `Critical request ${i} should be accepted`);
  }

  // 4th critical in same minute should be rate limited
  const limited = await router.handle({
    id: 'c3', type: 'chat.submit', text: 'too many', target: 'copilot', priority: 'critical'
  }, fn);
  assert.equal(limited.code, 'RATE_LIMITED');
  router.dispose();
});

test('router: idempotency prevents cross-type replay', async () => {
  const router = makeRouter();
  const { fn } = collectSend();

  // Submit with an idempotency key
  await router.handle({
    id: 'idem1', type: 'chat.submit', text: 'hello', target: 'copilot', idempotencyKey: 'key123'
  }, fn);

  // Wait for processing
  await new Promise(r => setTimeout(r, 50));

  // Same idempotency key on chat.submit should hit cache
  const result = await router.handle({
    id: 'idem2', type: 'chat.submit', text: 'hello', target: 'copilot', idempotencyKey: 'key123'
  }, fn);
  assert.equal(result.idempotencyHit, true);

  // Same key but different type should NOT hit cache
  const result2 = await router.handle({
    id: 'idem3', type: 'list-commands', idempotencyKey: 'key123'
  }, fn);
  assert.notEqual(result2.idempotencyHit, true);

  router.dispose();
});

test('router: run-command blocks terminal.sendSequence', async () => {
  const router = makeRouter();
  const { fn } = collectSend();

  const result = await router.handle({
    id: 'rc1', type: 'run-command', command: 'workbench.action.terminal.sendSequence'
  }, fn);
  assert.equal(result.code, 'BLOCKED_COMMAND');
  router.dispose();
});

test('router: run-command blocks terminal.send prefix variants', async () => {
  const router = makeRouter();
  const { fn } = collectSend();

  // Custom send command that starts with blocked prefix
  const result = await router.handle({
    id: 'rc2', type: 'run-command', command: 'workbench.action.terminal.sendCustomPayload'
  }, fn);
  assert.equal(result.code, 'BLOCKED_COMMAND');
  router.dispose();
});

test('router: run-command blocks quit and close', async () => {
  const router = makeRouter();
  const { fn } = collectSend();

  for (const cmd of ['workbench.action.quit', 'workbench.action.closeWindow', 'workbench.action.files.delete', 'deleteFile']) {
    const result = await router.handle({
      id: `rc-${cmd}`, type: 'run-command', command: cmd
    }, fn);
    assert.equal(result.code, 'BLOCKED_COMMAND', `${cmd} should be blocked`);
  }
  router.dispose();
});

test('router: run-command without command field returns error', async () => {
  const router = makeRouter();
  const { fn } = collectSend();
  const result = await router.handle({ id: 'rc3', type: 'run-command' }, fn);
  assert.equal(result.code, 'MISSING_COMMAND');
  router.dispose();
});

test('router: unknown request type returns UNKNOWN_TYPE', async () => {
  const router = makeRouter();
  const { fn } = collectSend();
  const result = await router.handle({ id: 'u1', type: 'DROP_DATABASE' }, fn);
  assert.equal(result.code, 'UNKNOWN_TYPE');
  router.dispose();
});

test('router: extremely long type is truncated in error', async () => {
  const router = makeRouter();
  const { fn } = collectSend();
  const longType = 'x'.repeat(1000);
  const result = await router.handle({ id: 'u2', type: longType }, fn);
  assert.equal(result.code, 'UNKNOWN_TYPE');
  // Error message should contain truncated type
  assert.ok(result.message.length < 200, 'Error message should be bounded');
  router.dispose();
});

test('router: _sanitizeError strips Windows paths', () => {
  const router = makeRouter();
  const sanitized = router._sanitizeError('Error at C:\\Users\\admin\\secret\\token.json:42');
  assert.ok(!sanitized.includes('admin'), 'Should strip Windows path');
  assert.ok(!sanitized.includes('secret'), 'Should strip Windows path');
  assert.ok(sanitized.includes('<path>'), 'Should replace with <path>');
  router.dispose();
});

test('router: _sanitizeError strips Unix paths', () => {
  const router = makeRouter();
  const sanitized = router._sanitizeError('Error at /home/user/.ssh/id_rsa');
  assert.ok(!sanitized.includes('.ssh'), 'Should strip Unix path');
  assert.ok(sanitized.includes('<path>'), 'Should replace with <path>');
  router.dispose();
});

test('router: _sanitizeError caps at 200 chars', () => {
  const router = makeRouter();
  const sanitized = router._sanitizeError('E'.repeat(500));
  assert.ok(sanitized.length <= 200, `Length should be <= 200, got ${sanitized.length}`);
  router.dispose();
});

test('router: adapter that throws has error sanitized', async () => {
  const router = makeRouter({
    async submit() {
      const err = new Error('Failed at C:\\Users\\admin\\AppData\\Local\\secret.key line 42');
      err.code = 'ADAPTER_FAIL';
      throw err;
    }
  });
  const { msgs, fn } = collectSend();

  await router.handle({
    id: 'err1', type: 'chat.submit', text: 'hello', target: 'copilot'
  }, fn);

  // Wait for async processing
  await new Promise(r => setTimeout(r, 100));

  const errMsg = msgs.find(m => m.type === 'error');
  assert.ok(errMsg, 'Should have error response');
  assert.ok(!errMsg.message.includes('admin'), 'Should strip path from error');
  assert.ok(!errMsg.message.includes('secret'), 'Should strip path from error');
  router.dispose();
});

test('router: unavailable adapter returns TARGET_UNAVAILABLE', async () => {
  const router = makeRouter({ available: false });
  const { fn } = collectSend();
  const result = await router.handle({
    id: 'ua1', type: 'chat.submit', text: 'hello', target: 'copilot'
  }, fn);
  assert.equal(result.code, 'TARGET_UNAVAILABLE');
  router.dispose();
});

test('router: idempotency key with unicode is rejected', async () => {
  const router = makeRouter();
  const { fn } = collectSend();
  const result = await router.handle({
    id: 'ik1', type: 'chat.submit', text: 'hello', target: 'copilot',
    idempotencyKey: 'key\u200B123' // zero-width space
  }, fn);
  assert.equal(result.code, 'INVALID_IDEMPOTENCY_KEY');
  router.dispose();
});

// ============================================================================
// Summary
// ============================================================================

test.after(() => {
  // node:test handles this automatically
});
