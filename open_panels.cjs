#!/usr/bin/env node
/**
 * open_panels.cjs — Open Cline and/or Continue panels via IPC Bridge
 * ------------------------------------------------------------------
 * Runs VS Code commands to focus/open Cline and Continue chat panels.
 * Requires: Cursor/VS Code running with IPC Bridge extension.
 *
 * Usage:
 *   node open_panels.cjs           # Open both Cline and Continue
 *   node open_panels.cjs cline    # Open Cline only
 *   node open_panels.cjs continue # Open Continue only
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');

const RUN_CMD = path.join(__dirname, 'run_command.cjs');

const COMMANDS = {
  cline: [
    'cline.focusChatInput',           // Focus Cline sidebar
    'cline.openInNewTab',             // Open Cline in editor tab (if available)
  ],
  continue: [
    'continue.focusContinueInput',      // Focus Continue sidebar (Ctrl+L)
    'continue.focusContinueInputWithoutClear',
  ],
};

function run(cmd) {
  try {
    execSync(`node "${RUN_CMD}" ${cmd}`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    return true;
  } catch (err) {
    return false;
  }
}

function main() {
  const arg = (process.argv[2] || '').toLowerCase();
  const targets = arg === 'cline' ? ['cline']
    : arg === 'continue' ? ['continue']
    : ['cline', 'continue'];

  for (const target of targets) {
    const cmds = COMMANDS[target];
    if (!cmds) continue;

    console.log(`Opening ${target}...`);
    let ok = false;
    for (const cmd of cmds) {
      if (run(cmd)) {
        console.log(`  ✓ ${cmd}`);
        ok = true;
        break;
      }
    }
    if (!ok) console.log(`  ✗ No command succeeded for ${target}`);
  }
}

main();
