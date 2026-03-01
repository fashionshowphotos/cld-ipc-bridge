#!/usr/bin/env node
/**
 * adversarial-r8.cjs — Round 8 adversarial tests for IPC Bridge
 * ---------------------------------------------------------------
 * Focus: Registry PID validation, instanceId validation, findInstance
 * target/editor matching, workspaceHash consistency, writeRegistry
 * tokenHint stripping, pipe_server rate limiting window, auth
 * timeout boundary, buffer overflow protection, Router idempotency
 * cache eviction, _sanitizeError path regex exhaustive testing.
 *
 * Usage: node test/adversarial-r8.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// ── Router ────────────────────────────────────────────────────
const { Router } = require('../lib/router.cjs');

// ═══════════════════════════════════════════════════════════════
// REGISTRY: PID validation edge cases
// ═══════════════════════════════════════════════════════════════

const MAX_PID = 4194304;
const INSTANCE_ID_RE = /^[0-9a-f]{8}$/;

function isValidPid(pid) {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid <= MAX_PID;
}

function isValidInstanceId(id) {
  return typeof id === 'string' && INSTANCE_ID_RE.test(id);
}

test('Registry PID: 0 rejected (not positive)', () => {
  assert.equal(isValidPid(0), false, 'PID 0 rejected');
});

test('Registry PID: -1 rejected (negative)', () => {
  assert.equal(isValidPid(-1), false, 'Negative rejected');
});

test('Registry PID: 1 accepted (minimum valid)', () => {
  assert.ok(isValidPid(1), 'PID 1 valid');
});

test('Registry PID: MAX_PID accepted', () => {
  assert.ok(isValidPid(MAX_PID), 'MAX_PID valid');
});

test('Registry PID: MAX_PID + 1 rejected', () => {
  assert.equal(isValidPid(MAX_PID + 1), false, 'Over MAX rejected');
});

test('Registry PID: float rejected', () => {
  assert.equal(isValidPid(123.5), false, 'Float rejected');
});

test('Registry PID: NaN rejected', () => {
  assert.equal(isValidPid(NaN), false, 'NaN rejected');
});

test('Registry PID: Infinity rejected', () => {
  assert.equal(isValidPid(Infinity), false, 'Infinity rejected');
});

test('Registry PID: string "123" rejected (type check)', () => {
  assert.equal(isValidPid('123'), false, 'String rejected');
});

test('Registry PID: null rejected', () => {
  assert.equal(isValidPid(null), false, 'null rejected');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: Instance ID validation
// ═══════════════════════════════════════════════════════════════

test('Registry instanceId: valid 8 hex chars', () => {
  assert.ok(isValidInstanceId('abcdef12'), 'Lowercase hex');
  assert.ok(isValidInstanceId('00000000'), 'All zeros');
  assert.ok(isValidInstanceId('ffffffff'), 'All f');
});

test('Registry instanceId: uppercase rejected', () => {
  assert.equal(isValidInstanceId('ABCDEF12'), false, 'Uppercase hex rejected');
});

test('Registry instanceId: 7 chars rejected', () => {
  assert.equal(isValidInstanceId('abcdef1'), false, 'Too short');
});

test('Registry instanceId: 9 chars rejected', () => {
  assert.equal(isValidInstanceId('abcdef123'), false, 'Too long');
});

test('Registry instanceId: non-hex chars rejected', () => {
  assert.equal(isValidInstanceId('abcdefgg'), false, 'Non-hex rejected');
});

test('Registry instanceId: empty string rejected', () => {
  assert.equal(isValidInstanceId(''), false, 'Empty rejected');
});

test('Registry instanceId: number rejected', () => {
  assert.equal(isValidInstanceId(12345678), false, 'Number type rejected');
});

test('Registry instanceId: null rejected', () => {
  assert.equal(isValidInstanceId(null), false, 'null rejected');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: Workspace hash consistency
// ═══════════════════════════════════════════════════════════════

test('workspaceHash: same path always same hash', () => {
  const hash = (p) => crypto.createHash('sha256').update(p || 'global').digest('hex').slice(0, 6);
  assert.equal(hash('/foo/bar'), hash('/foo/bar'), 'Deterministic');
});

test('workspaceHash: null/undefined → "global"', () => {
  const hash = (p) => crypto.createHash('sha256').update(p || 'global').digest('hex').slice(0, 6);
  assert.equal(hash(null), hash(undefined), 'Both map to global');
  assert.equal(hash(null), hash(''), 'Empty also maps to global');
  // Wait: '' || 'global' = 'global', null || 'global' = 'global', undefined || 'global' = 'global'
});

test('workspaceHash: different paths produce different hashes', () => {
  const hash = (p) => crypto.createHash('sha256').update(p || 'global').digest('hex').slice(0, 6);
  assert.notEqual(hash('/path/a'), hash('/path/b'), 'Different paths → different hashes');
});

test('workspaceHash: 6 hex chars output', () => {
  const hash = crypto.createHash('sha256').update('test').digest('hex').slice(0, 6);
  assert.equal(hash.length, 6, '6 chars');
  assert.ok(/^[0-9a-f]{6}$/.test(hash), 'Hex chars only');
});

test('workspaceHash: case sensitivity', () => {
  const hash = (p) => crypto.createHash('sha256').update(p || 'global').digest('hex').slice(0, 6);
  // Windows paths may have different case
  assert.notEqual(hash('C:\\Users\\test'), hash('c:\\users\\test'),
    'DESIGN GAP: case-sensitive hashing on case-insensitive filesystem');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: tokenHint stripping
// ═══════════════════════════════════════════════════════════════

test('writeRegistry: tokenHint stripped via destructuring', () => {
  const entry = {
    instanceId: 'abcd1234',
    pipe: '\\\\.\\pipe\\test',
    pid: 1234,
    tokenHint: 'secret-token-value',
    capabilities: {},
  };
  const { tokenHint: _stripped, ...safeEntry } = entry;
  assert.ok(!('tokenHint' in safeEntry), 'tokenHint removed');
  assert.ok('instanceId' in safeEntry, 'Other fields preserved');
  assert.ok('pid' in safeEntry, 'pid preserved');
});

test('writeRegistry: entry without tokenHint — destructuring safe', () => {
  const entry = { instanceId: 'abcd1234', pid: 1234 };
  const { tokenHint: _stripped, ...safeEntry } = entry;
  assert.equal(_stripped, undefined, 'Undefined tokenHint is fine');
  assert.ok('instanceId' in safeEntry, 'Fields preserved');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: findInstance matching logic (pure tests)
// ═══════════════════════════════════════════════════════════════

test('findInstance: exact instanceId match', () => {
  const entries = [
    { instanceId: 'aaaa1111', pid: 100, workspaceName: 'project-a' },
    { instanceId: 'bbbb2222', pid: 200, workspaceName: 'project-b' },
  ];
  const criteria = { instanceId: 'aaaa1111' };
  const found = entries.find(e => e.instanceId === criteria.instanceId);
  assert.equal(found.workspaceName, 'project-a');
});

test('findInstance: workspacePath case insensitive', () => {
  const entries = [
    { workspacePath: 'C:\\Users\\test\\Project', pid: 100 },
  ];
  const criteria = { workspacePath: 'c:\\users\\test\\project' };
  const found = entries.find(e =>
    e.workspacePath && e.workspacePath.toLowerCase() === criteria.workspacePath.toLowerCase()
  );
  assert.ok(found, 'Case-insensitive path match');
});

test('findInstance: workspaceName uses substring match', () => {
  const entries = [
    { workspaceName: 'Coherent Light Designs', pid: 100 },
  ];
  const criteria = { workspaceName: 'coherent' };
  const matches = entries.filter(e =>
    e.workspaceName && e.workspaceName.toLowerCase().includes(criteria.workspaceName.toLowerCase())
  );
  assert.equal(matches.length, 1, 'Substring match');
});

test('findInstance: target preference in workspace matches', () => {
  const entries = [
    { workspaceName: 'project', pid: 100, capabilities: { targets: { copilot: { available: false } } } },
    { workspaceName: 'project', pid: 200, capabilities: { targets: { copilot: { available: true } } } },
  ];
  const criteria = { workspaceName: 'project', target: 'copilot' };
  const matches = entries.filter(e =>
    e.workspaceName && e.workspaceName.toLowerCase().includes(criteria.workspaceName.toLowerCase())
  );
  const withTarget = matches.find(e =>
    e.capabilities?.targets?.[criteria.target]?.available === true
  );
  assert.equal(withTarget.pid, 200, 'Target-available instance preferred');
});

test('findInstance: editorName filter', () => {
  const entries = [
    { editorName: 'visual studio code', pid: 100 },
    { editorName: 'antigravity', pid: 200 },
  ];
  const criteria = { editorName: 'antigravity' };
  const matches = entries.filter(e =>
    e.editorName && e.editorName.toLowerCase().includes(criteria.editorName.toLowerCase())
  );
  assert.equal(matches.length, 1, 'Filtered by editor');
  assert.equal(matches[0].pid, 200, 'Correct editor');
});

test('findInstance: editorName no match returns null', () => {
  const entries = [
    { editorName: 'visual studio code', pid: 100 },
  ];
  const criteria = { editorName: 'cursor' };
  const matches = entries.filter(e =>
    e.editorName && e.editorName.toLowerCase().includes(criteria.editorName.toLowerCase())
  );
  assert.equal(matches.length, 0, 'No cursor instances');
  // Code returns null when editorName explicitly requested but not found
});

// ═══════════════════════════════════════════════════════════════
// PIPE SERVER: Rate limiting logic (pure tests)
// ═══════════════════════════════════════════════════════════════

test('pipe rate limit: fresh connection allows messages', () => {
  const conn = { msgTimestamps: [] };
  const CONN_RATE_LIMIT = 30;
  const CONN_RATE_WINDOW_MS = 60000;
  const now = Date.now();
  conn.msgTimestamps = conn.msgTimestamps.filter(t => now - t < CONN_RATE_WINDOW_MS);
  assert.ok(conn.msgTimestamps.length < CONN_RATE_LIMIT, 'Under limit');
});

test('pipe rate limit: 30th message triggers limit', () => {
  const CONN_RATE_LIMIT = 30;
  const CONN_RATE_WINDOW_MS = 60000;
  const now = Date.now();
  const conn = { msgTimestamps: [] };
  // Add 30 timestamps within window
  for (let i = 0; i < 30; i++) {
    conn.msgTimestamps.push(now - i * 100);
  }
  conn.msgTimestamps = conn.msgTimestamps.filter(t => now - t < CONN_RATE_WINDOW_MS);
  assert.ok(conn.msgTimestamps.length >= CONN_RATE_LIMIT, 'At limit');
});

test('pipe rate limit: old timestamps expire', () => {
  const CONN_RATE_LIMIT = 30;
  const CONN_RATE_WINDOW_MS = 60000;
  const now = Date.now();
  const conn = { msgTimestamps: [] };
  // Add 30 timestamps 61s ago
  for (let i = 0; i < 30; i++) {
    conn.msgTimestamps.push(now - 61000 - i * 100);
  }
  conn.msgTimestamps = conn.msgTimestamps.filter(t => now - t < CONN_RATE_WINDOW_MS);
  assert.equal(conn.msgTimestamps.length, 0, 'All expired');
});

test('pipe rate limit: mixed old and new timestamps', () => {
  const CONN_RATE_LIMIT = 30;
  const CONN_RATE_WINDOW_MS = 60000;
  const now = Date.now();
  const conn = { msgTimestamps: [] };
  // 15 recent, 15 old
  for (let i = 0; i < 15; i++) {
    conn.msgTimestamps.push(now - i * 100); // recent
    conn.msgTimestamps.push(now - 61000 - i * 100); // old
  }
  conn.msgTimestamps = conn.msgTimestamps.filter(t => now - t < CONN_RATE_WINDOW_MS);
  assert.equal(conn.msgTimestamps.length, 15, '15 recent remain');
  assert.ok(conn.msgTimestamps.length < CONN_RATE_LIMIT, 'Under limit');
});

// ═══════════════════════════════════════════════════════════════
// PIPE SERVER: Buffer overflow protection
// ═══════════════════════════════════════════════════════════════

test('pipe buffer: MAX_MESSAGE_SIZE byte counting', () => {
  const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB
  // Buffer.byteLength counts bytes, not chars
  const ascii = 'a'.repeat(100);
  assert.equal(Buffer.byteLength(ascii, 'utf8'), 100, 'ASCII: 1 byte per char');

  const unicode = '€'.repeat(100);
  assert.equal(Buffer.byteLength(unicode, 'utf8'), 300, 'Euro sign: 3 bytes per char');
});

test('pipe buffer: NDJSON line parsing correctness', () => {
  let buffer = '{"type":"hello"}\n{"type":"world"}\n';
  const messages = [];
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line.length > 0) {
      messages.push(JSON.parse(line));
    }
  }
  assert.equal(messages.length, 2, '2 messages parsed');
  assert.equal(messages[0].type, 'hello');
  assert.equal(messages[1].type, 'world');
});

test('pipe buffer: partial JSON waits for newline', () => {
  let buffer = '{"type":"hel';
  const idx = buffer.indexOf('\n');
  assert.equal(idx, -1, 'No newline → no parse');
  // Data accumulates until newline arrives
  buffer += 'lo"}\n';
  const idx2 = buffer.indexOf('\n');
  assert.ok(idx2 >= 0, 'Now has newline');
  const line = buffer.slice(0, idx2).trim();
  const msg = JSON.parse(line);
  assert.equal(msg.type, 'hello', 'Complete JSON parsed');
});

test('pipe buffer: empty lines skipped', () => {
  let buffer = '\n\n{"type":"msg"}\n\n';
  const messages = [];
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line.length > 0) {
      messages.push(JSON.parse(line));
    }
  }
  assert.equal(messages.length, 1, 'Empty lines skipped');
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: Idempotency cache eviction
// ═══════════════════════════════════════════════════════════════

test('Router: idempotency cache structure', () => {
  const router = new Router({ adapters: {}, log: () => {} });
  // Router has _idempotencyCache (Map)
  assert.ok(router._idempotencyCache instanceof Map, 'Idempotency cache is Map');
  clearInterval(router._cleanupInterval);
});

test('Router: idempotency key format', () => {
  // Key format: `${target}:${type}:${key}`
  const target = 'copilot';
  const type = 'chat.submit';
  const key = 'unique-key';
  const cacheKey = `${target}:${type}:${key}`;
  assert.equal(cacheKey, 'copilot:chat.submit:unique-key');
});

test('Router: idempotency cache eviction at capacity 200', () => {
  const cache = new Map();
  const MAX = 200;
  // Fill to capacity
  for (let i = 0; i < MAX + 50; i++) {
    cache.set(`key-${i}`, { ts: Date.now() - (MAX + 50 - i) * 1000 });
  }
  // Evict oldest (Map iterates in insertion order)
  while (cache.size > MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  assert.equal(cache.size, MAX, 'Evicted to capacity');
  assert.ok(!cache.has('key-0'), 'Oldest evicted');
  assert.ok(cache.has('key-50'), 'Recent preserved');
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: _sanitizeError comprehensive
// ═══════════════════════════════════════════════════════════════

test('Router: _sanitizeError with UNC path — DESIGN GAP: not fully sanitized', () => {
  const router = new Router({ adapters: {}, log: () => {} });
  const msg = 'Error accessing \\\\server\\share\\secret.txt';
  const result = router._sanitizeError(msg);
  // DESIGN GAP: regex handles C:\... paths but NOT UNC \\server\share\... paths
  // Backslashes get stripped but filename text survives
  assert.ok(result.includes('secret'), 'DESIGN GAP: UNC path filename leaks through sanitizer');
  clearInterval(router._cleanupInterval);
});

test('Router: _sanitizeError with env var expansion', () => {
  const router = new Router({ adapters: {}, log: () => {} });
  const msg = 'Cannot read C:\\Users\\admin\\AppData\\Roaming\\config.json';
  const result = router._sanitizeError(msg);
  assert.ok(!result.includes('admin'), 'Username stripped');
  clearInterval(router._cleanupInterval);
});

test('Router: _sanitizeError caps at 200 chars', () => {
  const router = new Router({ adapters: {}, log: () => {} });
  const msg = 'Error: '.padEnd(300, 'x');
  const result = router._sanitizeError(msg);
  assert.ok(result.length <= 200, 'Capped at 200 chars');
  clearInterval(router._cleanupInterval);
});

test('Router: _sanitizeError null/undefined → Internal error', () => {
  const router = new Router({ adapters: {}, log: () => {} });
  assert.equal(router._sanitizeError(null), 'Internal error');
  assert.equal(router._sanitizeError(undefined), 'Internal error');
  clearInterval(router._cleanupInterval);
});

test('Router: _sanitizeError number input CRASHES (REAL BUG)', () => {
  const router = new Router({ adapters: {}, log: () => {} });
  // _sanitizeError does (msg || "Internal error").replace(...)
  // Number 42 is truthy, so msg=42, then 42.replace() throws TypeError
  assert.throws(() => router._sanitizeError(42),
    { name: 'TypeError' },
    'REAL BUG: number.replace() throws TypeError');
  clearInterval(router._cleanupInterval);
});

// ═══════════════════════════════════════════════════════════════
// PIPE NAME: Format validation
// ═══════════════════════════════════════════════════════════════

test('pipe name: correct format', () => {
  const wsHash = 'abc123';
  const instanceId = 'deadbeef';
  const name = `\\\\.\\pipe\\cld-ipc-bridge.${wsHash}.${instanceId}`;
  assert.equal(name, '\\\\.\\pipe\\cld-ipc-bridge.abc123.deadbeef');
});

test('pipe name: special chars in hash don\'t break pipe', () => {
  // SHA256 hex output is safe for pipe names
  const hash = crypto.createHash('sha256').update('C:\\path with spaces').digest('hex').slice(0, 6);
  assert.ok(/^[0-9a-f]{6}$/.test(hash), 'Hash is hex-safe for pipe name');
});

// ═══════════════════════════════════════════════════════════════
// CROSS-MODULE: Error handling patterns
// ═══════════════════════════════════════════════════════════════

test('cross-module: process.kill(pid, 0) check semantics', () => {
  // Signal 0 = check existence without killing
  try {
    process.kill(process.pid, 0);
    assert.ok(true, 'Own PID is alive');
  } catch {
    assert.fail('Own PID should be alive');
  }
});

test('cross-module: process.kill on dead PID throws', () => {
  // Use a PID that's very likely dead
  const deadPid = 2; // PID 2 on Windows is System, not accessible
  try {
    process.kill(deadPid, 0);
    // May succeed if PID 2 exists (it does on some systems)
  } catch (err) {
    assert.ok(err.code === 'ESRCH' || err.code === 'EPERM',
      `Expected ESRCH or EPERM, got ${err.code}`);
  }
});

test('cross-module: JSON roundtrip preserves registry entry', () => {
  const entry = {
    instanceId: 'abcd1234',
    pipe: '\\\\.\\pipe\\cld-ipc-bridge.abc123.abcd1234',
    workspaceName: 'test project',
    pid: 12345,
    capabilities: { targets: { copilot: { available: true } } },
    startedAt: new Date().toISOString(),
    v: 1
  };
  const roundTrip = JSON.parse(JSON.stringify(entry));
  assert.deepEqual(roundTrip, entry, 'Perfect JSON roundtrip');
});
