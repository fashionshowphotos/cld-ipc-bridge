#!/usr/bin/env node
/**
 * run_command.test.cjs - Tests for run_command client protocol
 */
'use strict';

const net = require('net');
const crypto = require('crypto');
const { PipeServer } = require('../lib/pipe_server.cjs');
const { generateToken } = require('../lib/auth.cjs');

const TEST_PIPE = '\\\\.\\pipe\\cld-ipc-bridge.rc.' + crypto.randomBytes(4).toString('hex');
const INST = crypto.randomBytes(4).toString('hex');
const TOK = generateToken();

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { console.log('  PASS:', name); passed++; }
  else { console.log('  FAIL:', name); failed++; }
}

function connectAndRun(pipePath, token, instId, req) {
  return new Promise((resolve, reject) => {
    const s = net.connect(pipePath);
    s.setEncoding('utf8');
    let buf = '';
    let sent = false;
    const to = setTimeout(() => { s.destroy(); reject(new Error('Timeout')); }, 5000);
    s.on('connect', () => {
      s.write(JSON.stringify({ id: 'h1', type: 'handshake', token, expect_instance: instId }) + '\n');
    });
    s.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.type === 'error') {
          clearTimeout(to);
          s.destroy();
          reject(new Error(m.code + ': ' + m.message));
          return;
        }
        if (m.type === 'handshake_ok' && !sent) {
          sent = true;
          req.id = req.id || 'c1';
          req.expect_instance = instId;
          s.write(JSON.stringify(req) + '\n');
          continue;
        }
        if (['command-result', 'command-list', 'reload', 'reprobe'].includes(m.type)) {
          clearTimeout(to);
          s.end();
          resolve(m);
          return;
        }
      }
    });
    s.on('error', reject);
    s.on('close', () => clearTimeout(to));
  });
}

async function main() {
  console.log('=== run_command client tests ===\n');

  const srv = new PipeServer({
    pipePath: TEST_PIPE,
    token: TOK,
    instanceId: INST,
    log: () => {},
    onRequest: async (r) => {
      if (r.type === 'list-commands') return { id: r.id, type: 'command-list', ok: true, count: 2, commands: ['cline.focusChatInput', 'cline.addToChat'] };
      if (r.type === 'run-command') {
        if (r.command === 'cline.focusChatInput') return { id: r.id, type: 'command-result', ok: true, command: r.command, result: null };
        return { id: r.id, type: 'error', ok: false, code: 'COMMAND_FAILED', message: 'Unknown' };
      }
      return { id: r.id, type: 'error', ok: false, code: 'UNKNOWN', message: 'x' };
    },
  });
  await srv.listen();

  try {
    console.log('Test 1: list-commands');
    const lr = await connectAndRun(TEST_PIPE, TOK, INST, { type: 'list-commands', filter: 'cline' });
    assert(lr.type === 'command-list', 'Returns command-list');
    assert(lr.count === 2, 'Count is 2');

    console.log('\nTest 2: run-command success');
    const rr = await connectAndRun(TEST_PIPE, TOK, INST, { type: 'run-command', command: 'cline.focusChatInput' });
    assert(rr.type === 'command-result', 'Returns command-result');
    assert(rr.ok === true, 'ok true');

    console.log('\nTest 3: run-command failure');
    try {
      await connectAndRun(TEST_PIPE, TOK, INST, { type: 'run-command', command: 'bad.cmd' });
      assert(false, 'Should reject');
    } catch (e) {
      assert(e.message.indexOf('COMMAND_FAILED') !== -1, 'Error contains COMMAND_FAILED');
    }
  } finally {
    if (srv.close) srv.close();
    else if (srv._server) srv._server.close();
  }

  console.log('\n=== Results:', passed, 'passed,', failed, 'failed ===');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
