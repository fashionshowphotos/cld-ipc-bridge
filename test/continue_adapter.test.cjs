#!/usr/bin/env node
/**
 * continue_adapter.test.cjs - Unit tests for ContinueAdapter
 */
'use strict';

const { ContinueAdapter } = require('../lib/adapters/continue.cjs');

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { console.log('  PASS:', name); passed++; }
  else { console.log('  FAIL:', name); failed++; }
}

async function main() {
  console.log('=== ContinueAdapter unit tests ===\n');

  const mockVscode = {
    commands: {
      getCommands: async () => ['continue.focusContinueInput', 'workbench.action.chat.open'],
      executeCommand: async () => {},
    },
  };

  const adapter = new ContinueAdapter({ vscode: mockVscode, log: () => {} });

  console.log('Test 1: probe finds Continue commands');
  await adapter.probe();
  assert(adapter.available === true, 'available true');
  assert(adapter._focusCmd === 'continue.focusContinueInput', 'focusCmd set');

  console.log('\nTest 2: submit when available');
  const result = await adapter.submit('hello');
  assert(result.grade === 'submitted', 'grade submitted');

  console.log('\nTest 3: unavailable when no Continue commands');
  const mock2 = { commands: { getCommands: async () => [] } };
  const ad2 = new ContinueAdapter({ vscode: mock2, log: () => {} });
  await ad2.probe();
  assert(ad2.available === false, 'unavailable');
  try {
    await ad2.submit('hi');
    assert(false, 'Should throw');
  } catch (e) {
    assert(e.code === 'TARGET_UNAVAILABLE', 'TARGET_UNAVAILABLE');
  }

  console.log('\n=== Results:', passed, 'passed,', failed, 'failed ===');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
