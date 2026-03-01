#!/usr/bin/env node
/**
 * cline_adapter.test.cjs - Unit tests for ClineAdapter
 */
'use strict';

const { ClineAdapter } = require('../lib/adapters/cline.cjs');

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { console.log('  PASS:', name); passed++; }
  else { console.log('  FAIL:', name); failed++; }
}

async function main() {
  console.log('=== ClineAdapter unit tests ===\n');

  const mockVscode = {
    commands: {
      getCommands: async () => ['cline.addToChat', 'cline.focusChatInput'],
      executeCommand: async (cmd, arg) => {
        if (cmd === 'cline.focusChatInput' || cmd === 'cline.addToChat') return;
        throw new Error('Unknown');
      },
    },
  };

  const log = () => {};
  const adapter = new ClineAdapter({ vscode: mockVscode, log });

  console.log('Test 1: probe finds Cline commands');
  const probe = await adapter.probe();
  assert(adapter.available === true, 'available true');
  assert(adapter._sendCmd === 'cline.addToChat', 'sendCmd set');
  assert(adapter._focusCmd === 'cline.focusChatInput', 'focusCmd set');

  console.log('\nTest 2: submit when available');
  const result = await adapter.submit('hello world');
  assert(result.grade === 'submitted', 'grade submitted');
  assert(result.detail && result.detail.includes('cline'), 'detail mentions cline');

  console.log('\nTest 3: submit rejects empty after strip');
  try {
    await adapter.submit('   ');
    assert(false, 'Should throw');
  } catch (e) {
    assert(e.code === 'INVALID_TEXT', 'INVALID_TEXT');
  }

  console.log('\nTest 4: submit strips leading slash');
  const mock2 = {
    commands: {
      getCommands: async () => ['cline.addToChat', 'cline.focusChatInput'],
      executeCommand: async () => {},
    },
  };
  const ad2 = new ClineAdapter({ vscode: mock2, log });
  await ad2.probe();
  const r2 = await ad2.submit('/help');
  assert(r2.grade === 'submitted', 'submitted after strip');

  console.log('\nTest 5: isBusy during submit');
  let resolveSubmit;
  const pending = new Promise(r => { resolveSubmit = r; });
  const mock3 = {
    commands: {
      getCommands: async () => ['cline.addToChat'],
      executeCommand: async () => { await pending; },
    },
  };
  const ad3 = new ClineAdapter({ vscode: mock3, log });
  await ad3.probe();
  const p = ad3.submit('x');
  assert(ad3.isBusy() === true, 'busy during submit');
  resolveSubmit();
  await p;
  assert(ad3.isBusy() === false, 'not busy after');

  console.log('\nTest 6: unavailable when no Cline commands');
  const mock4 = { commands: { getCommands: async () => [] } };
  const ad4 = new ClineAdapter({ vscode: mock4, log });
  await ad4.probe();
  assert(ad4.available === false, 'unavailable');
  try {
    await ad4.submit('hi');
    assert(false, 'Should throw');
  } catch (e) {
    assert(e.code === 'TARGET_UNAVAILABLE', 'TARGET_UNAVAILABLE');
  }

  console.log('\n=== Results:', passed, 'passed,', failed, 'failed ===');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
