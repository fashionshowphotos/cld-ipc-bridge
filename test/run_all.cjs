#!/usr/bin/env node
/**
 * run_all.cjs - Run all IPC Bridge tests
 */
'use strict';

const { execSync } = require('child_process');
const path = require('path');

const TEST_DIR = path.join(__dirname);
const TESTS = [
  'smoke.cjs',
  'adversarial.cjs',
  'run_command.test.cjs',
  'cline_adapter.test.cjs',
  'continue_adapter.test.cjs',
  'router_cline.test.cjs',
  'open_panels.test.cjs',
];

let failed = 0;
for (const t of TESTS) {
  const p = path.join(TEST_DIR, t);
  process.stdout.write('\n--- ' + t + ' ---\n');
  try {
    execSync('node "' + p + '"', { stdio: 'inherit', cwd: path.dirname(__dirname) });
  } catch (e) {
    failed++;
  }
}

console.log('\n=== Total: ' + (TESTS.length - failed) + '/' + TESTS.length + ' suites passed ===');
process.exit(failed > 0 ? 1 : 0);
