/**
 * generic.cjs — Best-effort chat adapter (query-based)
 * -----------------------------------------------------
 * Uses VS Code chat commands with query pre-fill for deterministic text injection.
 * Phase 0 spike confirmed: query method works, type method is focus-sensitive and unsafe.
 *
 * Busy policy: submit-anyway (best-effort, caller accepts risk)
 *
 * SECURITY:
 *   - terminal.sendText is DISABLED (arbitrary shell command injection)
 *   - 'type' submit method is DISABLED (Phase 0 confirmed focus-sensitive)
 *   - Only 'query' submit method is permitted
 *   - Commands validated against allowlist to prevent config-driven injection
 *   - Leading / and @ stripped to prevent chat slash-command injection
 */

'use strict';

const READY_RETRIES = 5;
const RETRY_DELAYS = [100, 200, 300, 500, 500]; // ms

// Only these VS Code commands are allowed as openCommand / submitCommand.
// Prevents workspace settings from redirecting IPC to arbitrary commands.
const ALLOWED_COMMANDS = new Set([
  // Generic chat
  'workbench.action.chat.open',
  'workbench.action.chat.submit',
  'workbench.action.chat.newChat',
  'workbench.action.chat.focus',
  'workbench.action.chat.focusInput',
  // Copilot chat
  'workbench.panel.chat.view.copilot.focus',
  // Codex (openai.chatgpt extension)
  'workbench.action.chat.openNewChatSessionInPlace.openai-codex',
  'workbench.action.chat.openNewChatSessionExternal.openai-codex',
  'workbench.action.chat.openSessionWithPrompt.openai-codex',
  'chatgpt.sidebarView.focus',
  'chatgpt.openSidebar',
  'chatgpt.newCodexPanel',
  'chatgpt.newChat',
  // Text input (for Codex type-based injection)
  'default:type',
  'editor.action.selectAll',
  'deleteLeft',
]);

// Phase 0 confirmed: only 'query' is safe. 'type' goes to active editor.
const ALLOWED_SUBMIT_METHODS = new Set(['query']);

function validateCommand(command, fieldName) {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(
      `${fieldName} "${command}" is not in the allowlist. ` +
      `Allowed: ${[...ALLOWED_COMMANDS].join(', ')}`
    );
  }
}

class GenericAdapter {
  /**
   * @param {object} opts
   * @param {object} opts.vscode - VS Code API reference
   * @param {object} [opts.commands] - { openCommand, submitMethod, submitCommand }
   * @param {function} [opts.log]
   */
  constructor(opts) {
    this._vscode = opts.vscode;
    this._commands = opts.commands || {
      openCommand: 'workbench.action.chat.open',
      submitMethod: 'query',
      submitCommand: 'workbench.action.chat.submit'
    };
    this._log = opts.log || (() => {});
    this.available = false;
    this.method = 'unknown';
    this.busyPolicy = 'submit-anyway';
    this._busyFlag = false;
    this._abortToken = null;

    // Validate commands at construction time
    this._validateCommands();
  }

  /**
   * Validate that configured commands are in the allowlist.
   * Rejects arbitrary command names from workspace settings.
   */
  _validateCommands() {
    try {
      validateCommand(this._commands.openCommand, 'openCommand');
      validateCommand(this._commands.submitCommand, 'submitCommand');
    } catch (err) {
      this._log(`Command validation failed: ${err.message}`);
      this._commands.openCommand = 'workbench.action.chat.open';
      this._commands.submitCommand = 'workbench.action.chat.submit';
      this._log('Reverted to default commands');
    }

    if (!ALLOWED_SUBMIT_METHODS.has(this._commands.submitMethod)) {
      this._log(
        `submitMethod "${this._commands.submitMethod}" not allowed ` +
        `(allowed: ${[...ALLOWED_SUBMIT_METHODS].join(', ')}). Reverting to "query".`
      );
      this._commands.submitMethod = 'query';
    }
  }

  /**
   * Probe available commands and set this.available.
   */
  async probe() {
    try {
      const allCmds = await this._vscode.commands.getCommands(true);
      const openExists = allCmds.includes(this._commands.openCommand);
      const submitExists = allCmds.includes(this._commands.submitCommand);

      this.available = openExists;
      this.method = this._commands.submitMethod;

      this._log(`Generic probe: open=${openExists} submit=${submitExists} method=${this.method}`);
      return { openExists, submitExists };
    } catch (err) {
      this._log(`Generic probe failed: ${err.message}`);
      this.available = false;
      return { openExists: false, submitExists: false };
    }
  }

  /**
   * Submit text to the chat panel via query pre-fill + submit.
   * @param {string} text
   * @param {object} [options]
   * @returns {Promise<{grade: string, detail: string|null}>}
   */
  async submit(text, options = {}) {
    if (!this.available) {
      const err = new Error('Adapter not available — probe() returned false');
      err.code = 'TARGET_UNAVAILABLE';
      throw err;
    }

    this._busyFlag = true;
    try {
      // Sanitize: strip leading slash commands (/clear, /help) and @mentions
      let safeText = text.replace(/^[/@]+/, '');
      if (!safeText.trim()) {
        const err = new Error('Text is empty after stripping leading slash/@ commands');
        err.code = 'INVALID_TEXT';
        throw err;
      }

      // Step 1: Open chat with query pre-fill (deterministic — no focus issues)
      this._checkAbort();
      await this._vscode.commands.executeCommand(this._commands.openCommand, {
        query: safeText,
        isPartialQuery: false
      });
      await this._sleep(300);

      // Step 2: Submit
      this._checkAbort();
      try {
        await this._vscode.commands.executeCommand(this._commands.submitCommand);
        await this._sleep(200);
        return { grade: 'submitted', detail: `submitted via query pre-fill + ${this._commands.submitCommand}` };
      } catch (err) {
        const submitErr = new Error(`Submit failed: ${err.message} (text was pre-filled but submit unconfirmed)`);
        submitErr.code = 'SUBMIT_UNCONFIRMED';
        throw submitErr;
      }
    } finally {
      this._busyFlag = false;
      this._abortToken = null;
    }
  }

  /**
   * Is the adapter currently processing a submit?
   */
  isBusy() {
    return this._busyFlag;
  }

  /**
   * Retry executing a VS Code command with backoff.
   */
  async _retryCommand(command, args) {
    validateCommand(command, 'command');
    let lastErr;
    for (let i = 0; i < READY_RETRIES; i++) {
      try {
        await this._vscode.commands.executeCommand(command, args);
        return;
      } catch (err) {
        lastErr = err;
        if (i < READY_RETRIES - 1) {
          await this._sleep(RETRY_DELAYS[i] || 500);
        }
      }
    }
    const err = new Error(`Command "${command}" failed after ${READY_RETRIES} retries: ${lastErr?.message}`);
    err.code = 'COMMAND_NOT_FOUND';
    throw err;
  }

  /**
   * Set abort token for cooperative cancellation from the router timeout.
   * @param {{ aborted: boolean }} token
   */
  _setAbortToken(token) {
    this._abortToken = token;
  }

  /**
   * Check abort token and throw if aborted.
   * Call between automation steps to stop mid-sequence on timeout.
   */
  _checkAbort() {
    if (this._abortToken?.aborted) {
      const err = new Error('Submit aborted by router timeout');
      err.code = 'PROCESSING_TIMEOUT';
      throw err;
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { GenericAdapter, ALLOWED_COMMANDS, ALLOWED_SUBMIT_METHODS };
