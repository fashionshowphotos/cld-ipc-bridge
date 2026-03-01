/**
 * Phase 0 Capability Spike — Probes VS Code chat commands
 * -------------------------------------------------------
 * Temporary file. Run via the "CLD IPC Bridge: Probe Chat Commands" command
 * in a VS Code instance with Codex/Copilot installed.
 *
 * Results are logged to the Output channel "CLD IPC Bridge" and written to
 * 12 - IPC Bridge/spike_results.json for reference.
 *
 * DELETE THIS FILE after Phase 0 is complete.
 */

'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

/** @param {vscode.OutputChannel} out */
async function runSpike(out) {
  const results = {
    timestamp: new Date().toISOString(),
    vscodeVersion: vscode.version,
    commands: { chat: [], codex: [], copilot: [], all: [] },
    tests: {}
  };

  out.appendLine('=== CLD IPC Bridge — Phase 0 Capability Spike ===');
  out.appendLine(`VS Code version: ${vscode.version}`);
  out.appendLine('');

  // 1. Enumerate all commands matching chat/codex/copilot
  out.appendLine('--- Step 1: Command Enumeration ---');
  try {
    const allCmds = await vscode.commands.getCommands(true);
    results.commands.chat = allCmds.filter(c => /chat/i.test(c));
    results.commands.codex = allCmds.filter(c => /codex/i.test(c));
    results.commands.copilot = allCmds.filter(c => /copilot/i.test(c));
    // Also grab "type", "submit", and other relevant commands
    const relevant = allCmds.filter(c =>
      /chat|codex|copilot|inline|submit|type|send/i.test(c)
    );
    results.commands.all = relevant;

    out.appendLine(`Chat commands (${results.commands.chat.length}):`);
    results.commands.chat.forEach(c => out.appendLine(`  ${c}`));
    out.appendLine(`Codex commands (${results.commands.codex.length}):`);
    results.commands.codex.forEach(c => out.appendLine(`  ${c}`));
    out.appendLine(`Copilot commands (${results.commands.copilot.length}):`);
    results.commands.copilot.forEach(c => out.appendLine(`  ${c}`));
    out.appendLine('');
  } catch (err) {
    out.appendLine(`ERROR enumerating commands: ${err.message}`);
    results.tests.enumerate = { ok: false, error: err.message };
  }

  // 2. Test: Open chat panel
  out.appendLine('--- Step 2: Open Chat Panel ---');
  try {
    await vscode.commands.executeCommand('workbench.action.chat.open');
    await sleep(500);
    out.appendLine('workbench.action.chat.open: SUCCESS (executed, check if panel opened)');
    results.tests.open = { ok: true };
  } catch (err) {
    out.appendLine(`workbench.action.chat.open: FAILED — ${err.message}`);
    results.tests.open = { ok: false, error: err.message };
  }

  // 3. Test: Open with query pre-fill
  out.appendLine('');
  out.appendLine('--- Step 3: Open with Query Pre-fill ---');
  try {
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: 'SPIKE_TEST_PREFILL_12345',
      isPartialQuery: true
    });
    await sleep(500);
    out.appendLine('workbench.action.chat.open + query: SUCCESS (check if input pre-filled with SPIKE_TEST_PREFILL_12345)');
    results.tests.openWithQuery = { ok: true, note: 'Check chat input for SPIKE_TEST_PREFILL_12345' };
  } catch (err) {
    out.appendLine(`workbench.action.chat.open + query: FAILED — ${err.message}`);
    results.tests.openWithQuery = { ok: false, error: err.message };
  }

  // 4. Test: Type command into chat input
  out.appendLine('');
  out.appendLine('--- Step 4: Type Command ---');
  try {
    // First, try to clear any existing text
    await vscode.commands.executeCommand('editor.action.selectAll');
    await sleep(100);
    await vscode.commands.executeCommand('type', { text: 'SPIKE_TYPE_MARKER_67890' });
    await sleep(300);
    out.appendLine('type command: SUCCESS (check if SPIKE_TYPE_MARKER_67890 appears in chat input, NOT in editor)');
    results.tests.type = { ok: true, note: 'Verify text went to chat input, not active editor' };
  } catch (err) {
    out.appendLine(`type command: FAILED — ${err.message}`);
    results.tests.type = { ok: false, error: err.message };
  }

  // 5. Test: Submit command (DON'T actually submit — just check if command exists)
  out.appendLine('');
  out.appendLine('--- Step 5: Submit Command Existence ---');
  try {
    const allCmds = await vscode.commands.getCommands(true);
    const submitExists = allCmds.includes('workbench.action.chat.submit');
    const chatSubmitExists = allCmds.includes('chat.action.submit');
    out.appendLine(`workbench.action.chat.submit exists: ${submitExists}`);
    out.appendLine(`chat.action.submit exists: ${chatSubmitExists}`);
    results.tests.submitExists = { ok: true, workbenchSubmit: submitExists, chatSubmit: chatSubmitExists };
  } catch (err) {
    out.appendLine(`Submit check: FAILED — ${err.message}`);
    results.tests.submitExists = { ok: false, error: err.message };
  }

  // 6. Check context keys (if accessible)
  out.appendLine('');
  out.appendLine('--- Step 6: Context Keys ---');
  try {
    // Context keys aren't directly queryable, but we can check if certain
    // "when" clauses would be true by trying conditional commands
    out.appendLine('Context keys are not directly queryable from extension API.');
    out.appendLine('Check keybindings.json for "when" clauses like: inChatInput, chatInputHasText');
    results.tests.contextKeys = { ok: true, note: 'Manual check needed' };
  } catch (err) {
    results.tests.contextKeys = { ok: false, error: err.message };
  }

  // 7. List installed extensions related to chat/codex
  out.appendLine('');
  out.appendLine('--- Step 7: Installed Extensions ---');
  try {
    const extensions = vscode.extensions.all.filter(ext =>
      /chat|codex|copilot|openai/i.test(ext.id)
    );
    extensions.forEach(ext => {
      out.appendLine(`  ${ext.id} v${ext.packageJSON?.version || '?'} (active: ${ext.isActive})`);
    });
    results.extensions = extensions.map(ext => ({
      id: ext.id,
      version: ext.packageJSON?.version,
      active: ext.isActive
    }));
  } catch (err) {
    out.appendLine(`Extension scan: ${err.message}`);
  }

  // Save results to file
  out.appendLine('');
  out.appendLine('--- Results ---');
  const resultsPath = path.join(__dirname, 'spike_results.json');
  try {
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2), 'utf8');
    out.appendLine(`Results saved to: ${resultsPath}`);
  } catch (err) {
    out.appendLine(`Failed to save results: ${err.message}`);
  }

  out.appendLine('');
  out.appendLine('=== Spike Complete ===');
  out.appendLine('Review the output above and spike_results.json.');
  out.appendLine('Then decide: GO / PARTIAL / PIVOT / NO-GO for Codex adapter.');
  out.show(true);

  return results;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { runSpike };
