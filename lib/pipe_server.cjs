/**
 * pipe_server.cjs — Named pipe server with NDJSON framing
 * --------------------------------------------------------
 * Multi-connection, serialized request queue per target.
 * Each connection is authenticated independently.
 *
 * Protocol: NDJSON (one JSON object per line, newline-delimited)
 *
 * Connection lifecycle:
 *   1. Client connects to named pipe
 *   2. Client sends handshake: {"type":"handshake","token":"...","expect_instance":"..."}
 *   3. Server validates token + instanceId → responds with ack + capabilities
 *   4. Client sends requests, server responds
 *   5. Either side can close
 */

'use strict';

const net = require('net');
const { safeCompare, AUTH_TIMEOUT_MS } = require('./auth.cjs');

const MAX_MESSAGE_SIZE = 256 * 1024; // 256KB
const MAX_CONNECTIONS = 10;
const CONN_IDLE_TIMEOUT_MS = 5 * 60_000; // 5 min idle → close (reclaim slots)
const CONN_RATE_LIMIT = 30; // max messages per minute per connection
const CONN_RATE_WINDOW_MS = 60_000;

/**
 * @typedef {object} PipeServerOptions
 * @property {string} pipePath - Windows named pipe path
 * @property {string} token - Auth token for this session
 * @property {string} instanceId - This instance's ID
 * @property {function} onRequest - async (request, connection) => response
 * @property {function} [log] - logging function
 */

class PipeServer {
  /** @param {PipeServerOptions} opts */
  constructor(opts) {
    this._pipePath = opts.pipePath;
    this._token = opts.token;
    this._instanceId = opts.instanceId;
    this._onRequest = opts.onRequest;
    this._log = opts.log || (() => {});
    this._server = null;
    /** @type {Set<net.Socket>} */
    this._connections = new Set();
    this._closed = false;
  }

  /**
   * Start listening. Returns a promise that resolves when the pipe is bound.
   */
  listen() {
    return new Promise((resolve, reject) => {
      this._server = net.createServer({ allowHalfOpen: false }, (socket) => {
        this._handleConnection(socket);
      });

      this._server.maxConnections = MAX_CONNECTIONS;

      this._server.on('error', (err) => {
        this._log(`Pipe server error: ${err.message}`);
        if (!this._closed) reject(err);
      });

      this._server.listen(this._pipePath, () => {
        this._log(`Pipe server listening: ${this._pipePath}`);
        resolve();
      });
    });
  }

  /**
   * Handle a new connection.
   * @param {net.Socket} socket
   */
  _handleConnection(socket) {
    if (this._connections.size >= MAX_CONNECTIONS) {
      this._log('Max connections reached, rejecting');
      socket.destroy();
      return;
    }

    this._connections.add(socket);
    this._log(`Connection opened (${this._connections.size} active)`);

    const conn = {
      socket,
      authenticated: false,
      buffer: '',
      authTimer: null,
      idleTimer: null,
      msgTimestamps: [] // for per-connection rate limiting
    };

    // Auth timeout: must authenticate within AUTH_TIMEOUT_MS
    conn.authTimer = setTimeout(() => {
      if (!conn.authenticated) {
        this._log('Auth timeout — closing connection');
        this._sendLine(socket, { type: 'error', ok: false, code: 'AUTH_TIMEOUT', message: 'Authentication timeout' });
        socket.destroy();
      }
    }, AUTH_TIMEOUT_MS);

    socket.setEncoding('utf8');

    socket.on('data', (chunk) => {
      conn.buffer += chunk;

      // Enforce max message size (byte-count, not char-count — multibyte safe)
      if (Buffer.byteLength(conn.buffer, 'utf8') > MAX_MESSAGE_SIZE) {
        this._log('Message too large — closing connection');
        this._sendLine(socket, { type: 'error', ok: false, code: 'MESSAGE_TOO_LARGE', message: `Max ${MAX_MESSAGE_SIZE} bytes` });
        socket.destroy();
        return;
      }

      // Process complete lines (NDJSON)
      let newlineIdx;
      while ((newlineIdx = conn.buffer.indexOf('\n')) !== -1) {
        const line = conn.buffer.slice(0, newlineIdx).trim();
        conn.buffer = conn.buffer.slice(newlineIdx + 1);

        if (line.length === 0) continue;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          this._sendLine(socket, { type: 'error', ok: false, code: 'PARSE_ERROR', message: 'Invalid JSON' });
          continue;
        }

        // Per-connection rate limit (post-auth messages only)
        if (conn.authenticated) {
          const now = Date.now();
          conn.msgTimestamps = conn.msgTimestamps.filter(t => now - t < CONN_RATE_WINDOW_MS);
          if (conn.msgTimestamps.length >= CONN_RATE_LIMIT) {
            this._sendLine(socket, { type: 'error', ok: false, code: 'RATE_LIMITED', message: `Max ${CONN_RATE_LIMIT} messages/minute per connection` });
            continue;
          }
          conn.msgTimestamps.push(now);
        }

        // Reset idle timer on activity
        if (conn.idleTimer) clearTimeout(conn.idleTimer);
        conn.idleTimer = setTimeout(() => {
          this._log('Idle timeout — closing connection');
          socket.destroy();
        }, CONN_IDLE_TIMEOUT_MS);

        this._handleMessage(conn, msg);
      }
    });

    socket.on('error', (err) => {
      this._log(`Connection error: ${err.message}`);
    });

    socket.on('close', () => {
      clearTimeout(conn.authTimer);
      clearTimeout(conn.idleTimer);
      this._connections.delete(socket);
      this._log(`Connection closed (${this._connections.size} active)`);
    });
  }

  /**
   * Handle a parsed message from a connection.
   */
  _handleMessage(conn, msg) {
    // Handshake must come first
    if (msg.type === 'handshake') {
      this._handleHandshake(conn, msg);
      return;
    }

    // All other messages require auth
    if (!conn.authenticated) {
      this._sendLine(conn.socket, {
        type: 'error', ok: false, code: 'AUTH_REQUIRED',
        message: 'Send handshake with token first'
      });
      return;
    }

    // Validate expect_instance on every request (mandatory — PID-reuse defense)
    if (!msg.expect_instance) {
      this._sendLine(conn.socket, {
        id: msg.id,
        type: 'error', ok: false, code: 'MISSING_INSTANCE',
        message: 'Request must include "expect_instance" field'
      });
      return;
    }
    if (msg.expect_instance !== this._instanceId) {
      this._sendLine(conn.socket, {
        id: msg.id,
        type: 'error', ok: false, code: 'INSTANCE_MISMATCH',
        message: `Expected ${msg.expect_instance}, got ${this._instanceId}`
      });
      return;
    }

    // Ping/pong (health check)
    if (msg.type === 'ping') {
      this._sendLine(conn.socket, {
        id: msg.id,
        type: 'pong', ok: true,
        instanceId: this._instanceId,
        ts: new Date().toISOString()
      });
      return;
    }

    // Delegate to request handler
    this._handleRequest(conn, msg);
  }

  /**
   * Handle handshake (auth).
   */
  _handleHandshake(conn, msg) {
    clearTimeout(conn.authTimer);

    // Validate token
    if (!msg.token || !safeCompare(msg.token, this._token)) {
      this._log('Auth failed — wrong token');
      this._sendLine(conn.socket, {
        id: msg.id,
        type: 'error', ok: false, code: 'AUTH_FAILED',
        message: 'Invalid auth token'
      });
      conn.socket.destroy();
      return;
    }

    // Validate expected instance ID (mandatory — PID-reuse defense)
    if (!msg.expect_instance) {
      this._log('Handshake missing expect_instance');
      this._sendLine(conn.socket, {
        id: msg.id,
        type: 'error', ok: false, code: 'MISSING_INSTANCE',
        message: 'Handshake must include "expect_instance" field'
      });
      conn.socket.destroy();
      return;
    }
    if (msg.expect_instance !== this._instanceId) {
      this._log(`Instance mismatch: expected ${msg.expect_instance}, got ${this._instanceId}`);
      this._sendLine(conn.socket, {
        id: msg.id,
        type: 'error', ok: false, code: 'INSTANCE_MISMATCH',
        message: `Expected instance ${msg.expect_instance}, this is ${this._instanceId}`
      });
      conn.socket.destroy();
      return;
    }

    conn.authenticated = true;
    this._log('Client authenticated');
    this._sendLine(conn.socket, {
      id: msg.id, // Echo id so PipeClient can match response
      type: 'handshake_ok', ok: true,
      instanceId: this._instanceId,
      capabilities: this._capabilities || {}
    });
  }

  /**
   * Handle an authenticated request — delegate to onRequest callback.
   */
  async _handleRequest(conn, msg) {
    if (!msg.id) {
      this._sendLine(conn.socket, {
        type: 'error', ok: false, code: 'MISSING_ID',
        message: 'Request must include "id" field'
      });
      return;
    }

    try {
      const response = await this._onRequest(msg, conn);
      if (response) {
        this._sendLine(conn.socket, response);
      }
    } catch (err) {
      // Sanitize: don't leak file paths or stack traces to client
      const safeMsg = (err.message || 'Internal error')
        .replace(/[A-Z]:\\[^\s"')]+/gi, '<path>')
        .replace(/\/[^\s"')]+/g, '<path>')
        .slice(0, 200);
      this._sendLine(conn.socket, {
        id: msg.id,
        type: 'error', ok: false,
        code: 'INTERNAL_ERROR',
        message: safeMsg
      });
    }
  }

  /**
   * Send a JSON line to a socket (NDJSON).
   */
  _sendLine(socket, obj) {
    if (socket.destroyed || socket.writableEnded) return;
    try {
      socket.write(JSON.stringify(obj) + '\n');
    } catch {}
  }

  /**
   * Set capabilities (advertised in handshake response).
   */
  setCapabilities(caps) {
    this._capabilities = caps;
  }

  /**
   * Close the server and all connections.
   */
  close() {
    this._closed = true;
    for (const socket of this._connections) {
      socket.destroy();
    }
    this._connections.clear();
    if (this._server) {
      this._server.close();
      this._server = null;
    }
    this._log('Pipe server closed');
  }
}

module.exports = { PipeServer, MAX_MESSAGE_SIZE };
