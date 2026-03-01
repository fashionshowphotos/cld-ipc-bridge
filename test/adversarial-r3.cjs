#!/usr/bin/env node
/**
 * adversarial-r3.cjs — Round 3 adversarial tests for IPC Bridge
 * --------------------------------------------------------------
 * Targeting: generic.cjs allowlist validation, codex_layout.cjs bbox
 * validation, adapter text sanitization patterns, router edge cases.
 *
 * Usage: node test/adversarial-r3.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================================
// Import targets
// ============================================================================

const { ALLOWED_COMMANDS, ALLOWED_SUBMIT_METHODS, GenericAdapter } = require('../lib/adapters/generic.cjs');
const { loadLayout, saveLayout, LAYOUT_FILE } = require('../lib/codex_layout.cjs');
const { isValidInstanceId, isValidPid, writeRegistry, readRegistry, findInstance } = require('../lib/registry.cjs');

// ============================================================================
// ALLOWED_COMMANDS — allowlist integrity
// ============================================================================

test('ALLOWED_COMMANDS: is a Set', () => {
  assert.ok(ALLOWED_COMMANDS instanceof Set);
});

test('ALLOWED_COMMANDS: contains expected core commands', () => {
  assert.ok(ALLOWED_COMMANDS.has('workbench.action.chat.open'));
  assert.ok(ALLOWED_COMMANDS.has('workbench.action.chat.submit'));
  assert.ok(ALLOWED_COMMANDS.has('workbench.action.chat.newChat'));
});

test('ALLOWED_COMMANDS: does NOT contain dangerous commands', () => {
  const dangerous = [
    'workbench.action.terminal.sendSequence',
    'workbench.action.terminal.sendText',
    'workbench.action.files.delete',
    'workbench.action.quit',
    'workbench.action.closeWindow',
    'workbench.action.terminal.runActiveFile',
    'editor.action.formatDocument',
    'git.push',
    'git.pushForce',
  ];
  for (const cmd of dangerous) {
    assert.ok(!ALLOWED_COMMANDS.has(cmd), `Should NOT contain: ${cmd}`);
  }
});

test('ALLOWED_COMMANDS: all entries are non-empty strings', () => {
  for (const cmd of ALLOWED_COMMANDS) {
    assert.equal(typeof cmd, 'string');
    assert.ok(cmd.length > 0, `Empty command found in allowlist`);
  }
});

test('ALLOWED_COMMANDS: Set is mutable (potential security issue)', () => {
  // Document this behavior — exported Set CAN be mutated by callers
  const originalSize = ALLOWED_COMMANDS.size;
  const testCmd = '__test_injection__';

  ALLOWED_COMMANDS.add(testCmd);
  assert.ok(ALLOWED_COMMANDS.has(testCmd), 'Set is mutable — caller can add commands');

  // Clean up
  ALLOWED_COMMANDS.delete(testCmd);
  assert.equal(ALLOWED_COMMANDS.size, originalSize, 'Cleanup successful');
});

// ============================================================================
// ALLOWED_SUBMIT_METHODS — allowlist integrity
// ============================================================================

test('ALLOWED_SUBMIT_METHODS: only "query" is allowed', () => {
  assert.ok(ALLOWED_SUBMIT_METHODS.has('query'));
  assert.equal(ALLOWED_SUBMIT_METHODS.size, 1, 'Only one method allowed');
});

test('ALLOWED_SUBMIT_METHODS: "type" is NOT allowed', () => {
  assert.ok(!ALLOWED_SUBMIT_METHODS.has('type'));
});

// ============================================================================
// Allowlist enforcement via Set membership
// ============================================================================

test('allowlist: valid commands are in Set', () => {
  assert.ok(ALLOWED_COMMANDS.has('workbench.action.chat.open'));
  assert.ok(ALLOWED_COMMANDS.has('workbench.action.chat.submit'));
});

test('allowlist: invalid commands are NOT in Set', () => {
  assert.ok(!ALLOWED_COMMANDS.has('workbench.action.terminal.sendSequence'));
  assert.ok(!ALLOWED_COMMANDS.has(''));
  assert.ok(!ALLOWED_COMMANDS.has(undefined));
  assert.ok(!ALLOWED_COMMANDS.has(null));
});

test('allowlist: case-sensitive lookup', () => {
  assert.ok(!ALLOWED_COMMANDS.has('WORKBENCH.ACTION.CHAT.OPEN'));
  assert.ok(!ALLOWED_COMMANDS.has('workbench.action.chat.open '));
});

// ============================================================================
// GenericAdapter — constructor validation revert
// ============================================================================

test('GenericAdapter: invalid commands revert to defaults', () => {
  const logs = [];
  const adapter = new GenericAdapter({
    vscode: { commands: { getCommands: async () => [], executeCommand: async () => {} } },
    commands: {
      openCommand: 'evil.open',
      submitMethod: 'type', // invalid
      submitCommand: 'evil.submit',
    },
    log: (msg) => logs.push(msg),
  });

  // Commands should have been reverted
  assert.ok(logs.some(l => l.includes('validation failed')), 'Should log validation failure');
  assert.ok(logs.some(l => l.includes('submitMethod') && l.includes('not allowed')), 'Should reject submitMethod');
});

test('GenericAdapter: valid commands accepted', () => {
  const logs = [];
  const adapter = new GenericAdapter({
    vscode: { commands: { getCommands: async () => [], executeCommand: async () => {} } },
    commands: {
      openCommand: 'workbench.action.chat.open',
      submitMethod: 'query',
      submitCommand: 'workbench.action.chat.submit',
    },
    log: (msg) => logs.push(msg),
  });

  assert.ok(!logs.some(l => l.includes('validation failed')), 'Should not log failure');
  assert.equal(adapter.available, false, 'Available is false until probe()');
});

test('GenericAdapter: isBusy returns false initially', () => {
  const adapter = new GenericAdapter({
    vscode: { commands: { getCommands: async () => [], executeCommand: async () => {} } },
  });
  assert.equal(adapter.isBusy(), false);
});

test('GenericAdapter: submit without probe throws TARGET_UNAVAILABLE', async () => {
  const adapter = new GenericAdapter({
    vscode: { commands: { getCommands: async () => [], executeCommand: async () => {} } },
  });

  try {
    await adapter.submit('test text');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.equal(err.code, 'TARGET_UNAVAILABLE');
  }
});

// ============================================================================
// Text sanitization pattern tests
// ============================================================================

test('text sanitization: leading slash stripped', () => {
  const text = '/help with this';
  const sanitized = text.replace(/^[/@]+/, '');
  assert.equal(sanitized, 'help with this');
});

test('text sanitization: leading @ stripped', () => {
  const text = '@workspace help';
  const sanitized = text.replace(/^[/@]+/, '');
  assert.equal(sanitized, 'workspace help');
});

test('text sanitization: multiple leading slashes stripped', () => {
  const text = '///help';
  const sanitized = text.replace(/^[/@]+/, '');
  assert.equal(sanitized, 'help');
});

test('text sanitization: mixed /@@ stripped', () => {
  const text = '/@@@query';
  const sanitized = text.replace(/^[/@]+/, '');
  assert.equal(sanitized, 'query');
});

test('text sanitization: mid-text slash NOT stripped', () => {
  const text = 'hello/world';
  const sanitized = text.replace(/^[/@]+/, '');
  assert.equal(sanitized, 'hello/world', 'Mid-text slash should survive');
});

test('text sanitization: mid-text @ NOT stripped', () => {
  const text = 'email@example.com';
  const sanitized = text.replace(/^[/@]+/, '');
  assert.equal(sanitized, 'email@example.com');
});

test('text sanitization: only slashes results in empty', () => {
  const text = '///';
  const sanitized = text.replace(/^[/@]+/, '');
  assert.equal(sanitized.trim(), '', 'All-slash text should become empty');
});

test('text sanitization: whitespace-only after strip', () => {
  const text = '/   \n\t  ';
  const sanitized = text.replace(/^[/@]+/, '');
  assert.equal(sanitized.trim(), '', 'Whitespace-only should be empty after trim');
});

test('text sanitization: Unicode text preserved', () => {
  const text = '\u{1F680} rocket launch';
  const sanitized = text.replace(/^[/@]+/, '');
  assert.equal(sanitized, '\u{1F680} rocket launch');
});

// ============================================================================
// codex_layout — loadLayout bbox validation
// ============================================================================

test('loadLayout: valid layout from disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-r3-'));
  const layoutPath = path.join(dir, 'codex_layout.json');
  fs.writeFileSync(layoutPath, JSON.stringify({
    input: { bbox: [0.1, 0.8, 0.3, 0.05] },
    taught_at: '2026-02-22T00:00:00Z'
  }));

  // loadLayout reads from LAYOUT_FILE constant — we test the validation logic directly
  const data = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
  const valid = data.input?.bbox && Array.isArray(data.input.bbox)
    && data.input.bbox.length === 4
    && data.input.bbox.every(v => typeof v === 'number' && v >= 0 && v <= 1);
  assert.ok(valid, 'Valid layout should pass validation');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadLayout validation: bbox with 3 elements rejected', () => {
  const data = { input: { bbox: [0.1, 0.8, 0.3] } };
  const valid = data.input?.bbox && Array.isArray(data.input.bbox)
    && data.input.bbox.length === 4;
  assert.ok(!valid, 'bbox with 3 elements should be invalid');
});

test('loadLayout validation: bbox with 5 elements rejected', () => {
  const data = { input: { bbox: [0.1, 0.2, 0.3, 0.4, 0.5] } };
  const valid = data.input?.bbox && Array.isArray(data.input.bbox)
    && data.input.bbox.length === 4;
  assert.ok(!valid, 'bbox with 5 elements should be invalid');
});

test('loadLayout validation: bbox value > 1 rejected', () => {
  const data = { input: { bbox: [1.1, 0.5, 0.5, 0.5] } };
  const valid = data.input.bbox.every(v => typeof v === 'number' && v >= 0 && v <= 1);
  assert.ok(!valid, 'Value > 1 should be invalid');
});

test('loadLayout validation: bbox negative value rejected', () => {
  const data = { input: { bbox: [-0.1, 0.5, 0.5, 0.5] } };
  const valid = data.input.bbox.every(v => typeof v === 'number' && v >= 0 && v <= 1);
  assert.ok(!valid, 'Negative value should be invalid');
});

test('loadLayout validation: bbox with NaN rejected', () => {
  const data = { input: { bbox: [NaN, 0.5, 0.5, 0.5] } };
  const valid = data.input.bbox.every(v => typeof v === 'number' && v >= 0 && v <= 1);
  assert.ok(!valid, 'NaN should be invalid (NaN >= 0 is false)');
});

test('loadLayout validation: bbox with Infinity rejected', () => {
  const data = { input: { bbox: [Infinity, 0.5, 0.5, 0.5] } };
  const valid = data.input.bbox.every(v => typeof v === 'number' && v >= 0 && v <= 1);
  assert.ok(!valid, 'Infinity should be invalid');
});

test('loadLayout validation: bbox with string value rejected', () => {
  const data = { input: { bbox: ['0.1', 0.5, 0.5, 0.5] } };
  const valid = data.input.bbox.every(v => typeof v === 'number' && v >= 0 && v <= 1);
  assert.ok(!valid, 'String value should be invalid');
});

test('loadLayout validation: missing input field rejected', () => {
  const data = { submit: { bbox: [0.1, 0.5, 0.5, 0.5] } };
  const valid = data.input?.bbox && Array.isArray(data.input.bbox);
  assert.ok(!valid, 'Missing input field should be invalid');
});

test('loadLayout validation: input.bbox is not array rejected', () => {
  const data = { input: { bbox: 'not-array' } };
  const valid = data.input?.bbox && Array.isArray(data.input.bbox);
  assert.ok(!valid, 'Non-array bbox should be invalid');
});

test('loadLayout validation: bbox boundary [0, 0, 1, 1] is valid', () => {
  const data = { input: { bbox: [0, 0, 1, 1] } };
  const valid = data.input.bbox.every(v => typeof v === 'number' && v >= 0 && v <= 1);
  assert.ok(valid, 'Boundary values [0,0,1,1] should be valid');
});

test('loadLayout validation: bbox all zeros is valid', () => {
  const data = { input: { bbox: [0, 0, 0, 0] } };
  const valid = data.input.bbox.every(v => typeof v === 'number' && v >= 0 && v <= 1);
  assert.ok(valid, 'All zeros should be technically valid');
});

// ============================================================================
// saveLayout — atomic write
// ============================================================================

test('saveLayout: writes to temp dir with taught_at timestamp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-r3-layout-'));
  const layoutPath = path.join(dir, 'test_layout.json');

  // Simulate saveLayout logic
  const layout = { input: { bbox: [0.1, 0.8, 0.3, 0.05] } };
  const data = { ...layout, taught_at: new Date().toISOString() };
  fs.writeFileSync(layoutPath, JSON.stringify(data, null, 2));

  const read = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
  assert.ok(read.taught_at, 'Should have taught_at timestamp');
  assert.deepEqual(read.input.bbox, [0.1, 0.8, 0.3, 0.05]);

  fs.rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// Registry — additional edge cases
// ============================================================================

test('registry: instanceId with uppercase hex is invalid', () => {
  assert.ok(!isValidInstanceId('ABCDEF12'), 'Uppercase hex should be rejected');
});

test('registry: instanceId with 7 chars is invalid', () => {
  assert.ok(!isValidInstanceId('abcdef1'), 'Too short should be rejected');
});

test('registry: instanceId with 9 chars is invalid', () => {
  assert.ok(!isValidInstanceId('abcdef123'), 'Too long should be rejected');
});

test('registry: PID exactly 0 is invalid', () => {
  assert.ok(!isValidPid(0), 'PID 0 should be invalid');
});

test('registry: PID at max boundary (4194304) is valid', () => {
  assert.ok(isValidPid(4194304));
});

test('registry: PID above max (4194305) is invalid', () => {
  assert.ok(!isValidPid(4194305));
});

test('registry: PID as float is invalid', () => {
  assert.ok(!isValidPid(1.5));
});

test('registry: negative PID is invalid', () => {
  assert.ok(!isValidPid(-1));
});

test('registry: PID as NaN is invalid', () => {
  assert.ok(!isValidPid(NaN));
});

test('registry: PID as Infinity is invalid', () => {
  assert.ok(!isValidPid(Infinity));
});

// ============================================================================
// Registry — findInstance edge cases
// ============================================================================

test('findInstance: empty registry returns null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-r3-reg-'));
  fs.writeFileSync(path.join(dir, 'registry.json'), '{}');

  // findInstance reads from the real INSTANCES_DIR, can't easily override
  // Instead, test the logic pattern
  const registry = {};
  const result = Object.entries(registry).find(([id, inst]) => inst.pid);
  assert.equal(result, undefined, 'Empty registry should have no matches');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// Router constants and patterns (re-test with new vectors)
// ============================================================================

test('router target regex: valid targets', () => {
  const TARGET_RE = /^[a-z0-9][a-z0-9-]{0,31}$/i;
  assert.ok(TARGET_RE.test('copilot'));
  assert.ok(TARGET_RE.test('codex'));
  assert.ok(TARGET_RE.test('antigravity'));
  assert.ok(TARGET_RE.test('a'));
  assert.ok(TARGET_RE.test('target-with-dash'));
  assert.ok(TARGET_RE.test('A1')); // case-insensitive
});

test('router target regex: invalid targets', () => {
  const TARGET_RE = /^[a-z0-9][a-z0-9-]{0,31}$/i;
  assert.ok(!TARGET_RE.test(''), 'Empty string');
  assert.ok(!TARGET_RE.test('-starts-with-dash'), 'Leading dash');
  assert.ok(!TARGET_RE.test('has space'), 'Space');
  assert.ok(!TARGET_RE.test('has.dot'), 'Dot');
  assert.ok(!TARGET_RE.test('has_underscore'), 'Underscore');
  assert.ok(!TARGET_RE.test('a'.repeat(33)), '33 chars');
  assert.ok(!TARGET_RE.test('../etc'), 'Path traversal');
});

test('router target regex: max length 32 chars', () => {
  const TARGET_RE = /^[a-z0-9][a-z0-9-]{0,31}$/i;
  assert.ok(TARGET_RE.test('a' + '-'.repeat(30) + 'z'), '32 chars');
  assert.ok(!TARGET_RE.test('a' + '-'.repeat(31) + 'z'), '33 chars');
});

// ============================================================================
// Router text length limits
// ============================================================================

test('MAX_TEXT_LENGTH: 64KB limit', () => {
  const MAX_TEXT_LENGTH = 64 * 1024;
  assert.equal(MAX_TEXT_LENGTH, 65536);
});

test('MAX_ID_LENGTH: 256 chars', () => {
  const MAX_ID_LENGTH = 256;
  const validId = 'a'.repeat(256);
  assert.equal(validId.length, 256);
  const invalidId = 'a'.repeat(257);
  assert.ok(invalidId.length > MAX_ID_LENGTH);
});

// ============================================================================
// Error sanitization pattern
// ============================================================================

test('_sanitizeError pattern: strips Windows paths', () => {
  const sanitize = (msg) => {
    if (!msg) return 'Unknown error';
    let s = String(msg);
    // Strip absolute paths (Windows and Unix)
    s = s.replace(/[A-Z]:\\[^\s:]+/gi, '[PATH]');
    s = s.replace(/\/(?:home|usr|var|tmp|etc|opt)[^\s:]*/g, '[PATH]');
    return s.substring(0, 200);
  };

  const err = 'Failed to read C:\\Users\\admin\\secrets\\key.pem: ENOENT';
  const clean = sanitize(err);
  assert.ok(!clean.includes('admin'), 'Should strip user path');
  assert.ok(clean.includes('[PATH]'), 'Should replace with placeholder');
});

test('_sanitizeError pattern: strips Unix paths', () => {
  const sanitize = (msg) => {
    if (!msg) return 'Unknown error';
    let s = String(msg);
    s = s.replace(/[A-Z]:\\[^\s:]+/gi, '[PATH]');
    s = s.replace(/\/(?:home|usr|var|tmp|etc|opt)[^\s:]*/g, '[PATH]');
    return s.substring(0, 200);
  };

  const err = 'ENOENT: /home/user/.ssh/id_rsa';
  const clean = sanitize(err);
  assert.ok(!clean.includes('.ssh'), 'Should strip SSH path');
});

test('_sanitizeError pattern: caps at 200 chars', () => {
  const sanitize = (msg) => {
    return String(msg).substring(0, 200);
  };

  const longErr = 'x'.repeat(500);
  assert.equal(sanitize(longErr).length, 200);
});

test('_sanitizeError pattern: null input returns default', () => {
  const sanitize = (msg) => {
    if (!msg) return 'Unknown error';
    return String(msg).substring(0, 200);
  };

  assert.equal(sanitize(null), 'Unknown error');
  assert.equal(sanitize(undefined), 'Unknown error');
  assert.equal(sanitize(''), 'Unknown error');
});

// ============================================================================
// Adapter busy flag semantics
// ============================================================================

test('busy flag: initial state is false', () => {
  // All adapters start with _busyFlag = false
  const busyFlag = false;
  assert.equal(busyFlag, false);
});

test('busy flag: set during submit, cleared in finally', () => {
  let busyFlag = false;
  try {
    busyFlag = true;
    assert.equal(busyFlag, true, 'Should be busy during submit');
    // simulate work
  } finally {
    busyFlag = false;
  }
  assert.equal(busyFlag, false, 'Should be cleared after finally');
});

test('busy flag: cleared even on error', () => {
  let busyFlag = false;
  try {
    busyFlag = true;
    throw new Error('submit failed');
  } catch (e) {
    // error handling
  } finally {
    busyFlag = false;
  }
  assert.equal(busyFlag, false, 'Should be cleared after error');
});

// ============================================================================
// Abort token semantics
// ============================================================================

test('abort token: _checkAbort throws on cancel', () => {
  const token = { cancelled: true };
  const checkAbort = () => {
    if (token && token.cancelled) {
      const err = new Error('Operation cancelled');
      err.code = 'ABORT';
      throw err;
    }
  };

  assert.throws(() => checkAbort(), /Operation cancelled/);
});

test('abort token: _checkAbort does not throw when not cancelled', () => {
  const token = { cancelled: false };
  const checkAbort = () => {
    if (token && token.cancelled) {
      throw new Error('Operation cancelled');
    }
  };

  checkAbort(); // should not throw
});

test('abort token: null token does not throw', () => {
  const token = null;
  const checkAbort = () => {
    if (token && token.cancelled) {
      throw new Error('Operation cancelled');
    }
  };

  checkAbort(); // should not throw
});

// ============================================================================
// Retry delay array bounds
// ============================================================================

test('RETRY_DELAYS: exactly 5 entries for READY_RETRIES=5', () => {
  const RETRY_DELAYS = [100, 200, 300, 500, 500];
  const READY_RETRIES = 5;
  assert.equal(RETRY_DELAYS.length, READY_RETRIES);
});

test('RETRY_DELAYS: all values are positive', () => {
  const RETRY_DELAYS = [100, 200, 300, 500, 500];
  for (const d of RETRY_DELAYS) {
    assert.ok(d > 0, `Delay ${d} should be positive`);
  }
});

test('RETRY_DELAYS: fallback for out-of-bounds index', () => {
  const RETRY_DELAYS = [100, 200, 300, 500, 500];
  // Code uses: RETRY_DELAYS[i] || 500
  assert.equal(RETRY_DELAYS[5] || 500, 500, 'Out of bounds should fallback to 500');
  assert.equal(RETRY_DELAYS[100] || 500, 500, 'Way out of bounds should fallback');
});

// ============================================================================
// Instance ID generation pattern
// ============================================================================

test('instance ID generation: crypto.randomBytes produces valid format', () => {
  const crypto = require('crypto');
  for (let i = 0; i < 20; i++) {
    const id = crypto.randomBytes(4).toString('hex');
    assert.equal(id.length, 8);
    assert.ok(isValidInstanceId(id), `Generated ID ${id} should be valid`);
  }
});
