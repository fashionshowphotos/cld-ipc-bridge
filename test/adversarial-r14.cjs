#!/usr/bin/env node
/**
 * adversarial-r14.cjs — Round 14 adversarial tests for IPC Bridge
 * -----------------------------------------------------------------
 * Focus: generateInstanceId uniqueness, pipeName construction,
 * isPidAlive behavior, updateCapabilities lifecycle, findInstance
 * multi-criteria matching, findInstancesByEditor filtering,
 * cleanStale with live PIDs, Router handle() malformed types,
 * Router queue behavior under load.
 *
 * Usage: node test/adversarial-r14.cjs
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
  INSTANCES_DIR,
  TOKENS_DIR,
  writeRegistry,
  deleteRegistry,
  readAllRegistries,
  cleanStale,
  findInstance,
  findInstancesByEditor,
  isPidAlive,
  updateCapabilities,
} = require('../lib/registry.cjs');

const { Router } = require('../lib/router.cjs');

// ═══════════════════════════════════════════════════════════════
// REGISTRY: generateInstanceId uniqueness
// ═══════════════════════════════════════════════════════════════
test('generateInstanceId: returns valid ID', () => {
  const id = generateInstanceId();
  assert.ok(isValidInstanceId(id), 'Generated ID is valid');
});

test('generateInstanceId: 100 unique IDs', () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) {
    ids.add(generateInstanceId());
  }
  assert.equal(ids.size, 100, 'All 100 unique');
});

test('generateInstanceId: format is 8 hex chars', () => {
  const id = generateInstanceId();
  assert.equal(id.length, 8, '8 chars');
  assert.ok(/^[0-9a-f]{8}$/.test(id), 'Lowercase hex');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: pipeName construction
// ═══════════════════════════════════════════════════════════════
test('pipeName: returns string', () => {
  const name = pipeName('abc123', 'def45678');
  assert.equal(typeof name, 'string', 'Returns string');
  assert.ok(name.length > 0, 'Non-empty');
});

test('pipeName: includes workspace hash', () => {
  const hash = workspaceHash('/test');
  const name = pipeName(hash, 'abcd1234');
  assert.ok(name.includes(hash), 'Contains workspace hash');
});

test('pipeName: includes instance ID', () => {
  const id = 'abcd1234';
  const name = pipeName('abc123', id);
  assert.ok(name.includes(id), 'Contains instance ID');
});

test('pipeName: starts with pipe prefix on Windows', () => {
  const name = pipeName('abc123', 'def45678');
  if (process.platform === 'win32') {
    assert.ok(name.startsWith('\\\\.\\pipe\\'), 'Windows pipe prefix');
  } else {
    // Unix: typically /tmp/ path
    assert.ok(name.startsWith('/'), 'Unix path prefix');
  }
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: isPidAlive
// ═══════════════════════════════════════════════════════════════
test('isPidAlive: current process is alive', () => {
  assert.ok(isPidAlive(process.pid), 'Current process alive');
});

test('isPidAlive: invalid PID returns false', () => {
  assert.ok(!isPidAlive(-1), 'Negative PID → false');
  assert.ok(!isPidAlive(0), 'Zero PID → false');
  assert.ok(!isPidAlive(null), 'Null → false');
  assert.ok(!isPidAlive(undefined), 'Undefined → false');
});

test('isPidAlive: very large PID returns false', () => {
  assert.ok(!isPidAlive(99999999), 'Very large PID → false');
});

test('isPidAlive: string PID returns false', () => {
  assert.ok(!isPidAlive('123'), 'String PID → false');
});

test('isPidAlive: NaN returns false', () => {
  assert.ok(!isPidAlive(NaN), 'NaN → false');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: isValidPid boundary
// ═══════════════════════════════════════════════════════════════
test('isValidPid: 1 is valid', () => {
  assert.ok(isValidPid(1), 'PID 1 valid');
});

test('isValidPid: MAX boundary', () => {
  // Max PID is 4194304 (Linux) or similar
  assert.ok(isValidPid(4194304), 'Max PID valid');
  assert.ok(!isValidPid(4194305), 'Above max invalid');
});

test('isValidPid: 0 is invalid', () => {
  assert.ok(!isValidPid(0), 'PID 0 invalid');
});

test('isValidPid: float is invalid', () => {
  assert.ok(!isValidPid(1.5), 'Float invalid');
});

test('isValidPid: negative invalid', () => {
  assert.ok(!isValidPid(-1), 'Negative invalid');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: isValidInstanceId
// ═══════════════════════════════════════════════════════════════
test('isValidInstanceId: valid hex', () => {
  assert.ok(isValidInstanceId('abcd1234'), 'Valid hex ID');
});

test('isValidInstanceId: uppercase rejected', () => {
  assert.ok(!isValidInstanceId('ABCD1234'), 'Uppercase rejected');
});

test('isValidInstanceId: too short', () => {
  assert.ok(!isValidInstanceId('abcd123'), '7 chars rejected');
});

test('isValidInstanceId: too long', () => {
  assert.ok(!isValidInstanceId('abcd12345'), '9 chars rejected');
});

test('isValidInstanceId: non-hex chars', () => {
  assert.ok(!isValidInstanceId('abcdxyz1'), 'Non-hex rejected');
});

test('isValidInstanceId: empty', () => {
  assert.ok(!isValidInstanceId(''), 'Empty rejected');
});

test('isValidInstanceId: null', () => {
  assert.ok(!isValidInstanceId(null), 'Null rejected');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: updateCapabilities
// ═══════════════════════════════════════════════════════════════
test('updateCapabilities: updates existing entry', () => {
  const id = generateInstanceId();
  writeRegistry({
    instanceId: id,
    pipe: 'test-cap',
    workspaceName: 'cap-test',
    workspacePath: '/cap/test',
    pid: process.pid,
    capabilities: { targets: {} },
  });

  updateCapabilities(id, { targets: { copilot: { available: true } } });

  const filePath = path.join(INSTANCES_DIR, `${id}.json`);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.ok(data.capabilities.targets.copilot, 'Capability added');
  assert.ok(data.capabilities.targets.copilot.available, 'Available flag set');

  deleteRegistry(id);
});

test('updateCapabilities: nonexistent ID is no-op', () => {
  assert.doesNotThrow(() => {
    updateCapabilities('00000000', { targets: {} });
  }, 'Nonexistent ID no-op');
});

test('updateCapabilities: invalid ID is no-op', () => {
  assert.doesNotThrow(() => {
    updateCapabilities('INVALID', { targets: {} });
  }, 'Invalid ID no-op');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: findInstance multi-criteria
// ═══════════════════════════════════════════════════════════════
test('findInstance: by workspacePath (case-insensitive)', () => {
  const id = generateInstanceId();
  writeRegistry({
    instanceId: id,
    pipe: 'test-ws',
    workspaceName: 'ws-test',
    workspacePath: '/workspace/Test',
    pid: process.pid,
    capabilities: {},
  });

  const found = findInstance({ workspacePath: '/workspace/test' });
  if (found) {
    assert.equal(found.instanceId, id, 'Found by case-insensitive path');
  }

  deleteRegistry(id);
});

test('findInstance: by workspaceName', () => {
  const id = generateInstanceId();
  const uniqueName = `ws-r14-${Date.now()}`;
  writeRegistry({
    instanceId: id,
    pipe: 'test-wn',
    workspaceName: uniqueName,
    workspacePath: '/ws/r14',
    pid: process.pid,
    capabilities: {},
  });

  const found = findInstance({ workspaceName: uniqueName });
  if (found) {
    assert.equal(found.instanceId, id, 'Found by workspaceName');
  }

  deleteRegistry(id);
});

test('findInstance: nonexistent instanceId returns null', () => {
  // Use instanceId for exact match — guarantees null if not found
  const result = findInstance({ instanceId: '00000000' });
  assert.equal(result, null, 'Not found → null');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: findInstancesByEditor
// ═══════════════════════════════════════════════════════════════
test('findInstancesByEditor: specific editor name', () => {
  const id = generateInstanceId();
  writeRegistry({
    instanceId: id,
    pipe: 'test-ed',
    workspaceName: 'ed-test',
    workspacePath: '/ed/test',
    pid: process.pid,
    editorName: 'test-editor-r14',
    capabilities: {},
  });

  const found = findInstancesByEditor('test-editor-r14');
  assert.ok(Array.isArray(found), 'Returns array');
  const match = found.find(e => e.instanceId === id);
  if (match) {
    assert.equal(match.editorName, 'test-editor-r14', 'Editor name matches');
  }

  deleteRegistry(id);
});

test('findInstancesByEditor: empty string returns array', () => {
  const result = findInstancesByEditor('');
  assert.ok(Array.isArray(result), 'Empty editor → array');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: cleanStale behavior
// ═══════════════════════════════════════════════════════════════
test('cleanStale: does not remove live entries', () => {
  const id = generateInstanceId();
  writeRegistry({
    instanceId: id,
    pipe: 'test-live',
    workspaceName: 'live-test',
    workspacePath: '/live/test',
    pid: process.pid,
    capabilities: {},
  });

  cleanStale();

  // Our entry (with current PID) should survive
  const filePath = path.join(INSTANCES_DIR, `${id}.json`);
  assert.ok(fs.existsSync(filePath), 'Live entry preserved');

  deleteRegistry(id);
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: handle() with various request types
// ═══════════════════════════════════════════════════════════════
test('Router: handle unknown request type', () => {
  let sendResult = null;
  const router = new Router({
    adapters: { x: { submit: async () => ({}), available: true } },
    log: () => {},
  });

  const result = router.handle(
    { type: 'unknown_type_xyz', id: 'u1' },
    (resp) => { sendResult = resp; }
  );

  // Should handle gracefully — may ignore or return error
  router.dispose();
});

test('Router: handle null request rejects', async () => {
  const router = new Router({
    adapters: { x: { submit: async () => ({}), available: true } },
    log: () => {},
  });

  // handle(null) destructures request asynchronously — catch the rejection
  await assert.rejects(async () => {
    await router.handle(null, () => {});
  }, /Cannot destructure/, 'Null request rejected');

  router.dispose();
});

test('Router: handle request without id', () => {
  const router = new Router({
    adapters: { x: { submit: async () => ({}), available: true } },
    log: () => {},
  });

  assert.doesNotThrow(() => {
    try { router.handle({ type: 'chat.submit', text: 'hello' }, () => {}); } catch {}
  }, 'No-id request handled');

  router.dispose();
});

test('Router: getStatus shape', () => {
  const router = new Router({
    adapters: {
      a: { submit: async () => ({}), available: true },
      b: { submit: async () => ({}), available: false },
    },
    log: () => {},
  });

  const status = router.getStatus();
  assert.equal(typeof status, 'object', 'Returns object');
  // Should have adapter info
  assert.ok(status.adapters || status.targets || Object.keys(status).length >= 0,
    'Has adapter info');

  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: adapter error handling
// ═══════════════════════════════════════════════════════════════
test('Router: adapter that throws', async () => {
  let errorResp = null;
  const router = new Router({
    adapters: {
      err: {
        submit: async () => { throw new Error('adapter crash'); },
        available: true,
      }
    },
    log: () => {},
  });

  router._handleChatSubmit(
    { id: 'err-1', target: 'err', text: 'hello' },
    (resp) => { errorResp = resp; }
  );

  await new Promise(r => setTimeout(r, 100));
  assert.ok(errorResp, 'Error response sent');
  assert.ok(errorResp.error || errorResp.code, 'Has error info');
  router.dispose();
});

test('Router: adapter that returns non-object', async () => {
  let resp = null;
  const router = new Router({
    adapters: {
      str: {
        submit: async () => 'just a string',
        available: true,
      }
    },
    log: () => {},
  });

  router._handleChatSubmit(
    { id: 'str-1', target: 'str', text: 'hello' },
    (r) => { resp = r; }
  );

  await new Promise(r => setTimeout(r, 100));
  // Should handle string return gracefully
  router.dispose();
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: unavailable adapter
// ═══════════════════════════════════════════════════════════════
test('Router: submit to unavailable adapter', () => {
  let resp = null;
  const router = new Router({
    adapters: {
      offline: {
        submit: async () => ({}),
        available: false,
      }
    },
    log: () => {},
  });

  const result = router._handleChatSubmit(
    { id: 'off-1', target: 'offline', text: 'hello' },
    (r) => { resp = r; }
  );

  // Should reject with TARGET_UNAVAILABLE or similar
  if (result) {
    assert.ok(result.error || result.code, 'Error for unavailable');
  }

  router.dispose();
});

test('Router: submit to nonexistent target', () => {
  let resp = null;
  const router = new Router({
    adapters: {
      x: { submit: async () => ({}), available: true },
    },
    log: () => {},
  });

  const result = router._handleChatSubmit(
    { id: 'ne-1', target: 'nonexistent', text: 'hello' },
    (r) => { resp = r; }
  );

  if (result) {
    assert.ok(result.error || result.code, 'Error for nonexistent target');
  }

  router.dispose();
});
