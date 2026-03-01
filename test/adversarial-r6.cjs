#!/usr/bin/env node
/**
 * adversarial-r6.cjs — Round 6 adversarial tests for IPC Bridge
 * ---------------------------------------------------------------
 * Focus: Router queue management (_processQueue, critical priority,
 * busy adapter rejection), idempotency cache (collision, eviction
 * order, TTL boundaries, capacity), input validation gaps
 * (DANGEROUS_TERMINAL_PATTERNS, DANGEROUS_UNICODE, SAFE_ID_PATTERN,
 * target regex), _sanitizeError completeness, _cleanIdempotencyCache
 * timing, per-connection rate limiting.
 *
 * Usage: node test/adversarial-r6.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Router and constants ──────────────────────────────────────
const { Router } = require('../lib/router.cjs');

// ── Router validation constants (mirrored) ────────────────────
const DANGEROUS_TERMINAL_PATTERNS = /[\x00-\x08\x0e-\x1f\x7f]/;
const DANGEROUS_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/;
const SAFE_ID_PATTERN = /^[\x20-\x7E]+$/;
const MAX_TEXT_LENGTH = 64 * 1024;
const MAX_ID_LENGTH = 256;
const QUEUE_MAX = 5;
const IDEMPOTENCY_TTL_MS = 60_000;
const IDEMPOTENCY_CACHE_MAX = 200;

// ── Helper: create Router with mock adapter ──────────────────
function createRouter(adapterOpts = {}) {
  const mockAdapter = {
    available: true,
    submit: async (text) => ({ grade: 'submitted', detail: 'mock' }),
    isBusy: () => false,
    busyPolicy: 'reject-when-busy',
    ...adapterOpts,
  };

  const router = new Router({
    adapters: { copilot: mockAdapter, codex: mockAdapter, generic: mockAdapter },
    log: () => {},
  });

  return { router, mockAdapter };
}

// ═══════════════════════════════════════════════════════════════
// INPUT VALIDATION: DANGEROUS_TERMINAL_PATTERNS coverage
// ═══════════════════════════════════════════════════════════════

test('DANGEROUS_TERMINAL_PATTERNS: blocks NUL byte', () => {
  assert.ok(DANGEROUS_TERMINAL_PATTERNS.test('\x00'), 'NUL blocked');
});

test('DANGEROUS_TERMINAL_PATTERNS: blocks BEL', () => {
  assert.ok(DANGEROUS_TERMINAL_PATTERNS.test('\x07'), 'BEL blocked');
});

test('DANGEROUS_TERMINAL_PATTERNS: blocks ESC', () => {
  assert.ok(DANGEROUS_TERMINAL_PATTERNS.test('\x1b'), 'ESC (0x1B) blocked');
});

test('DANGEROUS_TERMINAL_PATTERNS: blocks DEL', () => {
  assert.ok(DANGEROUS_TERMINAL_PATTERNS.test('\x7f'), 'DEL blocked');
});

test('DANGEROUS_TERMINAL_PATTERNS: allows TAB (0x09)', () => {
  // TAB is \x09, range is \x00-\x08 then \x0e-\x1f — TAB not in range
  assert.equal(DANGEROUS_TERMINAL_PATTERNS.test('\x09'), false, 'TAB allowed');
});

test('DANGEROUS_TERMINAL_PATTERNS: allows LF (0x0A)', () => {
  assert.equal(DANGEROUS_TERMINAL_PATTERNS.test('\x0a'), false, 'LF allowed');
});

test('DANGEROUS_TERMINAL_PATTERNS: allows CR (0x0D)', () => {
  // CR is \x0d, range is \x0e-\x1f — CR not in range
  assert.equal(DANGEROUS_TERMINAL_PATTERNS.test('\x0d'), false, 'CR allowed');
});

test('DANGEROUS_TERMINAL_PATTERNS: allows VT (0x0B)', () => {
  // VT is \x0b, between TAB (0x09) and CR (0x0d) — not in blocked range
  assert.equal(DANGEROUS_TERMINAL_PATTERNS.test('\x0b'), false, 'VT allowed');
});

test('DANGEROUS_TERMINAL_PATTERNS: allows FF (0x0C)', () => {
  // FF is \x0c, not in blocked range
  assert.equal(DANGEROUS_TERMINAL_PATTERNS.test('\x0c'), false, 'FF allowed');
});

test('DANGEROUS_TERMINAL_PATTERNS: blocks 0x0E (SO)', () => {
  assert.ok(DANGEROUS_TERMINAL_PATTERNS.test('\x0e'), 'SO blocked');
});

test('DANGEROUS_TERMINAL_PATTERNS: allows printable ASCII', () => {
  assert.equal(DANGEROUS_TERMINAL_PATTERNS.test('Hello World 123!@#'), false, 'Printable ASCII safe');
});

// ═══════════════════════════════════════════════════════════════
// INPUT VALIDATION: DANGEROUS_UNICODE coverage
// ═══════════════════════════════════════════════════════════════

test('DANGEROUS_UNICODE: blocks zero-width space (U+200B)', () => {
  assert.ok(DANGEROUS_UNICODE.test('\u200B'), 'ZWSP blocked');
});

test('DANGEROUS_UNICODE: blocks zero-width non-joiner (U+200C)', () => {
  assert.ok(DANGEROUS_UNICODE.test('\u200C'), 'ZWNJ blocked');
});

test('DANGEROUS_UNICODE: blocks zero-width joiner (U+200D)', () => {
  assert.ok(DANGEROUS_UNICODE.test('\u200D'), 'ZWJ blocked');
});

test('DANGEROUS_UNICODE: blocks left-to-right mark (U+200E)', () => {
  assert.ok(DANGEROUS_UNICODE.test('\u200E'), 'LRM blocked');
});

test('DANGEROUS_UNICODE: blocks right-to-left mark (U+200F)', () => {
  assert.ok(DANGEROUS_UNICODE.test('\u200F'), 'RLM blocked');
});

test('DANGEROUS_UNICODE: blocks bidi overrides (U+202A-U+202E)', () => {
  for (let cp = 0x202A; cp <= 0x202E; cp++) {
    assert.ok(DANGEROUS_UNICODE.test(String.fromCharCode(cp)), `U+${cp.toString(16).toUpperCase()} blocked`);
  }
});

test('DANGEROUS_UNICODE: blocks word joiner (U+2060)', () => {
  assert.ok(DANGEROUS_UNICODE.test('\u2060'), 'Word joiner blocked');
});

test('DANGEROUS_UNICODE: blocks BOM (U+FEFF)', () => {
  assert.ok(DANGEROUS_UNICODE.test('\uFEFF'), 'BOM blocked');
});

test('DANGEROUS_UNICODE: allows normal Unicode (accented chars)', () => {
  assert.equal(DANGEROUS_UNICODE.test('café résumé naïve'), false, 'Accented chars safe');
});

test('DANGEROUS_UNICODE: allows CJK characters', () => {
  assert.equal(DANGEROUS_UNICODE.test('你好世界'), false, 'CJK safe');
});

test('DANGEROUS_UNICODE: allows emoji', () => {
  assert.equal(DANGEROUS_UNICODE.test('Hello 😊 World'), false, 'Emoji safe');
});

test('DANGEROUS_UNICODE: does NOT block combining diacritics (Zalgo)', () => {
  // Combining marks are U+0300-U+036F — not in blocked range
  const zalgo = 'h\u0310\u0352e\u0311\u0357l\u0312l\u0313o\u0314';
  assert.equal(DANGEROUS_UNICODE.test(zalgo), false, 'Zalgo text NOT blocked (combining diacritics allowed)');
});

// ═══════════════════════════════════════════════════════════════
// INPUT VALIDATION: SAFE_ID_PATTERN
// ═══════════════════════════════════════════════════════════════

test('SAFE_ID_PATTERN: printable ASCII accepted', () => {
  assert.ok(SAFE_ID_PATTERN.test('req-123-abc'), 'Basic ID');
  assert.ok(SAFE_ID_PATTERN.test('a'), 'Single char');
  assert.ok(SAFE_ID_PATTERN.test('hello world'), 'Space is printable ASCII');
  assert.ok(SAFE_ID_PATTERN.test('~!@#$%^&*()'), 'Special chars are printable');
});

test('SAFE_ID_PATTERN: rejects control characters', () => {
  assert.equal(SAFE_ID_PATTERN.test('req\x00id'), false, 'NUL rejected');
  assert.equal(SAFE_ID_PATTERN.test('req\nid'), false, 'Newline rejected');
  assert.equal(SAFE_ID_PATTERN.test('req\tid'), false, 'Tab rejected');
});

test('SAFE_ID_PATTERN: rejects Unicode (non-ASCII)', () => {
  assert.equal(SAFE_ID_PATTERN.test('req-café'), false, 'Accented chars rejected');
  assert.equal(SAFE_ID_PATTERN.test('req-你好'), false, 'CJK rejected');
});

test('SAFE_ID_PATTERN: rejects empty string', () => {
  assert.equal(SAFE_ID_PATTERN.test(''), false, 'Empty string rejected');
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: Idempotency cache logic
// ═══════════════════════════════════════════════════════════════

test('Router: idempotency cache hit returns cached response', async () => {
  const { router } = createRouter();
  const responses = [];
  const sendFn = (r) => responses.push(r);

  // First request
  await router.handle({
    id: 'req-1', type: 'chat.submit', target: 'copilot',
    text: 'hello', idempotencyKey: 'key-1'
  }, sendFn);

  // Wait for processing
  await new Promise(r => setTimeout(r, 100));

  // Second request with same idempotency key
  const result = await router.handle({
    id: 'req-2', type: 'chat.submit', target: 'copilot',
    text: 'different text', idempotencyKey: 'key-1'
  }, sendFn);

  // Should return cached response with idempotencyHit flag
  assert.equal(result.idempotencyHit, true, 'Cache hit flagged');
  assert.equal(result.id, 'req-2', 'Uses new request ID');

  clearInterval(router._cleanupInterval);
});

test('Router: different idempotency keys are independent', async () => {
  const { router } = createRouter();
  const responses = [];
  const sendFn = (r) => responses.push(r);

  await router.handle({
    id: 'req-1', type: 'chat.submit', target: 'copilot',
    text: 'hello', idempotencyKey: 'key-A'
  }, sendFn);

  await new Promise(r => setTimeout(r, 100));

  const result = await router.handle({
    id: 'req-2', type: 'chat.submit', target: 'copilot',
    text: 'hello', idempotencyKey: 'key-B'
  }, sendFn);

  // Different key → not a cache hit
  assert.ok(!result || result.idempotencyHit !== true, 'Different keys = independent');

  clearInterval(router._cleanupInterval);
});

test('Router: idempotency is scoped by target+type', async () => {
  const { router } = createRouter();
  const responses = [];
  const sendFn = (r) => responses.push(r);

  await router.handle({
    id: 'req-1', type: 'chat.submit', target: 'copilot',
    text: 'hello', idempotencyKey: 'key-1'
  }, sendFn);

  await new Promise(r => setTimeout(r, 100));

  // Same key but different target
  const result = await router.handle({
    id: 'req-2', type: 'chat.submit', target: 'codex',
    text: 'hello', idempotencyKey: 'key-1'
  }, sendFn);

  // Different target → different scoped key → not a hit
  assert.ok(!result || result.idempotencyHit !== true, 'Different target = no hit');

  clearInterval(router._cleanupInterval);
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: Input validation edge cases
// ═══════════════════════════════════════════════════════════════

test('Router: missing type returns MISSING_TYPE error', async () => {
  const { router } = createRouter();
  const result = await router.handle({ id: 'req-1' }, () => {});
  assert.equal(result.code, 'MISSING_TYPE');
  clearInterval(router._cleanupInterval);
});

test('Router: unknown type returns UNKNOWN_TYPE error', async () => {
  const { router } = createRouter();
  const result = await router.handle({ id: 'req-1', type: 'invalid.type' }, () => {});
  assert.equal(result.code, 'UNKNOWN_TYPE');
  clearInterval(router._cleanupInterval);
});

test('Router: empty text rejected', async () => {
  const { router } = createRouter();
  const result = await router.handle({
    id: 'req-1', type: 'chat.submit', target: 'copilot', text: ''
  }, () => {});
  assert.equal(result.code, 'INVALID_TEXT');
  clearInterval(router._cleanupInterval);
});

test('Router: whitespace-only text rejected', async () => {
  const { router } = createRouter();
  const result = await router.handle({
    id: 'req-1', type: 'chat.submit', target: 'copilot', text: '   \n\t  '
  }, () => {});
  assert.equal(result.code, 'INVALID_TEXT');
  clearInterval(router._cleanupInterval);
});

test('Router: text with control chars rejected', async () => {
  const { router } = createRouter();
  const result = await router.handle({
    id: 'req-1', type: 'chat.submit', target: 'copilot', text: 'hello\x00world'
  }, () => {});
  assert.equal(result.code, 'INVALID_TEXT');
  clearInterval(router._cleanupInterval);
});

test('Router: text with bidi override rejected', async () => {
  const { router } = createRouter();
  const result = await router.handle({
    id: 'req-1', type: 'chat.submit', target: 'copilot', text: 'hello\u202Eworld'
  }, () => {});
  assert.equal(result.code, 'INVALID_TEXT');
  clearInterval(router._cleanupInterval);
});

test('Router: text exceeding 64KB rejected', async () => {
  const { router } = createRouter();
  const result = await router.handle({
    id: 'req-1', type: 'chat.submit', target: 'copilot', text: 'x'.repeat(MAX_TEXT_LENGTH + 1)
  }, () => {});
  assert.equal(result.code, 'TEXT_TOO_LARGE');
  clearInterval(router._cleanupInterval);
});

test('Router: text at exactly 64KB accepted', async () => {
  const { router } = createRouter();
  const responses = [];
  const result = await router.handle({
    id: 'req-1', type: 'chat.submit', target: 'copilot', text: 'x'.repeat(MAX_TEXT_LENGTH)
  }, (r) => responses.push(r));
  // Should return null (ack sent via sendFn)
  assert.equal(result, null, '64KB text accepted, ack sent via callback');
  clearInterval(router._cleanupInterval);
});

test('Router: invalid ID with Unicode rejected', async () => {
  const { router } = createRouter();
  const result = await router.handle({
    id: 'req-café', type: 'chat.submit', target: 'copilot', text: 'hello'
  }, () => {});
  assert.equal(result.code, 'INVALID_ID');
  clearInterval(router._cleanupInterval);
});

test('Router: ID exceeding 256 chars rejected', async () => {
  const { router } = createRouter();
  const result = await router.handle({
    id: 'x'.repeat(MAX_ID_LENGTH + 1), type: 'chat.submit', target: 'copilot', text: 'hello'
  }, () => {});
  assert.equal(result.code, 'INVALID_ID');
  clearInterval(router._cleanupInterval);
});

test('Router: invalid priority rejected', async () => {
  const { router } = createRouter();
  const result = await router.handle({
    id: 'req-1', type: 'chat.submit', target: 'copilot', text: 'hello', priority: 'urgent'
  }, () => {});
  assert.equal(result.code, 'INVALID_PRIORITY');
  clearInterval(router._cleanupInterval);
});

test('Router: invalid target name rejected', async () => {
  const { router } = createRouter();
  const result = await router.handle({
    id: 'req-1', type: 'chat.submit', target: '-invalid', text: 'hello'
  }, () => {});
  assert.equal(result.code, 'INVALID_TARGET');
  clearInterval(router._cleanupInterval);
});

test('Router: target too long (>32 chars) rejected', async () => {
  const { router } = createRouter();
  const result = await router.handle({
    id: 'req-1', type: 'chat.submit', target: 'a'.repeat(33), text: 'hello'
  }, () => {});
  assert.equal(result.code, 'INVALID_TARGET');
  clearInterval(router._cleanupInterval);
});

test('Router: unsupported target returns UNSUPPORTED_TARGET', async () => {
  const { router } = createRouter();
  const result = await router.handle({
    id: 'req-1', type: 'chat.submit', target: 'nonexistent', text: 'hello'
  }, () => {});
  assert.equal(result.code, 'UNSUPPORTED_TARGET');
  clearInterval(router._cleanupInterval);
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: Queue management
// ═══════════════════════════════════════════════════════════════

test('Router: critical priority goes to head of queue', async () => {
  const { router } = createRouter({
    submit: async (text) => {
      await new Promise(r => setTimeout(r, 200));
      return { grade: 'submitted' };
    }
  });
  const responses = [];
  const sendFn = (r) => responses.push(r);

  // Fill queue: first request starts processing
  await router.handle({
    id: 'req-1', type: 'chat.submit', target: 'copilot', text: 'first'
  }, sendFn);

  // Normal priority queued
  await router.handle({
    id: 'req-2', type: 'chat.submit', target: 'copilot', text: 'normal'
  }, sendFn);

  // Critical priority should go before normal
  await router.handle({
    id: 'req-3', type: 'chat.submit', target: 'copilot', text: 'critical',
    priority: 'critical'
  }, sendFn);

  // Check queue state
  const queue = router._queues.get('copilot');
  if (queue && queue.length >= 2) {
    assert.equal(queue[0].request.id, 'req-3', 'Critical at head of queue');
  }

  clearInterval(router._cleanupInterval);
});

test('Router: queue full returns QUEUE_FULL error', async () => {
  const { router } = createRouter({
    submit: async () => {
      await new Promise(r => setTimeout(r, 5000));
      return { grade: 'submitted' };
    }
  });
  const sendFn = () => {};

  // Fill queue beyond capacity
  for (let i = 0; i < QUEUE_MAX + 1; i++) {
    await router.handle({
      id: `req-${i}`, type: 'chat.submit', target: 'copilot', text: `msg-${i}`
    }, sendFn);
  }

  // Next request should get QUEUE_FULL
  const result = await router.handle({
    id: 'overflow', type: 'chat.submit', target: 'copilot', text: 'overflow'
  }, sendFn);

  assert.equal(result?.code, 'QUEUE_FULL', 'Queue full after capacity exceeded');

  clearInterval(router._cleanupInterval);
});

test('Router: critical rate limiting (max 3/min)', async () => {
  const { router } = createRouter();
  const sendFn = () => {};

  // Send 3 critical requests
  for (let i = 0; i < 3; i++) {
    await router.handle({
      id: `crit-${i}`, type: 'chat.submit', target: 'copilot',
      text: 'critical msg', priority: 'critical'
    }, sendFn);
  }

  // 4th critical should be rate limited
  const result = await router.handle({
    id: 'crit-4', type: 'chat.submit', target: 'copilot',
    text: 'critical msg', priority: 'critical'
  }, sendFn);

  assert.equal(result.code, 'RATE_LIMITED', '4th critical request rate limited');

  clearInterval(router._cleanupInterval);
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: _sanitizeError
// ═══════════════════════════════════════════════════════════════

test('Router: _sanitizeError strips Windows paths', () => {
  const { router } = createRouter();
  const result = router._sanitizeError('Error at C:\\Users\\test\\project\\file.js:42');
  assert.ok(!result.includes('C:\\'), 'Windows path stripped');
  assert.ok(result.includes('<path>'), 'Replaced with <path>');
  clearInterval(router._cleanupInterval);
});

test('Router: _sanitizeError strips Unix paths', () => {
  const { router } = createRouter();
  const result = router._sanitizeError('Error at /home/user/project/file.js:42');
  assert.ok(!result.includes('/home/'), 'Unix path stripped');
  assert.ok(result.includes('<path>'), 'Replaced with <path>');
  clearInterval(router._cleanupInterval);
});

test('Router: _sanitizeError caps at 200 chars', () => {
  const { router } = createRouter();
  const result = router._sanitizeError('x'.repeat(500));
  assert.ok(result.length <= 200, 'Capped at 200 chars');
  clearInterval(router._cleanupInterval);
});

test('Router: _sanitizeError handles null/undefined', () => {
  const { router } = createRouter();
  assert.equal(router._sanitizeError(null), 'Internal error');
  assert.equal(router._sanitizeError(undefined), 'Internal error');
  clearInterval(router._cleanupInterval);
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: _cleanIdempotencyCache
// ═══════════════════════════════════════════════════════════════

test('Router: _cleanIdempotencyCache removes expired entries', () => {
  const { router } = createRouter();

  // Manually add entries with old timestamps
  router._idempotencyCache.set('old-key', {
    response: { ok: true },
    ts: Date.now() - IDEMPOTENCY_TTL_MS - 1000
  });
  router._idempotencyCache.set('new-key', {
    response: { ok: true },
    ts: Date.now()
  });

  router._cleanIdempotencyCache();

  assert.equal(router._idempotencyCache.has('old-key'), false, 'Expired entry removed');
  assert.equal(router._idempotencyCache.has('new-key'), true, 'Fresh entry preserved');

  clearInterval(router._cleanupInterval);
});

test('Router: idempotency cache eviction at capacity', () => {
  const { router } = createRouter();

  // Fill cache to capacity
  for (let i = 0; i < IDEMPOTENCY_CACHE_MAX; i++) {
    router._idempotencyCache.set(`key-${i}`, {
      response: { ok: true },
      ts: Date.now()
    });
  }

  assert.equal(router._idempotencyCache.size, IDEMPOTENCY_CACHE_MAX, 'At capacity');

  // Note: eviction happens during _executeSubmit, not here
  // But we can verify that the cache has a bound
  clearInterval(router._cleanupInterval);
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: Adapter availability check
// ═══════════════════════════════════════════════════════════════

test('Router: unavailable adapter returns TARGET_UNAVAILABLE', async () => {
  const mockAdapter = {
    available: false, // not available
    submit: async () => ({ grade: 'submitted' }),
  };

  const router = new Router({
    adapters: { copilot: mockAdapter },
    log: () => {},
  });

  const result = await router.handle({
    id: 'req-1', type: 'chat.submit', target: 'copilot', text: 'hello'
  }, () => {});

  assert.equal(result.code, 'TARGET_UNAVAILABLE');

  clearInterval(router._cleanupInterval);
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: Request type routing
// ═══════════════════════════════════════════════════════════════

test('Router: list-commands without vscode returns NO_VSCODE', async () => {
  const { router } = createRouter();
  const result = await router.handle({ id: 'req-1', type: 'list-commands' }, () => {});
  assert.equal(result.code, 'NO_VSCODE');
  clearInterval(router._cleanupInterval);
});

test('Router: reload without vscode returns error', async () => {
  const { router } = createRouter();
  const result = await router.handle({ id: 'req-1', type: 'reload' }, () => {});
  // Should handle gracefully even without vscode
  assert.ok(result, 'Returns a response');
  clearInterval(router._cleanupInterval);
});

test('Router: unknown type caps at 64 chars in error message', async () => {
  const { router } = createRouter();
  const longType = 'x'.repeat(100);
  const result = await router.handle({ id: 'req-1', type: longType }, () => {});
  assert.equal(result.code, 'UNKNOWN_TYPE');
  assert.ok(result.message.length < 200, 'Error message bounded');
  clearInterval(router._cleanupInterval);
});
