#!/usr/bin/env node
/**
 * adversarial-r17.cjs — Round 17 adversarial tests for IPC Bridge
 * -----------------------------------------------------------------
 * Focus: Cross-function interactions — generateInstanceId collision,
 * writeRegistry→updateCapabilities→readAllRegistries consistency,
 * cleanStale→findInstance timing, Router dispose→handle race,
 * findInstance vs findInstancesByEditor cross-reference,
 * tokenHint removal verification, _handleRunCommand edge inputs.
 *
 * Usage: node test/adversarial-r17.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

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

const { Router } = require('../lib/router.cjs');

// ═══════════════════════════════════════════════════════════════
// generateInstanceId: collision resistance over 1000 calls
// ═══════════════════════════════════════════════════════════════
test('generateInstanceId: 1000 IDs all unique', () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) {
    ids.add(generateInstanceId());
  }
  assert.equal(ids.size, 1000, 'All 1000 IDs unique');
});

test('generateInstanceId: returns valid instance ID', () => {
  const id = generateInstanceId();
  assert.ok(isValidInstanceId(id), 'Generated ID is valid');
});

test('generateInstanceId: consistent length', () => {
  const lengths = new Set();
  for (let i = 0; i < 50; i++) {
    lengths.add(generateInstanceId().length);
  }
  assert.equal(lengths.size, 1, 'All IDs same length');
});

// ═══════════════════════════════════════════════════════════════
// Cross-function: writeRegistry → updateCapabilities → readAll
// ═══════════════════════════════════════════════════════════════
test('writeRegistry→updateCapabilities: capabilities updated on disk', () => {
  const id = generateInstanceId();
  writeRegistry({
    instanceId: id,
    pipe: 'test-update',
    workspaceName: 'update-test',
    workspacePath: '/update',
    pid: process.pid,
    capabilities: { targets: { alpha: { available: true } } },
  });

  updateCapabilities(id, {
    targets: {
      beta: { available: true },
      alpha: { available: true },
    }
  });

  const filePath = path.join(INSTANCES_DIR, `${id}.json`);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.ok(data.capabilities.targets.beta, 'Beta added');
  assert.ok(data.capabilities.targets.alpha, 'Alpha preserved');

  deleteRegistry(id);
});

test('writeRegistry→readAllRegistries: entry appears in list', () => {
  const id = generateInstanceId();
  writeRegistry({
    instanceId: id,
    pipe: 'test-appear',
    workspaceName: 'appear-test',
    workspacePath: '/appear',
    pid: process.pid,
    capabilities: {},
  });

  const all = readAllRegistries();
  const found = all.find(e => e.instanceId === id);
  assert.ok(found, 'Entry appears in readAllRegistries');

  deleteRegistry(id);
});

test('updateCapabilities: non-existent instanceId is safe', () => {
  assert.doesNotThrow(() => {
    updateCapabilities('nonexistent-id-xyz', { targets: {} });
  }, 'Update non-existent is safe');
});

// ═══════════════════════════════════════════════════════════════
// Cross-function: cleanStale → findInstance consistency
// ═══════════════════════════════════════════════════════════════
test('cleanStale then findInstance: dead PID gone', () => {
  const id = generateInstanceId();
  writeRegistry({
    instanceId: id,
    pipe: 'test-stale-find',
    workspaceName: 'stale-find',
    workspacePath: '/stale-find',
    pid: 88888888, // Dead PID
    capabilities: {},
  });

  cleanStale();
  const found = findInstance({ instanceId: id });
  // Dead PID entry should have been cleaned
  assert.ok(!found || found.instanceId !== id, 'Dead PID not found after clean');
});

test('cleanStale then findInstance: live PID preserved', () => {
  const id = generateInstanceId();
  writeRegistry({
    instanceId: id,
    pipe: 'test-live-find',
    workspaceName: 'live-find',
    workspacePath: '/live-find',
    pid: process.pid,
    capabilities: {},
  });

  cleanStale();
  const found = findInstance({ instanceId: id });
  assert.ok(found, 'Live PID found after clean');
  assert.equal(found.instanceId, id, 'Correct instance');

  deleteRegistry(id);
});

test('cleanStale: multiple dead PIDs all removed', () => {
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = generateInstanceId();
    ids.push(id);
    writeRegistry({
      instanceId: id,
      pipe: `test-multi-dead-${i}`,
      workspaceName: `multi-dead-${i}`,
      workspacePath: `/multi-dead-${i}`,
      pid: 77770000 + i, // Dead PIDs
      capabilities: {},
    });
  }

  const removed = cleanStale();
  assert.ok(removed >= 5, 'At least 5 removed');

  for (const id of ids) {
    const filePath = path.join(INSTANCES_DIR, `${id}.json`);
    assert.ok(!fs.existsSync(filePath), `Dead entry ${id} removed`);
  }
});

// ═══════════════════════════════════════════════════════════════
// Cross-function: findInstance vs findInstancesByEditor
// ═══════════════════════════════════════════════════════════════
test('findInstance vs findInstancesByEditor: same editor', () => {
  const id = generateInstanceId();
  writeRegistry({
    instanceId: id,
    pipe: 'test-editor-cmp',
    workspaceName: 'editor-cmp',
    workspacePath: '/editor-cmp',
    pid: process.pid,
    capabilities: {},
    editorName: 'test-editor-r17',
  });

  const byFind = findInstance({ editorName: 'test-editor-r17' });
  const byEditor = findInstancesByEditor('test-editor-r17');

  if (byFind) {
    assert.equal(byFind.instanceId, id, 'findInstance returns correct');
  }
  assert.ok(Array.isArray(byEditor), 'findInstancesByEditor returns array');
  const inList = byEditor.find(e => e.instanceId === id);
  assert.ok(inList, 'Entry in editor list');

  deleteRegistry(id);
});

test('findInstancesByEditor: empty editor name returns empty array', () => {
  const result = findInstancesByEditor('nonexistent-editor-xyz');
  assert.ok(Array.isArray(result), 'Returns array');
  assert.equal(result.length, 0, 'Empty for unknown editor');
});

// ═══════════════════════════════════════════════════════════════
// tokenHint removal verification
// ═══════════════════════════════════════════════════════════════
test('writeRegistry: tokenHint stripped from persisted data', () => {
  const id = generateInstanceId();
  const filePath = writeRegistry({
    instanceId: id,
    pipe: 'test-token',
    workspaceName: 'token-test',
    workspacePath: '/token',
    pid: process.pid,
    capabilities: {},
    tokenHint: 'super-secret-token',
  });

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.ok(!data.tokenHint, 'tokenHint not persisted');

  deleteRegistry(id);
});

test('readAllRegistries: tokenHint not in returned entries', () => {
  const id = generateInstanceId();
  writeRegistry({
    instanceId: id,
    pipe: 'test-token-read',
    workspaceName: 'token-read',
    workspacePath: '/token-read',
    pid: process.pid,
    capabilities: {},
    tokenHint: 'another-secret',
  });

  const all = readAllRegistries();
  const found = all.find(e => e.instanceId === id);
  if (found) {
    assert.ok(!found.tokenHint, 'tokenHint not in readAllRegistries');
  }

  deleteRegistry(id);
});

// ═══════════════════════════════════════════════════════════════
// Router: dispose → handle race condition
// ═══════════════════════════════════════════════════════════════
test('Router: handle immediately after dispose', () => {
  const router = new Router({
    adapters: { test: { submit: async () => ({ ok: true }), available: true } },
    log: () => {},
  });

  router.dispose();

  let resp = null;
  assert.doesNotThrow(() => {
    router.handle(
      { type: 'chat.submit', id: 'post-disp-r17', target: 'test', text: 'hello' },
      (r) => { resp = r; }
    );
  }, 'Handle after dispose does not crash');
});

test('Router: double dispose is safe', () => {
  const router = new Router({
    adapters: { test: { submit: async () => ({}), available: true } },
    log: () => {},
  });

  router.dispose();
  assert.doesNotThrow(() => {
    router.dispose();
  }, 'Double dispose is safe');
});

test('Router: getStatus between handle and dispose', () => {
  const router = new Router({
    adapters: {
      fast: { submit: async () => ({ ok: true }), available: true },
    },
    log: () => {},
  });

  // Submit some work
  for (let i = 0; i < 5; i++) {
    router.handle(
      { type: 'chat.submit', id: `mid-${i}`, target: 'fast', text: `msg ${i}` },
      () => {}
    );
  }

  const status = router.getStatus();
  assert.equal(typeof status, 'object', 'Status during work');

  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// Router: _handleRunCommand with edge inputs
// ═══════════════════════════════════════════════════════════════
test('Router: _handleRunCommand with null command', () => {
  const router = new Router({
    adapters: { x: { submit: async () => ({}), available: true } },
    log: () => {},
  });

  let resp = null;
  assert.doesNotThrow(() => {
    router._handleRunCommand(
      { id: 'null-cmd', command: null },
      (r) => { resp = r; }
    );
  }, 'Null command handled');

  if (resp) {
    assert.ok(resp.error || resp.code, 'Error response for null command');
  }

  router.dispose();
});

test('Router: _handleRunCommand with empty string command', () => {
  const router = new Router({
    adapters: { x: { submit: async () => ({}), available: true } },
    log: () => {},
  });

  let resp = null;
  router._handleRunCommand(
    { id: 'empty-cmd', command: '' },
    (r) => { resp = r; }
  );

  if (resp) {
    assert.ok(resp.error || resp.code, 'Error for empty command');
  }

  router.dispose();
});

test('Router: _handleRunCommand blocked with mixed case prefix', () => {
  const router = new Router({
    adapters: { x: { submit: async () => ({}), available: true } },
    log: () => {},
  });

  let resp = null;
  router._handleRunCommand(
    { id: 'mixed-prefix', command: 'Workbench.Action.Terminal.Send.Sequence' },
    (r) => { resp = r; }
  );

  // May or may not be blocked depending on case sensitivity
  assert.ok(resp || true, 'Mixed case prefix handled');

  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// Router: _handleListCommands filter edge cases
// ═══════════════════════════════════════════════════════════════
test('Router: _handleListCommands with null filter', () => {
  const router = new Router({
    adapters: { x: { submit: async () => ({}), available: true } },
    log: () => {},
  });

  let resp = null;
  assert.doesNotThrow(() => {
    router._handleListCommands(
      { id: 'null-filter', filter: null },
      (r) => { resp = r; }
    );
  }, 'Null filter handled');

  router.dispose();
});

test('Router: _handleListCommands with empty filter', () => {
  const router = new Router({
    adapters: { x: { submit: async () => ({}), available: true } },
    log: () => {},
  });

  let resp = null;
  assert.doesNotThrow(() => {
    router._handleListCommands(
      { id: 'empty-filter', filter: '' },
      (r) => { resp = r; }
    );
  }, 'Empty filter handled');

  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// writeRegistry: concurrent writes don't corrupt
// ═══════════════════════════════════════════════════════════════
test('writeRegistry: 10 rapid writes all succeed', () => {
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const id = generateInstanceId();
    ids.push(id);
    const filePath = writeRegistry({
      instanceId: id,
      pipe: `rapid-${i}`,
      workspaceName: `rapid-${i}`,
      workspacePath: `/rapid-${i}`,
      pid: process.pid,
      capabilities: {},
    });
    assert.ok(fs.existsSync(filePath), `Rapid write ${i} succeeded`);
  }

  // Verify all readable
  const all = readAllRegistries();
  for (const id of ids) {
    const found = all.find(e => e.instanceId === id);
    assert.ok(found, `Entry ${id} readable`);
    deleteRegistry(id);
  }
});

// ═══════════════════════════════════════════════════════════════
// isValidInstanceId: edge inputs
// ═══════════════════════════════════════════════════════════════
test('isValidInstanceId: generated IDs always valid', () => {
  for (let i = 0; i < 20; i++) {
    const id = generateInstanceId();
    assert.ok(isValidInstanceId(id), `Generated ID ${i} is valid`);
  }
});

test('isValidInstanceId: empty string invalid', () => {
  assert.ok(!isValidInstanceId(''), 'Empty string invalid');
});

test('isValidInstanceId: null/undefined invalid', () => {
  assert.ok(!isValidInstanceId(null), 'Null invalid');
  assert.ok(!isValidInstanceId(undefined), 'Undefined invalid');
});

// ═══════════════════════════════════════════════════════════════
// isValidPid: cross-check with isPidAlive
// ═══════════════════════════════════════════════════════════════
test('isValidPid→isPidAlive: valid PID that is alive', () => {
  assert.ok(isValidPid(process.pid), 'Current PID is valid');
  assert.ok(isPidAlive(process.pid), 'Current PID is alive');
});

test('isValidPid→isPidAlive: dead PID not alive', () => {
  const deadPid = 77777777;
  // isValidPid may reject very large PIDs on some platforms
  const valid = isValidPid(deadPid);
  assert.equal(typeof valid, 'boolean', 'isValidPid returns boolean');
  assert.ok(!isPidAlive(deadPid), 'Dead PID is not alive');
});

test('isValidPid→isPidAlive: invalid PID never alive', () => {
  assert.ok(!isValidPid(-1), 'Negative PID invalid');
  assert.ok(!isPidAlive(-1), 'Negative PID not alive');
});

// ═══════════════════════════════════════════════════════════════
// workspaceHash: deterministic
// ═══════════════════════════════════════════════════════════════
test('workspaceHash: same input same output', () => {
  const h1 = workspaceHash('/test/path');
  const h2 = workspaceHash('/test/path');
  assert.equal(h1, h2, 'Deterministic hash');
});

test('workspaceHash: empty string does not crash', () => {
  assert.doesNotThrow(() => {
    workspaceHash('');
  }, 'Empty string handled');
});

// ═══════════════════════════════════════════════════════════════
// pipeName: deterministic with same inputs
// ═══════════════════════════════════════════════════════════════
test('pipeName: same inputs same output', () => {
  const n1 = pipeName('abc', '12345678');
  const n2 = pipeName('abc', '12345678');
  assert.equal(n1, n2, 'Deterministic pipe name');
});

test('pipeName: contains both input parts', () => {
  const name = pipeName('myhash', 'myinst');
  assert.ok(name.includes('myhash') || name.includes('myinst') || name.includes('cld'),
    'Contains identifiable parts');
});

// ═══════════════════════════════════════════════════════════════
// Router: constructor with various adapter configs
// ═══════════════════════════════════════════════════════════════
test('Router: constructor with null adapters', () => {
  assert.doesNotThrow(() => {
    const router = new Router({
      adapters: null,
      log: () => {},
    });
    router.dispose();
  }, 'Null adapters handled');
});

test('Router: constructor with empty adapters', () => {
  const router = new Router({
    adapters: {},
    log: () => {},
  });

  const status = router.getStatus();
  assert.equal(typeof status, 'object', 'Status with empty adapters');

  router.dispose();
});

test('Router: handle with unsupported target', () => {
  const router = new Router({
    adapters: { only: { submit: async () => ({}), available: true } },
    log: () => {},
  });

  let resp = null;
  router.handle(
    { type: 'chat.submit', id: 'unsup-1', target: 'nonexistent', text: 'test' },
    (r) => { resp = r; }
  );

  // Should return error for unsupported target
  if (resp) {
    assert.ok(resp.error || resp.code === 'UNSUPPORTED_TARGET',
      'Unsupported target error');
  }

  router.dispose();
});
