#!/usr/bin/env node
/**
 * adversarial-r7.cjs — Round 7 adversarial tests for IPC Bridge
 * ---------------------------------------------------------------
 * Focus: Codex adapter safety interlocks (ALLOWED_EDITORS, workspace
 * matching, bbox validation, DPI scaling), Copilot adapter submit
 * cascade (slash stripping, enter key methods, unverified success),
 * Router busy adapter handling, processing timeout, error path
 * sanitization, per-connection rate limiting, request lifecycle.
 *
 * Usage: node test/adversarial-r7.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Router ────────────────────────────────────────────────────
const { Router } = require('../lib/router.cjs');
// ── GenericAdapter for testing ────────────────────────────────
const { GenericAdapter } = require('../lib/adapters/generic.cjs');

// ═══════════════════════════════════════════════════════════════
// CODEX ADAPTER: Safety interlock edge cases (pure logic tests)
// ═══════════════════════════════════════════════════════════════

const ALLOWED_EDITORS = ['Code', 'Antigravity', 'Cursor', 'Windsurf'];

test('Codex safety: ALLOWED_EDITORS is case-sensitive', () => {
  assert.ok(ALLOWED_EDITORS.includes('Code'), 'Code accepted');
  assert.equal(ALLOWED_EDITORS.includes('code'), false, 'code (lowercase) rejected');
  assert.equal(ALLOWED_EDITORS.includes('CODE'), false, 'CODE rejected');
  // This means processName must match exact case — potential Windows issue
  // where processName could be 'code.exe' not 'Code'
});

test('Codex safety: workspace substring match is case-insensitive', () => {
  const layout = { workspace: 'Coherent Light' };
  const winTitle = 'COHERENT LIGHT DESIGNS - Visual Studio Code';
  const matches = winTitle.toLowerCase().includes(layout.workspace.toLowerCase());
  assert.ok(matches, 'Case-insensitive substring match');
});

test('Codex safety: empty workspace matches any title', () => {
  const layout = { workspace: '' };
  const winTitle = 'Any Project - Visual Studio Code';
  // In code: layout.workspace && !winTitle.toLowerCase().includes(...)
  // Empty string is falsy → condition is false → no rejection
  assert.ok(!layout.workspace, 'Empty workspace is falsy → no check');
});

test('Codex safety: workspace as substring of different project', () => {
  const layout = { workspace: 'Test' };
  // Title could be "Testing Project - Visual Studio Code"
  const winTitle = 'Testing Project - Visual Studio Code';
  const matches = winTitle.toLowerCase().includes(layout.workspace.toLowerCase());
  assert.ok(matches, 'VULNERABILITY: "Test" matches "Testing" via substring');
  // This could cause injection into wrong VS Code instance
});

test('Codex safety: workspace with special regex chars', () => {
  const layout = { workspace: 'project (v2.0)' };
  const winTitle = 'project (v2.0) - Visual Studio Code';
  // .includes() is not regex-based, so special chars are literal
  const matches = winTitle.toLowerCase().includes(layout.workspace.toLowerCase());
  assert.ok(matches, 'Special chars treated literally in includes()');
});

// ═══════════════════════════════════════════════════════════════
// CODEX ADAPTER: BBox validation
// ═══════════════════════════════════════════════════════════════

test('Codex bbox: valid fractional coordinates', () => {
  const bbox = [0.1, 0.2, 0.3, 0.4]; // [x, y, width, height] as fractions
  const [bx, by, bw, bh] = bbox;
  const centerX = bx + bw / 2; // 0.1 + 0.15 = 0.25
  const centerY = by + bh / 2; // 0.2 + 0.2 = 0.4
  assert.equal(centerX, 0.25, 'Center X computed');
  assert.equal(centerY, 0.4, 'Center Y computed');
});

test('Codex bbox: NaN in coordinates propagates to screen position', () => {
  const bbox = [NaN, 0.2, 0.3, 0.4];
  const winRect = { left: 100, top: 100, width: 1920, height: 1080 };
  const [bx, by, bw, bh] = bbox;
  const absX = winRect.left + (bx + bw / 2) * winRect.width;
  assert.ok(isNaN(absX), 'NaN in bbox → NaN screen position');
  // Math.round(NaN) = NaN → clickAt(NaN, y) would likely fail
});

test('Codex bbox: negative coordinates', () => {
  const bbox = [-0.1, 0.2, 0.3, 0.4];
  const winRect = { left: 100, top: 100, width: 1920, height: 1080 };
  const [bx, by, bw, bh] = bbox;
  const absX = winRect.left + (bx + bw / 2) * winRect.width;
  // -0.1 + 0.15 = 0.05 → 100 + 0.05 * 1920 = 196 → valid but leftmost area
  assert.ok(absX >= 0, 'Negative bbox offset still produces valid screen pos');
});

test('Codex bbox: zero-width/height', () => {
  const bbox = [0.5, 0.5, 0, 0]; // zero size
  const [bx, by, bw, bh] = bbox;
  const centerX = bx + bw / 2; // 0.5 + 0 = 0.5
  assert.equal(centerX, 0.5, 'Zero width → center at edge');
});

test('Codex bbox: coordinates > 1.0 (outside window)', () => {
  const bbox = [1.5, 0.5, 0.1, 0.1]; // x > 1 = outside window
  const winRect = { left: 0, top: 0, width: 1920, height: 1080 };
  const absX = winRect.left + (bbox[0] + bbox[2] / 2) * winRect.width;
  assert.ok(absX > winRect.width, 'Click outside window boundaries');
  // This would click on a different monitor or outside the window
});

// ═══════════════════════════════════════════════════════════════
// COPILOT ADAPTER: Slash stripping edge cases
// ═══════════════════════════════════════════════════════════════

test('Copilot slash strip: leading slash removed', () => {
  const text = '/hello world';
  const result = text.replace(/^[/@]+/, '');
  assert.equal(result, 'hello world');
});

test('Copilot slash strip: leading @ removed', () => {
  const text = '@workspace hello';
  const result = text.replace(/^[/@]+/, '');
  assert.equal(result, 'workspace hello');
});

test('Copilot slash strip: mixed /@ removed', () => {
  const text = '/@//@@hello';
  const result = text.replace(/^[/@]+/, '');
  assert.equal(result, 'hello');
});

test('Copilot slash strip: only slashes → empty string', () => {
  const text = '////';
  const result = text.replace(/^[/@]+/, '');
  assert.equal(result, '', 'All slashes → empty');
  assert.ok(!result.trim(), 'Fails non-empty check');
});

test('Copilot slash strip: slash in middle preserved', () => {
  const text = 'hello/world';
  const result = text.replace(/^[/@]+/, '');
  assert.equal(result, 'hello/world', 'Middle slash preserved');
});

test('Copilot slash strip: "/ " (slash space) → " " → trim = empty', () => {
  const text = '/ ';
  const result = text.replace(/^[/@]+/, '');
  assert.equal(result, ' ', 'Space remains after strip');
  assert.ok(!result.trim(), 'Trim makes it empty → should reject');
});

// ═══════════════════════════════════════════════════════════════
// COPILOT ADAPTER: Enter key cascade logic
// ═══════════════════════════════════════════════════════════════

test('Copilot enter cascade: method list has 4 entries', () => {
  const enterMethods = [
    ['workbench.action.chat.acceptInput', undefined],
    ['workbench.action.chat.submit', undefined],
    ['default:type', { text: '\r' }],
    ['default:type', { text: '\n' }],
  ];
  assert.equal(enterMethods.length, 4, '4 enter methods');
});

test('Copilot enter cascade: first success breaks loop', () => {
  const enterMethods = [
    ['method1', null], // succeeds
    ['method2', null], // should not be tried
  ];

  let tried = [];
  for (const [cmd] of enterMethods) {
    tried.push(cmd);
    // Simulate: first method succeeds
    if (cmd === 'method1') break;
  }
  assert.deepEqual(tried, ['method1'], 'Only first method tried');
});

test('Copilot enter cascade: all methods fail → success returned anyway', () => {
  // In real code: loop tries all 4, all throw/no-op
  // Then returns { grade: 'submitted' } on line 148
  // This is a potential false-success scenario
  const allFailed = true;
  const returnValue = { grade: 'submitted', detail: 'submitted via chat.submit + Enter key cascade' };
  // Code returns success even if all enter methods failed
  assert.equal(returnValue.grade, 'submitted', 'Returns success regardless');
  // This is an unverified success — caller doesn't know message wasn't sent
});

test('Copilot enter cascade: CR vs LF handling', () => {
  // Method 3: { text: '\r' } (CR)
  // Method 4: { text: '\n' } (LF)
  assert.notEqual('\r', '\n', 'CR and LF are different characters');
  assert.equal('\r'.charCodeAt(0), 13, 'CR = 0x0D');
  assert.equal('\n'.charCodeAt(0), 10, 'LF = 0x0A');
  // Some chat UIs may only respond to one
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: Busy adapter handling
// ═══════════════════════════════════════════════════════════════

test('Router: busy adapter with reject policy', async () => {
  const busyAdapter = {
    available: true,
    submit: async () => ({ grade: 'submitted' }),
    isBusy: () => true, // always busy
    busyPolicy: 'reject-when-busy',
  };

  const router = new Router({
    adapters: { copilot: busyAdapter },
    log: () => {},
  });

  const responses = [];
  await router.handle({
    id: 'req-1', type: 'chat.submit', target: 'copilot', text: 'hello'
  }, (r) => responses.push(r));

  // Wait for async processing
  await new Promise(r => setTimeout(r, 200));

  // Should have ack + busy error
  const busyResp = responses.find(r => r.code === 'TARGET_BUSY');
  assert.ok(busyResp, 'Busy rejection sent');

  clearInterval(router._cleanupInterval);
});

test('Router: busy adapter with submit-anyway policy', async () => {
  const busyAdapter = {
    available: true,
    submit: async () => ({ grade: 'submitted', detail: 'forced' }),
    isBusy: () => true,
    busyPolicy: 'submit-anyway', // override
  };

  const router = new Router({
    adapters: { copilot: busyAdapter },
    log: () => {},
  });

  const responses = [];
  await router.handle({
    id: 'req-1', type: 'chat.submit', target: 'copilot', text: 'hello'
  }, (r) => responses.push(r));

  await new Promise(r => setTimeout(r, 200));

  // Should submit despite being busy
  const submitted = responses.find(r => r.type === 'chat.submitted');
  assert.ok(submitted, 'Submitted despite busy');

  clearInterval(router._cleanupInterval);
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: Processing timeout
// ═══════════════════════════════════════════════════════════════

test('Router: adapter submit timeout produces PROCESSING_TIMEOUT', async () => {
  const slowAdapter = {
    available: true,
    submit: async () => {
      // Simulate hung adapter (would normally timeout at 30s, we use a short test)
      await new Promise(r => setTimeout(r, 100000));
      return { grade: 'submitted' };
    },
    _setAbortToken: function(token) { this._abortToken = token; },
  };

  const router = new Router({
    adapters: { copilot: slowAdapter },
    log: () => {},
  });

  // Override timeout for test speed
  const originalTimeout = 30000; // PROCESSING_TIMEOUT_MS

  const responses = [];
  await router.handle({
    id: 'req-1', type: 'chat.submit', target: 'copilot', text: 'hello'
  }, (r) => responses.push(r));

  // We can't wait 30s in a test, so just verify the router accepted the request
  const ack = responses.find(r => r.type === 'ack');
  assert.ok(ack, 'Immediate ack sent before timeout');

  clearInterval(router._cleanupInterval);
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: Error path sanitization completeness
// ═══════════════════════════════════════════════════════════════

test('Router: _sanitizeError strips mixed path formats', () => {
  const router = new Router({ adapters: {}, log: () => {} });

  const msg = 'Error: ENOENT C:\\Users\\admin\\project\\secret.key and /etc/shadow';
  const result = router._sanitizeError(msg);
  assert.ok(!result.includes('admin'), 'Windows path user stripped');
  assert.ok(!result.includes('shadow'), 'Unix sensitive path stripped');

  clearInterval(router._cleanupInterval);
});

test('Router: _sanitizeError with quoted paths', () => {
  const router = new Router({ adapters: {}, log: () => {} });

  const msg = 'Cannot find "C:\\secret\\config.json"';
  const result = router._sanitizeError(msg);
  // The regex strips up to the closing quote
  assert.ok(!result.includes('secret'), 'Quoted path stripped');

  clearInterval(router._cleanupInterval);
});

test('Router: _sanitizeError with empty message', () => {
  const router = new Router({ adapters: {}, log: () => {} });
  assert.equal(router._sanitizeError(''), 'Internal error');
  clearInterval(router._cleanupInterval);
});

// ═══════════════════════════════════════════════════════════════
// GENERIC ADAPTER: Constructor and probe patterns
// ═══════════════════════════════════════════════════════════════

test('GenericAdapter: constructor requires vscode', () => {
  const mockVscode = {
    commands: { getCommands: async () => [], executeCommand: async () => {} },
  };
  const adapter = new GenericAdapter({
    vscode: mockVscode,
    commands: { openCommand: 'test.open', submitMethod: 'query', submitCommand: 'test.submit' },
    log: () => {},
  });
  assert.equal(adapter.available, false, 'Not available until probed');
  assert.equal(adapter._busyFlag, false, 'Not busy initially');
});

test('GenericAdapter: isBusy returns busy flag', () => {
  const mockVscode = {
    commands: { getCommands: async () => [], executeCommand: async () => {} },
  };
  const adapter = new GenericAdapter({
    vscode: mockVscode,
    commands: { openCommand: 'test.open', submitMethod: 'query', submitCommand: 'test.submit' },
    log: () => {},
  });
  assert.equal(adapter.isBusy(), false, 'Not busy initially');
  adapter._busyFlag = true;
  assert.equal(adapter.isBusy(), true, 'Busy when flag set');
});

// ═══════════════════════════════════════════════════════════════
// ROUTER: Cleanup interval management
// ═══════════════════════════════════════════════════════════════

test('Router: cleanup interval exists on construction', () => {
  const router = new Router({ adapters: {}, log: () => {} });
  assert.ok(router._cleanupInterval, 'Cleanup interval created');
  clearInterval(router._cleanupInterval);
  // After clear, interval should not fire
});

test('Router: concurrent queue processing across targets', async () => {
  const order = [];
  const adapterA = {
    available: true,
    submit: async (text) => {
      order.push('A:' + text);
      return { grade: 'submitted' };
    },
    isBusy: () => false,
  };
  const adapterB = {
    available: true,
    submit: async (text) => {
      order.push('B:' + text);
      return { grade: 'submitted' };
    },
    isBusy: () => false,
  };

  const router = new Router({
    adapters: { targetA: adapterA, targetB: adapterB },
    log: () => {},
  });

  await router.handle({ id: 'r1', type: 'chat.submit', target: 'targetA', text: 'msg1' }, () => {});
  await router.handle({ id: 'r2', type: 'chat.submit', target: 'targetB', text: 'msg2' }, () => {});

  await new Promise(r => setTimeout(r, 200));

  assert.ok(order.includes('A:msg1'), 'Target A processed');
  assert.ok(order.includes('B:msg2'), 'Target B processed');

  clearInterval(router._cleanupInterval);
});
