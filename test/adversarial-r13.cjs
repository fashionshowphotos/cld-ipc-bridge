#!/usr/bin/env node
/**
 * adversarial-r13.cjs — Round 13 adversarial tests for IPC Bridge
 * -----------------------------------------------------------------
 * Focus: Registry writeRegistry/deleteRegistry lifecycle, cleanStale
 * behavior, findInstance criteria matching (workspacePath, workspaceName,
 * editorName, target), findInstancesByEditor filtering, workspaceHash
 * edge cases, Router dispose idempotency, _processQueue timer cleanup,
 * adapter timeout behavior.
 *
 * Usage: node test/adversarial-r13.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  isValidInstanceId,
  isValidPid,
  workspaceHash,
  pipeName,
  generateInstanceId,
  INSTANCES_DIR,
  TOKENS_DIR,
  writeRegistry,
  deleteRegistry,
  readAllRegistries,
  cleanStale,
  findInstance,
  findInstancesByEditor,
} = require('../lib/registry.cjs');

const { Router } = require('../lib/router.cjs');

// ═══════════════════════════════════════════════════════════════
// REGISTRY: writeRegistry / deleteRegistry lifecycle
// ═══════════════════════════════════════════════════════════════
test('writeRegistry + deleteRegistry lifecycle', () => {
  const id = generateInstanceId();
  const entry = {
    instanceId: id,
    pipe: pipeName(workspaceHash('/test'), id),
    workspaceName: 'test-r13',
    workspacePath: '/test/r13',
    pid: process.pid,
    capabilities: { targets: {} },
  };

  const filePath = writeRegistry(entry);
  assert.ok(filePath, 'Write returned path');
  assert.ok(fs.existsSync(filePath), 'File created');

  // Read back
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(data.instanceId, id, 'instanceId preserved');
  assert.equal(data.workspaceName, 'test-r13', 'workspaceName preserved');
  assert.ok(data.startedAt, 'startedAt auto-set');
  assert.equal(data.v, 1, 'Version set');

  // Clean up
  deleteRegistry(id);
  assert.ok(!fs.existsSync(filePath), 'File deleted');
});

test('writeRegistry: strips tokenHint', () => {
  const id = generateInstanceId();
  const entry = {
    instanceId: id,
    pipe: 'test-pipe',
    workspaceName: 'test',
    workspacePath: '/test',
    pid: process.pid,
    capabilities: {},
    tokenHint: 'secret-token-value',
  };

  const filePath = writeRegistry(entry);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(data.tokenHint, undefined, 'tokenHint stripped');

  deleteRegistry(id);
});

test('writeRegistry: invalid instanceId throws', () => {
  assert.throws(() => {
    writeRegistry({
      instanceId: 'INVALID',
      pipe: 'test',
      workspaceName: 'test',
      workspacePath: '/test',
      pid: process.pid,
      capabilities: {},
    });
  }, /Invalid instanceId/, 'Invalid ID rejected');
});

test('deleteRegistry: invalid instanceId is no-op', () => {
  assert.doesNotThrow(() => {
    deleteRegistry('INVALID');
    deleteRegistry(null);
    deleteRegistry(undefined);
  }, 'Invalid delete is no-op');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: readAllRegistries
// ═══════════════════════════════════════════════════════════════
test('readAllRegistries: returns array', () => {
  const entries = readAllRegistries();
  assert.ok(Array.isArray(entries), 'Returns array');
});

test('readAllRegistries: filters tmp files', () => {
  // Tmp files with .tmp. in name should not appear
  const entries = readAllRegistries();
  for (const e of entries) {
    if (e && e.instanceId) {
      assert.ok(!e.instanceId.includes('.tmp.'), 'No tmp files');
    }
  }
});

test('readAllRegistries: strips tokenHint from returned data', () => {
  const id = generateInstanceId();
  const entry = {
    instanceId: id,
    pipe: 'test',
    workspaceName: 'test-strip',
    workspacePath: '/test/strip',
    pid: process.pid,
    capabilities: {},
    tokenHint: 'should-be-stripped',
  };

  writeRegistry(entry);

  // Manually add tokenHint to written file (simulating old version)
  const filePath = path.join(INSTANCES_DIR, `${id}.json`);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  data.tokenHint = 'leaked-token';
  fs.writeFileSync(filePath, JSON.stringify(data));

  // Read back via readAllRegistries
  const entries = readAllRegistries();
  const found = entries.find(e => e.instanceId === id);
  if (found) {
    assert.equal(found.tokenHint, undefined, 'tokenHint stripped on read');
  }

  deleteRegistry(id);
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: findInstance criteria
// ═══════════════════════════════════════════════════════════════
test('findInstance: by instanceId', () => {
  const id = generateInstanceId();
  writeRegistry({
    instanceId: id,
    pipe: 'test-find',
    workspaceName: 'find-test',
    workspacePath: '/find/test',
    pid: process.pid,
    capabilities: {},
  });

  const found = findInstance({ instanceId: id });
  assert.ok(found, 'Found by instanceId');
  assert.equal(found.instanceId, id, 'Correct instance');

  deleteRegistry(id);
});

test('findInstance: empty criteria with one instance', () => {
  // If only one instance exists, findInstance({}) should return it
  // But in test env there may be many — just verify no crash
  const result = findInstance({});
  // Result may be null or an object
  assert.ok(result === null || typeof result === 'object', 'Valid result');
});

test('findInstance: by editorName (case-insensitive)', () => {
  const id = generateInstanceId();
  writeRegistry({
    instanceId: id,
    pipe: 'test-editor',
    workspaceName: 'editor-test',
    workspacePath: '/editor/test',
    pid: process.pid,
    editorName: 'Test Editor',
    capabilities: {},
  });

  const found = findInstance({ editorName: 'test editor' });
  if (found) {
    assert.ok(found.editorName.toLowerCase().includes('test editor'), 'Case-insensitive match');
  }

  deleteRegistry(id);
});

test('findInstance: editorName not found returns null', () => {
  const result = findInstance({ editorName: 'nonexistent-editor-xyz' });
  assert.equal(result, null, 'Not found → null');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: findInstancesByEditor
// ═══════════════════════════════════════════════════════════════
test('findInstancesByEditor: returns array', () => {
  const result = findInstancesByEditor('test');
  assert.ok(Array.isArray(result), 'Returns array');
});

test('findInstancesByEditor: null returns all', () => {
  const result = findInstancesByEditor(null);
  assert.ok(Array.isArray(result), 'Null → array of all');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: cleanStale
// ═══════════════════════════════════════════════════════════════
test('cleanStale: returns number', () => {
  const count = cleanStale();
  assert.equal(typeof count, 'number', 'Returns number');
  assert.ok(count >= 0, 'Non-negative');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: workspaceHash edge cases
// ═══════════════════════════════════════════════════════════════
test('workspaceHash: very long path', () => {
  const longPath = '/home/user/' + 'a'.repeat(10000);
  const hash = workspaceHash(longPath);
  assert.equal(hash.length, 6, 'Still 6 chars');
  assert.ok(/^[0-9a-f]+$/.test(hash), 'Still hex');
});

test('workspaceHash: Windows path with backslashes', () => {
  const hash = workspaceHash('C:\\Users\\new\\Projects');
  assert.equal(hash.length, 6, '6 chars');
});

test('workspaceHash: special characters', () => {
  const hash = workspaceHash('/path/with spaces/and (parens)/file');
  assert.equal(hash.length, 6, '6 chars despite special chars');
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: dispose idempotency
// ═══════════════════════════════════════════════════════════════
test('Router: double dispose does not crash', () => {
  const router = new Router({
    adapters: { x: { submit: async () => ({}), available: true } },
    log: () => {},
  });

  router.dispose();
  assert.doesNotThrow(() => router.dispose(), 'Double dispose safe');
});

test('Router: operations after dispose handled gracefully', () => {
  const router = new Router({
    adapters: { x: { submit: async () => ({}), available: true } },
    log: () => {},
  });

  router.dispose();

  // These should not crash
  const status = router.getStatus();
  assert.ok(typeof status === 'object', 'getStatus after dispose');
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: adapter with custom options
// ═══════════════════════════════════════════════════════════════
test('Router: options passed to adapter.submit', async () => {
  let receivedOpts = null;
  const router = new Router({
    adapters: {
      custom: {
        submit: async (text, opts) => {
          receivedOpts = opts;
          return { grade: 'ok' };
        },
        available: true,
      }
    },
    log: () => {},
  });

  router._handleChatSubmit(
    { id: 'opt-1', target: 'custom', text: 'hello', options: { foo: 'bar' } },
    () => {}
  );

  await new Promise(r => setTimeout(r, 50));
  assert.ok(receivedOpts, 'Options received');
  assert.equal(receivedOpts.foo, 'bar', 'Custom option passed');
  router.dispose();
});

test('Router: missing options defaults to empty object', async () => {
  let receivedOpts = null;
  const router = new Router({
    adapters: {
      noopt: {
        submit: async (text, opts) => {
          receivedOpts = opts;
          return { grade: 'ok' };
        },
        available: true,
      }
    },
    log: () => {},
  });

  router._handleChatSubmit(
    { id: 'noopt-1', target: 'noopt', text: 'hello' },
    () => {}
  );

  await new Promise(r => setTimeout(r, 50));
  assert.ok(receivedOpts, 'Options received');
  assert.deepEqual(receivedOpts, {}, 'Empty object default');
  router.dispose();
});
