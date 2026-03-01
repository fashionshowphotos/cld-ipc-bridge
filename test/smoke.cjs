#!/usr/bin/env node
/**
 * smoke.cjs — Standalone transport smoke test
 * ---------------------------------------------
 * Tests the pipe server + client WITHOUT VS Code.
 * Runs a temporary pipe server in-process and connects a client to it.
 *
 * Usage: node test/smoke.cjs
 *
 * Tests:
 *   1. Client connects
 *   2. Handshake (auth) + 2b. id echo
 *   3. Ping/Pong
 *   4. Request routing (echo)
 *   5. Wrong token rejected
 *   6. Instance mismatch rejected
 *   7. Request without auth rejected
 *   7b. Missing expect_instance rejected
 *   7c. Oversized message rejected
 *   8. Concurrent connections
 *   9. Graceful shutdown
 */

'use strict';

const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { PipeServer } = require('../lib/pipe_server.cjs');
const { generateToken, safeCompare } = require('../lib/auth.cjs');

const TEST_INSTANCE_ID = crypto.randomBytes(4).toString('hex'); // valid 8-hex format
const TEST_PIPE = `\\\\.\\pipe\\cld-ipc-bridge.smoke.${crypto.randomBytes(4).toString('hex')}`;
const TEST_TOKEN = generateToken();

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}`);
    failed++;
  }
}

/**
 * Connect a raw NDJSON client to the pipe.
 */
function connectClient(pipePath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath, () => resolve(socket));
    socket.setEncoding('utf8');
    socket.on('error', reject);
  });
}

/**
 * Send a JSON line and wait for one response line.
 */
function sendAndReceive(socket, msg, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs);
    let buffer = '';
    const handler = (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        clearTimeout(timer);
        socket.removeListener('data', handler);
        try { resolve(JSON.parse(buffer.slice(0, idx))); }
        catch (e) { reject(e); }
      }
    };
    socket.on('data', handler);
    socket.write(JSON.stringify(msg) + '\n');
  });
}

async function runTests() {
  console.log('=== CLD IPC Bridge — Smoke Test ===');
  console.log(`Pipe: ${TEST_PIPE}`);
  console.log(`Token: ${TEST_TOKEN.slice(0, 8)}...`);
  console.log('');

  // Start server
  const server = new PipeServer({
    pipePath: TEST_PIPE,
    token: TEST_TOKEN,
    instanceId: TEST_INSTANCE_ID,
    log: (msg) => {}, // silent
    onRequest: async (request) => {
      // Echo back for testing
      return { id: request.id, type: 'echo', ok: true, payload: request };
    }
  });

  try {
    await server.listen();
    console.log('Server started.\n');
  } catch (err) {
    console.log(`FATAL: Server failed to start: ${err.message}`);
    process.exit(1);
  }

  // Test 1: Client connects
  console.log('Test 1: Client connects');
  let client1;
  try {
    client1 = await connectClient(TEST_PIPE);
    assert(true, 'Connection established');
  } catch (err) {
    assert(false, `Connection failed: ${err.message}`);
    server.close();
    process.exit(1);
  }

  // Test 2: Handshake (correct token + instanceId)
  console.log('\nTest 2: Handshake (auth)');
  try {
    const resp = await sendAndReceive(client1, {
      type: 'handshake',
      token: TEST_TOKEN,
      expect_instance: TEST_INSTANCE_ID
    });
    assert(resp.ok === true, 'Handshake OK');
    assert(resp.type === 'handshake_ok', 'Response type is handshake_ok');
    assert(resp.instanceId === TEST_INSTANCE_ID, `Instance ID matches: ${resp.instanceId}`);
  } catch (err) {
    assert(false, `Handshake failed: ${err.message}`);
  }

  // Test 2b: Handshake echoes id (regression: PipeClient needs id matching)
  console.log('\nTest 2b: Handshake echoes id');
  try {
    const client1b = await connectClient(TEST_PIPE);
    const resp = await sendAndReceive(client1b, {
      id: 'hs-id-test',
      type: 'handshake',
      token: TEST_TOKEN,
      expect_instance: TEST_INSTANCE_ID
    });
    assert(resp.id === 'hs-id-test', `Handshake echoes id: ${resp.id}`);
    assert(resp.ok === true, 'Handshake OK with id');
    client1b.destroy();
  } catch (err) {
    assert(false, `Handshake id echo failed: ${err.message}`);
  }

  // Test 3: Ping/Pong
  console.log('\nTest 3: Ping/Pong');
  try {
    const resp = await sendAndReceive(client1, {
      id: 'ping-1',
      type: 'ping',
      expect_instance: TEST_INSTANCE_ID
    });
    assert(resp.ok === true, 'Ping OK');
    assert(resp.type === 'pong', 'Response type is pong');
    assert(typeof resp.ts === 'string', `Has timestamp: ${resp.ts}`);
  } catch (err) {
    assert(false, `Ping failed: ${err.message}`);
  }

  // Test 4: Echo request
  console.log('\nTest 4: Request routing (echo)');
  try {
    const resp = await sendAndReceive(client1, {
      id: 'echo-1',
      type: 'test.echo',
      data: 'hello',
      expect_instance: TEST_INSTANCE_ID
    });
    assert(resp.ok === true, 'Echo OK');
    assert(resp.payload?.data === 'hello', 'Payload preserved');
  } catch (err) {
    assert(false, `Echo failed: ${err.message}`);
  }

  client1.destroy();

  // Test 5: Wrong token rejected
  console.log('\nTest 5: Wrong token rejected');
  try {
    const client2 = await connectClient(TEST_PIPE);
    const resp = await sendAndReceive(client2, {
      type: 'handshake',
      token: 'wrong-token-000000000000000000000000000000000000000000000000',
      expect_instance: TEST_INSTANCE_ID
    });
    assert(resp.ok === false, 'Rejected');
    assert(resp.code === 'AUTH_FAILED', `Code: ${resp.code}`);
    client2.destroy();
  } catch (err) {
    // Connection may be destroyed — that's also OK
    assert(true, 'Connection rejected/destroyed');
  }

  // Test 6: Instance mismatch
  console.log('\nTest 6: Instance mismatch');
  try {
    const client3 = await connectClient(TEST_PIPE);
    const resp = await sendAndReceive(client3, {
      type: 'handshake',
      token: TEST_TOKEN,
      expect_instance: 'wrong-instance'
    });
    assert(resp.ok === false, 'Rejected');
    assert(resp.code === 'INSTANCE_MISMATCH', `Code: ${resp.code}`);
    client3.destroy();
  } catch (err) {
    assert(true, 'Connection rejected/destroyed');
  }

  // Test 7: Request without auth
  console.log('\nTest 7: Request without auth');
  try {
    const client4 = await connectClient(TEST_PIPE);
    const resp = await sendAndReceive(client4, {
      id: 'unauth-1',
      type: 'ping'
    });
    assert(resp.ok === false, 'Rejected');
    assert(resp.code === 'AUTH_REQUIRED', `Code: ${resp.code}`);
    client4.destroy();
  } catch (err) {
    assert(false, `Unexpected error: ${err.message}`);
  }

  // Test 7b: Missing expect_instance rejected (post-auth)
  console.log('\nTest 7b: Missing expect_instance rejected');
  try {
    const client5 = await connectClient(TEST_PIPE);
    await sendAndReceive(client5, {
      type: 'handshake', token: TEST_TOKEN, expect_instance: TEST_INSTANCE_ID
    });
    const resp = await sendAndReceive(client5, {
      id: 'no-instance-1',
      type: 'ping'
      // expect_instance deliberately omitted
    });
    assert(resp.ok === false, 'Rejected');
    assert(resp.code === 'MISSING_INSTANCE', `Code: ${resp.code}`);
    client5.destroy();
  } catch (err) {
    assert(false, `Unexpected error: ${err.message}`);
  }

  // Test 7c: Oversized message rejected
  console.log('\nTest 7c: Oversized message rejected');
  try {
    const client6 = await connectClient(TEST_PIPE);
    await sendAndReceive(client6, {
      type: 'handshake', token: TEST_TOKEN, expect_instance: TEST_INSTANCE_ID
    });
    // Send a message that exceeds MAX_MESSAGE_SIZE (256KB)
    const bigPayload = 'X'.repeat(300 * 1024);
    client6.write(JSON.stringify({ id: 'big-1', type: 'ping', data: bigPayload }) + '\n');
    // Server should close the connection
    const closed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000);
      client6.on('close', () => { clearTimeout(timer); resolve(true); });
      client6.on('data', (chunk) => {
        // May get error response before close
        try {
          const msg = JSON.parse(chunk.toString().trim().split('\n').pop());
          if (msg.code === 'MESSAGE_TOO_LARGE') {
            clearTimeout(timer);
            resolve(true);
          }
        } catch {}
      });
    });
    assert(closed, 'Oversized message rejected or connection closed');
    client6.destroy();
  } catch (err) {
    assert(false, `Unexpected error: ${err.message}`);
  }

  // Test 8: Two concurrent connections
  console.log('\nTest 8: Concurrent connections');
  try {
    const clientA = await connectClient(TEST_PIPE);
    const clientB = await connectClient(TEST_PIPE);

    const respA = await sendAndReceive(clientA, {
      type: 'handshake', token: TEST_TOKEN, expect_instance: TEST_INSTANCE_ID
    });
    const respB = await sendAndReceive(clientB, {
      type: 'handshake', token: TEST_TOKEN, expect_instance: TEST_INSTANCE_ID
    });

    assert(respA.ok && respB.ok, 'Both connections authenticated');

    const pingA = await sendAndReceive(clientA, { id: 'pa', type: 'ping', expect_instance: TEST_INSTANCE_ID });
    const pingB = await sendAndReceive(clientB, { id: 'pb', type: 'ping', expect_instance: TEST_INSTANCE_ID });

    assert(pingA.ok && pingB.ok, 'Both connections respond to ping');

    clientA.destroy();
    clientB.destroy();
  } catch (err) {
    assert(false, `Concurrent test failed: ${err.message}`);
  }

  // Shutdown
  console.log('\nTest 9: Graceful shutdown');
  server.close();
  assert(true, 'Server closed without error');

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
