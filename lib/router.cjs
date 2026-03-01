/**
 * router.cjs — Request dispatcher with queue management
 * ------------------------------------------------------
 * Routes incoming IPC requests to target adapters.
 * Manages per-target serialized queues with idempotency.
 */

'use strict';

const QUEUE_MAX = 5;
const CRITICAL_RATE_MAX = 3; // max critical requests per minute
const IDEMPOTENCY_TTL_MS = 60_000; // 60s cache window
const IDEMPOTENCY_CACHE_MAX = 200; // max cached entries (prevents memory DoS)
const MAX_TEXT_LENGTH = 64 * 1024; // 64KB max text payload
const MAX_ID_LENGTH = 256; // max request/idempotency ID length
const RATE_LIMIT_WINDOW_MS = 60_000; // per-connection rate limit window
const RATE_LIMIT_MAX = 30; // max requests per connection per minute
const PROCESSING_TIMEOUT_MS = 30_000; // max time for a single submit before forced abandon
const VALID_PRIORITIES = new Set(['normal', 'critical']);

// Characters that could cause command injection in terminals or shells
const DANGEROUS_TERMINAL_PATTERNS = /[\x00-\x08\x0e-\x1f\x7f]/;
// Unicode bidi overrides + zero-width chars that can disguise text
const DANGEROUS_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/;
// IDs must be printable ASCII only (no Unicode, no control chars)
const SAFE_ID_PATTERN = /^[\x20-\x7E]+$/;

class Router {
  /**
   * @param {object} opts
   * @param {object} opts.adapters - { codex: adapter, copilot: adapter, generic: adapter }
   * @param {function} [opts.log]
   */
  constructor(opts) {
    this._adapters = opts.adapters || {};
    this._vscode = opts.vscode || null;
    this._log = opts.log || (() => {});

    /** @type {Map<string, Array>} Per-target request queues */
    this._queues = new Map();
    /** @type {Map<string, boolean>} Per-target busy state */
    this._busy = new Map();
    /** @type {Map<string, {response: object, ts: number}>} Idempotency cache */
    this._idempotencyCache = new Map();
    /** @type {Array<number>} Timestamps of critical requests (rate limiting) */
    this._criticalTimestamps = [];

    // Periodic cleanup of idempotency cache
    this._cleanupInterval = setInterval(() => this._cleanIdempotencyCache(), 30_000);
  }

  /**
   * Handle an incoming request. Returns the initial response (ack or error).
   * The actual processing happens asynchronously; results are sent via sendFn.
   *
   * @param {object} request - The parsed request
   * @param {function} sendFn - function(responseObj) to send responses back
   * @returns {object} immediate response (ack or error)
   */
  async handle(request, sendFn) {
    const { id, type, target, idempotencyKey, priority } = request;

    // Validate required fields
    if (!type) {
      return { id, type: 'error', ok: false, code: 'MISSING_TYPE', message: 'Request must include "type"' };
    }

    // Idempotency check (namespaced by target+type to prevent cross-type collisions)
    if (idempotencyKey) {
      const scopedKey = `${target || 'generic'}:${type}:${idempotencyKey}`;
      const cached = this._idempotencyCache.get(scopedKey);
      if (cached && (Date.now() - cached.ts) < IDEMPOTENCY_TTL_MS) {
        this._log(`Idempotency hit: ${scopedKey}`);
        return { ...cached.response, id, idempotencyHit: true };
      }
    }

    // Route by type
    if (type === 'chat.submit') {
      return this._handleChatSubmit(request, sendFn);
    }

    if (type === 'list-commands') {
      return this._handleListCommands(request);
    }

    if (type === 'reload') {
      return this._handleReload(request);
    }

    if (type === 'reprobe') {
      return this._handleReprobe(request);
    }

    if (type === 'run-command') {
      return this._handleRunCommand(request);
    }

    if (type === 'query-dirty-files') {
      return this._handleQueryDirtyFiles(request);
    }

    // Cap type in error to prevent reflection amplification
    const safeType = typeof type === 'string' ? type.slice(0, 64) : '?';
    return { id, type: 'error', ok: false, code: 'UNKNOWN_TYPE', message: `Unknown request type: ${safeType}` };
  }

  /**
   * Handle chat.submit requests with queuing and adapter dispatch.
   */
  _handleChatSubmit(request, sendFn) {
    const { id, target: targetName, text, priority, idempotencyKey } = request;
    const target = targetName || 'generic';

    // === INPUT VALIDATION ===

    // Validate text field (required, bounded, no control chars)
    if (typeof text !== 'string' || !text.trim()) {
      return { id, type: 'error', ok: false, code: 'INVALID_TEXT', message: '"text" field is required and must be a non-empty string' };
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return { id, type: 'error', ok: false, code: 'TEXT_TOO_LARGE', message: `"text" exceeds max length (${MAX_TEXT_LENGTH} chars)` };
    }
    if (DANGEROUS_TERMINAL_PATTERNS.test(text)) {
      return { id, type: 'error', ok: false, code: 'INVALID_TEXT', message: '"text" contains disallowed control characters' };
    }
    if (DANGEROUS_UNICODE.test(text)) {
      return { id, type: 'error', ok: false, code: 'INVALID_TEXT', message: '"text" contains disallowed Unicode control characters (bidi/zero-width)' };
    }

    // Validate request ID (printable ASCII only)
    if (id && (typeof id !== 'string' || id.length > MAX_ID_LENGTH || !SAFE_ID_PATTERN.test(id))) {
      return { id, type: 'error', ok: false, code: 'INVALID_ID', message: `"id" must be printable ASCII, under ${MAX_ID_LENGTH} chars` };
    }

    // Validate idempotency key (printable ASCII only)
    if (idempotencyKey && (typeof idempotencyKey !== 'string' || idempotencyKey.length > MAX_ID_LENGTH || !SAFE_ID_PATTERN.test(idempotencyKey))) {
      return { id, type: 'error', ok: false, code: 'INVALID_IDEMPOTENCY_KEY', message: `"idempotencyKey" must be printable ASCII, under ${MAX_ID_LENGTH} chars` };
    }

    // Validate priority (enum)
    if (priority && !VALID_PRIORITIES.has(priority)) {
      return { id, type: 'error', ok: false, code: 'INVALID_PRIORITY', message: `"priority" must be one of: ${[...VALID_PRIORITIES].join(', ')}` };
    }

    // Validate target name (alphanumeric + hyphens only)
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/i.test(target)) {
      return { id, type: 'error', ok: false, code: 'INVALID_TARGET', message: '"target" must be alphanumeric (max 32 chars)' };
    }

    // Check adapter exists
    const adapter = this._adapters[target];
    if (!adapter) {
      const available = Object.keys(this._adapters).join(', ');
      return {
        id, type: 'error', ok: false,
        code: 'UNSUPPORTED_TARGET',
        message: `Target "${target}" not available. Available: ${available}`
      };
    }

    // Check adapter capability
    if (!adapter.available) {
      return {
        id, type: 'error', ok: false,
        code: 'TARGET_UNAVAILABLE',
        message: `Target "${target}" is not available (commands not found)`
      };
    }

    // Critical priority rate limiting
    if (priority === 'critical') {
      const now = Date.now();
      this._criticalTimestamps = this._criticalTimestamps.filter(t => now - t < 60_000);
      if (this._criticalTimestamps.length >= CRITICAL_RATE_MAX) {
        return {
          id, type: 'error', ok: false,
          code: 'RATE_LIMITED',
          message: `Critical requests limited to ${CRITICAL_RATE_MAX}/minute`
        };
      }
      this._criticalTimestamps.push(now);
    }

    // Check queue capacity
    const queue = this._queues.get(target) || [];
    if (queue.length >= QUEUE_MAX) {
      return {
        id, type: 'error', ok: false,
        code: 'QUEUE_FULL',
        message: `Queue full for target "${target}" (max ${QUEUE_MAX})`
      };
    }

    // Check busy + adapter busy policy
    const isBusy = this._busy.get(target) || false;

    // Enqueue the request
    const queueEntry = { request, sendFn, idempotencyKey };
    if (priority === 'critical') {
      queue.unshift(queueEntry); // Head of queue
    } else {
      queue.push(queueEntry); // Tail
    }
    this._queues.set(target, queue);

    const position = queue.indexOf(queueEntry);
    const status = isBusy ? 'queued' : 'processing';

    // Send immediate ack
    const ack = {
      v: 1, id, type: 'ack', ok: true,
      status,
      position: position + 1,
      queueSize: queue.length
    };
    sendFn(ack);

    // Start processing if not already busy
    if (!isBusy) {
      this._processQueue(target);
    }

    return null; // ack already sent via sendFn
  }

  /**
   * Process the next item in a target's queue.
   */
  async _processQueue(target) {
    const queue = this._queues.get(target);
    if (!queue || queue.length === 0) {
      this._busy.set(target, false);
      return;
    }

    this._busy.set(target, true);
    const { request, sendFn, idempotencyKey } = queue.shift();
    const adapter = this._adapters[target];

    try {
      // Check adapter busy policy
      if (adapter.isBusy && adapter.isBusy()) {
        const busyPolicy = adapter.busyPolicy || 'reject-when-busy';
        if (busyPolicy === 'reject-when-busy') {
          const errResp = {
            v: 1, id: request.id, type: 'error', ok: false,
            code: 'TARGET_BUSY',
            message: `Target "${target}" is busy (mid-generation)`,
            retryAfterMs: 5000
          };
          sendFn(errResp);
          // Re-queue at front for retry? No — let client decide
        } else {
          // submit-anyway: proceed
          await this._executeSubmit(adapter, target, request, sendFn, idempotencyKey);
        }
      } else {
        await this._executeSubmit(adapter, target, request, sendFn, idempotencyKey);
      }
    } catch (err) {
      this._log(`Queue processing error: ${err.message}`);
      const safeMsg = (err.message || 'Internal error')
        .replace(/[A-Z]:\\[^\s"')]+/gi, '<path>')
        .replace(/\/[^\s"')]+/g, '<path>')
        .slice(0, 200);
      sendFn({
        v: 1, id: request.id, type: 'error', ok: false,
        code: 'INTERNAL_ERROR', message: safeMsg
      });
    }

    // Process next in queue
    setImmediate(() => this._processQueue(target));
  }

  /**
   * Execute a chat submit via the adapter.
   */
  async _executeSubmit(adapter, target, request, sendFn, idempotencyKey) {
    const { id, text, options } = request;

    let timeoutTimer;
    const abortToken = { aborted: false };
    if (typeof adapter._setAbortToken === 'function') {
      adapter._setAbortToken(abortToken);
    }
    try {
      const result = await Promise.race([
        adapter.submit(text, options || {}),
        new Promise((_, reject) => {
          timeoutTimer = setTimeout(() => {
            abortToken.aborted = true;
            const err = new Error(`Processing timeout (${PROCESSING_TIMEOUT_MS}ms) — adapter.submit hung`);
            err.code = 'PROCESSING_TIMEOUT';
            reject(err);
          }, PROCESSING_TIMEOUT_MS);
        })
      ]);
      clearTimeout(timeoutTimer);
      const response = {
        v: 1, id, type: 'chat.submitted', ok: true,
        grade: result.grade || 'submitted',
        ts: new Date().toISOString(),
        detail: result.detail || null
      };
      sendFn(response);

      // Cache for idempotency (bounded)
      if (idempotencyKey) {
        // Evict oldest if at capacity
        if (this._idempotencyCache.size >= IDEMPOTENCY_CACHE_MAX) {
          const oldestKey = this._idempotencyCache.keys().next().value;
          if (oldestKey !== undefined) this._idempotencyCache.delete(oldestKey);
        }
        const scopedKey = `${target}:chat.submit:${idempotencyKey}`;
        this._idempotencyCache.set(scopedKey, {
          response: { ...response, id: undefined }, // Don't cache the request ID
          ts: Date.now()
        });
      }
    } catch (err) {
      clearTimeout(timeoutTimer);
      // Sanitize error message: strip file paths and internal details
      const safeMessage = (err.message || 'Submit failed')
        .replace(/[A-Z]:\\[^\s"')]+/gi, '<path>')
        .replace(/\/[^\s"')]+/g, '<path>')
        .slice(0, 200);
      const errResp = {
        v: 1, id, type: 'error', ok: false,
        code: err.code || 'SUBMIT_FAILED',
        message: safeMessage
      };
      sendFn(errResp);

      // Don't cache errors in idempotency (allow retry)
    }
  }

  /**
   * Clean expired idempotency cache entries.
   */
  _cleanIdempotencyCache() {
    const now = Date.now();
    for (const [key, entry] of this._idempotencyCache) {
      if (now - entry.ts > IDEMPOTENCY_TTL_MS) {
        this._idempotencyCache.delete(key);
      }
    }
  }

  /**
   * Strip file paths and cap length from error messages.
   */
  _sanitizeError(msg) {
    return (msg || 'Internal error')
      .replace(/[A-Z]:\\[^\s"')]+/gi, '<path>')
      .replace(/\/[^\s"')]+/g, '<path>')
      .slice(0, 200);
  }

  /**
   * List available VS Code commands matching a filter pattern.
   */
  async _handleListCommands(request) {
    const { id, filter } = request;
    if (!this._vscode) {
      return { id, type: 'error', ok: false, code: 'NO_VSCODE', message: 'vscode API not available' };
    }
    try {
      const allCmds = await this._vscode.commands.getCommands(true);
      const pattern = (filter || 'chat').toLowerCase();
      const matched = allCmds.filter(c => c.toLowerCase().includes(pattern));
      return { id, type: 'command-list', ok: true, filter: pattern, count: matched.length, commands: matched };
    } catch (err) {
      return { id, type: 'error', ok: false, code: 'COMMAND_LIST_FAILED', message: this._sanitizeError(err.message) };
    }
  }

  /**
   * Trigger a window reload (picks up extension updates).
   */
  async _handleReload(request) {
    const { id } = request;
    if (!this._vscode) {
      return { id, type: 'error', ok: false, code: 'NO_VSCODE', message: 'vscode API not available' };
    }
    this._log('Reload requested via IPC');
    // Schedule reload after a short delay so the response can be sent first
    setTimeout(() => {
      this._vscode.commands.executeCommand('workbench.action.reloadWindow').catch(() => {});
    }, 200);
    return { id, type: 'reload', ok: true, message: 'Window reload scheduled' };
  }

  /**
   * Re-probe all adapters and update capabilities.
   */
  async _handleReprobe(request) {
    const { id } = request;
    this._log('Reprobe requested via IPC');
    const caps = { targets: {} };
    for (const [name, adapter] of Object.entries(this._adapters)) {
      try {
        const result = await adapter.probe();
        caps.targets[name] = {
          available: adapter.available,
          method: adapter.method,
          busyPolicy: adapter.busyPolicy,
          probeResult: result
        };
      } catch (err) {
        caps.targets[name] = { available: false, error: this._sanitizeError(err.message) };
      }
    }
    return { id, type: 'reprobe', ok: true, capabilities: caps };
  }

  /**
   * Execute an arbitrary VS Code command by ID.
   * Equivalent to Ctrl+Shift+P → typing the command.
   * @param {object} request - { id, command: string, args?: any[] }
   */
  async _handleRunCommand(request) {
    const { id, command, args } = request;

    // Validate command field first (before vscode check, to avoid leaking vscode state)
    if (!command || typeof command !== 'string') {
      return { id, type: 'error', ok: false, code: 'MISSING_COMMAND', message: 'command field is required' };
    }

    // Safety: block destructive and dangerous commands (before vscode check)
    const BLOCKED = [
      'workbench.action.quit',
      'workbench.action.closeWindow',
      'workbench.action.terminal.sendSequence',
      'workbench.action.terminal.runSelectedText',
      'workbench.action.terminal.runActiveFile',
      'workbench.action.files.delete',
      'deleteFile',
      'workbench.action.closeAllEditors',
      'workbench.action.closeFolder',
    ];
    const BLOCKED_PREFIXES = [
      'workbench.action.terminal.send',
    ];
    if (BLOCKED.includes(command) || BLOCKED_PREFIXES.some(p => command.startsWith(p))) {
      return { id, type: 'error', ok: false, code: 'BLOCKED_COMMAND', message: `Command "${command}" is blocked for safety` };
    }

    if (!this._vscode) {
      return { id, type: 'error', ok: false, code: 'NO_VSCODE', message: 'vscode API not available' };
    }

    this._log(`Run command via IPC: ${command}${args ? ' args=' + JSON.stringify(args) : ''}`);
    try {
      const cmdArgs = Array.isArray(args) ? args : (args !== undefined ? [args] : []);
      const result = await this._vscode.commands.executeCommand(command, ...cmdArgs);
      return { id, type: 'command-result', ok: true, command, result: result !== undefined ? String(result) : null };
    } catch (err) {
      return { id, type: 'error', ok: false, code: 'COMMAND_FAILED', command, message: this._sanitizeError(err.message) };
    }
  }

  /**
   * Query VS Code for dirty (unsaved) text documents.
   *
   * Request: { id, type: 'query-dirty-files', includeContent?: boolean, pathFilter?: string }
   *   includeContent — if true, include buffer text (capped at MAX_TEXT_LENGTH)
   *   pathFilter     — optional substring to filter by file path (case-insensitive)
   *
   * Response: { id, type: 'query-dirty-files', ok: true, count, files: [{path, isDirty,
   *             isUntitled, languageId, version, lineCount, eol, content?}] }
   */
  async _handleQueryDirtyFiles(request) {
    const { id, includeContent, pathFilter } = request;

    if (!this._vscode) {
      return { id, type: 'error', ok: false, code: 'NO_VSCODE', message: 'vscode API not available' };
    }

    try {
      const docs = this._vscode.workspace.textDocuments;
      const filterLower = pathFilter ? String(pathFilter).toLowerCase().slice(0, 512) : null;

      const files = [];
      for (const doc of docs) {
        // Skip output channels, debug consoles, git internals
        if (doc.uri.scheme !== 'file') continue;

        if (filterLower && !doc.fileName.toLowerCase().includes(filterLower)) continue;

        const entry = {
          path: doc.fileName,
          isDirty: doc.isDirty,
          isUntitled: doc.isUntitled,
          languageId: doc.languageId,
          version: doc.version,
          lineCount: doc.lineCount,
          eol: doc.eol === 1 ? 'LF' : 'CRLF',
        };

        if (includeContent) {
          const raw = doc.getText();
          if (raw.length > MAX_TEXT_LENGTH) {
            entry.content = raw.slice(0, MAX_TEXT_LENGTH);
            entry.contentTruncated = true;
            entry.contentFullLength = raw.length;
          } else {
            entry.content = raw;
            entry.contentTruncated = false;
          }
        }

        files.push(entry);
      }

      // Only dirty files unless caller wants all open files
      const dirtyOnly = files.filter(f => f.isDirty);

      return {
        id, type: 'query-dirty-files', ok: true,
        count: dirtyOnly.length,
        totalOpen: files.length,
        files: dirtyOnly,
      };
    } catch (err) {
      return { id, type: 'error', ok: false, code: 'QUERY_FAILED', message: this._sanitizeError(err.message) };
    }
  }

  /**
   * Get queue status for all targets.
   */
  getStatus() {
    const status = {};
    for (const [target, adapter] of Object.entries(this._adapters)) {
      const queue = this._queues.get(target) || [];
      status[target] = {
        available: adapter.available || false,
        busy: this._busy.get(target) || false,
        queueLength: queue.length,
        method: adapter.method || 'unknown',
        busyPolicy: adapter.busyPolicy || 'reject-when-busy'
      };
    }
    return status;
  }

  /**
   * Cleanup on shutdown.
   */
  dispose() {
    clearInterval(this._cleanupInterval);
    this._idempotencyCache.clear();
    this._queues.clear();
  }
}

module.exports = { Router };
