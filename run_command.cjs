#!/usr/bin/env node
/**
 * run_command.cjs — IPC Bridge client for arbitrary VS Code commands
 * ------------------------------------------------------------------
 * Sends run-command or list-commands requests to the IPC Bridge via named pipe.
 * Use this to open Cline, focus panels, or run any VS Code command from scripts/agents.
 *
 * Usage:
 *   node run_command.cjs <command> [args...]
 *   node run_command.cjs list-commands [filter]
 *
 * Examples:
 *   node run_command.cjs cline.openInNewTab
 *   node run_command.cjs workbench.action.chat.focusInput
 *   node run_command.cjs list-commands cline
 */

'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');

const baseDir = path.join(process.env.APPDATA || '', 'CoherentLight', 'ipc-bridge');
const instancesDir = path.join(baseDir, 'instances');
const tokensDir = path.join(baseDir, 'tokens');

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function getLatestInstance() {
  if (!fs.existsSync(instancesDir)) {
    fail(`Instances directory not found: ${instancesDir}. Ensure Cursor is running with IPC Bridge extension loaded.`);
  }

  const files = fs.readdirSync(instancesDir)
    .filter(name => name.endsWith('.json') && !name.includes('.tmp.'))
    .map(name => ({
      name,
      fullPath: path.join(instancesDir, name),
      mtimeMs: fs.statSync(path.join(instancesDir, name)).mtimeMs
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (files.length === 0) {
    fail(`No running IPC Bridge instances found in ${instancesDir}`);
  }

  for (const file of files) {
    try {
      const instance = JSON.parse(fs.readFileSync(file.fullPath, 'utf8'));
      if (instance && instance.instanceId && instance.pipe) {
        return instance;
      }
    } catch {
    }
  }

  fail('Could not parse any valid instance registry file');
}

function readToken(instanceId) {
  const tokenPath = path.join(tokensDir, `${instanceId}.token`);
  if (!fs.existsSync(tokenPath)) {
    fail(`Token file not found: ${tokenPath}`);
  }
  return fs.readFileSync(tokenPath, 'utf8').trim();
}

function connectAndRun(instance, token, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(instance.pipe);
    socket.setEncoding('utf8');

    let buffer = '';
    let sent = false;

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for server response'));
    }, 15000);

    socket.on('connect', () => {
      socket.write(JSON.stringify({
        id: 'hs-1',
        type: 'handshake',
        token,
        expect_instance: instance.instanceId
      }) + '\n');
    });

    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx;

      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }

        if (msg.type === 'error') {
          clearTimeout(timeout);
          socket.destroy();
          reject(new Error(`${msg.code || 'ERROR'}: ${msg.message || 'Unknown error'}`));
          return;
        }

        if (msg.type === 'handshake_ok' && !sent) {
          sent = true;
          request.id = request.id || 'cmd-1';
          request.expect_instance = instance.instanceId;
          socket.write(JSON.stringify(request) + '\n');
          continue;
        }

        if (msg.type === 'command-result' || msg.type === 'command-list' || msg.type === 'reload' || msg.type === 'reprobe') {
          clearTimeout(timeout);
          socket.end();
          resolve(msg);
          return;
        }
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    socket.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log('Usage: node run_command.cjs <command> [args...]');
    console.log('       node run_command.cjs list-commands [filter]');
    console.log('');
    console.log('Examples:');
    console.log('  node run_command.cjs cline.openInNewTab');
    console.log('  node run_command.cjs list-commands cline');
    process.exit(1);
  }

  const instance = getLatestInstance();
  const token = readToken(instance.instanceId);

  console.log(`Using instance ${instance.instanceId} (${instance.editorName || 'editor'})`);

  let request;

  if (command === 'list-commands') {
    const filter = args[1] || 'cline';
    request = { type: 'list-commands', filter };
    console.log(`Listing commands matching "${filter}"...`);
  } else {
    const cmdArgs = args.slice(1);
    request = {
      type: 'run-command',
      command,
      ...(cmdArgs.length > 0 && { args: cmdArgs })
    };
    console.log(`Running: ${command}${cmdArgs.length ? ' ' + JSON.stringify(cmdArgs) : ''}`);
  }

  try {
    const result = await connectAndRun(instance, token, request);

    if (result.type === 'command-list') {
      console.log(`Found ${result.count} commands:`);
      (result.commands || []).forEach(c => console.log(c));
    } else if (result.type === 'command-result') {
      console.log('OK:', result.result !== null ? result.result : '(no return value)');
    } else {
      console.log('OK:', JSON.stringify(result));
    }
  } catch (err) {
    fail(err.message || String(err));
  }
}

main();
