#!/usr/bin/env node
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
    fail(`Instances directory not found: ${instancesDir}`);
  }

  const files = fs.readdirSync(instancesDir)
    .filter(name => name.endsWith('.json'))
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

function connectAndSubmit({ instance, token, target, text }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(instance.pipe);
    socket.setEncoding('utf8');

    let buffer = '';
    let submitted = false;

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

        console.log('<<', JSON.stringify(msg));

        if (msg.type === 'error') {
          clearTimeout(timeout);
          socket.destroy();
          reject(new Error(`${msg.code || 'ERROR'}: ${msg.message || 'Unknown error'}`));
          return;
        }

        if (msg.type === 'handshake_ok' && !submitted) {
          submitted = true;
          socket.write(JSON.stringify({
            id: 'submit-1',
            type: 'chat.submit',
            target,
            text,
            expect_instance: instance.instanceId
          }) + '\n');
          continue;
        }

        if (msg.type === 'chat.submitted') {
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
  const target = process.argv[2] || 'codex';
  const text = process.argv.slice(3).join(' ') || 'Hello from live_submit test';

  const instance = getLatestInstance();
  const token = readToken(instance.instanceId);

  console.log(`Using instance ${instance.instanceId}`);
  console.log(`Pipe: ${instance.pipe}`);
  console.log(`Target: ${target}`);
  console.log(`Text: ${text}`);

  const result = await connectAndSubmit({ instance, token, target, text });
  console.log('OK:', JSON.stringify(result));
}

main().catch((err) => {
  fail(err.message || String(err));
});
