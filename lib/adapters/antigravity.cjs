/**
 * antigravity.cjs -- Antigravity / Cascade chat adapter
 * ------------------------------------------------------
 * Targets Antigravity editor's built-in Cascade AI chat.
 *
 * Antigravity is a VS Code fork that uses its own chat commands instead
 * of the standard workbench.action.chat.* commands.
 *
 * Key commands:
 *   antigravity.sendTextToChat   -- inject text into Cascade chat
 *   antigravity.toggleChatFocus  -- focus the chat panel
 *   antigravity.startNewConversation -- start new conversation
 *
 * Submit strategy:
 *   1. Focus chat panel
 *   2. Send text via antigravity.sendTextToChat
 *
 * Busy policy: submit-anyway (best-effort, like generic adapter)
 *
 * SECURITY:
 *   - Only allowlisted commands are used
 *   - Leading / and @ stripped to prevent slash-command injection
 */

'use strict';

class AntigravityAdapter {
  /**
   * @param {object} opts
   * @param {object} opts.vscode - VS Code API reference
   * @param {function} [opts.log]
   */
  constructor(opts) {
    this._vscode = opts.vscode;
    this._log = opts.log || (() => {});
    this.available = false;
    this.method = 'sendTextToChat';
    this.busyPolicy = 'submit-anyway';
    this._busyFlag = false;
    this._abortToken = null;
    // Resolved during probe() — varies by editor (antigravity vs windsurf)
    this._sendCmd = null;
    this._focusCmd = null;
  }

  /**
   * Probe for Antigravity-specific commands.
   */
  async probe() {
    try {
      const allCmds = await this._vscode.commands.getCommands(true);

      // Detect editor by app name — more reliable than getCommands for Windsurf.
      // In Windsurf, getCommands(true) may not include windsurf.prioritized.chat.open
      // from the extension host context even though the command is registered.
      const appName = (this._vscode.env?.appName || '').toLowerCase();
      const isWindsurf = appName.includes('windsurf') && !allCmds.includes('antigravity.sendTextToChat');

      // Support both Antigravity and Windsurf command namespaces
      const agSendText = allCmds.includes('antigravity.sendTextToChat');
      const wsSendText = allCmds.includes('windsurf.sendTextToChat');
      const sendText = agSendText || wsSendText || isWindsurf;

      const toggleFocus = allCmds.includes('antigravity.toggleChatFocus');
      const wsCascadeOpen = allCmds.includes('windsurf.cascadePanel.open');
      const wsOpenChat = allCmds.includes('windsurf.prioritized.chat.open');
      const newConvo = allCmds.includes('antigravity.startNewConversation') || allCmds.includes('windsurf.prioritized.chat.openNewConversation');
      const agentFocus = allCmds.includes('antigravity.agentPanel.focus');

      // Resolve which commands to use at submit time.
      // For Windsurf: windsurf.sendTextToChat fails with string args ("Internal error").
      // Use windsurf.prioritized.chat.open({ query: text }) instead — tested and verified.
      // isWindsurf fallback: getCommands may not reliably include prioritized.chat.open
      // from the Windsurf extension host even after the command is registered.
      if (agSendText) {
        // Antigravity: sendTextToChat(string) works fine
        this._sendCmd = 'antigravity.sendTextToChat';
        this._sendArgs = 'string'; // pass text as positional string arg
      } else if (wsOpenChat || isWindsurf) {
        // Windsurf: prioritized.chat.open({ query }) is the correct injection method
        this._sendCmd = 'windsurf.prioritized.chat.open';
        this._sendArgs = 'query'; // pass { query: text } object
      } else if (wsSendText) {
        // Windsurf fallback: sendTextToChat with no args (focuses only, no text)
        this._sendCmd = 'windsurf.sendTextToChat';
        this._sendArgs = 'string';
      } else {
        this._sendCmd = null;
        this._sendArgs = null;
      }
      // Focus command: cascadePanel.open for Windsurf, toggleChatFocus for Antigravity
      this._focusCmd = toggleFocus ? 'antigravity.toggleChatFocus' : ((wsCascadeOpen || isWindsurf) ? 'windsurf.cascadePanel.open' : null);

      // We're available if the primary injection command exists
      this.available = !!(this._sendCmd);
      this.method = this._sendCmd ? this._sendCmd.split('.').pop() : 'unavailable';

      this._log(`Antigravity/Windsurf probe: appName=${appName} isWindsurf=${isWindsurf} sendCmd=${this._sendCmd} sendArgs=${this._sendArgs} focusCmd=${this._focusCmd} newConvo=${newConvo} agentFocus=${agentFocus}`);

      return { sendText: this.available, toggleFocus: !!(toggleFocus || this._focusCmd), newConvo, agentFocus };
    } catch (err) {
      this._log(`Antigravity probe failed: ${err.message}`);
      this.available = false;
      return { sendText: false, toggleFocus: false, newConvo: false, agentFocus: false };
    }
  }

  /**
   * Submit text to Antigravity's Cascade chat.
   * @param {string} text
   * @param {object} [options]
   * @returns {Promise<{grade: string, detail: string|null}>}
   */
  async submit(text, options = {}) {
    if (!this.available) {
      const err = new Error('Antigravity adapter not available -- antigravity.sendTextToChat not found');
      err.code = 'TARGET_UNAVAILABLE';
      throw err;
    }

    this._busyFlag = true;
    try {
      // Sanitize: strip leading slash commands and @mentions
      let safeText = text.replace(/^[/@]+/, '');
      if (!safeText.trim()) {
        const err = new Error('Text is empty after stripping leading slash/@ commands');
        err.code = 'INVALID_TEXT';
        throw err;
      }

      // Step 1: Focus chat panel
      this._checkAbort();
      if (this._focusCmd) {
        try {
          await this._vscode.commands.executeCommand(this._focusCmd);
          await this._sleep(800);
        } catch {
          this._log(`${this._focusCmd} failed, continuing...`);
        }
      }

      // Step 2: Send text via native command — arg format depends on editor
      // If probe used sendTextToChat but it fails with "Internal error" (Windsurf timing issue),
      // fall back to windsurf.prioritized.chat.open({ query }) which is always safe.
      this._checkAbort();
      this._log(`submit: _sendCmd=${this._sendCmd} _sendArgs=${this._sendArgs}`);
      if (this._sendArgs === 'query') {
        await this._vscode.commands.executeCommand(this._sendCmd, { query: safeText });
      } else {
        try {
          await this._vscode.commands.executeCommand(this._sendCmd, safeText);
        } catch (cmdErr) {
          // sendTextToChat(string) fails on Windsurf with "Internal error".
          // Fall back to windsurf.prioritized.chat.open({ query }) — don't use getCommands
          // since Windsurf may not include it in getCommands from the extension host.
          this._log(`${this._sendCmd} failed, trying windsurf.prioritized.chat.open fallback`);
          try {
            await this._vscode.commands.executeCommand('windsurf.prioritized.chat.open', { query: safeText });
            // Update for next call to skip the failing path
            this._sendCmd = 'windsurf.prioritized.chat.open';
            this._sendArgs = 'query';
          } catch {
            throw cmdErr; // Re-throw original error if fallback also fails
          }
        }
      }
      await this._sleep(200);

      return { grade: 'submitted', detail: `submitted via ${this._sendCmd}` };
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
   * Set abort token for cooperative cancellation.
   * @param {{ aborted: boolean }} token
   */
  _setAbortToken(token) {
    this._abortToken = token;
  }

  /**
   * Check abort token and throw if aborted.
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

module.exports = { AntigravityAdapter };
