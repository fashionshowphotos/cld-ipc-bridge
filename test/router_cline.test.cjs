#!/usr/bin/env node
/**
 * router_cline.test.cjs - Tests Router with cline target
 */
'use strict';

const { Router } = require('../lib/router.cjs');
const { ClineAdapter } = require('../lib/adapters/cline.cjs');

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { console.log('  PASS:', name); passed++; }
  else { console.log('  FAIL:', name); failed++; }
}

const mockVscode = {
  commands: {
    getCommands: async () => ['cline.addToChat', 'cline.focusChatInput'],
    executeCommand: async () => {},
  },
};

async function main() {
  console.log('=== Router + Cline tests ===\n');

  const cline = new ClineAdapter({ vscode: mockVscode, log: () => {} });
  await cline.probe();

  const router = new Router({
    adapters: { cline, generic: { available: false }, codex: { available: false }, copilot: { available: false }, antigravity: { available: false } },
    vscode: mockVscode,
    log: () => {},
  });

  const sendFn = () => {};

  console.log('Test 1: chat.submit to cline target');
  const r1 = await router.handle({
    id: 't1',
    type: 'chat.submit',
    target: 'cline',
    text: 'hello',
  }, sendFn);
  assert(r1 === null, 'ack sent via sendFn (returns null)');

  console.log('\nTest 2: unsupported target rejected');
  const r2 = await router.handle({
    id: 't2',
    type: 'chat.submit',
    target: 'nonexistent',
    text: 'hi',
  }, sendFn);
  assert(r2 && r2.code === 'UNSUPPORTED_TARGET', 'UNSUPPORTED_TARGET');

  console.log('\nTest 3: invalid text rejected');
  const r3 = await router.handle({
    id: 't3',
    type: 'chat.submit',
    target: 'cline',
    text: '',
  }, sendFn);
  assert(r3 && r3.code === 'INVALID_TEXT', 'INVALID_TEXT');

  router.dispose();
  console.log('\n=== Results:', passed, 'passed,', failed, 'failed ===');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
