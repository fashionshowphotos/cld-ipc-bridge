#!/usr/bin/env node
/**
 * adversarial-r12.cjs — Round 12 adversarial tests for IPC Bridge
 * -----------------------------------------------------------------
 * Focus: Registry validation (isValidInstanceId, isValidPid, workspaceHash,
 * pipeName, writeRegistry/deleteRegistry lifecycle), Router queue flood
 * resilience, idempotency cache scoping (same key different targets),
 * _sanitizeError with nested path patterns, adapter dispose cleanup,
 * handle() with missing/malformed fields, rate limiter edge cases.
 *
 * Usage: node test/adversarial-r12.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isValidInstanceId,
  isValidPid,
  workspaceHash,
  pipeName,
  generateInstanceId,
} = require('../lib/registry.cjs');

const { Router } = require('../lib/router.cjs');

// ═══════════════════════════════════════════════════════════════
// REGISTRY: isValidInstanceId
// ═══════════════════════════════════════════════════════════════
test('isValidInstanceId: valid 8-char hex', () => {
  assert.ok(isValidInstanceId('0123abcd'), '8 hex chars valid');
  assert.ok(isValidInstanceId('deadbeef'), 'Lowercase hex valid');
});

test('isValidInstanceId: uppercase hex rejected', () => {
  assert.ok(!isValidInstanceId('0123ABCD'), 'Uppercase hex rejected');
});

test('isValidInstanceId: 7-char hex rejected', () => {
  assert.ok(!isValidInstanceId('0123abc'), 'Too short');
});

test('isValidInstanceId: 9-char hex rejected', () => {
  assert.ok(!isValidInstanceId('0123abcde'), 'Too long');
});

test('isValidInstanceId: non-hex chars rejected', () => {
  assert.ok(!isValidInstanceId('0123abcg'), 'G not hex');
  assert.ok(!isValidInstanceId('0123abc!'), 'Special char rejected');
});

test('isValidInstanceId: null/undefined rejected', () => {
  assert.ok(!isValidInstanceId(null), 'null rejected');
  assert.ok(!isValidInstanceId(undefined), 'undefined rejected');
  assert.ok(!isValidInstanceId(''), 'empty rejected');
  assert.ok(!isValidInstanceId(12345678), 'number rejected');
});

test('isValidInstanceId: path traversal in hex rejected', () => {
  assert.ok(!isValidInstanceId('../abcd'), 'Path traversal rejected');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: isValidPid
// ═══════════════════════════════════════════════════════════════
test('isValidPid: normal PID accepted', () => {
  assert.ok(isValidPid(1234), 'Normal PID');
  assert.ok(isValidPid(1), 'PID 1');
});

test('isValidPid: zero rejected', () => {
  assert.ok(!isValidPid(0), 'Zero rejected');
});

test('isValidPid: negative rejected', () => {
  assert.ok(!isValidPid(-1), 'Negative rejected');
  assert.ok(!isValidPid(-999), 'Large negative rejected');
});

test('isValidPid: MAX_PID boundary', () => {
  assert.ok(isValidPid(4194304), 'MAX_PID accepted');
  assert.ok(!isValidPid(4194305), 'MAX_PID + 1 rejected');
});

test('isValidPid: float rejected', () => {
  assert.ok(!isValidPid(1.5), 'Float rejected');
  assert.ok(!isValidPid(1234.001), 'Near-integer float rejected');
});

test('isValidPid: string rejected', () => {
  assert.ok(!isValidPid('1234'), 'String rejected');
});

test('isValidPid: NaN/Infinity rejected', () => {
  assert.ok(!isValidPid(NaN), 'NaN rejected');
  assert.ok(!isValidPid(Infinity), 'Infinity rejected');
  assert.ok(!isValidPid(-Infinity), '-Infinity rejected');
});

test('isValidPid: null/undefined rejected', () => {
  assert.ok(!isValidPid(null), 'null rejected');
  assert.ok(!isValidPid(undefined), 'undefined rejected');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: workspaceHash
// ═══════════════════════════════════════════════════════════════
test('workspaceHash: returns 6-char hex string', () => {
  const hash = workspaceHash('/home/user/project');
  assert.equal(hash.length, 6, '6 chars');
  assert.ok(/^[0-9a-f]+$/.test(hash), 'Hex chars only');
});

test('workspaceHash: deterministic', () => {
  const h1 = workspaceHash('/home/user/project');
  const h2 = workspaceHash('/home/user/project');
  assert.equal(h1, h2, 'Same input → same hash');
});

test('workspaceHash: different paths → different hashes', () => {
  const h1 = workspaceHash('/home/user/project-a');
  const h2 = workspaceHash('/home/user/project-b');
  assert.notEqual(h1, h2, 'Different paths → different hashes');
});

test('workspaceHash: null/undefined → uses "global"', () => {
  const h1 = workspaceHash(null);
  const h2 = workspaceHash(undefined);
  const hGlobal = workspaceHash('global');
  // null and undefined should use 'global' fallback
  assert.equal(h1, hGlobal, 'null falls back to global');
  assert.equal(h2, hGlobal, 'undefined falls back to global');
});

test('workspaceHash: empty string → uses "global"', () => {
  const hEmpty = workspaceHash('');
  const hGlobal = workspaceHash('global');
  // Empty string is falsy, should use 'global'
  assert.equal(hEmpty, hGlobal, 'Empty falls back to global');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: pipeName
// ═══════════════════════════════════════════════════════════════
test('pipeName: Windows named pipe format', () => {
  const name = pipeName('abc123', 'deadbeef');
  assert.ok(name.startsWith('\\\\.\\pipe\\'), 'Starts with pipe prefix');
  assert.ok(name.includes('abc123'), 'Contains wsHash');
  assert.ok(name.includes('deadbeef'), 'Contains instanceId');
});

test('pipeName: deterministic', () => {
  const n1 = pipeName('hash1', 'inst1');
  const n2 = pipeName('hash1', 'inst1');
  assert.equal(n1, n2, 'Same inputs → same pipe name');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: generateInstanceId
// ═══════════════════════════════════════════════════════════════
test('generateInstanceId: returns valid 8-char hex', () => {
  const id = generateInstanceId();
  assert.ok(isValidInstanceId(id), 'Generated ID is valid');
});

test('generateInstanceId: two calls produce different IDs', () => {
  const id1 = generateInstanceId();
  const id2 = generateInstanceId();
  assert.notEqual(id1, id2, 'Unique IDs');
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: queue flood resilience
// ═══════════════════════════════════════════════════════════════
test('Router: 100 rapid submissions do not crash', async () => {
  const router = new Router({
    adapters: {
      flood: {
        submit: async (text) => {
          await new Promise(r => setTimeout(r, 1));
          return { grade: 'ok' };
        },
        isBusy: () => false,
        available: true,
      }
    },
    log: () => {},
  });

  const promises = [];
  for (let i = 0; i < 100; i++) {
    router._handleChatSubmit(
      { id: `flood-${i}`, target: 'flood', text: `msg ${i}` },
      () => {}
    );
  }

  // Wait for processing
  await new Promise(r => setTimeout(r, 500));

  // Should not have crashed
  const status = router.getStatus();
  assert.ok('flood' in status, 'Adapter still exists');
  router.dispose();
});

test('Router: dispose clears queue timers', async () => {
  const router = new Router({
    adapters: {
      slow: {
        submit: async () => {
          await new Promise(r => setTimeout(r, 5000));
          return { grade: 'ok' };
        },
        available: true,
      }
    },
    log: () => {},
  });

  router._handleChatSubmit(
    { id: 'disp-1', target: 'slow', text: 'hello' },
    () => {}
  );

  // Dispose immediately — should not crash
  router.dispose();

  // Wait briefly to confirm no post-dispose errors
  await new Promise(r => setTimeout(r, 100));
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: idempotency cache scoping
// ═══════════════════════════════════════════════════════════════
test('Router: same idempotencyKey different targets → separate cache entries', async () => {
  const adapter = {
    submit: async () => ({ grade: 'ok' }),
    available: true,
  };
  const router = new Router({
    adapters: { alpha: adapter, beta: { ...adapter } },
    log: () => {},
  });

  // Fill cache for alpha
  const scopedKey = 'alpha:chat.submit:shared-key';
  router._idempotencyCache.set(scopedKey, {
    ts: Date.now(),
    response: { type: 'chat.submitted', ok: true, grade: 'cached-alpha' }
  });

  // Request to beta with same idempotencyKey should NOT hit alpha's cache
  const result = await router.handle(
    { id: 'scope-1', type: 'chat.submit', target: 'beta', text: 'hello', idempotencyKey: 'shared-key' },
    () => {}
  );

  // Should NOT be a cache hit (different target scope)
  assert.ok(!result || !result.idempotencyHit, 'Different target → no cache hit');
  router.dispose();
});

test('Router: same target same idempotencyKey → cache hit', async () => {
  const router = new Router({
    adapters: { cached: { submit: async () => ({ grade: 'ok' }), available: true } },
    log: () => {},
  });

  const scopedKey = 'cached:chat.submit:test-key';
  router._idempotencyCache.set(scopedKey, {
    ts: Date.now(),
    response: { type: 'chat.submitted', ok: true, grade: 'from-cache' }
  });

  const result = await router.handle(
    { id: 'hit-1', type: 'chat.submit', target: 'cached', text: 'hello', idempotencyKey: 'test-key' },
    () => {}
  );

  assert.ok(result, 'Got result');
  assert.ok(result.idempotencyHit, 'Cache hit');
  assert.equal(result.grade, 'from-cache', 'Cached grade');
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: _sanitizeError with nested patterns
// ═══════════════════════════════════════════════════════════════
test('Router: _sanitizeError strips multiple paths', () => {
  const router = new Router({ adapters: {}, log: () => {} });
  const msg = 'Error at C:\\Users\\admin\\app.js and /home/user/config.json';
  const result = router._sanitizeError(msg);
  assert.ok(!result.includes('admin'), 'Windows path stripped');
  assert.ok(!result.includes('/home'), 'Unix path stripped');
  assert.ok(result.includes('<path>'), 'Replaced with <path>');
  router.dispose();
});

test('Router: _sanitizeError preserves error codes', () => {
  const router = new Router({ adapters: {}, log: () => {} });
  const msg = 'ECONNREFUSED: Connection refused';
  const result = router._sanitizeError(msg);
  assert.ok(result.includes('ECONNREFUSED'), 'Error code preserved');
  router.dispose();
});

test('Router: _sanitizeError with quoted paths', () => {
  const router = new Router({ adapters: {}, log: () => {} });
  const msg = 'File "C:\\Users\\admin\\secret.key" not found';
  const result = router._sanitizeError(msg);
  assert.ok(result.includes('<path>'), 'Quoted path sanitized');
  assert.ok(!result.includes('secret'), 'Path content removed');
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: handle() with malformed requests
// ═══════════════════════════════════════════════════════════════
test('Router: handle with missing type → MISSING_TYPE', async () => {
  const router = new Router({
    adapters: { x: { submit: async () => ({}), available: true } },
    log: () => {},
  });
  const result = await router.handle(
    { id: 'mt-1', target: 'x', text: 'hello' },
    () => {}
  );
  assert.ok(result, 'Got response');
  assert.equal(result.code, 'MISSING_TYPE', 'MISSING_TYPE code');
  router.dispose();
});

test('Router: handle with unknown type → UNKNOWN_TYPE', async () => {
  const router = new Router({
    adapters: { x: { submit: async () => ({}), available: true } },
    log: () => {},
  });
  const result = await router.handle(
    { id: 'ut-1', type: 'nonexistent.type', target: 'x', text: 'hello' },
    () => {}
  );
  assert.ok(result, 'Got response');
  assert.equal(result.code, 'UNKNOWN_TYPE', 'UNKNOWN_TYPE code');
  router.dispose();
});

test('Router: handle with valid type but missing target', async () => {
  const router = new Router({
    adapters: {},
    log: () => {},
  });
  const result = await router.handle(
    { id: 'nt-1', type: 'chat.submit', text: 'hello' },
    () => {}
  );
  // Should fail gracefully
  assert.ok(result, 'Got response');
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: getStatus with multiple adapters
// ═══════════════════════════════════════════════════════════════
test('Router: getStatus reflects adapter availability', () => {
  const router = new Router({
    adapters: {
      online: { submit: async () => ({}), available: true },
      offline: { submit: async () => ({}), available: false },
    },
    log: () => {},
  });

  const status = router.getStatus();
  assert.ok('online' in status, 'Online adapter in status');
  assert.ok('offline' in status, 'Offline adapter in status');
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: text length validation
// ═══════════════════════════════════════════════════════════════
test('Router: text exceeding max length rejected (returned, not via sendFn)', () => {
  const router = new Router({
    adapters: { x: { submit: async () => ({}), available: true } },
    log: () => {},
  });

  const longText = 'x'.repeat(64 * 1024 + 1);
  const result = router._handleChatSubmit(
    { id: 'long-1', target: 'x', text: longText },
    () => {}
  );

  assert.ok(result, 'Error returned synchronously');
  assert.equal(result.code, 'TEXT_TOO_LARGE', 'Correct error code');
  router.dispose();
});

test('Router: text at exactly max length accepted', () => {
  const router = new Router({
    adapters: { x: { submit: async () => ({}), available: true } },
    log: () => {},
  });

  const maxText = 'x'.repeat(64 * 1024);
  let ackReceived = false;
  router._handleChatSubmit(
    { id: 'exact-1', target: 'x', text: maxText },
    (resp) => { if (resp.type === 'ack') ackReceived = true; }
  );

  assert.ok(ackReceived, 'Exact max length accepted');
  router.dispose();
});
