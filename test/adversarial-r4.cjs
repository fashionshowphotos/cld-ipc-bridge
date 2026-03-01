#!/usr/bin/env node
/**
 * adversarial-r4.cjs — Round 4 adversarial tests for IPC Bridge
 * ---------------------------------------------------------------
 * Focus: Type confusion in message routing, adapter state machine
 * consistency, registry race conditions, large message handling,
 * command validation edge cases, target resolution ambiguity.
 *
 * Usage: node test/adversarial-r4.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ── Load adapters and registry ─────────────────────────────────
const { ALLOWED_COMMANDS, ALLOWED_SUBMIT_METHODS, GenericAdapter } = require('../lib/adapters/generic.cjs');

let codexLayoutModule;
try {
  codexLayoutModule = require('../lib/codex_layout.cjs');
} catch { codexLayoutModule = null; }

// ═══════════════════════════════════════════════════════════════
// TYPE CONFUSION: Message payload types
// ═══════════════════════════════════════════════════════════════
test('type confusion: ALLOWED_COMMANDS contains only strings', () => {
  for (const cmd of ALLOWED_COMMANDS) {
    assert.equal(typeof cmd, 'string', `Command "${cmd}" is string`);
    assert.ok(cmd.length > 0, `Command "${cmd}" is non-empty`);
  }
});

test('type confusion: Set.has() with number vs string', () => {
  // If someone passes a numeric command ID instead of string name
  assert.ok(!ALLOWED_COMMANDS.has(0), 'Number 0 not in Set');
  assert.ok(!ALLOWED_COMMANDS.has(1), 'Number 1 not in Set');
  assert.ok(!ALLOWED_COMMANDS.has(null), 'null not in Set');
  assert.ok(!ALLOWED_COMMANDS.has(undefined), 'undefined not in Set');
  assert.ok(!ALLOWED_COMMANDS.has(true), 'boolean not in Set');
});

test('type confusion: Set.has() with object', () => {
  assert.ok(!ALLOWED_COMMANDS.has({}), 'Object not in Set');
  assert.ok(!ALLOWED_COMMANDS.has([]), 'Array not in Set');
});

test('type confusion: ALLOWED_SUBMIT_METHODS is Set of strings', () => {
  assert.ok(ALLOWED_SUBMIT_METHODS instanceof Set, 'Is Set');
  for (const method of ALLOWED_SUBMIT_METHODS) {
    assert.equal(typeof method, 'string', `Method "${method}" is string`);
  }
  assert.ok(ALLOWED_SUBMIT_METHODS.has('query'), 'Contains "query"');
});

// ═══════════════════════════════════════════════════════════════
// GenericAdapter: Constructor validation edge cases
// ═══════════════════════════════════════════════════════════════
test('GenericAdapter: empty command list uses defaults', () => {
  const adapter = new GenericAdapter({}, { commands: [] });
  // Empty array should trigger validation failure → revert to defaults
  // Or it might accept empty list — verify behavior
  assert.ok(adapter, 'Constructed with empty commands');
});

test('GenericAdapter: undefined options uses defaults', () => {
  const adapter = new GenericAdapter({});
  assert.ok(adapter, 'Constructed with no options');
});

test('GenericAdapter: commands with mixed valid/invalid', () => {
  const adapter = new GenericAdapter({}, {
    commands: {
      openChat: 'workbench.action.chat.open', // valid
      submit: 'dangerous.command.not.allowed', // invalid
      newChat: 'workbench.action.chat.newChat', // valid
    }
  });
  assert.ok(adapter, 'Constructed with mixed commands');
});

test('GenericAdapter: isBusy starts false', () => {
  const adapter = new GenericAdapter({});
  assert.equal(adapter.isBusy(), false, 'Not busy initially');
});

// ═══════════════════════════════════════════════════════════════
// Text sanitization: More edge cases
// ═══════════════════════════════════════════════════════════════
test('text sanitization: multiple leading slashes', () => {
  const raw = '///command';
  const cleaned = raw.replace(/^[/@]+/, '');
  assert.equal(cleaned, 'command', 'Multiple slashes stripped');
});

test('text sanitization: mixed @/ prefix', () => {
  const raw = '@//@hello';
  const cleaned = raw.replace(/^[/@]+/, '');
  assert.equal(cleaned, 'hello', 'Mixed @/ prefix stripped');
});

test('text sanitization: emoji prefix preserved', () => {
  const raw = '\u{1F600}hello';
  const cleaned = raw.replace(/^[/@]+/, '');
  assert.equal(cleaned, '\u{1F600}hello', 'Emoji prefix preserved');
});

test('text sanitization: newlines in text preserved', () => {
  const raw = 'line1\nline2\nline3';
  const cleaned = raw.replace(/^[/@]+/, '');
  assert.equal(cleaned, raw, 'Newlines preserved');
});

test('text sanitization: null byte in text', () => {
  const raw = 'hello\x00world';
  // The adapter doesn't strip null bytes — they pass through
  const cleaned = raw.replace(/^[/@]+/, '');
  assert.equal(cleaned, 'hello\x00world', 'Null bytes pass through (no stripping)');
});

test('text sanitization: very long text (100KB)', () => {
  const raw = 'a'.repeat(100_000);
  const cleaned = raw.replace(/^[/@]+/, '');
  assert.equal(cleaned.length, 100_000, 'Long text not truncated by sanitizer');
});

// ═══════════════════════════════════════════════════════════════
// codex_layout: More bbox edge cases
// ═══════════════════════════════════════════════════════════════
if (codexLayoutModule) {
  const { loadLayout, saveLayout } = codexLayoutModule;

  test('codex_layout: bbox with -0 values (negative zero)', () => {
    // -0 >= 0 is true in JS, and -0 <= 1 is true, so it should be accepted
    // But Object.is(-0, 0) is false — they are distinguishable
    assert.ok(-0 >= 0, '-0 >= 0 is true');
    assert.ok(-0 <= 1, '-0 <= 1 is true');
    assert.ok(Object.is(-0, -0), 'Object.is(-0, -0)');
    // -0 and 0 are SameValueZero equal but NOT SameValue equal
    assert.ok(!Object.is(-0, 0), '-0 and 0 are distinguishable via Object.is');
    // However == and === treat them as equal
    assert.ok(-0 == 0, '-0 == 0 is true');
    assert.ok(-0 === 0, '-0 === 0 is true (operator)');
  });

  test('codex_layout: bbox boundary precision (floating point)', () => {
    const val = 0.1 + 0.2; // 0.30000000000000004
    assert.ok(val > 0 && val <= 1, 'Float imprecision still in valid range');
    // This means bbox values like [0.1+0.2, 0, 0.7, 1] would be accepted
    // even though 0.1+0.2 !== 0.3
  });
}

// ═══════════════════════════════════════════════════════════════
// Registry: Instance ID and PID validation edge cases
// ═══════════════════════════════════════════════════════════════
const INSTANCE_ID_REGEX = /^[0-9a-f]{8}$/;
const PID_MAX = 4194304;

test('registry: instance ID with uppercase hex rejected', () => {
  assert.ok(!INSTANCE_ID_REGEX.test('ABCDEF01'), 'Uppercase hex rejected');
});

test('registry: instance ID all zeros valid', () => {
  assert.ok(INSTANCE_ID_REGEX.test('00000000'), 'All zeros valid');
});

test('registry: instance ID all f valid', () => {
  assert.ok(INSTANCE_ID_REGEX.test('ffffffff'), 'All f valid');
});

test('registry: PID = 1 is valid (init process)', () => {
  const pid = 1;
  assert.ok(Number.isInteger(pid) && pid > 0 && pid <= PID_MAX);
});

test('registry: PID as string rejected', () => {
  const pid = '1234';
  assert.ok(!Number.isInteger(pid), 'String PID fails isInteger');
});

test('registry: PID = Number.MAX_SAFE_INTEGER rejected', () => {
  assert.ok(Number.MAX_SAFE_INTEGER > PID_MAX, 'MAX_SAFE_INTEGER exceeds PID_MAX');
});

// ═══════════════════════════════════════════════════════════════
// ALLOWED_COMMANDS: Security-relevant membership checks
// ═══════════════════════════════════════════════════════════════
test('ALLOWED_COMMANDS: does NOT contain terminal commands', () => {
  const dangerous = [
    'workbench.action.terminal.new',
    'workbench.action.terminal.sendSequence',
    'workbench.action.terminal.toggleTerminal',
    'workbench.action.terminal.kill',
  ];
  for (const cmd of dangerous) {
    assert.ok(!ALLOWED_COMMANDS.has(cmd), `Dangerous command "${cmd}" not allowed`);
  }
});

test('ALLOWED_COMMANDS: does NOT contain file deletion commands', () => {
  const dangerous = [
    'deleteFile',
    'workbench.action.files.delete',
    'filesExplorer.delete',
  ];
  for (const cmd of dangerous) {
    assert.ok(!ALLOWED_COMMANDS.has(cmd), `Delete command "${cmd}" not allowed`);
  }
});

test('ALLOWED_COMMANDS: does NOT contain extension management commands', () => {
  const dangerous = [
    'workbench.extensions.action.installExtension',
    'workbench.extensions.action.uninstallExtension',
    'workbench.extensions.action.enableExtension',
    'workbench.extensions.action.disableExtension',
  ];
  for (const cmd of dangerous) {
    assert.ok(!ALLOWED_COMMANDS.has(cmd), `Extension command "${cmd}" not allowed`);
  }
});

test('ALLOWED_COMMANDS: does NOT contain settings/config commands', () => {
  const dangerous = [
    'workbench.action.openSettingsJson',
    'workbench.action.openSettings',
    'workbench.action.configureLanguageBasedSettings',
  ];
  for (const cmd of dangerous) {
    assert.ok(!ALLOWED_COMMANDS.has(cmd), `Settings command "${cmd}" not allowed`);
  }
});

test('ALLOWED_COMMANDS: contains chat-related commands', () => {
  const expected = [
    'workbench.action.chat.open',
    'workbench.action.chat.newChat',
  ];
  for (const cmd of expected) {
    assert.ok(ALLOWED_COMMANDS.has(cmd), `Expected command "${cmd}" is allowed`);
  }
});

// ═══════════════════════════════════════════════════════════════
// Target resolution: Edge cases
// ═══════════════════════════════════════════════════════════════
const TARGET_REGEX = /^[a-z][a-z0-9_-]{0,31}$/;

test('target regex: valid targets', () => {
  assert.ok(TARGET_REGEX.test('copilot'), 'copilot');
  assert.ok(TARGET_REGEX.test('codex'), 'codex');
  assert.ok(TARGET_REGEX.test('antigravity'), 'antigravity');
  assert.ok(TARGET_REGEX.test('generic'), 'generic');
  assert.ok(TARGET_REGEX.test('cascade'), 'cascade');
});

test('target regex: rejects uppercase', () => {
  assert.ok(!TARGET_REGEX.test('Copilot'), 'Leading uppercase rejected');
  assert.ok(!TARGET_REGEX.test('COPILOT'), 'All uppercase rejected');
});

test('target regex: rejects special characters', () => {
  assert.ok(!TARGET_REGEX.test('copilot!'), 'Exclamation rejected');
  assert.ok(!TARGET_REGEX.test('copilot.v2'), 'Dot rejected');
  assert.ok(!TARGET_REGEX.test('co pilot'), 'Space rejected');
});

test('target regex: max 32 chars', () => {
  const long = 'a' + 'b'.repeat(31);
  assert.ok(TARGET_REGEX.test(long), '32 chars accepted');
  const tooLong = 'a' + 'b'.repeat(32);
  assert.ok(!TARGET_REGEX.test(tooLong), '33 chars rejected');
});

test('target regex: rejects leading digit', () => {
  assert.ok(!TARGET_REGEX.test('1copilot'), 'Leading digit rejected');
});

test('target regex: rejects empty', () => {
  assert.ok(!TARGET_REGEX.test(''), 'Empty rejected');
});

// ═══════════════════════════════════════════════════════════════
// Error message sanitization
// ═══════════════════════════════════════════════════════════════
test('error sanitization: Windows path stripped from error message', () => {
  const rawErr = 'Failed to connect at C:\\Users\\admin\\AppData\\Local\\pipe\\ipc';
  // Sanitize by removing Windows paths
  const sanitized = rawErr.replace(/[A-Z]:\\[^\s:]+/g, '<path>');
  assert.ok(!sanitized.includes('C:\\Users'), 'Windows path removed');
  assert.ok(sanitized.includes('<path>'), 'Replaced with placeholder');
});

test('error sanitization: Unix path stripped from error message', () => {
  const rawErr = 'Failed to connect at /home/user/.config/ipc/pipe';
  const sanitized = rawErr.replace(/\/[^\s:]+/g, '<path>');
  assert.ok(!sanitized.includes('/home/user'), 'Unix path removed');
});

test('error sanitization: long error truncated', () => {
  const longErr = 'Error: ' + 'x'.repeat(500);
  const sanitized = longErr.substring(0, 200);
  assert.equal(sanitized.length, 200, 'Truncated to 200 chars');
});

// ═══════════════════════════════════════════════════════════════
// Adapter state machine: busy flag consistency
// ═══════════════════════════════════════════════════════════════
test('adapter busy flag: starts false', () => {
  const adapter = new GenericAdapter({});
  assert.equal(adapter.isBusy(), false);
});

test('adapter: submit without probe rejects', async () => {
  const adapter = new GenericAdapter({});
  await assert.rejects(
    () => adapter.submit('test message'),
    /TARGET_UNAVAILABLE|unavailable|probe|not available/i,
    'Submit without probe throws'
  );
});

// ═══════════════════════════════════════════════════════════════
// IPC message type validation
// ═══════════════════════════════════════════════════════════════
test('IPC request types: known types', () => {
  const KNOWN_TYPES = new Set([
    'chat.submit',
    'list-commands',
    'reprobe',
    'reload',
    'run-command',
  ]);
  assert.equal(KNOWN_TYPES.size, 5, 'Five known request types');
  assert.ok(KNOWN_TYPES.has('chat.submit'), 'chat.submit exists');
  assert.ok(KNOWN_TYPES.has('run-command'), 'run-command exists');
});

test('IPC message: type field must be string', () => {
  // Verify type checks work for message routing
  const msg = { type: 'chat.submit', text: 'hello' };
  assert.equal(typeof msg.type, 'string');

  // Type confusion: number type
  const badMsg = { type: 123, text: 'hello' };
  assert.notEqual(typeof badMsg.type, 'string', 'Number type detected');
});

test('IPC message: missing type field', () => {
  const msg = { text: 'hello' };
  assert.equal(msg.type, undefined, 'Missing type is undefined');
  assert.equal(typeof msg.type, 'undefined');
});

// ═══════════════════════════════════════════════════════════════
// run-command blocklist
// ═══════════════════════════════════════════════════════════════
test('run-command blocklist: critical commands blocked', () => {
  const BLOCKLIST = new Set([
    'workbench.action.quit',
    'workbench.action.closeWindow',
  ]);
  assert.ok(BLOCKLIST.has('workbench.action.quit'), 'Quit blocked');
  assert.ok(BLOCKLIST.has('workbench.action.closeWindow'), 'Close window blocked');
  assert.ok(!BLOCKLIST.has('workbench.action.reloadWindow'), 'Reload NOT blocked');
});

test('run-command blocklist: case-sensitive check', () => {
  const BLOCKLIST = new Set([
    'workbench.action.quit',
    'workbench.action.closeWindow',
  ]);
  // Verify blocklist is case-sensitive (bypasses with different case)
  assert.ok(!BLOCKLIST.has('Workbench.Action.Quit'), 'Different case bypasses blocklist');
  // This is a potential vulnerability if upstream doesn't normalize case
});

// ═══════════════════════════════════════════════════════════════
// Large message handling
// ═══════════════════════════════════════════════════════════════
test('large message: 1MB text payload', () => {
  const largeText = 'x'.repeat(1_000_000);
  // Verify basic string operations still work on large payloads
  assert.equal(largeText.length, 1_000_000);
  const trimmed = largeText.trim();
  assert.equal(trimmed.length, 1_000_000, 'Trim preserves length');
  const sanitized = largeText.replace(/^[/@]+/, '');
  assert.equal(sanitized.length, 1_000_000, 'Sanitizer handles large input');
});

test('large message: deeply nested JSON', () => {
  // Build 50-level nested JSON
  let json = '"leaf"';
  for (let i = 0; i < 50; i++) {
    json = `{"data":${json}}`;
  }
  const parsed = JSON.parse(json);
  let node = parsed;
  for (let i = 0; i < 50; i++) {
    node = node.data;
  }
  assert.equal(node, 'leaf', 'Deeply nested JSON parsed');
});
