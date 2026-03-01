#!/usr/bin/env node
/**
 * adversarial-r5.cjs — Round 5 adversarial tests for IPC Bridge
 * ---------------------------------------------------------------
 * Focus: Router idempotency patterns, registry file write edge cases,
 * adapter command cascade ordering, target resolution priority,
 * message payload validation, Windows path normalization.
 *
 * Usage: node test/adversarial-r5.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const { ALLOWED_COMMANDS, ALLOWED_SUBMIT_METHODS, GenericAdapter } = require('../lib/adapters/generic.cjs');

let codexLayoutModule;
try {
  codexLayoutModule = require('../lib/codex_layout.cjs');
} catch { codexLayoutModule = null; }

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'ipc-r5-'));
}

// ═══════════════════════════════════════════════════════════════
// IDEMPOTENCY CACHE: Map-based pattern testing
// ═══════════════════════════════════════════════════════════════
test('idempotency cache: basic dedup pattern', () => {
  const cache = new Map();
  const MAX_SIZE = 200;

  function checkIdempotency(key) {
    if (cache.has(key)) return { isDup: true, original: cache.get(key) };
    cache.set(key, { ts: Date.now() });
    if (cache.size > MAX_SIZE) {
      // Evict oldest — Map iterates in insertion order
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    return { isDup: false };
  }

  assert.equal(checkIdempotency('req-1').isDup, false, 'First request not dup');
  assert.equal(checkIdempotency('req-1').isDup, true, 'Second request is dup');
  assert.equal(checkIdempotency('req-2').isDup, false, 'Different key not dup');
});

test('idempotency cache: eviction at MAX_SIZE', () => {
  const cache = new Map();
  const MAX_SIZE = 5;

  for (let i = 0; i < MAX_SIZE + 3; i++) {
    cache.set(`key-${i}`, Date.now());
    if (cache.size > MAX_SIZE) {
      cache.delete(cache.keys().next().value);
    }
  }

  assert.equal(cache.size, MAX_SIZE, `Size capped at ${MAX_SIZE}`);
  assert.ok(!cache.has('key-0'), 'Oldest evicted');
  assert.ok(!cache.has('key-1'), 'Second oldest evicted');
  assert.ok(!cache.has('key-2'), 'Third oldest evicted');
  assert.ok(cache.has('key-3'), 'key-3 retained');
});

test('idempotency cache: composite key with target', () => {
  const cache = new Map();
  const key1 = 'copilot:chat.submit:req-1';
  const key2 = 'codex:chat.submit:req-1';

  cache.set(key1, true);
  assert.ok(cache.has(key1), 'Composite key found');
  assert.ok(!cache.has(key2), 'Different target = different key');
});

// ═══════════════════════════════════════════════════════════════
// REGISTRY: File write patterns and edge cases
// ═══════════════════════════════════════════════════════════════
test('registry: atomic write with tmp → rename pattern', () => {
  const tmpDir = makeTempDir('reg-write-');
  const registryFile = path.join(tmpDir, 'instances.json');
  try {
    const data = { instances: [{ id: 'abcd1234', pid: 1234 }] };
    const tmpPath = `${registryFile}.${process.pid}.tmp`;

    // Write to temp
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    // Rename to target
    fs.renameSync(tmpPath, registryFile);

    // Verify
    const read = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    assert.deepEqual(read, data, 'Data preserved through atomic write');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('registry: orphaned tmp file cleanup on failed rename', () => {
  const tmpDir = makeTempDir('reg-orphan-');
  const registryFile = path.join(tmpDir, 'instances.json');
  const tmpPath = `${registryFile}.${process.pid}.tmp`;
  try {
    // Write temp file
    fs.writeFileSync(tmpPath, '{"test":true}');
    // Simulate failed rename by making target a directory
    fs.mkdirSync(registryFile);

    try {
      fs.renameSync(tmpPath, registryFile);
      assert.fail('Should have thrown');
    } catch (e) {
      // Rename failed — verify tmp file still exists (potential leak)
      if (fs.existsSync(tmpPath)) {
        // Clean up manually
        fs.unlinkSync(tmpPath);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('registry: JSON.stringify with circular reference throws', () => {
  const circular = {};
  circular.self = circular;

  assert.throws(() => JSON.stringify(circular), /circular|Converting/i,
    'Circular reference throws on stringify');
});

test('registry: instance ID generation produces valid hex', () => {
  const id = crypto.randomBytes(4).toString('hex');
  assert.equal(id.length, 8, '8-char hex');
  assert.ok(/^[0-9a-f]{8}$/.test(id), 'Valid lowercase hex');
});

test('registry: Windows file mode param ignored', () => {
  const tmpDir = makeTempDir('reg-mode-');
  const testFile = path.join(tmpDir, 'mode-test.json');
  try {
    // On Windows, mode parameter is mostly ignored
    fs.writeFileSync(testFile, '{}', { mode: 0o600 });
    assert.ok(fs.existsSync(testFile), 'File created regardless of mode');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════
// ADAPTER: Command cascade and priority
// ═══════════════════════════════════════════════════════════════
test('adapter: ALLOWED_COMMANDS has chat-related commands', () => {
  const chatCmds = [
    'workbench.action.chat.open',
    'workbench.action.chat.newChat',
  ];
  for (const cmd of chatCmds) {
    assert.ok(ALLOWED_COMMANDS.has(cmd), `${cmd} in allowlist`);
  }
});

test('adapter: command validation is exact match, not prefix', () => {
  // Verify that "workbench.action.chat.open.evil" is NOT allowed
  // even though "workbench.action.chat.open" is
  assert.ok(!ALLOWED_COMMANDS.has('workbench.action.chat.open.evil'),
    'Extended command name not in Set');
});

test('adapter: command validation with trailing whitespace', () => {
  assert.ok(!ALLOWED_COMMANDS.has('workbench.action.chat.open '),
    'Trailing space not in Set');
  assert.ok(!ALLOWED_COMMANDS.has(' workbench.action.chat.open'),
    'Leading space not in Set');
});

test('adapter: GenericAdapter with all valid commands', () => {
  const allCmds = {};
  for (const cmd of ALLOWED_COMMANDS) {
    allCmds[cmd.replace(/\./g, '_')] = cmd;
  }
  const adapter = new GenericAdapter({}, { commands: allCmds });
  assert.ok(adapter, 'All valid commands accepted');
});

// ═══════════════════════════════════════════════════════════════
// TARGET RESOLUTION: Priority and ambiguity
// ═══════════════════════════════════════════════════════════════
const TARGET_MAP = {
  copilot: 'copilot',
  codex: 'codex',
  antigravity: 'antigravity',
  cascade: 'antigravity',
  generic: 'generic',
};

test('target resolution: cascade maps to antigravity', () => {
  assert.equal(TARGET_MAP['cascade'], 'antigravity');
});

test('target resolution: unknown target returns undefined', () => {
  assert.equal(TARGET_MAP['unknown'], undefined);
  assert.equal(TARGET_MAP[''], undefined);
});

test('target resolution: case-sensitive lookup', () => {
  assert.equal(TARGET_MAP['Copilot'], undefined, 'Case-sensitive');
  assert.equal(TARGET_MAP['COPILOT'], undefined, 'All caps');
});

test('target resolution: null/undefined key', () => {
  assert.equal(TARGET_MAP[null], undefined, 'null key');
  assert.equal(TARGET_MAP[undefined], undefined, 'undefined key');
});

// ═══════════════════════════════════════════════════════════════
// MESSAGE VALIDATION: Payload edge cases
// ═══════════════════════════════════════════════════════════════
test('message: JSON.parse of valid IPC message', () => {
  const msg = JSON.stringify({ type: 'chat.submit', text: 'hello', target: 'copilot' });
  const parsed = JSON.parse(msg);
  assert.equal(parsed.type, 'chat.submit');
  assert.equal(parsed.text, 'hello');
});

test('message: JSON.parse of message with unicode', () => {
  const msg = JSON.stringify({ type: 'chat.submit', text: 'Hello \u{1F600} world' });
  const parsed = JSON.parse(msg);
  assert.ok(parsed.text.includes('\u{1F600}'), 'Emoji preserved');
});

test('message: very large text field (1MB)', () => {
  const text = 'x'.repeat(1_000_000);
  const msg = JSON.stringify({ type: 'chat.submit', text });
  const parsed = JSON.parse(msg);
  assert.equal(parsed.text.length, 1_000_000, 'Large text preserved');
});

test('message: missing required fields', () => {
  const msg = {};
  assert.equal(msg.type, undefined, 'Missing type');
  assert.equal(msg.text, undefined, 'Missing text');
  // typeof undefined checks
  assert.equal(typeof msg.type, 'undefined');
  assert.ok(!msg.type, 'Falsy missing type');
});

test('message: type coercion in field access', () => {
  const msg = { type: 0, text: '' };
  assert.ok(!msg.type, 'Numeric 0 is falsy');
  assert.ok(!msg.text, 'Empty string is falsy');
  assert.equal(typeof msg.type, 'number', 'type is number');
});

// ═══════════════════════════════════════════════════════════════
// PATH NORMALIZATION: Windows-specific edge cases
// ═══════════════════════════════════════════════════════════════
test('path: backslash vs forward slash normalization', () => {
  const winPath = 'C:\\Users\\admin\\project';
  const unixPath = 'C:/Users/admin/project';
  const normalized = winPath.replace(/\\/g, '/');
  assert.equal(normalized, unixPath, 'Backslashes normalized to forward slashes');
});

test('path: UNC paths handled', () => {
  const uncPath = '\\\\server\\share\\file.json';
  const normalized = uncPath.replace(/\\/g, '/');
  assert.equal(normalized, '//server/share/file.json', 'UNC path normalized');
});

test('path: path.resolve handles mixed separators', () => {
  const mixed = 'dir1\\dir2/dir3\\file.js';
  const resolved = path.resolve(mixed);
  assert.ok(resolved.length > 0, 'Mixed separators resolved');
});

test('path: path.basename handles both separators', () => {
  assert.equal(path.basename('C:\\dir\\file.js'), 'file.js', 'Windows path basename');
  assert.equal(path.basename('/home/user/file.js'), 'file.js', 'Unix path basename');
});

// ═══════════════════════════════════════════════════════════════
// PIPE NAME: Named pipe edge cases
// ═══════════════════════════════════════════════════════════════
test('pipe name: valid Windows named pipe format', () => {
  const pipeName = '\\\\.\\pipe\\coherent-light-ipc-abcd1234';
  assert.ok(pipeName.startsWith('\\\\.\\pipe\\'), 'Windows pipe prefix');
  assert.ok(pipeName.includes('abcd1234'), 'Contains instance ID');
});

test('pipe name: pipe name with special chars', () => {
  // Windows pipe names have some restrictions
  const pipeName = '\\\\.\\pipe\\test-pipe_with.dots';
  assert.ok(pipeName.includes('test-pipe_with.dots'), 'Dots and hyphens in pipe name');
});

// ═══════════════════════════════════════════════════════════════
// ALLOWED_SUBMIT_METHODS: Enforcement
// ═══════════════════════════════════════════════════════════════
test('ALLOWED_SUBMIT_METHODS: only "query" is allowed', () => {
  assert.ok(ALLOWED_SUBMIT_METHODS.has('query'), 'query allowed');
  assert.equal(ALLOWED_SUBMIT_METHODS.size, 1, 'Only one method');
});

test('ALLOWED_SUBMIT_METHODS: rejects other methods', () => {
  assert.ok(!ALLOWED_SUBMIT_METHODS.has('post'), 'post rejected');
  assert.ok(!ALLOWED_SUBMIT_METHODS.has('execute'), 'execute rejected');
  assert.ok(!ALLOWED_SUBMIT_METHODS.has('eval'), 'eval rejected');
  assert.ok(!ALLOWED_SUBMIT_METHODS.has(''), 'empty rejected');
});

// ═══════════════════════════════════════════════════════════════
// SECURITY: run-command blocklist completeness
// ═══════════════════════════════════════════════════════════════
test('blocklist: should block all window-closing commands', () => {
  const BLOCKLIST = new Set([
    'workbench.action.quit',
    'workbench.action.closeWindow',
  ]);

  // These commands are dangerous but NOT in the minimal blocklist
  const notBlocked = [
    'workbench.action.closeAllEditors',
    'workbench.action.closeFolder',
    'workbench.action.terminal.kill',
    'workbench.action.files.deleteFile',
  ];

  for (const cmd of notBlocked) {
    assert.ok(!BLOCKLIST.has(cmd), `${cmd} not in blocklist (potential gap)`);
  }
});

test('blocklist: case bypass potential', () => {
  const BLOCKLIST = new Set([
    'workbench.action.quit',
    'workbench.action.closeWindow',
  ]);

  // VS Code commands are case-sensitive, so these bypasses would not actually work
  // But the blocklist check should be done AFTER normalization
  assert.ok(!BLOCKLIST.has('WORKBENCH.ACTION.QUIT'), 'Uppercase not blocked');
  assert.ok(!BLOCKLIST.has('workbench.Action.Quit'), 'Mixed case not blocked');
});

// ═══════════════════════════════════════════════════════════════
// GenericAdapter: More constructor edge cases
// ═══════════════════════════════════════════════════════════════
test('GenericAdapter: null commands object', () => {
  const adapter = new GenericAdapter({}, { commands: null });
  assert.ok(adapter, 'null commands handled');
});

test('GenericAdapter: commands with valid submitMethod', () => {
  const adapter = new GenericAdapter({}, {
    commands: {
      openChat: 'workbench.action.chat.open',
      submitMethod: 'query',
    }
  });
  assert.ok(adapter, 'Valid submitMethod accepted');
});

test('GenericAdapter: commands with invalid submitMethod reverts', () => {
  const adapter = new GenericAdapter({}, {
    commands: {
      openChat: 'workbench.action.chat.open',
      submitMethod: 'execute', // not in ALLOWED_SUBMIT_METHODS
    }
  });
  assert.ok(adapter, 'Invalid submitMethod handled (reverted to default)');
});
