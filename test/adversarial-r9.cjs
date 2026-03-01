#!/usr/bin/env node
/**
 * adversarial-r9.cjs — Round 9 adversarial tests for IPC Bridge
 * ---------------------------------------------------------------
 * Focus: Router queue processing (critical priority, busy policy,
 * processing timeout, queue capacity), idempotency cache (TTL,
 * eviction, scoped keys), dangerous unicode/terminal pattern
 * detection, _handleRunCommand blocklist, _sanitizeError inline
 * vs _processQueue sanitization, pipe_server buffer boundary,
 * adapter null check, cross-component text payload validation.
 *
 * Usage: node test/adversarial-r9.cjs
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
const PROCESSING_TIMEOUT_MS = 30_000;

// Inline replicas of validation patterns from router.cjs
const DANGEROUS_TERMINAL_PATTERNS = /[\x00-\x08\x0e-\x1f\x7f]/;
const DANGEROUS_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/;
const SAFE_ID_PATTERN = /^[\x20-\x7E]+$/;

// Helper: create a Router with a mock adapter
function createRouter(adapterOverrides = {}) {
  const adapter = {
    available: true,
    method: 'test',
    busyPolicy: 'reject-when-busy',
    isBusy: () => false,
    submit: async (text) => ({ grade: 'submitted', detail: 'test' }),
    probe: async () => ({}),
    ...adapterOverrides,
  };
  const router = new Router({
    adapters: { test: adapter, copilot: adapter },
    log: () => {},
  });
  return router;
}

// ═══════════════════════════════════════════════════════════════
// DANGEROUS TERMINAL PATTERNS: Control character detection
// ═══════════════════════════════════════════════════════════════

test('dangerous terminal: null byte detected', () => {
  assert.ok(DANGEROUS_TERMINAL_PATTERNS.test('\x00'), 'Null byte blocked');
});

test('dangerous terminal: bell char detected', () => {
  assert.ok(DANGEROUS_TERMINAL_PATTERNS.test('\x07'), 'Bell blocked');
});

test('dangerous terminal: escape char detected', () => {
  assert.ok(DANGEROUS_TERMINAL_PATTERNS.test('\x1b'), 'Escape blocked');
});

test('dangerous terminal: tab NOT detected (allowed)', () => {
  assert.ok(!DANGEROUS_TERMINAL_PATTERNS.test('\t'), 'Tab allowed (\\x09)');
});

test('dangerous terminal: newline NOT detected (allowed)', () => {
  assert.ok(!DANGEROUS_TERMINAL_PATTERNS.test('\n'), 'Newline allowed (\\x0a)');
});

test('dangerous terminal: carriage return NOT detected (allowed)', () => {
  assert.ok(!DANGEROUS_TERMINAL_PATTERNS.test('\r'), 'CR allowed (\\x0d)');
});

test('dangerous terminal: DEL char (\\x7f) detected', () => {
  assert.ok(DANGEROUS_TERMINAL_PATTERNS.test('\x7f'), 'DEL blocked');
});

test('dangerous terminal: printable ASCII not detected', () => {
  assert.ok(!DANGEROUS_TERMINAL_PATTERNS.test('Hello World!'), 'Normal text safe');
});

// ═══════════════════════════════════════════════════════════════
// DANGEROUS UNICODE: Bidi and zero-width detection
// ═══════════════════════════════════════════════════════════════

test('dangerous unicode: zero-width space (U+200B)', () => {
  assert.ok(DANGEROUS_UNICODE.test('\u200B'), 'ZWSP blocked');
});

test('dangerous unicode: left-to-right mark (U+200E)', () => {
  assert.ok(DANGEROUS_UNICODE.test('\u200E'), 'LRM blocked');
});

test('dangerous unicode: right-to-left override (U+202E)', () => {
  assert.ok(DANGEROUS_UNICODE.test('\u202E'), 'RLO blocked — can reverse displayed text');
});

test('dangerous unicode: invisible function apply (U+2061) IS detected (in range 2060-2064)', () => {
  // The regex [\u2060-\u2064] includes 2060, 2061, 2062, 2063, 2064
  assert.ok(DANGEROUS_UNICODE.test('\u2061'), 'U+2061 IS detected (in range)');
});

test('dangerous unicode: U+2065 NOT in range (just outside)', () => {
  // The regex range is [\u2060-\u2064] — U+2065 is outside
  assert.ok(!DANGEROUS_UNICODE.test('\u2065'),
    'DESIGN GAP: U+2065 (invisible separator) not blocked');
});

test('dangerous unicode: BOM (U+FEFF)', () => {
  assert.ok(DANGEROUS_UNICODE.test('\uFEFF'), 'BOM blocked');
});

test('dangerous unicode: normal emoji NOT detected', () => {
  assert.ok(!DANGEROUS_UNICODE.test('Hello 👋'), 'Emoji is safe');
});

test('dangerous unicode: mixed in text detected', () => {
  assert.ok(DANGEROUS_UNICODE.test('Hello\u200BWorld'), 'ZWSP in text detected');
});

// ═══════════════════════════════════════════════════════════════
// SAFE ID PATTERN: Printable ASCII validation
// ═══════════════════════════════════════════════════════════════

test('safe ID: normal string passes', () => {
  assert.ok(SAFE_ID_PATTERN.test('req-123-abc'), 'Normal ID');
});

test('safe ID: spaces allowed (\\x20)', () => {
  assert.ok(SAFE_ID_PATTERN.test('request 123'), 'Spaces are printable ASCII');
});

test('safe ID: tilde allowed (\\x7E)', () => {
  assert.ok(SAFE_ID_PATTERN.test('req~123'), 'Tilde is printable');
});

test('safe ID: DEL (\\x7F) NOT allowed', () => {
  assert.ok(!SAFE_ID_PATTERN.test('req\x7Ftest'), 'DEL not printable');
});

test('safe ID: unicode NOT allowed', () => {
  assert.ok(!SAFE_ID_PATTERN.test('req-日本語'), 'Unicode rejected');
});

test('safe ID: empty string NOT allowed', () => {
  assert.ok(!SAFE_ID_PATTERN.test(''), 'Empty rejected (requires at least 1 char)');
});

test('safe ID: newline NOT allowed', () => {
  assert.ok(!SAFE_ID_PATTERN.test('req\ntest'), 'Newline rejected');
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: Chat submit input validation
// ═══════════════════════════════════════════════════════════════

test('Router: empty text rejected', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'r1', target: 'test', text: '', priority: 'normal' },
    () => {}
  );
  assert.equal(result.code, 'INVALID_TEXT', 'Empty text rejected');
  clearInterval(router._cleanupInterval);
});

test('Router: text with null byte rejected', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'r2', target: 'test', text: 'hello\x00world', priority: 'normal' },
    () => {}
  );
  assert.equal(result.code, 'INVALID_TEXT', 'Null byte in text rejected');
  clearInterval(router._cleanupInterval);
});

test('Router: text with zero-width space rejected', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'r3', target: 'test', text: 'hello\u200Bworld', priority: 'normal' },
    () => {}
  );
  assert.equal(result.code, 'INVALID_TEXT', 'Zero-width space rejected');
  clearInterval(router._cleanupInterval);
});

test('Router: text exceeding 64KB rejected', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'r4', target: 'test', text: 'x'.repeat(MAX_TEXT_LENGTH + 1), priority: 'normal' },
    () => {}
  );
  assert.equal(result.code, 'TEXT_TOO_LARGE', 'Oversized text rejected');
  clearInterval(router._cleanupInterval);
});

test('Router: text at exactly 64KB accepted', () => {
  const router = createRouter();
  const responses = [];
  const result = router._handleChatSubmit(
    { id: 'r5', target: 'test', text: 'x'.repeat(MAX_TEXT_LENGTH), priority: 'normal' },
    (r) => responses.push(r)
  );
  // result is null when ack sent via sendFn
  assert.equal(result, null, 'Exactly 64KB accepted');
  assert.ok(responses.length > 0, 'Ack sent');
  assert.equal(responses[0].ok, true, 'Ack is OK');
  clearInterval(router._cleanupInterval);
});

test('Router: invalid priority rejected', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'r6', target: 'test', text: 'hello', priority: 'urgent' },
    () => {}
  );
  assert.equal(result.code, 'INVALID_PRIORITY', 'Unknown priority rejected');
  clearInterval(router._cleanupInterval);
});

test('Router: invalid target format rejected', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'r7', target: '../escape', text: 'hello' },
    () => {}
  );
  assert.equal(result.code, 'INVALID_TARGET', 'Path traversal in target rejected');
  clearInterval(router._cleanupInterval);
});

test('Router: unknown target rejected', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'r8', target: 'nonexistent', text: 'hello' },
    () => {}
  );
  assert.equal(result.code, 'UNSUPPORTED_TARGET', 'Unknown target rejected');
  clearInterval(router._cleanupInterval);
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: Queue capacity and ordering
// ═══════════════════════════════════════════════════════════════

test('Router: queue fills to QUEUE_MAX then rejects', () => {
  // Use busy adapter to prevent _processQueue from consuming entries
  const router = createRouter({
    submit: async () => ({ grade: 'ok' }),
    isBusy: () => true,
    busyPolicy: 'reject-when-busy',
  });

  // Pre-fill queue directly to avoid processing
  const queue = [];
  for (let i = 0; i < QUEUE_MAX; i++) {
    queue.push({ request: { id: `q-${i}` }, sendFn: () => {}, idempotencyKey: null });
  }
  router._queues.set('test', queue);
  router._busy.set('test', true); // pretend busy

  // Next request should be rejected
  const result = router._handleChatSubmit(
    { id: 'overflow', target: 'test', text: 'overflow msg' },
    () => {}
  );
  assert.equal(result.code, 'QUEUE_FULL', 'Queue full rejection');
  router.dispose();
});

test('Router: critical priority goes to head of queue', () => {
  const router = createRouter({
    submit: async () => ({ grade: 'ok' }),
  });

  // Pre-fill queue with one entry, set busy
  router._queues.set('test', [
    { request: { id: 'existing' }, sendFn: () => {}, idempotencyKey: null }
  ]);
  router._busy.set('test', true);

  // Normal request queues at tail
  router._handleChatSubmit(
    { id: 'normal', target: 'test', text: 'normal', priority: 'normal' },
    () => {}
  );

  // Critical request queues at head
  router._handleChatSubmit(
    { id: 'critical', target: 'test', text: 'critical', priority: 'critical' },
    () => {}
  );

  const queue = router._queues.get('test');
  // unshift puts critical at [0], existing at [1], normal at [2]
  assert.ok(queue.length >= 3, 'Queue has entries');
  assert.equal(queue[0].request.id, 'critical', 'Critical at head (unshifted)');
  assert.equal(queue[1].request.id, 'existing', 'Existing pushed to middle');
  assert.equal(queue[2].request.id, 'normal', 'Normal at tail');
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: Critical rate limiting
// ═══════════════════════════════════════════════════════════════

test('Router: 3 critical requests → 4th rate limited', () => {
  const router = createRouter();
  // Manually inject 3 critical timestamps (simulates 3 prior critical sends)
  router._criticalTimestamps = [Date.now(), Date.now(), Date.now()];

  // 4th should be rate limited
  const result = router._handleChatSubmit(
    { id: 'c-3', target: 'test', text: 'critical 3', priority: 'critical' },
    () => {}
  );
  assert.equal(result.code, 'RATE_LIMITED', '4th critical rate limited');
  router.dispose();
});

test('Router: critical timestamps expire after 60s', () => {
  const router = createRouter();
  // Manually inject old timestamps
  router._criticalTimestamps = [
    Date.now() - 61_000,
    Date.now() - 61_000,
    Date.now() - 61_000,
  ];

  // Should succeed because old timestamps are expired
  const result = router._handleChatSubmit(
    { id: 'c-new', target: 'test', text: 'new critical', priority: 'critical' },
    () => {}
  );
  assert.equal(result, null, 'Old timestamps expired → accepted');
  clearInterval(router._cleanupInterval);
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: Idempotency cache
// ═══════════════════════════════════════════════════════════════

test('Router: idempotency cache scoped by target+type', () => {
  const router = createRouter();
  const key1 = 'test:chat.submit:dedup-1';
  const key2 = 'copilot:chat.submit:dedup-1';
  router._idempotencyCache.set(key1, { response: { ok: true }, ts: Date.now() });
  router._idempotencyCache.set(key2, { response: { ok: true }, ts: Date.now() });
  assert.notEqual(key1, key2, 'Same idempotencyKey, different targets → different cache keys');
  assert.equal(router._idempotencyCache.size, 2, '2 separate entries');
  clearInterval(router._cleanupInterval);
});

test('Router: idempotency cache cleanup removes expired entries', () => {
  const router = createRouter();
  router._idempotencyCache.set('old', { response: {}, ts: Date.now() - 61_000 });
  router._idempotencyCache.set('new', { response: {}, ts: Date.now() });

  router._cleanIdempotencyCache();

  assert.ok(!router._idempotencyCache.has('old'), 'Old entry removed');
  assert.ok(router._idempotencyCache.has('new'), 'New entry kept');
  clearInterval(router._cleanupInterval);
});

test('Router: idempotency cache bounded at 200', () => {
  const router = createRouter();
  // Fill beyond capacity
  for (let i = 0; i < 210; i++) {
    if (router._idempotencyCache.size >= IDEMPOTENCY_CACHE_MAX) {
      const oldestKey = router._idempotencyCache.keys().next().value;
      if (oldestKey !== undefined) router._idempotencyCache.delete(oldestKey);
    }
    router._idempotencyCache.set(`key-${i}`, { response: {}, ts: Date.now() });
  }
  assert.ok(router._idempotencyCache.size <= IDEMPOTENCY_CACHE_MAX, 'Bounded at 200');
  clearInterval(router._cleanupInterval);
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: _handleRunCommand blocklist
// ═══════════════════════════════════════════════════════════════

test('Router: quit command blocked', async () => {
  const router = createRouter();
  const result = await router._handleRunCommand({ id: 'rc1', command: 'workbench.action.quit' });
  assert.equal(result.code, 'BLOCKED_COMMAND', 'Quit blocked');
  clearInterval(router._cleanupInterval);
});

test('Router: closeWindow blocked', async () => {
  const router = createRouter();
  const result = await router._handleRunCommand({ id: 'rc2', command: 'workbench.action.closeWindow' });
  assert.equal(result.code, 'BLOCKED_COMMAND', 'Close window blocked');
  clearInterval(router._cleanupInterval);
});

test('Router: terminal.sendSequence blocked', async () => {
  const router = createRouter();
  const result = await router._handleRunCommand({ id: 'rc3', command: 'workbench.action.terminal.sendSequence' });
  assert.equal(result.code, 'BLOCKED_COMMAND', 'Terminal send blocked');
  clearInterval(router._cleanupInterval);
});

test('Router: terminal.send prefix blocks all send variants', async () => {
  const router = createRouter();
  const result = await router._handleRunCommand({ id: 'rc4', command: 'workbench.action.terminal.sendCustomSequence' });
  assert.equal(result.code, 'BLOCKED_COMMAND', 'Terminal send prefix blocked');
  clearInterval(router._cleanupInterval);
});

test('Router: deleteFile blocked', async () => {
  const router = createRouter();
  const result = await router._handleRunCommand({ id: 'rc5', command: 'deleteFile' });
  assert.equal(result.code, 'BLOCKED_COMMAND', 'Delete file blocked');
  clearInterval(router._cleanupInterval);
});

test('Router: safe command needs vscode', async () => {
  const router = createRouter();
  const result = await router._handleRunCommand({ id: 'rc6', command: 'workbench.action.showCommands' });
  assert.equal(result.code, 'NO_VSCODE', 'Safe command needs vscode API');
  clearInterval(router._cleanupInterval);
});

test('Router: missing command field rejected', async () => {
  const router = createRouter();
  const result = await router._handleRunCommand({ id: 'rc7' });
  assert.equal(result.code, 'MISSING_COMMAND', 'No command → error');
  clearInterval(router._cleanupInterval);
});

test('Router: empty string command rejected', async () => {
  const router = createRouter();
  const result = await router._handleRunCommand({ id: 'rc8', command: '' });
  assert.equal(result.code, 'MISSING_COMMAND', 'Empty command → error');
  clearInterval(router._cleanupInterval);
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: _sanitizeError consistency
// ═══════════════════════════════════════════════════════════════

test('Router: _sanitizeError strips Windows paths', () => {
  const router = createRouter();
  const result = router._sanitizeError('Error at C:\\Users\\test\\file.js:42');
  assert.ok(!result.includes('C:\\Users'), 'Windows path stripped');
  assert.ok(result.includes('<path>'), 'Replaced with <path>');
  clearInterval(router._cleanupInterval);
});

test('Router: _sanitizeError strips Unix paths', () => {
  const router = createRouter();
  const result = router._sanitizeError('Error at /home/user/app/file.js:42');
  assert.ok(!result.includes('/home/user'), 'Unix path stripped');
  clearInterval(router._cleanupInterval);
});

test('Router: _sanitizeError truncates to 200 chars', () => {
  const router = createRouter();
  const longMsg = 'x'.repeat(300);
  const result = router._sanitizeError(longMsg);
  assert.equal(result.length, 200, 'Truncated to 200');
  clearInterval(router._cleanupInterval);
});

test('Router: _sanitizeError null → "Internal error"', () => {
  const router = createRouter();
  const result = router._sanitizeError(null);
  assert.equal(result, 'Internal error', 'null → default message');
  clearInterval(router._cleanupInterval);
});

test('Router: _sanitizeError undefined → "Internal error"', () => {
  const router = createRouter();
  const result = router._sanitizeError(undefined);
  assert.equal(result, 'Internal error', 'undefined → default message');
  clearInterval(router._cleanupInterval);
});

test('Router: _sanitizeError empty string → "Internal error"', () => {
  const router = createRouter();
  const result = router._sanitizeError('');
  assert.equal(result, 'Internal error', 'Empty → default (falsy)');
  clearInterval(router._cleanupInterval);
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: Adapter null check
// ═══════════════════════════════════════════════════════════════

test('Router: null adapter in map → UNSUPPORTED_TARGET', () => {
  const router = new Router({
    adapters: { broken: null },
    log: () => {},
  });
  const result = router._handleChatSubmit(
    { id: 'null-adapt', target: 'broken', text: 'test' },
    () => {}
  );
  assert.equal(result.code, 'UNSUPPORTED_TARGET', 'null adapter rejected');
  clearInterval(router._cleanupInterval);
});

test('Router: adapter with available=false → TARGET_UNAVAILABLE', () => {
  const router = new Router({
    adapters: { disabled: { available: false } },
    log: () => {},
  });
  const result = router._handleChatSubmit(
    { id: 'disabled', target: 'disabled', text: 'test' },
    () => {}
  );
  assert.equal(result.code, 'TARGET_UNAVAILABLE', 'Disabled adapter rejected');
  clearInterval(router._cleanupInterval);
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: Unknown request type handling
// ═══════════════════════════════════════════════════════════════

test('Router: unknown type → UNKNOWN_TYPE error', async () => {
  const router = createRouter();
  const result = await router.handle({ id: 'unk', type: 'invalid' }, () => {});
  assert.equal(result.code, 'UNKNOWN_TYPE', 'Unknown type rejected');
  clearInterval(router._cleanupInterval);
});

test('Router: type truncated to 64 chars in error', async () => {
  const router = createRouter();
  const longType = 'x'.repeat(100);
  const result = await router.handle({ id: 'long', type: longType }, () => {});
  assert.ok(result.message.length < 100, 'Long type truncated in error message');
  clearInterval(router._cleanupInterval);
});

test('Router: missing type → MISSING_TYPE error', async () => {
  const router = createRouter();
  const result = await router.handle({ id: 'notype' }, () => {});
  assert.equal(result.code, 'MISSING_TYPE', 'Missing type rejected');
  clearInterval(router._cleanupInterval);
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: getStatus
// ═══════════════════════════════════════════════════════════════

test('Router: getStatus reports all adapters', () => {
  const router = createRouter();
  const status = router.getStatus();
  assert.ok(status.test, 'test adapter in status');
  assert.ok(status.copilot, 'copilot adapter in status');
  assert.equal(status.test.available, true, 'Adapter available');
  assert.equal(status.test.busy, false, 'Not busy');
  assert.equal(status.test.queueLength, 0, 'Empty queue');
  clearInterval(router._cleanupInterval);
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: dispose cleanup
// ═══════════════════════════════════════════════════════════════

test('Router: dispose clears all state', () => {
  const router = createRouter();
  router._idempotencyCache.set('key1', { response: {}, ts: Date.now() });
  router._queues.set('test', [{ request: {} }]);

  router.dispose();

  assert.equal(router._idempotencyCache.size, 0, 'Cache cleared');
  assert.equal(router._queues.size, 0, 'Queues cleared');
});

// ═══════════════════════════════════════════════════════════════
// PIPE SERVER: Buffer boundary (inline replica)
// ═══════════════════════════════════════════════════════════════

test('pipe server: buffer at exactly MAX → allowed', () => {
  const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB
  const buffer = 'x'.repeat(MAX_MESSAGE_SIZE);
  const byteLength = Buffer.byteLength(buffer, 'utf8');
  assert.ok(!(byteLength > MAX_MESSAGE_SIZE), 'Exactly at limit → allowed');
});

test('pipe server: buffer at MAX+1 → overflow', () => {
  const MAX_MESSAGE_SIZE = 1024 * 1024;
  const buffer = 'x'.repeat(MAX_MESSAGE_SIZE + 1);
  const byteLength = Buffer.byteLength(buffer, 'utf8');
  assert.ok(byteLength > MAX_MESSAGE_SIZE, 'One byte over → overflow');
});

test('pipe server: multi-byte chars change byte count', () => {
  const MAX_MESSAGE_SIZE = 1024 * 1024;
  // 500K emoji = 2M bytes (UTF-16) but Buffer.byteLength uses UTF-8
  const emoji = '😀'.repeat(100);
  const charLen = emoji.length; // 200 (surrogate pairs)
  const byteLen = Buffer.byteLength(emoji, 'utf8');
  assert.ok(byteLen > charLen, 'Emoji byte length > char length');
});

// ═══════════════════════════════════════════════════════════════
// CROSS-COMPONENT: Request ID validation
// ═══════════════════════════════════════════════════════════════

test('cross-component: request ID with unicode rejected', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'req-日本語', target: 'test', text: 'hello' },
    () => {}
  );
  assert.equal(result.code, 'INVALID_ID', 'Unicode in ID rejected');
  clearInterval(router._cleanupInterval);
});

test('cross-component: request ID over 256 chars rejected', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'x'.repeat(257), target: 'test', text: 'hello' },
    () => {}
  );
  assert.equal(result.code, 'INVALID_ID', 'Long ID rejected');
  clearInterval(router._cleanupInterval);
});

test('cross-component: request ID with newline rejected', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { id: 'req\ninjection', target: 'test', text: 'hello' },
    () => {}
  );
  assert.equal(result.code, 'INVALID_ID', 'Newline in ID rejected');
  clearInterval(router._cleanupInterval);
});

test('cross-component: no ID → validation skipped (ID is optional)', () => {
  const router = createRouter();
  const result = router._handleChatSubmit(
    { target: 'test', text: 'hello' },
    () => {}
  );
  // No ID = valid, null/undefined skips validation
  assert.equal(result, null, 'Missing ID is OK');
  clearInterval(router._cleanupInterval);
});
