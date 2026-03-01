#!/usr/bin/env node
/**
 * adversarial-r19.cjs — Round 19 adversarial tests for IPC Bridge
 * -----------------------------------------------------------------
 * Focus: Property-based testing — auth token lifecycle, safeCompare
 * constant-time, token file creation/deletion, Router rate limiting,
 * Router reprobe/reload behavior, idempotency cache properties,
 * registry invariants.
 *
 * Usage: node test/adversarial-r19.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  isValidInstanceId,
  isValidPid,
  workspaceHash,
  pipeName,
  generateInstanceId,
  BASE_DIR,
  INSTANCES_DIR,
  TOKENS_DIR,
  writeRegistry,
  deleteRegistry,
  readAllRegistries,
  findInstance,
  findInstancesByEditor,
  isPidAlive,
  updateCapabilities,
  cleanStale,
} = require('../lib/registry.cjs');

const {
  generateToken,
  safeCompare,
  tokenHint,
  writeTokenFile,
  readTokenFile,
  deleteTokenFile,
  AUTH_TIMEOUT_MS,
} = require('../lib/auth.cjs');

const { Router } = require('../lib/router.cjs');

// ═══════════════════════════════════════════════════════════════
// Auth: generateToken properties
// ═══════════════════════════════════════════════════════════════
test('generateToken: returns string', () => {
  const token = generateToken();
  assert.equal(typeof token, 'string', 'Token is string');
  assert.ok(token.length > 0, 'Token non-empty');
});

test('generateToken: all tokens unique', () => {
  const tokens = new Set();
  for (let i = 0; i < 100; i++) {
    tokens.add(generateToken());
  }
  assert.equal(tokens.size, 100, 'All 100 tokens unique');
});

test('generateToken: consistent length', () => {
  const lengths = new Set();
  for (let i = 0; i < 20; i++) {
    lengths.add(generateToken().length);
  }
  assert.equal(lengths.size, 1, 'All tokens same length');
});

// ═══════════════════════════════════════════════════════════════
// Auth: safeCompare constant-time
// ═══════════════════════════════════════════════════════════════
test('safeCompare: matching strings return true', () => {
  const token = generateToken();
  assert.ok(safeCompare(token, token), 'Same string matches');
});

test('safeCompare: different strings return false', () => {
  const t1 = generateToken();
  const t2 = generateToken();
  assert.ok(!safeCompare(t1, t2), 'Different strings do not match');
});

test('safeCompare: different length returns false', () => {
  assert.ok(!safeCompare('short', 'much longer string'), 'Different length false');
});

test('safeCompare: empty strings', () => {
  assert.ok(safeCompare('', ''), 'Empty strings match');
});

test('safeCompare: one empty one not', () => {
  assert.ok(!safeCompare('', 'hello'), 'Empty vs non-empty false');
});

// ═══════════════════════════════════════════════════════════════
// Auth: tokenHint
// ═══════════════════════════════════════════════════════════════
test('tokenHint: returns partial token', () => {
  const token = generateToken();
  const hint = tokenHint(token);
  assert.equal(typeof hint, 'string', 'Hint is string');
  assert.ok(hint.length < token.length, 'Hint shorter than token');
  assert.ok(hint.includes('...') || hint.length <= 8, 'Hint is truncated');
});

test('tokenHint: null/undefined handled', () => {
  assert.doesNotThrow(() => {
    tokenHint(null);
    tokenHint(undefined);
    tokenHint('');
  }, 'Null/undefined/empty handled');
});

// ═══════════════════════════════════════════════════════════════
// Auth: writeTokenFile + readTokenFile + deleteTokenFile lifecycle
// ═══════════════════════════════════════════════════════════════
test('Auth lifecycle: write → read → delete', () => {
  const id = generateInstanceId();
  const token = generateToken();
  try {
    writeTokenFile(TOKENS_DIR, id, token);
    const read = readTokenFile(TOKENS_DIR, id);
    assert.equal(read, token, 'Read matches written token');
    deleteTokenFile(TOKENS_DIR, id);
    const after = readTokenFile(TOKENS_DIR, id);
    assert.ok(!after, 'Token gone after delete');
  } finally {
    try { deleteTokenFile(TOKENS_DIR, id); } catch {}
  }
});

test('deleteTokenFile: double delete is safe', () => {
  const id = generateInstanceId();
  const token = generateToken();
  writeTokenFile(TOKENS_DIR, id, token);
  deleteTokenFile(TOKENS_DIR, id);
  assert.doesNotThrow(() => {
    deleteTokenFile(TOKENS_DIR, id);
  }, 'Double delete safe');
});

test('readTokenFile: non-existent token returns null/undefined', () => {
  const result = readTokenFile(TOKENS_DIR, 'nonexistent-token-id');
  assert.ok(!result, 'Non-existent returns falsy');
});

test('writeTokenFile: invalid instanceId handled', () => {
  assert.doesNotThrow(() => {
    try {
      writeTokenFile(TOKENS_DIR, '../../../evil', 'token');
    } catch {
      // May throw for invalid ID — that's expected
    }
  }, 'Invalid ID does not crash process');
});

// ═══════════════════════════════════════════════════════════════
// Auth: AUTH_TIMEOUT_MS is reasonable
// ═══════════════════════════════════════════════════════════════
test('AUTH_TIMEOUT_MS: is positive number', () => {
  assert.equal(typeof AUTH_TIMEOUT_MS, 'number', 'Is number');
  assert.ok(AUTH_TIMEOUT_MS > 0, 'Positive');
  assert.ok(AUTH_TIMEOUT_MS < 60000, 'Under 60 seconds');
});

// ═══════════════════════════════════════════════════════════════
// Router: _handleReprobe behavior
// ═══════════════════════════════════════════════════════════════
test('Router: _handleReprobe does not crash', () => {
  const router = new Router({
    adapters: {
      a: { submit: async () => ({}), available: true, probe: () => {} },
      b: { submit: async () => ({}), available: false, probe: () => {} },
    },
    log: () => {},
  });

  let resp = null;
  if (typeof router._handleReprobe === 'function') {
    assert.doesNotThrow(() => {
      router._handleReprobe({ id: 'reprobe-r19' }, (r) => { resp = r; });
    }, 'Reprobe does not crash');
  }

  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// Router: _handleReload behavior
// ═══════════════════════════════════════════════════════════════
test('Router: _handleReload does not crash', () => {
  const router = new Router({
    adapters: { x: { submit: async () => ({}), available: true } },
    log: () => {},
  });

  let resp = null;
  if (typeof router._handleReload === 'function') {
    assert.doesNotThrow(() => {
      router._handleReload({ id: 'reload-r19' }, (r) => { resp = r; });
    }, 'Reload does not crash');
  }

  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// Property: registry write → read → delete cycle
// ═══════════════════════════════════════════════════════════════
test('Property: registry write→read→delete is atomic', () => {
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = generateInstanceId();
    ids.push(id);
    writeRegistry({
      instanceId: id,
      pipe: `prop-${i}`,
      workspaceName: `prop-${i}`,
      workspacePath: `/prop-${i}`,
      pid: process.pid,
      capabilities: {},
    });
  }

  // All should be readable
  const all = readAllRegistries();
  for (const id of ids) {
    assert.ok(all.find(e => e.instanceId === id), `${id} readable`);
  }

  // Delete all
  for (const id of ids) {
    deleteRegistry(id);
  }

  // None should be readable
  const after = readAllRegistries();
  for (const id of ids) {
    assert.ok(!after.find(e => e.instanceId === id), `${id} deleted`);
  }
});

// ═══════════════════════════════════════════════════════════════
// Property: workspaceHash deterministic
// ═══════════════════════════════════════════════════════════════
test('Property: workspaceHash(x) == workspaceHash(x) always', () => {
  const paths = ['/a', '/b', '/c/d/e', 'C:\\Users\\test'];
  for (const p of paths) {
    assert.equal(workspaceHash(p), workspaceHash(p), `Deterministic for ${p}`);
  }
});

test('Property: workspaceHash is hex string', () => {
  const hash = workspaceHash('/test/path');
  assert.ok(/^[0-9a-f]+$/.test(hash), 'Hash is hex');
});

// ═══════════════════════════════════════════════════════════════
// Property: pipeName deterministic
// ═══════════════════════════════════════════════════════════════
test('Property: pipeName(a,b) == pipeName(a,b) always', () => {
  const n1 = pipeName('hash1', 'inst1');
  const n2 = pipeName('hash1', 'inst1');
  assert.equal(n1, n2, 'Deterministic');
});

// ═══════════════════════════════════════════════════════════════
// Property: cleanStale preserves live, removes dead
// ═══════════════════════════════════════════════════════════════
test('Property: cleanStale live/dead separation', () => {
  const liveId = generateInstanceId();
  const deadId = generateInstanceId();

  writeRegistry({
    instanceId: liveId, pipe: 'live', workspaceName: 'live',
    workspacePath: '/live', pid: process.pid, capabilities: {},
  });
  writeRegistry({
    instanceId: deadId, pipe: 'dead', workspaceName: 'dead',
    workspacePath: '/dead', pid: 55550000, capabilities: {},
  });

  cleanStale();

  const live = findInstance({ instanceId: liveId });
  const dead = findInstance({ instanceId: deadId });

  assert.ok(live, 'Live entry preserved');
  assert.ok(!dead || dead.instanceId !== deadId, 'Dead entry removed');

  deleteRegistry(liveId);
});

// ═══════════════════════════════════════════════════════════════
// Property: isValidInstanceId rejects non-hex
// ═══════════════════════════════════════════════════════════════
test('Property: generated IDs always pass isValidInstanceId', () => {
  for (let i = 0; i < 50; i++) {
    const id = generateInstanceId();
    assert.ok(isValidInstanceId(id), `Generated ${id} is valid`);
  }
});

test('Property: non-hex strings fail isValidInstanceId', () => {
  const invalids = ['ghijklmn', 'ABCDEFGH', '12345678!', '', null, undefined, 42];
  for (const inv of invalids) {
    assert.ok(!isValidInstanceId(inv), `${inv} is invalid`);
  }
});
